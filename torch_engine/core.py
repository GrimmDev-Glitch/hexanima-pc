# HexAnima PC · motor PyTorch: carga del modelo, generación, vista previa, ADetailer y ampliadores (AGPL-3.0).
# Se importa en segundo plano desde server.py (torch + backend de Forge tardan varios segundos).
import os
import time
import traceback

from common import *  # noqa: F401,F403
from common import ARGS, STATUS, JOBS, QUEUE, LOCK, RUN, HERE, log, now_ms, decode_image, png_b64, safe_join, upscalers

import hexanima_torch as ht  # carga torch y el backend de Forge
import torch
import numpy as np
from PIL import Image

ht.setup_memory(ARGS.inference_mb)
ENGINE = ht.Engine()


def to_tensor(img, w, h):
    img = img.convert("RGB").resize((w, h), Image.LANCZOS)
    a = torch.from_numpy(np.asarray(img).astype(np.float32) / 127.5 - 1.0).permute(2, 0, 1).unsqueeze(0)
    return a


def to_pil(t):
    return Image.fromarray(((t[0].float().clamp(-1, 1) + 1) * 127.5).round().byte().permute(1, 2, 0).cpu().numpy())


# Vista previa durante la generación:
#  · TAESD-XL (models/vae_approx/taesdxl_decoder.pth, 5 MB, se descarga desde Ajustes): casi como la final.
#  · si no, el «Approx NN» de Forge/WebUI (vaeapprox-sdxl.pt, incluido): 2× la resolución del latente.
import torch.nn as nn  # noqa: E402


class VAEApprox(nn.Module):  # de stable-diffusion-webui (AGPL-3.0), modules/sd_vae_approx.py
    def __init__(self):
        super().__init__()
        ch = [4, 8, 16, 32, 64, 32, 16, 8, 3]; k = [7, 5, 3, 3, 3, 3, 3, 3]
        for n in range(8):
            setattr(self, f"conv{n + 1}", nn.Conv2d(ch[n], ch[n + 1], (k[n], k[n])))

    def forward(self, x):
        x = nn.functional.interpolate(x, (x.shape[2] * 2, x.shape[3] * 2))
        x = nn.functional.pad(x, (11, 11, 11, 11))
        for n in range(8):
            x = nn.functional.leaky_relu(getattr(self, f"conv{n + 1}")(x), 0.1)
        return x


def _tconv(i, o, **k): return nn.Conv2d(i, o, 3, padding=1, **k)


class _Clamp(nn.Module):
    def forward(self, x): return torch.tanh(x / 3) * 3


class _Block(nn.Module):
    def __init__(self, i, o):
        super().__init__()
        self.conv = nn.Sequential(_tconv(i, o), nn.ReLU(), _tconv(o, o), nn.ReLU(), _tconv(o, o))
        self.skip = nn.Conv2d(i, o, 1, bias=False) if i != o else nn.Identity()
        self.fuse = nn.ReLU()

    def forward(self, x): return self.fuse(self.conv(x) + self.skip(x))


def taesd_decoder():  # https://github.com/madebyollin/taesd (MIT)
    B = _Block
    return nn.Sequential(_Clamp(), _tconv(4, 64), nn.ReLU(), B(64, 64), B(64, 64), B(64, 64), nn.Upsample(scale_factor=2), _tconv(64, 64, bias=False),
                         B(64, 64), B(64, 64), B(64, 64), nn.Upsample(scale_factor=2), _tconv(64, 64, bias=False),
                         B(64, 64), B(64, 64), B(64, 64), nn.Upsample(scale_factor=2), _tconv(64, 64, bias=False), B(64, 64), _tconv(64, 3))


_PREV = {"kind": None, "model": None}


def previewer():
    taesd = os.path.join(ARGS.model_dir, "vae_approx", "taesdxl_decoder.pth")
    kind = "taesd" if os.path.isfile(taesd) else "approx"
    if _PREV["kind"] != kind:
        if kind == "taesd":
            m = taesd_decoder(); m.load_state_dict(torch.load(taesd, map_location="cpu"))
        else:
            m = VAEApprox(); m.load_state_dict(torch.load(os.path.join(HERE, "vaeapprox-sdxl.pt"), map_location="cpu"))
        _PREV.update(kind=kind, model=m.eval())
    return _PREV["kind"], _PREV["model"]


