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
CATS = ["checkpoints", "diffusion_models", "text_encoders", "vae", "upscalers", "detectors"]
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


# Vista previa rápida del latente SDXL (aproximación lineal latente -> RGB, como "proj" de sd.cpp)
_RGB = torch.tensor([[0.3651, 0.4232, 0.4341], [-0.2533, -0.0042, 0.1068], [0.1076, 0.1111, -0.0362], [-0.3165, -0.2492, -0.2188]])
_BIAS = torch.tensor([0.1084, -0.0175, -0.0011])


def preview_b64(latent):
    x = latent[0].float().cpu().permute(1, 2, 0) @ _RGB + _BIAS
    x = ((x.clamp(-1, 1) + 1) * 127.5).byte().numpy()
    return png_b64(Image.fromarray(x))


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
    with LOCK:
        STATUS.update(state="loading", recipe=recipe, models=models, error=None)
    t = time.time()
    try:
        with RUN:
            ENGINE.load(path)
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
    if init is not None and body.get("mask_image"):
        # pegar solo la zona pintada: el resto queda idéntico a la foto
        m = decode_image(body["mask_image"]).convert("L").resize(out.size, Image.BILINEAR)
        out = Image.composite(out, init.convert("RGB").resize(out.size, Image.LANCZOS), m)
    prog("encoding")
    return {"images": [{"b64_json": png_b64(out), "width": out.width, "height": out.height, "seed": seed}]}


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
