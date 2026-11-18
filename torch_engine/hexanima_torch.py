# HexAnima PC · motor PyTorch (prototipo).
# Usa el backend de Stable Diffusion WebUI Forge (AGPL-3.0, https://github.com/lllyasviel/stable-diffusion-webui-forge):
# carga de modelos, gestión de memoria para poca VRAM, LoRAs y atención SDP; este archivo solo hace el
# recorrido de generación (texto -> muestreo k-diffusion -> VAE) sin la interfaz web de Forge.
# Este motor se distribuye bajo AGPL-3.0 (ver LICENSE en esta carpeta).
import os
import sys
import time
import types

_HERE = os.path.dirname(os.path.abspath(__file__))
FORGE = os.environ.get("HEXANIMA_FORGE_ROOT") or next(
    (p for p in (os.path.join(_HERE, "forge"), os.path.join(_HERE, "..", "forge")) if os.path.isdir(os.path.join(p, "backend"))),
    os.path.join(_HERE, "forge"))
for p in (FORGE, os.path.join(FORGE, "packages_3rdparty"), os.path.join(FORGE, "repositories", "huggingface_guess")):
    if p not in sys.path:
        sys.path.insert(0, p)

# Forge lee 6 opciones de su interfaz (modules.shared.opts): se dan aquí con sus valores por defecto,
# sin cargar la interfaz.
_shared = types.ModuleType("modules.shared")
_shared.opts = types.SimpleNamespace(sdxl_crop_left=0, sdxl_crop_top=0, sdxl_refiner_low_aesthetic_score=2.5,
                                     sdxl_refiner_high_aesthetic_score=6.0, emphasis="Original", sd3_enable_t5=False)
_modules = types.ModuleType("modules"); _modules.shared = _shared; _modules.__path__ = []
sys.modules.setdefault("modules", _modules); sys.modules["modules.shared"] = _shared
_mf = types.ModuleType("modules_forge"); _mf.__path__ = []
_mfs = types.ModuleType("modules_forge.shared"); _mfs.controlnet_dir = _mfs.models_path = _HERE
sys.modules.setdefault("modules_forge", _mf); sys.modules.setdefault("modules_forge.shared", _mfs)
_IPA_DIR = os.path.join(FORGE, "extensions-builtin", "sd_forge_ipadapter")
if os.path.isdir(_IPA_DIR) and _IPA_DIR not in sys.path:
    sys.path.insert(0, _IPA_DIR)
_ARGV = sys.argv[:]
sys.argv = [sys.argv[0]]  # backend.args lee la línea de órdenes: que use sus valores por defecto

import torch  # noqa: E402
from backend import memory_management, stream  # noqa: E402
from backend.loader import forge_loader  # noqa: E402
from backend.utils import load_torch_file  # noqa: E402
from backend.patcher.lora import model_lora_keys_clip, model_lora_keys_unet, load_lora  # noqa: E402
from backend.sampling.sampling_function import sampling_function_inner, sampling_prepare, sampling_cleanup  # noqa: E402
from backend.sampling.condition import compile_conditions  # noqa: E402
import k_diffusion.sampling as ks  # noqa: E402


def setup_memory(inference_mb=1024, async_loading=False, pin_shared=False):
    """Como el «GPU Weights» de Forge: deja `inference_mb` para calcular y el resto para pesos."""
    stream.stream_activated = async_loading
    memory_management.current_inference_memory = inference_mb * 1024 * 1024
    memory_management.PIN_SHARED_MEMORY = pin_shared


from backend import utils as _futils  # noqa: E402
from backend.patcher import lora as _flora  # noqa: E402

_forge_refresh = _flora.LoraLoader.refresh


