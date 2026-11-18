# HexAnima PC · servidor del motor PyTorch (AGPL-3.0, ver README.md).
# Habla la misma API que sd-server (stable-diffusion.cpp) para que la app no cambie:
#   /sdcpp/v1/models/status|load|unload|refresh, /sdcpp/v1/model-files, /sdcpp/v1/img_gen (trabajos),
#   /sdcpp/v1/jobs/{id}[/cancel], /sdcpp/v1/upscale, /sdapi/v1/samplers|schedulers|upscalers|loras.
# Solo escucha en 127.0.0.1: todo es local.
# Escucha enseguida: la app ve los modelos, VAEs y LoRAs mientras PyTorch se carga en segundo plano
# (core.py); lo que necesita el motor espera a que termine.
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import ARGS, STATUS, JOBS, QUEUE, LOCK, RUN, EXTS, SAMPLERS, SCHEDULERS, log, now_ms, decode_image, png_b64, model_files, upscalers  # noqa: E402

READY = threading.Event()
BOOT = {"error": None, "seconds": None}
core = None


def boot():
    global core
    t = time.time()
    try:
        import core as c
        core = c
        BOOT["seconds"] = round(time.time() - t, 1)
        threading.Thread(target=c.worker, daemon=True).start()
        log(f"PyTorch listo en {BOOT['seconds']} s")
    except Exception as e:
        traceback.print_exc()
        BOOT["error"] = f"No se pudo iniciar PyTorch: {e}"
    finally:
        with LOCK:
            STATUS["booting"] = False
        READY.set()


def need_core():
    READY.wait()
    if BOOT["error"]:
        raise RuntimeError(BOOT["error"])
    return core


STATUS["booting"] = True


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
            if p == "/hexanima/v1/reference/status":
                return self.send(200, need_core().ref_status())
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
                return self.send(200, need_core().load_model(self.body()))
            if p == "/sdcpp/v1/models/unload":
                c = need_core()
                with RUN:
                    c.ENGINE.unload()
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
                c = need_core()
                with RUN:
                    boxes = c.detector(b.get("kind", "face")).detect(img, float(b.get("confidence") or 0.3))
                return self.send(200, {"items": [{"x1": x1, "y1": y1, "x2": x2, "y2": y2, "confidence": c} for x1, y1, x2, y2, c in boxes],
                                       "width": img.width, "height": img.height})
            if p == "/hexanima/v1/tag":
                b = self.body()
                img = decode_image(b["image"])
                c = need_core()
                t = time.time()
                tags = c.tagger().tag(img, float(b.get("general") or 0.35), float(b.get("character") or 0.85))
                return self.send(200, {"tags": [{"name": n, "score": round(sc, 3), "category": cat} for n, sc, cat in tags],
                                       "seconds": round(time.time() - t, 2)})
            if p == "/hexanima/v1/reference/encode":
                b = self.body()
                c = need_core()
                t = time.time()
                with RUN:
                    c.ipa_embeds(b["image"])
                return self.send(200, {"ok": True, "seconds": round(time.time() - t, 1)})
            if p == "/sdcpp/v1/upscale":
                b = self.body()
                c = need_core()
                with RUN:
                    img = c.upscale_model(decode_image(b["image"]), b.get("upscaler"))
                return self.send(200, {"images": [{"b64_json": png_b64(img)}], "width": img.width, "height": img.height})
            return self.send(404, {"error": "no existe"})
        except Exception as e:
            traceback.print_exc()
            return self.send(422 if isinstance(e, ValueError) else 500, {"error": str(e), "message": str(e)})




if __name__ == "__main__":
    threading.Thread(target=boot, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", ARGS.listen_port), H)
    log(f"listening on: http://127.0.0.1:{ARGS.listen_port}")
    srv.serve_forever()
