"""HexAnima PC: ayudante en la CPU con el Python del motor rápido (engine/torch/python), sin internet.

La app lo lanza una vez y se queda abierto: lee una línea JSON por stdin y responde otra por stdout.
  {"texts": [...]}                       -> {"out": [...]}    🌐 ES→EN con OPUS-MT es-en (Helsinki-NLP, Apache-2.0)
  {"op": "tag", "image": "data:…", ...}  -> {"tags": [[nombre, puntuación, categoría], ...]}
                                                              WD Tagger v3 (tagger.py del motor) para 👗/🧍 Copiar
Cada modelo se carga la primera vez que se usa. Corre en la CPU para no quitarle memoria al generador.
argv: carpeta del traductor, carpeta hexanima del motor (tagger.py), carpeta models.
"""
import base64
import io
import json
import os
import sys

TR_DIR, ENGINE_CODE, MODELS = sys.argv[1], sys.argv[2], sys.argv[3]
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

import torch  # noqa: E402

torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
_M = {}


def translator():
    if "tr" not in _M:
        from transformers import MarianMTModel, MarianTokenizer
        _M["tr"] = (MarianTokenizer.from_pretrained(TR_DIR), MarianMTModel.from_pretrained(TR_DIR).eval())
    return _M["tr"]


def tagger():
    if "tag" not in _M:
        sys.path.insert(0, ENGINE_CODE)
        from tagger import WDTagger
        d = os.path.join(MODELS, "tagger")
        _M["tag"] = WDTagger(os.path.join(d, "wd-vit-tagger-v3.safetensors"), os.path.join(d, "wd-vit-tagger-v3.csv"))
    return _M["tag"]


def handle(req):
    if req.get("op") == "tag":
        from PIL import Image
        raw = req["image"].split(",", 1)[1] if "," in req["image"] else req["image"]
        img = Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGB")
        tags = tagger().tag(img, float(req.get("general") or 0.25), float(req.get("character") or 0.85))
        return {"tags": [[n, round(float(s), 3), int(c)] for n, s, c in tags]}
    texts = [str(t) for t in req.get("texts", [])][:64]
    if not texts:
        return {"out": []}
    tok, model = translator()
    with torch.inference_mode():
        batch = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=256)
        gen = model.generate(**batch, num_beams=3, max_new_tokens=200)
    return {"out": tok.batch_decode(gen, skip_special_tokens=True)}


print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        print(json.dumps(handle(json.loads(line)), ensure_ascii=False), flush=True)
    except Exception as e:  # una línea mala no tumba al ayudante
        print(json.dumps({"error": str(e)}, ensure_ascii=False), flush=True)
