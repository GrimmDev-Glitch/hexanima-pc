#!/usr/bin/env python3
"""Convierte un detector YOLOv8 de Ultralytics (.pt) al .safetensors que usa ADetailer de sd.cpp,
sin torch ni ultralytics (solo numpy).

Hace lo mismo que scripts/convert_yolov8_to_safetensors.py de stable-diffusion.cpp:
fusiona cada Conv+BatchNorm, descarta bn y dfl, pesos en f16 y sesgos en f32, y escribe los
mismos metadatos (yolov8.*). El pickle NO se ejecuta: un Unpickler restringido solo reconstruye
tensores y diccionarios; cualquier otra clase se convierte en un objeto inerte.

Uso: python -I tools/convert_yolov8.py face_yolov8n.pt models/detectors/face_yolov8n.safetensors
"""
import collections
import json
import pickle
import struct
import sys
import zipfile
from pathlib import Path

import numpy as np

DTYPES = {"HalfStorage": np.float16, "FloatStorage": np.float32, "DoubleStorage": np.float64,
          "LongStorage": np.int64, "IntStorage": np.int32, "ByteStorage": np.uint8, "BFloat16Storage": None}
BN_EPS = 1e-3  # ultralytics Conv usa BatchNorm2d(eps=0.001)


class Stub:
    """Objeto inerte en lugar de cualquier clase del pickle (módulos de ultralytics/torch)."""
    def __init__(self, *a, **k): self._args = a
    def __setstate__(self, st):
        if isinstance(st, tuple) and len(st) == 2 and isinstance(st[1], dict):  # (dict, slots)
            st = {**(st[0] or {}), **st[1]}
        if isinstance(st, dict): self.__dict__.update(st)
        else: self._state = st


def stub_class(name):
    return type(name, (Stub,), {})


class Storage:
    def __init__(self, kind): self.kind = kind


def rebuild_tensor(storage, offset, size, stride, *_):
    arr = storage
    n = 1
    for s in size: n *= s
    if not size: return arr[offset:offset + 1].reshape(())
    item = arr.itemsize
    return np.lib.stride_tricks.as_strided(arr[offset:], shape=tuple(size), strides=tuple(s * item for s in stride)).copy()


def rebuild_parameter(data, *_):
    return data


class SafeUnpickler(pickle.Unpickler):
    def __init__(self, f, zf, prefix):
        super().__init__(f)
        self.zf, self.prefix, self.cache = zf, prefix, {}

    def find_class(self, module, name):
        if module == "collections" and name == "OrderedDict": return collections.OrderedDict
        if module == "torch._utils" and name == "_rebuild_tensor_v2": return rebuild_tensor
        if module == "torch._utils" and name == "_rebuild_parameter": return rebuild_parameter
        if module == "torch" and name in DTYPES: return Storage(name)
        return stub_class(f"{module}.{name}")

    def persistent_load(self, pid):
        # ('storage', <tipo>, key, location, numel)
        _, kind, key, _, numel = pid
        if key not in self.cache:
            dt = DTYPES.get(kind.kind if isinstance(kind, Storage) else str(kind))
            if dt is None: raise ValueError(f"tipo de tensor no soportado: {kind}")
            raw = self.zf.read(f"{self.prefix}/data/{key}")
            self.cache[key] = np.frombuffer(raw, dtype=dt)
        return self.cache[key]


def state_dict(mod, prefix=""):
    out = {}
    d = getattr(mod, "__dict__", {})
    for k, v in (d.get("_parameters") or {}).items():
        if v is not None: out[prefix + k] = v
    for k, v in (d.get("_buffers") or {}).items():
        if v is not None: out[prefix + k] = v
    for k, v in (d.get("_modules") or {}).items():
        if v is not None: out.update(state_dict(v, prefix + k + "."))
    return out


