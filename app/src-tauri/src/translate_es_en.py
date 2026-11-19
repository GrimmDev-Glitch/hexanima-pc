"""HexAnima PC: traductor español → inglés para el prompt, sin internet.

Lo lanza la app con el Python del motor rápido (engine/torch/python) y se queda abierto: lee una línea JSON
{"texts": [...]} por stdin y responde otra {"out": [...]} por stdout. Modelo: Helsinki-NLP/opus-mt-es-en
(MarianMT, Apache-2.0) en models/translate/opus-mt-es-en. Corre en la CPU (~0,1-0,5 s por frase) para no
quitarle memoria de la gráfica al generador.
"""
import json
import os
import sys

model_dir = sys.argv[1]
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

import torch  # noqa: E402
from transformers import MarianMTModel, MarianTokenizer  # noqa: E402

torch.set_num_threads(max(1, min(4, (os.cpu_count() or 2) // 2)))
tok = MarianTokenizer.from_pretrained(model_dir)
model = MarianMTModel.from_pretrained(model_dir).eval()
print(json.dumps({"ready": True}), flush=True)

for line in sys.stdin:
    try:
        texts = [str(t) for t in json.loads(line).get("texts", [])][:64]
        out = []
        if texts:
            with torch.inference_mode():
                batch = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=256)
                gen = model.generate(**batch, num_beams=3, max_new_tokens=200)
            out = tok.batch_decode(gen, skip_special_tokens=True)
        print(json.dumps({"out": out}, ensure_ascii=False), flush=True)
    except Exception as e:  # una línea mala no tumba el traductor
        print(json.dumps({"error": str(e)}, ensure_ascii=False), flush=True)
