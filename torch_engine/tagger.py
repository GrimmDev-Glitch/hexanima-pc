# HexAnima PC · WD Tagger v3 (SmilingWolf/wd-vit-tagger-v3, Apache-2.0) en PyTorch puro.
# «Leer rasgos» de una imagen: devuelve etiquetas Danbooru (pelo, ojos, ropa, personaje…), como el
# «Prompt desde una imagen» del teléfono. ViT-B/16 de timm a 448 px, sin token de clase, media global.
import csv
import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import load_file


class Block(nn.Module):
    def __init__(self, d=768, heads=12):
        super().__init__()
        self.heads = heads
        self.norm1 = nn.LayerNorm(d, eps=1e-6); self.norm2 = nn.LayerNorm(d, eps=1e-6)
        self.qkv = nn.Linear(d, 3 * d); self.proj = nn.Linear(d, d)
        self.fc1 = nn.Linear(d, 4 * d); self.fc2 = nn.Linear(4 * d, d)

    def forward(self, x):
        b, n, d = x.shape
        q, k, v = self.qkv(self.norm1(x)).view(b, n, 3, self.heads, d // self.heads).permute(2, 0, 3, 1, 4)
        a = F.scaled_dot_product_attention(q, k, v).transpose(1, 2).reshape(b, n, d)
        x = x + self.proj(a)
        return x + self.fc2(F.gelu(self.fc1(self.norm2(x)), approximate="tanh"))


class WDTagger(nn.Module):
    SIZE = 448

    def __init__(self, weights, tags_csv):
        super().__init__()
        sd = load_file(weights)
        depth = len({k.split(".")[1] for k in sd if k.startswith("blocks.")})
        self.patch = nn.Conv2d(3, 768, 16, 16)
        self.pos = nn.Parameter(torch.zeros(1, (self.SIZE // 16) ** 2, 768))
        self.blocks = nn.ModuleList([Block() for _ in range(depth)])
        self.norm = nn.LayerNorm(768, eps=1e-6)
        self.head = nn.Linear(768, sd["head.weight"].shape[0])
        m = {"patch_embed.proj.": "patch.", "pos_embed": "pos", "attn.qkv": "qkv", "attn.proj": "proj", "mlp.fc1": "fc1", "mlp.fc2": "fc2"}
        out = {}
        for k, v in sd.items():
            for a, b in m.items():
                k = k.replace(a, b)
            out[k] = v
        self.load_state_dict(out)
        self.eval()
        # WD Tagger runs on CPU on PCs so it does not compete with the diffusion
        # model for scarce VRAM. Dynamic int8 linear layers use optimized CPU
        # kernels and make the large ViT projections much lighter. The downloaded
        # checkpoint remains unchanged.
        qengine = torch.backends.quantized.engine
        if qengine in torch.backends.quantized.supported_engines and qengine != "none":
            torch.ao.quantization.quantize_dynamic(self, {nn.Linear}, dtype=torch.qint8, inplace=True)
        with open(tags_csv, encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
        self.names = [r["name"] for r in rows]
        self.cats = [int(r["category"]) for r in rows]

    def forward(self, x):
        x = self.patch(x).flatten(2).transpose(1, 2) + self.pos
        for blk in self.blocks:
            x = blk(x)
        return self.head(self.norm(x).mean(1))

    @torch.inference_mode()
    def tag(self, pil, general=0.35, character=0.85, device="cpu"):
        """[(etiqueta, probabilidad, categoría)] por probabilidad. Categorías: 0 general, 4 personaje, 9 clasificación."""
        import numpy as np
        from PIL import Image
        img = pil.convert("RGBA")
        bg = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(bg, img).convert("RGB")
        s = max(img.size)  # cuadrado con fondo blanco, como el tagger original
        sq = Image.new("RGB", (s, s), (255, 255, 255)); sq.paste(img, ((s - img.width) // 2, (s - img.height) // 2))
        sq = sq.resize((self.SIZE, self.SIZE), Image.BICUBIC)
        # BGR: los pesos vienen del tagger ONNX de SmilingWolf, que lee los canales al revés. Con RGB salían
        # etiquetas falsas como «blue_skin» o «alien» en fotos de piel normal (medido con dos fotos de prueba).
        x = torch.from_numpy(np.asarray(sq)[:, :, ::-1].astype("float32") / 127.5 - 1.0).permute(2, 0, 1)[None]
        self.to(device)
        p = torch.sigmoid(self.forward(x.to(device))[0]).float().cpu()
        self.to("cpu")
        res = []
        for i in torch.argsort(p, descending=True).tolist():
            c, sc = self.cats[i], float(p[i])
            if (c == 0 and sc >= general) or (c == 4 and sc >= character) or c == 9:
                res.append((self.names[i], sc, c))
            if sc < min(general, 0.2) and c != 9:
                break
        return res
