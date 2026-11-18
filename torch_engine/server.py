# HexAnima PC · servidor del motor PyTorch (AGPL-3.0, ver README.md).
# Habla la misma API que sd-server (stable-diffusion.cpp) para que la app no cambie:
#   /sdcpp/v1/models/status|load|unload|refresh, /sdcpp/v1/model-files, /sdcpp/v1/img_gen (trabajos),
#   /sdcpp/v1/jobs/{id}[/cancel], /sdcpp/v1/upscale, /sdapi/v1/samplers|schedulers|upscalers|loras.
# Solo escucha en 127.0.0.1: todo es local.
import argparse
import base64
import io
import json
import os
import queue
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ap = argparse.ArgumentParser()
ap.add_argument("--listen-port", type=int, default=7861)
ap.add_argument("--model-dir", required=True)
ap.add_argument("--lora-model-dir", required=True)
ap.add_argument("--hires-upscalers-dir", default=None)
ap.add_argument("--inference-mb", type=int, default=1024)
ARGS, _ = ap.parse_known_args()

import hexanima_torch as ht  # noqa: E402  (carga torch y el backend de Forge)
import torch  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

ht.setup_memory(ARGS.inference_mb)
ENGINE = ht.Engine()
STATUS = {"state": "empty", "recipe": None, "models": {}, "load_elapsed_seconds": None, "error": None, "revision": 0}
JOBS = {}
QUEUE = queue.Queue()
LOCK = threading.Lock()
RUN = threading.Lock()  # una sola carga o generación a la vez (el modelo es compartido)
CATS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "vae_approx", "upscalers", "detectors"]
SAMPLERS = ["euler_a", "euler", "dpm++2m", "dpm++2s_a", "dpm++2m_sde", "heun", "dpm2", "lms"]
SCHEDULERS = ["discrete", "karras", "exponential"]
EXTS = (".safetensors", ".ckpt", ".gguf", ".pth", ".pt", ".bin")


def log(*a):
    print("[hexanima-torch]", *a, flush=True)


def now_ms():
    return int(time.time() * 1000)


# ---------- imágenes ----------
def decode_image(data_url):
    raw = base64.b64decode(data_url.split(",", 1)[1] if "," in data_url else data_url)
    return Image.open(io.BytesIO(raw))


def png_b64(img):
    buf = io.BytesIO(); img.save(buf, format="PNG"); return base64.b64encode(buf.getvalue()).decode()


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


# ---------- modelos ----------
def model_files():
    out = []
    for cat in CATS:
        d = os.path.join(ARGS.model_dir, cat)
        if not os.path.isdir(d):
            continue
        for n in sorted(os.listdir(d)):
            if n.lower().endswith(EXTS) and os.path.isfile(os.path.join(d, n)):
                out.append({"category": cat, "id": f"{cat}/{n}", "name": n, "relative_path": f"{cat}/{n}"})
    return {"errors": [], "files": out}