@torch.inference_mode()
def preview_b64(latent):
    kind, m = previewer()
    x = latent[:1].float().cpu()
    if kind == "taesd":
        y = m(x).clamp(0, 1)[0]                      # 0..1, tamaño final
    else:
        y = ((m(x).clamp(-1, 1) + 1) / 2)[0]          # -1..1 -> 0..1, 2× el latente
    img = Image.fromarray((y.permute(1, 2, 0).numpy() * 255).round().astype(np.uint8))
    if kind != "taesd":                               # que se vea suave al llenar el lienzo
        img = img.resize((img.width * 2, img.height * 2), Image.BICUBIC)
    return png_b64(img)



def load_model(body):
    recipe = body.get("recipe")
    models = body.get("models") or {}
    if recipe != "sdxl-checkpoint" or "model" not in models:
        raise ValueError("Este motor solo carga checkpoints SDXL / Illustrious / Pony")
    path = safe_join(ARGS.model_dir, models["model"])
    vae = safe_join(ARGS.model_dir, models["vae"]) if models.get("vae") else None
    with LOCK:
        STATUS.update(state="loading", recipe=recipe, models=models, error=None)
    t = time.time()
    try:
        with RUN:
            ENGINE.load(path, vae)
        with LOCK:
            STATUS.update(state="ready", load_elapsed_seconds=time.time() - t, revision=STATUS["revision"] + 1)
    except Exception as e:
        with LOCK:
            STATUS.update(state="error", error=str(e), load_elapsed_seconds=time.time() - t)
        raise
    return dict(STATUS)


# ---------- generación ----------
class Cancelled(Exception):
    pass


