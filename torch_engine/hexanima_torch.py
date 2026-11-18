# HexAnima PC · motor PyTorch (prototipo).
# Usa el backend de Stable Diffusion WebUI Forge (AGPL-3.0, https://github.com/lllyasviel/stable-diffusion-webui-forge):
# carga de modelos, gestión de memoria para poca VRAM, LoRAs y atención SDP; este archivo solo hace el
# recorrido de generación (texto -> muestreo k-diffusion -> VAE) sin la interfaz web de Forge.
# Este motor se distribuye bajo AGPL-3.0 (ver LICENSE en esta carpeta).
import os
import sys
import time
import types

FORGE = os.environ.get("HEXANIMA_FORGE_ROOT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "forge"))
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

    def load(self, path):
        if self.path == path:
            return
        self.sd = None
        memory_management.unload_all_models()
        memory_management.soft_empty_cache()
        t = time.time()
        self.sd = forge_loader(path)
        if self.sd is None:
            raise RuntimeError("Modelo no reconocido")
        self.path = path
        self.lora_key = None
        print(f"[hexanima] modelo cargado en {time.time() - t:.1f}s: {os.path.basename(path)}", flush=True)

    def set_loras(self, loras):
        """loras: [(ruta, peso)]. Igual que la extensión de LoRA de Forge (parches sobre una copia)."""
        key = repr(loras)
        if key == self.lora_key:
            return
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

    @torch.inference_mode()
    def generate(self, prompt, negative, width, height, steps, cfg, seed, sampler="euler_a", scheduler="normal",
                 clip_skip=2, loras=(), progress=None):
        sd = self.sd
        self.set_loras(list(loras))
        sd.set_clip_skip(clip_skip)
        t0 = time.time()
        cond = sd.get_learned_conditioning(Prompts([prompt], width, height))
        uncond = sd.get_learned_conditioning(Prompts([negative], width, height, negative=True))
        t_cond = time.time() - t0

        unet = sd.forge_objects.unet
        g = torch.Generator(device="cpu").manual_seed(int(seed))
        x = torch.randn([1, 4, height // 8, width // 8], generator=g, dtype=torch.float32)
        sigmas = self.sigmas(steps, scheduler)
        sampling_prepare(unet, x)
        dev = unet.current_device if hasattr(unet, "current_device") else memory_management.get_torch_device()
        x = x.to(dev) * sigmas[0]
        sigmas = sigmas.to(dev)
        c, u = compile_conditions(cond), compile_conditions(uncond)
        model = unet.model

        class Denoiser:  # los samplers de Forge miran denoiser.inner_model.predictor
            inner_model = model
            def __call__(self, xx, sigma, **_):
                return sampling_function_inner(model, xx, sigma, u, c, cfg, unet.model_options, seed)
        denoiser = Denoiser()

        ts = time.time(); last = [ts]
        def cb(d):
            now = time.time()
            if progress: progress(d["i"] + 1, steps, now - last[0])
            last[0] = now
        names = {"euler_a": "sample_euler_ancestral", "euler": "sample_euler", "dpm++2m": "sample_dpmpp_2m",
                 "dpm++2s_a": "sample_dpmpp_2s_ancestral", "lcm": "sample_lcm"}
        fn = getattr(ks, names.get(sampler, ""), None) or ks.sample_euler_ancestral
        ns = None
        if sampler in ("euler_a", "dpm++2s_a"):
            ns = lambda s, sn: torch.randn(x.shape, generator=g, dtype=torch.float32).to(dev)
        samples = fn(denoiser, x, sigmas, callback=cb, disable=True, **({"noise_sampler": ns} if ns else {}))
        sampling_cleanup(unet)
        t_samp = time.time() - ts

        td = time.time()
        img = sd.decode_first_stage(samples.to(torch.float32))
        t_dec = time.time() - td
        img = ((img[0].float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy()
        return img, dict(cond=t_cond, sampling=t_samp, decode=t_dec, per_step=t_samp / max(1, steps))


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
