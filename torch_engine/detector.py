# HexAnima PC · detector YOLOv8 (caras / manos) en PyTorch puro para ADetailer.
# Lee los .safetensors que la app convierte (Conv+BN ya fusionados, como el script de sd.cpp):
# la red se arma a partir de las formas de los pesos, sin ultralytics.
import json
import torch
import torch.nn as nn
import torch.nn.functional as F
from safetensors.torch import load_file, safe_open


class Conv(nn.Module):
    def __init__(self, w, b, stride):
        super().__init__()
        self.c = nn.Conv2d(w.shape[1], w.shape[0], w.shape[2], stride, w.shape[2] // 2)
        self.c.weight.data, self.c.bias.data = w.float(), b.float()

    def forward(self, x):
        return F.silu(self.c(x))


def conv_at(sd, p, stride=1):
    return Conv(sd[p + ".conv.weight"], sd[p + ".conv.bias"], stride)


class C2f(nn.Module):
    def __init__(self, sd, p, shortcut):
        super().__init__()
        self.cv1, self.cv2 = conv_at(sd, p + ".cv1"), conv_at(sd, p + ".cv2")
        n = len({k.split(".")[3] for k in sd if k.startswith(p + ".m.")})
        self.m = nn.ModuleList([nn.Sequential(conv_at(sd, f"{p}.m.{i}.cv1"), conv_at(sd, f"{p}.m.{i}.cv2")) for i in range(n)])
        self.shortcut = shortcut

    def forward(self, x):
        y = list(self.cv1(x).chunk(2, 1))
        for m in self.m:
            z = m(y[-1])
            y.append(y[-1] + z if self.shortcut else z)
        return self.cv2(torch.cat(y, 1))


class SPPF(nn.Module):
    def __init__(self, sd, p):
        super().__init__()
        self.cv1, self.cv2 = conv_at(sd, p + ".cv1"), conv_at(sd, p + ".cv2")

    def forward(self, x):
        x = self.cv1(x)
        y1 = F.max_pool2d(x, 5, 1, 2); y2 = F.max_pool2d(y1, 5, 1, 2); y3 = F.max_pool2d(y2, 5, 1, 2)
        return self.cv2(torch.cat([x, y1, y2, y3], 1))


class YOLOv8(nn.Module):
    """Estructura estándar de YOLOv8 detect (capas 0-22)."""
    def __init__(self, path):
        super().__init__()
        sd = load_file(path)
        with safe_open(path, "pt") as f:
            meta = f.metadata() or {}
        self.nc = int(meta.get("yolov8.num_classes", 1))
        self.reg = int(meta.get("yolov8.reg_max", 16))
        self.size = int(meta.get("yolov8.input_size", 640))
        self.names = json.loads(meta.get("yolov8.names", "{}") or "{}")
        L = {}
        for i in (0, 1, 3, 5, 7, 16, 19):
            L[i] = conv_at(sd, f"model.{i}", 2)
        for i in (2, 4, 6, 8):
            L[i] = C2f(sd, f"model.{i}", True)
        for i in (12, 15, 18, 21):
            L[i] = C2f(sd, f"model.{i}", False)
        L[9] = SPPF(sd, "model.9")
        self.L = nn.ModuleDict({str(k): v for k, v in L.items()})
        self.box = nn.ModuleList(); self.cls = nn.ModuleList()
        for lv in range(3):
            for name, lst in (("cv2", self.box), ("cv3", self.cls)):
                p = f"model.22.{name}.{lv}"
                last = nn.Conv2d(sd[p + ".2.weight"].shape[1], sd[p + ".2.weight"].shape[0], 1)
                last.weight.data, last.bias.data = sd[p + ".2.weight"].float(), sd[p + ".2.bias"].float()
                lst.append(nn.Sequential(conv_at(sd, p + ".0"), conv_at(sd, p + ".1"), last))
        self.eval()

    def forward(self, x):
        L = self.L
        f = {}
        for i in range(10):
            x = L[str(i)](x); f[i] = x
        x = torch.cat([F.interpolate(f[9], scale_factor=2.0), f[6]], 1); f[12] = L["12"](x)
        x = torch.cat([F.interpolate(f[12], scale_factor=2.0), f[4]], 1); p3 = L["15"](x)
        x = torch.cat([L["16"](p3), f[12]], 1); p4 = L["18"](x)
        x = torch.cat([L["19"](p4), f[9]], 1); p5 = L["21"](x)
        outs = []
        for lv, (p, s) in enumerate(((p3, 8), (p4, 16), (p5, 32))):
            b = self.box[lv](p); c = self.cls[lv](p)
            n, _, h, w = b.shape
            # DFL: distribución sobre reg_max bins -> distancia esperada a cada lado
            d = b.view(n, 4, self.reg, h * w).softmax(2)
            d = (d * torch.arange(self.reg, dtype=d.dtype, device=d.device).view(1, 1, -1, 1)).sum(2)
            gy, gx = torch.meshgrid(torch.arange(h, device=d.device), torch.arange(w, device=d.device), indexing="ij")
            ax = (gx.reshape(-1) + 0.5); ay = (gy.reshape(-1) + 0.5)
            boxes = torch.stack([ax - d[:, 0], ay - d[:, 1], ax + d[:, 2], ay + d[:, 3]], 1) * s  # n,4,hw
            outs.append(torch.cat([boxes, c.view(n, self.nc, h * w).sigmoid()], 1))
        return torch.cat(outs, 2)  # n, 4+nc, anchors

    @torch.inference_mode()
    def detect(self, pil, conf=0.3, iou=0.45, max_det=20):
        """Devuelve [(x1, y1, x2, y2, confianza)] en píxeles de la imagen."""
        import numpy as np
        from torchvision.ops import nms
        W, H = pil.size
        s = self.size / max(W, H)
        nw, nh = int(round(W * s)), int(round(H * s))
        img = pil.convert("RGB").resize((nw, nh))
        x = torch.full((1, 3, self.size, self.size), 114 / 255.0)
        px, py = (self.size - nw) // 2, (self.size - nh) // 2
        x[0, :, py:py + nh, px:px + nw] = torch.from_numpy(np.asarray(img).astype("float32") / 255.0).permute(2, 0, 1)
        out = self.forward(x)[0]  # 4+nc, A
        scores, _ = out[4:].max(0)
        keep = scores > conf
        b = out[:4, keep].T; sc = scores[keep]
        if not len(sc):
            return []
        k = nms(b, sc, iou)[:max_det]
        res = []
        for i in k.tolist():
            x1, y1, x2, y2 = b[i].tolist()
            res.append(((x1 - px) / s, (y1 - py) / s, (x2 - px) / s, (y2 - py) / s, float(sc[i])))
        return res
