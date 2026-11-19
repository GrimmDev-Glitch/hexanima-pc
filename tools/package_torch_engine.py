"""Empaqueta engine/torch para subirlo a Hugging Face y que HexAnima PC lo descargue en la bienvenida.

    python tools/package_torch_engine.py [--version 1]
    python tools/package_torch_engine.py --cu128 --version 1      # motor para RTX serie 50 (engine/torch-cu128)

Crea en dist/torch-engine/:
    hexanima-motor-pytorch-<v>.zip   el motor (sin lo que solo sirve para compilar ni bitsandbytes)
    motor.json                       versión, tamaño y sha256 que la app comprueba
    hexanima-motor-pytorch-cu128-<v>.zip + motor-cu128.json   con --cu128 (PyTorch 2.7.1 + CUDA 12.8)
    README.md                        ficha del repositorio (licencia AGPL-3.0 y contenido)

Subir (con tu cuenta, desde esta carpeta):
    huggingface-cli login
    huggingface-cli upload <usuario>/hexanima-engine dist/torch-engine . --repo-type model
"""
import argparse
import fnmatch
import hashlib
import json
import os
import sys
import time
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "engine", "torch")
OUT = os.path.join(ROOT, "dist", "torch-engine")
# Rutas relativas a engine/torch que no hacen falta para generar
SKIP = [
    "*/__pycache__/*", "*.pyc",
    "python/Lib/site-packages/torch/lib/*.lib",     # bibliotecas para compilar extensiones (dnnl.lib 600 MB)
    "python/Lib/site-packages/torch/include/*",
    "python/Lib/site-packages/torch/share/*",
    "python/Lib/site-packages/bitsandbytes/*",      # solo modelos nf4 (no los usa HexAnima)
    "python/Lib/site-packages/bitsandbytes-*",
]
# Ya comprimidos o casi incompresibles: se guardan tal cual (más rápido de crear y de extraer)
STORE = (".zip", ".png", ".jpg", ".pt", ".pth", ".safetensors")


def skipped(rel):
    r = rel.replace(os.sep, "/")
    return any(fnmatch.fnmatch(r, p) for p in SKIP)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", type=int, default=1)
    ap.add_argument("--cu128", action="store_true", help="motor de engine/torch-cu128 para las RTX serie 50")
    a = ap.parse_args()
    global SRC
    if a.cu128:
        SRC = os.path.join(ROOT, "engine", "torch-cu128")
    if not os.path.isfile(os.path.join(SRC, "hexanima", "server.py")):
        sys.exit(f"No existe {SRC}: ármalo con tools/build_torch_engine.py")
    os.makedirs(OUT, exist_ok=True)
    name = f"hexanima-motor-pytorch-{'cu128-' if a.cu128 else ''}{a.version}.zip"
    zpath = os.path.join(OUT, name)
    files = []
    for d, dirs, fs in os.walk(SRC):
        dirs.sort()
        for f in sorted(fs):
            p = os.path.join(d, f)
            rel = os.path.relpath(p, SRC)
            if not skipped(rel) and rel != "motor.json":
                files.append((p, rel))
    unpacked = sum(os.path.getsize(p) for p, _ in files)
    print(f"{len(files)} archivos · {unpacked / 2**30:.2f} GB sin comprimir", flush=True)
    t = time.time()
    with zipfile.ZipFile(zpath + ".tmp", "w", allowZip64=True) as z:
        for i, (p, rel) in enumerate(files):
            method = zipfile.ZIP_STORED if rel.lower().endswith(STORE) else zipfile.ZIP_DEFLATED
            z.write(p, rel.replace(os.sep, "/"), compress_type=method, compresslevel=6 if method == zipfile.ZIP_DEFLATED else None)
            if i % 2000 == 0:
                print(f"  {i}/{len(files)} · {time.time() - t:.0f} s", flush=True)
    os.replace(zpath + ".tmp", zpath)
    h = hashlib.sha256()
    with open(zpath, "rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    size = os.path.getsize(zpath)
    manifest = {"version": a.version, "file": name, "bytes": size, "sha256": h.hexdigest(),
                "unpacked_bytes": unpacked, "files": len(files), "requires": "nvidia"}
    with open(os.path.join(OUT, "motor-cu128.json" if a.cu128 else "motor.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(OUT, "README.md"), "w", encoding="utf-8") as f:
        f.write(README)
    print(f"Listo: {zpath} · {size / 2**30:.2f} GB · {time.time() - t:.0f} s")


README = """---
license: agpl-3.0
tags:
- stable-diffusion
- sdxl
---
# Motor PyTorch de HexAnima PC

Motor de generación de imágenes (SDXL / Illustrious / Pony) para GPUs NVIDIA que HexAnima PC descarga
desde su pantalla de bienvenida. No hace falta descargarlo a mano.

- `hexanima-motor-pytorch-<v>.zip` + `motor.json`: Python 3.10 portátil + PyTorch 2.3.1 con CUDA 12.1 + el
  backend de [Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) + el
  servidor de HexAnima (`hexanima/`). Para GTX 9xx/10xx/16xx y RTX 20/30/40.
- `hexanima-motor-pytorch-cu128-<v>.zip` + `motor-cu128.json`: lo mismo con PyTorch 2.7.1 y CUDA 12.8, para las
  **RTX serie 50** (también funciona en las anteriores). Necesita el driver de NVIDIA 570 o posterior.
- Los `.json` llevan versión, tamaño y sha256, que la app comprueba antes de instalar.

## Licencia

AGPL-3.0, como Forge, del que usa el código de carga de modelos, gestión de memoria y LoRAs. El código
fuente completo del motor va dentro del zip (`forge/`, `hexanima/`, archivos `.py`). PyTorch (BSD),
las bibliotecas CUDA de NVIDIA (redistribuibles) y el resto de paquetes conservan sus licencias, incluidas
en sus carpetas `*.dist-info`.
"""

if __name__ == "__main__":
    main()