def safe_join(base, rel):
    p = os.path.normpath(os.path.join(base, rel))
    if not os.path.normcase(p).startswith(os.path.normcase(os.path.normpath(base))):
        raise ValueError("ruta no permitida")
    return p


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
                                step_cb=cb, stage_cb=lambda s: prog(s))

    def mask_lat(m, pw, ph):
        a = np.asarray(m.resize((pw // 8, ph // 8), Image.BILINEAR)).astype(np.float32) / 255.0
        return torch.from_numpy(a)[None, None]

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
                      scheduler=scheduler, clip_skip=clip_skip, loras=loras, prog=prog)
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


def adetail(pil, ad, body, w, h, steps, cfg, seed, sampler, scheduler, clip_skip, loras, prog):
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
                               clip_skip=clip_skip, loras=loras, init_latent=lat, strength=strength, mask=mk)
        piece = to_pil(res).resize(crop.size, Image.LANCZOS)
        pil.paste(piece, (int(cx1), int(cy1)), m)
    return pil


# ---------- ampliadores (Real-ESRGAN / UltraSharp con spandrel, por trozos) ----------
_UP = {}


def upscalers():
    d = ARGS.hires_upscalers_dir
    out = []
    if d and os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            if n.lower().endswith((".pth", ".safetensors", ".pt")):
                out.append({"name": os.path.splitext(n)[0], "model_path": os.path.join(d, n)})
    return out


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


# ---------- HTTP ----------
class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def cors(self):
        o = self.headers.get("Origin")
        if o:
            self.send_header("Access-Control-Allow-Origin", o)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.cors()
        self.end_headers()
        self.wfile.write(b)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}") if n else {}

    def do_OPTIONS(self):
        self.send_response(204); self.cors(); self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        try:
            if p == "/sdcpp/v1/models/status":
                with LOCK: return self.send(200, dict(STATUS))
            if p == "/sdcpp/v1/model-files":
                return self.send(200, model_files())
            if p.startswith("/sdcpp/v1/jobs/"):
                j = JOBS.get(p.rsplit("/", 1)[1])
                if not j: return self.send(404, {"error": "no existe"})
                return self.send(200, {k: v for k, v in j.items() if k != "cancel"})
            if p == "/sdapi/v1/samplers":
                return self.send(200, [{"name": s} for s in SAMPLERS])
            if p == "/sdapi/v1/schedulers":
                return self.send(200, [{"name": s, "label": s} for s in SCHEDULERS])
            if p == "/sdapi/v1/upscalers":
                return self.send(200, upscalers())
            if p == "/sdapi/v1/loras":
                d = ARGS.lora_model_dir
                return self.send(200, [{"name": os.path.splitext(n)[0], "path": os.path.join(d, n)} for n in sorted(os.listdir(d)) if n.lower().endswith(EXTS)])
            return self.send(404, {"error": "no existe"})
        except Exception as e:
            return self.send(500, {"error": str(e)})

    def do_POST(self):
        p = self.path.split("?")[0]
        try:
            if p == "/sdcpp/v1/models/load":
                return self.send(200, load_model(self.body()))
            if p == "/sdcpp/v1/models/unload":
                with RUN:
                    ENGINE.unload()
                with LOCK: STATUS.update(state="empty", recipe=None, models={})
                return self.send(200, dict(STATUS))
            if p == "/sdcpp/v1/models/refresh":
                return self.send(200, {"ok": True})
            if p == "/sdcpp/v1/img_gen":
                body = self.body()
                jid = f"job_{now_ms():x}_{len(JOBS):04d}"
                JOBS[jid] = {"id": jid, "kind": "img_gen", "status": "queued", "created": now_ms(),
                             "progress": {"stage": "queued", "elapsed_ms": 0}}
                QUEUE.put((jid, body))
                return self.send(200, {"id": jid, "kind": "img_gen", "status": "queued", "poll_url": f"/sdcpp/v1/jobs/{jid}"})
            if p.startswith("/sdcpp/v1/jobs/") and p.endswith("/cancel"):
                j = JOBS.get(p.split("/")[-2])
                if j: j["cancel"] = True
                return self.send(200, {"ok": True})
            if p == "/hexanima/v1/detect":
                b = self.body()
                img = decode_image(b["image"])
                with RUN:
                    boxes = detector(b.get("kind", "face")).detect(img, float(b.get("confidence") or 0.3))
                return self.send(200, {"items": [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "confidence": c} for x1, y1, x2, y2, c in boxes],
                                       "width": img.width, "height": img.height})
            if p == "/sdcpp/v1/upscale":
                b = self.body()
                with RUN:
                    img = upscale_model(decode_image(b["image"]), b.get("upscaler"))
                return self.send(200, {"images": [{"b64_json": png_b64(img)}], "width": img.width, "height": img.height})
            return self.send(404, {"error": "no existe"})
        except Exception as e:
            traceback.print_exc()
            return self.send(422 if isinstance(e, ValueError) else 500, {"error": str(e), "message": str(e)})


if __name__ == "__main__":
    threading.Thread(target=worker, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.listen_port), H)
    log(f"listening on: http://127.0.0.1:{ARGS.listen_port}")
    srv.serve_forever()
