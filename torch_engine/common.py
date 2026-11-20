# HexAnima PC · motor PyTorch: estado compartido y utilidades ligeras (sin torch), AGPL-3.0.
import argparse
import base64
import io
import os
import queue
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

ap = argparse.ArgumentParser()
ap.add_argument("--listen-port", type=int, default=7861)
ap.add_argument("--model-dir", required=True)
ap.add_argument("--lora-model-dir", required=True)
ap.add_argument("--hires-upscalers-dir", default=None)
ap.add_argument("--inference-mb", type=int, default=1024)
ARGS, _ = ap.parse_known_args()

STATUS = {"state": "empty", "recipe": None, "models": {}, "load_elapsed_seconds": None, "error": None, "revision": 0}
JOBS = {}
QUEUE = queue.Queue(maxsize=1)
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
    from PIL import Image
    raw = base64.b64decode(data_url.split(",", 1)[1] if "," in data_url else data_url)
    return Image.open(io.BytesIO(raw))


def png_b64(img):
    buf = io.BytesIO(); img.save(buf, format="PNG"); return base64.b64encode(buf.getvalue()).decode()


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



def upscalers():
    d = ARGS.hires_upscalers_dir
    out = []
    if d and os.path.isdir(d):
        for n in sorted(os.listdir(d)):
            if n.lower().endswith((".pth", ".safetensors", ".pt")):
                out.append({"name": os.path.splitext(n)[0], "model_path": os.path.join(d, n)})
    return out