@torch.inference_mode()
def _refresh_sin_copia(self, lora_patches, offload_device=torch.device("cpu"), force_refresh=False):
    """LoraLoader.refresh de Forge sin la copia de los pesos originales que guarda para poder quitar el LoRA
    (4-5 GB de RAM con varios LoRAs en SDXL). Para quitarlos o cambiarlos, Engine.set_loras recarga el
    modelo desde el disco. Los modelos cuantizados (nf4/gguf) siguen con el método de Forge."""
    hashes = str(list(lora_patches.keys()))
    if hashes == self.loaded_hash and not force_refresh:
        return
    # el CLIP no tiene storage_dtype: se mira si algún peso está cuantizado (nf4 / gguf)
    quantized = any(hasattr(p, "bnb_quantized") or getattr(p, "gguf_cls", None) is not None for p in self.model.parameters())
    if quantized or any(online for (_, _, _, online) in lora_patches):
        return _forge_refresh(self, lora_patches, offload_device, force_refresh)
    if getattr(self, "hx_merged", False):
        raise RuntimeError("Los LoRAs anteriores siguen en el modelo: hay que recargarlo")
    merged = {}
    for (_, _, _, _online), patches in lora_patches.items():
        for key, cur in patches.items():
            merged[key] = merged.get(key, []) + cur
    _flora.memory_management.signal_empty_cache = True
    devices = _flora.get_parameter_devices(self.model)
    for key, cur in merged.items():
        try:
            _parent, _child, weight = _futils.get_attr_with_parent(self.model, key)
        except Exception:
            raise ValueError(f"Wrong LoRA Key: {key}")
        try:
            weight = _flora.merge_lora_to_weight(cur, weight, key, computation_dtype=torch.float32)
        except Exception:
            print("Patching LoRA weights out of memory. Retrying by offloading models.")
            _flora.set_parameter_devices(self.model, parameter_devices={k: offload_device for k in devices.keys()})
            _flora.memory_management.soft_empty_cache()
            weight = _flora.merge_lora_to_weight(cur, weight, key, computation_dtype=torch.float32)
        _futils.set_attr_raw(self.model, key, torch.nn.Parameter(weight, requires_grad=False))
        getattr(self.model, "_hx_mapped", {}).pop(key, None)
        del weight
    _flora.set_parameter_devices(self.model, parameter_devices=devices)
    self.loaded_hash = hashes
    self.hx_merged = bool(merged)
    # ya están dentro de los pesos: soltar los tensores de los LoRAs (~250 MB cada uno). Las claves
    # se quedan, así que el «hash» no cambia y no se vuelven a aplicar.
    del merged
    for patches in lora_patches.values():
        patches.clear()


_flora.LoraLoader.refresh = _refresh_sin_copia


# ---------- Leer .safetensors sin copiarlos enteros a la RAM ----------
# Forge usa safetensors.load_file: el checkpoint entero (6,9 GB en SDXL) va a la RAM y, mientras se arma
# el modelo, conviven las dos copias (~13,5 GB). Aquí los tensores son vistas de un mapeo del archivo
# (copy-on-write): Windows lee las páginas al convertirlas y puede soltarlas cuando quiera.
import json as _json  # noqa: E402
import mmap as _mmap  # noqa: E402

_ST_DTYPES = {"F64": torch.float64, "F32": torch.float32, "F16": torch.float16, "BF16": torch.bfloat16,
              "I64": torch.int64, "I32": torch.int32, "I16": torch.int16, "I8": torch.int8, "U8": torch.uint8,
              "BOOL": torch.bool}
for _n, _a in (("F8_E4M3", "float8_e4m3fn"), ("F8_E5M2", "float8_e5m2")):
    if hasattr(torch, _a):
        _ST_DTYPES[_n] = getattr(torch, _a)


_MMAP = {"on": False, "ptrs": set()}  # solo durante Engine.load; ptrs = memoria de los tensores mapeados