def run_img_gen(job, body):
    sp = body.get("sample_params") or {}
    steps = int(sp.get("sample_steps") or 20)
    cfg = float((sp.get("guidance") or {}).get("txt_cfg") or 5)
    sampler = sp.get("sample_method") or "euler_a"
    scheduler = sp.get("scheduler") or "discrete"
    w, h = int(body.get("width") or 832), int(body.get("height") or 1216)
    seed = int(body.get("seed") if body.get("seed") is not None else -1)
    if seed < 0:
        seed = int(time.time() * 1000) % (2 ** 31)
    clip_skip = int(body.get("clip_skip") or -1)
    clip_skip = 2 if clip_skip < 1 else clip_skip
    loras = [(safe_join(ARGS.lora_model_dir, l["path"]), float(l.get("multiplier", 1.0))) for l in body.get("lora") or []]
    want_preview = bool(body.get("preview"))
    t0 = time.time()

    def prog(stage, done=None, total=None):
        if job.get("cancel"):
            raise Cancelled()
        job["progress"] = {"stage": stage, "detail": "", "completed": done, "total": total,
                           "unit": "steps" if total else None, "elapsed_ms": int((time.time() - t0) * 1000)}

    init = mask = None
    if body.get("init_image"):
        init = decode_image(body["init_image"])
    if body.get("mask_image"):
        mask = decode_image(body["mask_image"]).convert("L")

    def pass_(pw, ph, steps_, strength, init_latent, init_pixels, label_total):
        def cb(i, n, latent):
            prog("sampling", i, n)
            if want_preview and latent is not None and i % max(1, int(body.get("preview_interval") or 1)) == 0:
                try: job["preview"] = {"b64_json": preview_b64(latent)}
                except Exception: pass
        return ENGINE.generate2(body.get("prompt", ""), body.get("negative_prompt", ""), pw, ph, steps_, cfg, seed,
                                sampler=sampler, scheduler=scheduler, clip_skip=clip_skip, loras=loras,
                                init_latent=init_latent, strength=strength, mask=mask_lat(mask, pw, ph) if mask is not None else None,
                                step_cb=cb, stage_cb=lambda s: prog(s), ipa=ipa, cnet=cnet)

    def mask_lat(m, pw, ph):
        a = np.asarray(m.resize((pw // 8, ph // 8), Image.BILINEAR)).astype(np.float32) / 255.0
        return torch.from_numpy(a)[None, None]

    # personaje de referencia: se prepara aquí (la primera vez con cada imagen tarda unos segundos)
    ipa = ipa_for(body, prog)
    # 🧍 Pose: ControlNet OpenPose con el esqueleto (también en el segundo paso del Hires fix)
    cnet = cnet_for(body, prog)
    prog("conditioning")
    init_latent = None
    strength = 1.0
    if init is not None:
        prog("vae_encode")
        init_latent = ENGINE.encode(to_tensor(init, w, h))
        strength = float(body.get("strength") or 0.75)
    img = pass_(w, h, steps, strength, init_latent, init, steps)

    # Hires fix: ampliar y segundo paso con denoise
    hr = body.get("hires") or {}
    if hr.get("enabled"):
        tw, th = int(hr.get("target_width") or w * 1.5) // 8 * 8, int(hr.get("target_height") or h * 1.5) // 8 * 8
        up = (hr.get("upscaler") or "Latent")
        prog("upscaling")
        pil = to_pil(img)
        if up.lower().startswith("latent") or up.lower() == "lanczos":
            big = pil.resize((tw, th), Image.LANCZOS)
        else:
            big = upscale_model(pil, up).resize((tw, th), Image.LANCZOS)
        mask = None
        lat = ENGINE.encode(to_tensor(big, tw, th))
        hsteps = int(hr.get("steps") or 0) or steps
        img = pass_(tw, th, hsteps, float(hr.get("denoising_strength") or 0.45), lat, big, hsteps)
        w, h = tw, th

    out = to_pil(img)
    # ADetailer: busca caras / manos y redibuja cada una (recorte ampliado, como el ADetailer de WebUI)
    ad = body.get("adetailer") or {}
    if ad.get("model") in ("face", "hand"):
        prog("adetailer")
        out = adetail(out, ad, body, w=out.width, h=out.height, steps=steps, cfg=cfg, seed=seed, sampler=sampler,
                      scheduler=scheduler, clip_skip=clip_skip, loras=loras, prog=prog, ipa=ipa)
    if init is not None and body.get("mask_image"):
        # pegar solo la zona pintada: el resto queda idéntico a la foto
        m = decode_image(body["mask_image"]).convert("L").resize(out.size, Image.BILINEAR)
        out = Image.composite(out, init.convert("RGB").resize(out.size, Image.LANCZOS), m)
    prog("encoding")
    return {"images": [{"b64_json": png_b64(out), "width": out.width, "height": out.height, "seed": seed}]}


# ---------- ADetailer ----------
_DET = {}


def detector(kind):
    path = os.path.join(ARGS.model_dir, "detectors", f"{kind}_yolov8n.safetensors")
    if not os.path.isfile(path):
        raise ValueError(f"Falta el detector de {'caras' if kind == 'face' else 'manos'} (se descarga al elegirlo en ADetailer)")
    if kind not in _DET:
        from detector import YOLOv8
        _DET[kind] = YOLOv8(path)
    return _DET[kind]


def adetail(pil, ad, body, w, h, steps, cfg, seed, sampler, scheduler, clip_skip, loras, prog, ipa=None):
    from PIL import ImageDraw, ImageFilter
    det = detector(ad["model"])
    boxes = det.detect(pil, float(ad.get("confidence") or 0.3))
    boxes.sort(key=lambda b: b[0])
    log(f"ADetailer: {len(boxes)} {'caras' if ad['model'] == 'face' else 'manos'}")
    strength = float(ad.get("strength") or 0.4)
    prompt = (ad.get("prompt") or "").replace("[PROMPT]", body.get("prompt", "")) or body.get("prompt", "")
    neg = body.get("negative_prompt", "")
    W, H = pil.size
    T = 768  # lado largo del recorte que se redibuja: más detalle en caras pequeñas
    for i, (x1, y1, x2, y2, _c) in enumerate(boxes[:8]):
        prog("adetailer", i, len(boxes[:8]))
        bw, bh = x2 - x1, y2 - y1
        pad = max(32, 0.25 * max(bw, bh))
        cx1, cy1, cx2, cy2 = max(0, x1 - pad), max(0, y1 - pad), min(W, x2 + pad), min(H, y2 + pad)
        cw, ch = cx2 - cx1, cy2 - cy1
        k = T / max(cw, ch)
        tw, th = max(64, int(round(cw * k / 8)) * 8), max(64, int(round(ch * k / 8)) * 8)
        crop = pil.crop((int(cx1), int(cy1), int(cx2), int(cy2)))
        m = Image.new("L", crop.size, 0)
        ImageDraw.Draw(m).rectangle([x1 - cx1 - 4, y1 - cy1 - 4, x2 - cx1 + 4, y2 - cy1 + 4], fill=255)
        m = m.filter(ImageFilter.GaussianBlur(4))
        lat = ENGINE.encode(to_tensor(crop, tw, th))
        mk = torch.from_numpy(np.asarray(m.resize((tw // 8, th // 8), Image.BILINEAR)).astype(np.float32) / 255.0)[None, None]
        res = ENGINE.generate2(prompt, neg, tw, th, steps, cfg, seed + i + 1, sampler=sampler, scheduler=scheduler,
                               clip_skip=clip_skip, loras=loras, init_latent=lat, strength=strength, mask=mk, ipa=ipa)
        piece = to_pil(res).resize(crop.size, Image.LANCZOS)
        pil.paste(piece, (int(cx1), int(cy1)), m)
    return pil


# ---------- ampliadores (Real-ESRGAN / UltraSharp con spandrel, por trozos) ----------
_UP = {}

def upscale_model(pil, name, tile=256, overlap=16):
    import spandrel
    hit = next((u for u in upscalers() if u["name"] == name), None)
    if not hit:
        raise ValueError(f"Ampliador no encontrado: {name}")
    if name not in _UP:
        _UP.clear()
        _UP[name] = spandrel.ModelLoader().load_from_file(hit["model_path"]).eval()
    model = _UP[name]
    dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model.to(dev)
    s = model.scale
    x = torch.from_numpy(np.asarray(pil.convert("RGB")).astype(np.float32) / 255.0).permute(2, 0, 1)[None]
    _, _, H, W = x.shape
    out = torch.zeros((1, 3, H * s, W * s))
    with torch.inference_mode():
        for y0 in range(0, H, tile):
            for x0 in range(0, W, tile):
                ya, xa = max(0, y0 - overlap), max(0, x0 - overlap)
                yb, xb = min(H, y0 + tile + overlap), min(W, x0 + tile + overlap)
                r = model(x[:, :, ya:yb, xa:xb].to(dev)).float().cpu()
                oy, ox = (y0 - ya) * s, (x0 - xa) * s
                th_, tw_ = (min(H, y0 + tile) - y0) * s, (min(W, x0 + tile) - x0) * s
                out[:, :, y0 * s:y0 * s + th_, x0 * s:x0 * s + tw_] = r[:, :, oy:oy + th_, ox:ox + tw_]
    model.to("cpu")
    torch.cuda.empty_cache()
    return Image.fromarray((out[0].clamp(0, 1) * 255).round().byte().permute(1, 2, 0).numpy())


def worker():
    while True:
        jid, body = QUEUE.get()
        job = JOBS[jid]
        if job.get("cancel"):
            job.update(status="cancelled", completed=now_ms()); continue
        job.update(status="running", started=now_ms())
        try:
            if STATUS["state"] != "ready":
                raise RuntimeError("No hay modelo cargado")
            with RUN:
                job["result"] = run_img_gen(job, body)
            job.update(status="completed", completed=now_ms())
        except Cancelled:
            job.update(status="cancelled", completed=now_ms(), error={"message": "cancelado"})
        except Exception as e:
            traceback.print_exc()
            job.update(status="failed", completed=now_ms(), error={"message": str(e)})
        finally:
            pass
            torch.cuda.empty_cache()


# ---------- Leer rasgos (WD Tagger) y personaje de referencia (IP-Adapter) ----------
_TAG = {}
_IPA = {"path": None, "sd": None}
_EMB = {}
REF_FILES = {
    "tagger": ("tagger", "wd-vit-tagger-v3.safetensors"),
    "tagger_tags": ("tagger", "wd-vit-tagger-v3.csv"),
    "ipadapter": ("ipadapter", "noobIPAMARK1_mark1.safetensors"),
    "clip_vision": ("clip_vision", "clip_vision_g.safetensors"),
    "pose": ("pose", "body_pose_model.pth"),
    "openpose": ("controlnet", "controlnet-openpose-sdxl-xinsir.safetensors"),
}


def ref_path(kind):
    d, f = REF_FILES[kind]
    return os.path.join(ARGS.model_dir, d, f)


def ref_status():
    return {k: os.path.isfile(ref_path(k)) for k in REF_FILES}


def tagger():
    if "m" not in _TAG:
        if not (os.path.isfile(ref_path("tagger")) and os.path.isfile(ref_path("tagger_tags"))):
            raise ValueError("Falta el lector de rasgos (WD Tagger): se descarga desde «Personaje de referencia»")
        from tagger import WDTagger
        _TAG["m"] = WDTagger(ref_path("tagger"), ref_path("tagger_tags"))
    return _TAG["m"]


def ipa_embeds(data_url, prog=None):
    """Embedding de CLIP de la imagen de referencia, con caché en memoria y en cache/ipa (un archivo pequeño)."""
    import hashlib
    raw = data_url.split(",", 1)[1] if "," in data_url else data_url
    key = hashlib.sha1(raw.encode()).hexdigest()[:20]
    if key in _EMB:
        return _EMB[key]
    cdir = os.path.join(os.path.dirname(os.path.abspath(ARGS.model_dir)), "cache", "ipa")
    cpath = os.path.join(cdir, key + ".pt")
    if os.path.isfile(cpath):
        _EMB[key] = torch.load(cpath, map_location="cpu", weights_only=True)
        return _EMB[key]
    if not os.path.isfile(ref_path("clip_vision")):
        raise ValueError("Falta el codificador de imágenes (CLIP ViT-bigG): se descarga desde «Personaje de referencia»")
    if prog: prog("reference")
    t = time.time()
    e = ht.encode_reference(decode_image(data_url), ref_path("clip_vision"))
    log(f"referencia codificada en {time.time() - t:.1f} s")
    os.makedirs(cdir, exist_ok=True)
    torch.save(e, cpath)
    _EMB[key] = e
    return e


def ipa_for(body, prog=None):
    spec = body.get("ip_adapter") or {}
    if not spec.get("image"):
        return None
    if not os.path.isfile(ref_path("ipadapter")):
        raise ValueError("Falta el IP-Adapter: se descarga desde «Personaje de referencia»")
    emb = ipa_embeds(spec["image"], prog)
    if _IPA["path"] != ref_path("ipadapter"):
        _IPA.update(path=ref_path("ipadapter"), sd=ht.load_ipadapter(ref_path("ipadapter")))
    return {"adapter": _IPA["sd"], "embeds": emb, "weight": float(spec.get("weight", 0.7)),
            "start": float(spec.get("start", 0.0)), "end": float(spec.get("end", 1.0))}



# ---------- 🧍 Pose: detector OpenPose y ControlNet ----------
_POSE = {}
_CNET = {"path": None, "model": None}


def pose_detect(img):
    """Esqueleto de colores (PIL) y número de personas."""
    if not os.path.isfile(ref_path("pose")):
        raise ValueError("Falta el detector de pose: se descarga desde la caja «🧍 Pose»")
    if "m" not in _POSE:
        from pose import OpenPose
        _POSE["m"] = OpenPose(ref_path("pose"))
    return _POSE["m"](img)


def cnet_for(body, prog=None):
    if not body.get("control_image"):
        return None
    path = ref_path("openpose")
    if not os.path.isfile(path):
        raise ValueError("Falta el ControlNet de pose: se descarga desde la caja «🧍 Pose»")
    if _CNET["path"] != path:
        if prog: prog("loading_control")
        t = time.time()
        _CNET.update(path=path, model=ht.load_controlnet(path))
        log(f"ControlNet cargado en {time.time() - t:.1f} s")
    return {"model": _CNET["model"], "hint": decode_image(body["control_image"]),
            "strength": float(body.get("control_strength") or 1.0), "start": 0.0, "end": 1.0}



# ---------- Liberar todo (botón «Liberar modelo» y liberar al estar inactivo) ----------
def free_all():
    """Suelta el modelo y todo lo que se carga aparte (ControlNet, IP-Adapter, CLIP de visión, ampliadores,
    detectores, tagger, pose, vista previa) y fuerza la recolección: sin gc.collect() los objetos con
    referencias circulares de Forge siguen ocupando RAM. Devuelve la RAM del proceso en MB."""
    import gc
    ENGINE.unload()
    for cache in (_DET, _UP, _TAG, _EMB, _POSE):
        cache.clear()
    _IPA.update(path=None, sd=None)
    _CNET.update(path=None, model=None)
    _PREV.update(kind=None, model=None)
    for _ in range(3):
        if not gc.collect():
            break
    try:
        torch.cuda.empty_cache()
        torch.cuda.ipc_collect()
    except Exception:
        pass
    try:
        import psutil
        return int(psutil.Process().memory_info().rss / 2**20)
    except Exception:
        return None