def fuse(sd):
    """Conv+BN -> Conv con sesgo, como network.fuse() de ultralytics."""
    out = {}
    for name, w in sd.items():
        if name.endswith(".conv.weight"):
            base = name[: -len(".conv.weight")]
            g = sd.get(base + ".bn.weight")
            if g is not None:
                b, mu, var = sd[base + ".bn.bias"], sd[base + ".bn.running_mean"], sd[base + ".bn.running_var"]
                s = g.astype(np.float64) / np.sqrt(var.astype(np.float64) + BN_EPS)
                out[name] = (w.astype(np.float64) * s.reshape(-1, 1, 1, 1))
                cb = sd.get(base + ".conv.bias")
                cb = cb.astype(np.float64) if cb is not None else 0.0
                out[base + ".conv.bias"] = (cb - mu.astype(np.float64)) * s + b.astype(np.float64)
                continue
        if ".bn." in name or name in out: continue
        out[name] = w
    return out


def write_safetensors(path, tensors, metadata):
    header, blobs, off = {"__metadata__": metadata}, [], 0
    for name in sorted(tensors):
        a = np.ascontiguousarray(tensors[name])
        dt = {np.dtype(np.float16): "F16", np.dtype(np.float32): "F32"}[a.dtype]
        b = a.tobytes()
        header[name] = {"dtype": dt, "shape": list(a.shape), "data_offsets": [off, off + len(b)]}
        blobs.append(b); off += len(b)
    h = json.dumps(header, separators=(",", ":")).encode()
    h += b" " * ((8 - len(h) % 8) % 8)
    with open(path, "wb") as f:
        f.write(struct.pack("<Q", len(h))); f.write(h)
        for b in blobs: f.write(b)


def convert(src, dst, input_size=640):
    zf = zipfile.ZipFile(src)
    pkl = next(n for n in zf.namelist() if n.endswith("/data.pkl") or n == "data.pkl")
    prefix = pkl.rsplit("/", 1)[0] if "/" in pkl else ""
    with zf.open(pkl) as f:
        ckpt = SafeUnpickler(f, zf, prefix).load()
    model = ckpt.get("ema") or ckpt.get("model") if isinstance(ckpt, dict) else ckpt
    if isinstance(ckpt, dict) and ckpt.get("model") is not None: model = ckpt["model"]
    layers = model.__dict__["_modules"]["model"].__dict__["_modules"]
    head = list(layers.values())[-1]
    if type(head).__name__ != "ultralytics.nn.modules.head.Detect" and not type(head).__name__.endswith(".Detect"):
        raise ValueError(f"solo detectores YOLOv8 de detección (la cabeza es {type(head).__name__})")
    sd = fuse(state_dict(model))
    for req in ("model.0.conv.weight", "model.22.cv2.0.2.weight", "model.22.cv3.0.2.weight"):
        if req not in sd: raise ValueError(f"el checkpoint no tiene la estructura YOLOv8 esperada: falta {req}")
    tensors = {}
    for name, t in sd.items():
        if not name.startswith("model.") or ".bn." in name or name.endswith("dfl.conv.weight"): continue
        if not (name.endswith(".weight") or name.endswith(".bias")): continue
        tensors[name] = np.asarray(t, dtype=np.float16 if name.endswith(".weight") else np.float32)
    names = getattr(model, "names", None) or getattr(head, "names", None) or {}
    if isinstance(names, list): names = dict(enumerate(names))
    meta = {
        "format": "pt", "yolov8.variant": "detect", "yolov8.input_size": str(input_size),
        "yolov8.num_classes": str(int(head.nc)), "yolov8.reg_max": str(int(getattr(head, "reg_max", 16))),
        "yolov8.names": json.dumps({str(k): v for k, v in names.items()}, ensure_ascii=False),
    }
    Path(dst).parent.mkdir(parents=True, exist_ok=True)
    write_safetensors(dst, tensors, meta)
    return len(tensors), meta


if __name__ == "__main__":
    n, meta = convert(sys.argv[1], sys.argv[2])
    print(f"escrito {sys.argv[2]}: {n} tensores · clases {meta['yolov8.names']}")