def load_safetensors_mmap(path):
    # Solo lectura (no reserva memoria). Los pesos que Forge usa tal cual se copian en _unalias() y el
    # mapeo se cierra: dejarlos leyéndose del archivo hacía que, con poca RAM libre, Windows soltara
    # esas páginas y cada paso volviera a leerlas del disco (3 veces más lento).
    with open(path, "rb") as f:
        n = int.from_bytes(f.read(8), "little")
        header = _json.loads(f.read(n))
        mm = _mmap.mmap(f.fileno(), 0, access=_mmap.ACCESS_READ)
    base = 8 + n
    out = {}
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for k, v in header.items():
            if k == "__metadata__":
                continue
            dt = _ST_DTYPES[v["dtype"]]
            a, b = v["data_offsets"]
            shape = v["shape"]
            if b == a:
                out[k] = torch.empty(shape, dtype=dt)
                continue
            t = torch.frombuffer(mm, dtype=dt, count=(b - a) // dt.itemsize, offset=base + a)
            out[k] = t.reshape(shape)
            _MMAP["ptrs"].add(t.untyped_storage().data_ptr())
    return out


def _unalias(sd):
    """Tras cargar: el UNet y el VAE que Forge dejó apuntando al archivo mapeado se copian (el UNet se usa en
    cada paso: leerlo del disco con poca RAM era 3 veces más lento). El CLIP (codificador de texto, 1,5 GB)
    se queda leyéndose del archivo, sin copia en RAM: solo se usa unos segundos al empezar cada imagen.
    `_hx_mapped` guarda sus pesos mapeados para volver a ellos cuando Forge lo saca de la gráfica."""
    ptrs, n = _MMAP["ptrs"], 0
    fo = sd.forge_objects
    clip_root = fo.clip.cond_stage_model
    mapped = {}
    for root in (fo.unet.model, clip_root, fo.vae.first_stage_model):
        keep = root is clip_root and os.environ.get("HEXANIMA_CLIP_MAPPED", "1") != "0"
        for mname, mod in root.named_modules():
            for name, p in list(mod._parameters.items()):
                if p is not None and p.device.type == "cpu" and p.untyped_storage().data_ptr() in ptrs:
                    if keep:
                        mapped[f"{mname}.{name}" if mname else name] = p.data
                    else:
                        mod._parameters[name] = torch.nn.Parameter(p.data.clone(), requires_grad=False)
                        n += p.numel() * p.element_size()
            for name, b in list(mod._buffers.items()):
                if b is not None and b.device.type == "cpu" and b.untyped_storage().data_ptr() in ptrs:
                    mod._buffers[name] = b.clone()
                    n += b.numel() * b.element_size()
    clip_root._hx_mapped = mapped
    ptrs.clear()
    import gc; gc.collect()
    if mapped:
        print(f"[hexanima] CLIP leído del archivo: {sum(t.numel() * t.element_size() for t in mapped.values()) / 2**30:.2f} GB sin copia en RAM", flush=True)
    return n


_forge_model_unload = memory_management.LoadedModel.model_unload


def _model_unload(self, avoid_model_moving=False):
    """Al sacar el CLIP de la gráfica, Forge lo copia a la RAM: se vuelve a apuntar cada peso al archivo."""
    _forge_model_unload(self, avoid_model_moving)
    root = getattr(self.model, "model", None)
    mapped = getattr(root, "_hx_mapped", None)
    if not mapped:
        return
    params = dict(root.named_parameters())
    for name, t in mapped.items():
        p = params.get(name)
        if p is not None and p.device.type == "cpu" and p.shape == t.shape and p.dtype == t.dtype and p.data_ptr() != t.data_ptr():
            p.data = t


memory_management.LoadedModel.model_unload = _model_unload


def _unet_storage_like_file(path):
    """Tipo de dato en el que se guarda el UNet. Por defecto, el que elige Forge (bf16 en GTX): medido en
    una GTX 1650 con SDXL, fp16 fue 3 veces más lento y fp8 7 veces más lento, aunque ocupen igual o menos.
    HEXANIMA_UNET_DTYPE=fp8|fp16|bf16 lo fuerza para probar."""
    from backend.args import args as fargs
    fargs.unet_in_fp16 = fargs.unet_in_bf16 = fargs.unet_in_fp8_e4m3fn = False
    want = (os.environ.get("HEXANIMA_UNET_DTYPE") or "auto").lower()
    if want == "fp8":
        fargs.unet_in_fp8_e4m3fn = True
    elif want in ("fp16", "bf16"):
        setattr(fargs, f"unet_in_{want}", True)
    return want


_forge_load_torch_file = _futils.load_torch_file


def _load_torch_file(ckpt, safe_load=False, device=None):
    if _MMAP["on"] and isinstance(ckpt, str) and ckpt.lower().endswith(".safetensors") and (device is None or torch.device(device).type == "cpu"):
        try:
            return load_safetensors_mmap(ckpt)
        except KeyError:  # tipo de dato raro: el método de Forge
            pass
    return _forge_load_torch_file(ckpt, safe_load=safe_load, device=device)


_futils.load_torch_file = _load_torch_file
import backend.loader as _floader  # noqa: E402
_floader.load_torch_file = _load_torch_file
load_torch_file = _load_torch_file


class Prompts(list):
    """Lista de prompts con los datos que el motor SDXL lee (ancho, alto, negativo)."""
    def __init__(self, items, width, height, negative=False):
        super().__init__(items)
        self.width, self.height, self.is_negative_prompt = width, height, negative


class Engine:
    def __init__(self):
        self.sd = None
        self.path = None
        self.lora_key = None

    def load(self, path, vae=None):
        key = (path, vae)
        if self.path == key:
            return
        self.sd = None
        memory_management.unload_all_models()
        import gc; gc.collect()
        memory_management.soft_empty_cache()
        t = time.time()
        # VAE aparte (p. ej. sdxl_vae.safetensors): Forge lo carga como diccionario adicional
        self.unet_dtype = _unet_storage_like_file(path)
        _MMAP["on"] = True
        try:
            self.sd = forge_loader(path, additional_state_dicts=[vae] if vae else None)
        finally:
            _MMAP["on"] = False
        if self.sd is None:
            _MMAP["ptrs"].clear()
            raise RuntimeError("Modelo no reconocido")
        _unalias(self.sd)
        self.path = key
        self.lora_key = None
        print(f"[hexanima] modelo cargado en {time.time() - t:.1f}s: {os.path.basename(path)}{' + VAE ' + os.path.basename(vae) if vae else ''}", flush=True)

    def set_loras(self, loras):
        """loras: [(ruta, peso)]. Igual que la extensión de LoRA de Forge (parches sobre una copia)."""
        key = repr(loras)
        if key == self.lora_key:
            return
        if self.lora_key not in (None, repr([])):
            # los LoRAs anteriores están fusionados en los pesos (sin copia, ver _refresh_sin_copia):
            # se vuelve al modelo limpio desde el disco
            print("[hexanima] LoRAs cambiados: recargando el modelo limpio", flush=True)
            path, vae = self.path
            self.path = None
            self.load(path, vae)
        sd = self.sd
        unet, clip = sd.forge_objects_original.unet, sd.forge_objects_original.clip
        online = unet.model.storage_dtype not in (torch.float32, torch.float16, torch.bfloat16)
        for path, w in loras:
            lora = load_torch_file(path, safe_load=True)
            lu, rest = load_lora(lora, model_lora_keys_unet(unet.model))
            lc, rest = load_lora(rest, model_lora_keys_clip(clip.cond_stage_model))
            if len(rest) > 12:
                print(f"[hexanima] LoRA para otro tipo de modelo, se ignora: {os.path.basename(path)}", flush=True)
                continue
            if lu:
                unet = unet.clone(); unet.add_patches(filename=path, patches=lu, strength_patch=w, online_mode=online)
            if lc:
                clip = clip.clone(); clip.add_patches(filename=path, patches=lc, strength_patch=w, online_mode=online)
        sd.forge_objects.unet, sd.forge_objects.clip = unet, clip
        sd.forge_objects_after_applying_lora = sd.forge_objects.shallow_copy()
        self.lora_key = key

    def sigmas(self, steps, scheduler):
        pred = self.sd.forge_objects.unet.model.predictor
        smin, smax = float(pred.sigma_min), float(pred.sigma_max)
        if scheduler == "karras":
            return ks.get_sigmas_karras(steps, smin, smax)
        if scheduler == "exponential":
            return ks.get_sigmas_exponential(steps, smin, smax)
        # "normal"/"discrete" (Automatic de Forge con Euler a): pasos uniformes en la tabla del modelo
        t = torch.linspace(pred.timestep(torch.tensor(smax)), pred.timestep(torch.tensor(smin)), steps)
        s = torch.stack([pred.sigma(x) for x in t])
        return torch.cat([s, s.new_zeros([1])])

    def unload(self):
        self.sd = None; self.path = None; self.lora_key = None
        memory_management.unload_all_models()
        memory_management.soft_empty_cache()

    @torch.inference_mode()
    def encode(self, pixels):
        """pixels: tensor [1,3,H,W] en -1..1 -> latente del modelo (ya escalado)."""
        return self.sd.encode_first_stage(pixels).float().cpu()

    @torch.inference_mode()
    def generate2(self, prompt, negative, width, height, steps, cfg, seed, sampler="euler_a", scheduler="discrete",
                  clip_skip=2, loras=(), init_latent=None, strength=1.0, mask=None, step_cb=None, stage_cb=None, ipa=None):
        """Devuelve el tensor de imagen [1,3,H,W] en -1..1. img2img con init_latent + strength;
        zona a cambiar con mask [1,1,h/8,w/8] (1 = rehacer)."""
        if stage_cb: stage_cb("conditioning")
        self.set_loras(list(loras))
        sd = self.sd  # después de set_loras: puede haber recargado el modelo
        sd.set_clip_skip(clip_skip)
        cond = sd.get_learned_conditioning(Prompts([prompt], width, height))
        uncond = sd.get_learned_conditioning(Prompts([negative], width, height, negative=True))

        unet = sd.forge_objects.unet
        if ipa:  # personaje de referencia: {"adapter": state dict, "embeds": tensor, "weight", "start", "end"}
            unet = apply_ipadapter(unet, ipa["adapter"], ipa["embeds"], ipa.get("weight", 0.7), ipa.get("start", 0.0), ipa.get("end", 1.0))
        g = torch.Generator(device="cpu").manual_seed(int(seed))
        noise = torch.randn([1, 4, height // 8, width // 8], generator=g, dtype=torch.float32)
        sigmas = self.sigmas(steps, scheduler)
        if init_latent is not None and strength < 1.0:
            start = max(0, min(steps - 1, steps - int(round(steps * strength))))
            sigmas = sigmas[start:]
        if stage_cb: stage_cb("sampling")
        sampling_prepare(unet, noise)
        dev = unet.current_device if hasattr(unet, "current_device") else memory_management.get_torch_device()
        sigmas = sigmas.to(dev)
        if init_latent is not None:
            lat0 = init_latent.to(dev)
            x = lat0 + noise.to(dev) * sigmas[0]
        else:
            lat0 = None
            x = noise.to(dev) * sigmas[0]
        m = mask.to(dev) if (mask is not None and lat0 is not None) else None
        c, u = compile_conditions(cond), compile_conditions(uncond)
        model = unet.model

        class Denoiser:  # los samplers de Forge miran denoiser.inner_model.predictor
            inner_model = model
            def __call__(self, xx, sigma, **_):
                d = sampling_function_inner(model, xx, sigma, u, c, cfg, unet.model_options, seed)
                if m is not None:  # fuera de la zona pintada se mantiene la foto
                    d = d * m + lat0 * (1 - m)
                return d

        n = len(sigmas) - 1
        def cb(d):
            if step_cb: step_cb(d["i"] + 1, n, d.get("denoised"))
        names = {"euler_a": "sample_euler_ancestral", "euler": "sample_euler", "dpm++2m": "sample_dpmpp_2m",
                 "dpm++2s_a": "sample_dpmpp_2s_ancestral", "dpm++2m_sde": "sample_dpmpp_2m_sde", "heun": "sample_heun",
                 "dpm2": "sample_dpm_2", "lms": "sample_lms", "lcm": "sample_lcm"}
        fn = getattr(ks, names.get(sampler, ""), None) or ks.sample_euler_ancestral
        kw = {}
        if sampler in ("euler_a", "dpm++2s_a", "dpm++2m_sde"):
            kw["noise_sampler"] = lambda s, sn: torch.randn(x.shape, generator=g, dtype=torch.float32).to(dev)
        try:
            samples = fn(Denoiser(), x, sigmas, callback=cb, disable=True, **kw)
        finally:
            sampling_cleanup(unet)
        if m is not None:
            samples = samples * m + lat0 * (1 - m)
        if stage_cb: stage_cb("vae_decode")
        return sd.decode_first_stage(samples.to(torch.float32)).float().cpu()

    def generate(self, prompt, negative, width, height, steps, cfg, seed, sampler="euler_a", scheduler="discrete",
                 clip_skip=2, loras=(), progress=None):
        t0 = time.time(); last = [t0]
        def cb(i, n, _):
            now = time.time()
            if progress: progress(i, n, now - last[0])
            last[0] = now
        img = self.generate2(prompt, negative, width, height, steps, cfg, seed, sampler, scheduler, clip_skip, loras, step_cb=cb)
        arr = ((img[0].clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).numpy()
        tot = time.time() - t0
        return arr, dict(cond=0.0, sampling=tot, decode=0.0, per_step=tot / max(1, steps))


if __name__ == "__main__":
    import argparse
    from PIL import Image
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--lora", action="append", default=[], help="ruta:peso")
    ap.add_argument("--prompt", default="1girl, solo, masterpiece, best quality")
    ap.add_argument("--neg", default="worst quality, low quality")
    ap.add_argument("--w", type=int, default=832); ap.add_argument("--h", type=int, default=1216)
    ap.add_argument("--steps", type=int, default=25); ap.add_argument("--cfg", type=float, default=5)
    ap.add_argument("--seed", type=int, default=1); ap.add_argument("--out", default="out.png")
    ap.add_argument("--inference-mb", type=int, default=1024)
    a = ap.parse_args(_ARGV[1:])
    setup_memory(a.inference_mb)
    e = Engine()
    e.load(a.model)
    loras = [(s.rsplit(":", 1)[0], float(s.rsplit(":", 1)[1])) for s in a.lora]
    t = time.time()
    img, st = e.generate(a.prompt, a.neg, a.w, a.h, a.steps, a.cfg, a.seed, loras=loras,
                         progress=lambda i, n, dt: print(f"[hexanima] paso {i}/{n} · {dt:.2f}s", flush=True))
    Image.fromarray(img).save(a.out)
    print(f"[hexanima] listo en {time.time() - t:.1f}s · prompt {st['cond']:.1f}s · muestreo {st['sampling']:.1f}s ({st['per_step']:.2f} s/paso) · VAE {st['decode']:.1f}s", flush=True)



# ---------- Personaje de referencia: IP-Adapter (Forge / cubiq, GPL-3.0) ----------
@torch.inference_mode()
def encode_reference(pil, clip_vision_path):
    """image_embeds de CLIP ViT (bigG o H) de una imagen, para el IP-Adapter. Se calcula una vez por imagen:
    el codificador (3,7 GB) se lee del archivo sin copiarlo (assign=True), va a la gráfica en fp16 por
    partes si no cabe, y se libera al terminar. Devuelve un tensor [1, 1280] (o [1, 1024]) en CPU."""
    import gc
    import numpy as np
    from backend.patcher import clipvision as cv
    memory_management.unload_all_models()
    _MMAP["on"] = True
    try:
        sd = _load_torch_file(clip_vision_path)
    finally:
        _MMAP["on"] = False
    if "visual.transformer.resblocks.0.attn.in_proj_weight" in sd:
        sd = cv.convert_to_transformers(sd, "visual.")
    cfg = cv.CLIP_VISION_G if "vision_model.encoder.layers.47.layer_norm1.weight" in sd else cv.CLIP_VISION_H
    real = memory_management.should_use_fp16
    memory_management.should_use_fp16 = lambda *a, **k: True   # fp16 aunque la GTX no lo use para el UNet
    try:
        clip = cv.ClipVisionModel(cfg)
    finally:
        memory_management.should_use_fp16 = real
    clip.model.load_state_dict({k: v.to(torch.float16) if v.is_floating_point() else v for k, v in sd.items()}, strict=False, assign=True)
    _MMAP["ptrs"].clear()
    del sd
    try:
        # capa a capa: cada una va a la gráfica (~75 MB en bigG), calcula y se suelta; la copia leída del
        # archivo no se toca (functional_call usa tensores temporales en la gráfica)
        from torch.func import functional_call
        gpu = memory_management.get_torch_device()
        def run(mod, *args):
            ps = {k: v.to(gpu, non_blocking=True) for k, v in list(mod.named_parameters()) + list(mod.named_buffers())}
            return functional_call(mod, ps, args)
        m = clip.model
        vm = m.vision_model
        img = torch.from_numpy(np.asarray(pil.convert("RGB")).astype(np.float32) / 255.0)[None]
        px = cv.clip_preprocess(img.to(gpu)).to(torch.float16)
        x = run(vm.embeddings, px)
        x = run(vm.pre_layrnorm, x)
        for layer in vm.encoder.layers:
            x = run(layer, x, None, None)[0]
        pooled = run(vm.post_layernorm, x[:, 0, :])
        out = run(m.visual_projection, pooled).float().cpu()
    finally:
        memory_management.unload_all_models()
        del clip
        gc.collect()
        memory_management.soft_empty_cache()
    return out


def load_ipadapter(path):
    """Separa el archivo en image_proj / ip_adapter (algunos traen las dos copias de nombres)."""
    sd = _forge_load_torch_file(path, safe_load=True)
    out = {"image_proj": {}, "ip_adapter": {}}
    for k, v in sd.items():
        head, _, rest = k.partition(".")
        if head in ("image_proj", "ip_adapter"):
            out[head][rest] = v
    if not out["image_proj"]:  # formato con image_proj_model / adapter_modules
        for k, v in sd.items():
            head, _, rest = k.partition(".")
            if head == "image_proj_model": out["image_proj"][rest] = v
            elif head == "adapter_modules": out["ip_adapter"][rest] = v
    return out


class _CachedKV(torch.nn.Module):
    """Las k/v del IP-Adapter salen siempre de los mismos 4 tokens de la imagen: se calculan una vez (en CPU)
    y solo esos resultados van a la gráfica; los pesos del adaptador no ocupan VRAM."""
    def __init__(self, linear, inputs, device):
        super().__init__()
        self.cache = [(x, torch.nn.functional.linear(x, linear.weight.to(x.dtype)).to(device)) for x in inputs]

    def forward(self, x):
        for ref, out in self.cache:
            if x.data_ptr() == ref.data_ptr() and x.shape == ref.shape:
                return out
        raise RuntimeError("IP-Adapter: entrada inesperada")


def apply_ipadapter(unet, adapter_sd, embeds, weight=0.7, start=0.0, end=1.0):
    """Devuelve una copia del UNet con el IP-Adapter aplicado (el original no cambia). Se prepara en CPU
    en fp16 (sin ocupar VRAM) y solo las k/v ya calculadas pasan a la gráfica."""
    from lib_ipadapter.IPAdapterPlus import IPAdapterApply
    gpu = memory_management.get_torch_device()
    real_dev, real_fp16 = memory_management.get_torch_device, memory_management.should_use_fp16
    memory_management.get_torch_device = lambda *a, **k: torch.device("cpu")
    memory_management.should_use_fp16 = lambda *a, **k: True
    try:
        op = IPAdapterApply()
        e = embeds.float()
        work, = op.apply_ipadapter(adapter_sd, unet, weight, embeds=torch.stack([e, torch.zeros_like(e)]),
                                   weight_type="original", start_at=start, end_at=end)
    finally:
        memory_management.get_torch_device, memory_management.should_use_fp16 = real_dev, real_fp16
    for patch in work.model_options["transformer_options"]["patches_replace"]["attn2"].values():
        for i, a in enumerate(patch.ipadapters):
            for key in (patch.k_key, patch.v_key):
                lin = a.ip_layers.to_kvs[key]
                if not isinstance(lin, _CachedKV):
                    a.ip_layers.to_kvs[key] = _CachedKV(lin, [patch.conds[i], patch.unconds[i]], gpu)
    return work
