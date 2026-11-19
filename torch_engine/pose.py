"""🧍 Pose: detector de cuerpo de OpenPose (18 puntos) en PyTorch, sin OpenCV.

Reescrito a partir del anotador «openpose» de lllyasviel/ControlNet (Apache-2.0), que a su vez porta el
modelo de CMU OpenPose. Los pesos (`body_pose_model.pth`, lllyasviel/Annotators) son de CMU: uso
académico / no comercial. Dibuja el esqueleto de colores que esperan los ControlNet OpenPose
(xinsir/controlnet-openpose-sdxl-1.0 y similares): extremidades al 60 % y puntos encima, fondo negro.
"""
import math
from collections import OrderedDict

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from PIL import Image, ImageDraw
from scipy.ndimage import gaussian_filter


def _layers(block, no_relu):
    out = []
    for name, v in block.items():
        if "pool" in name:
            out.append((name, nn.MaxPool2d(kernel_size=v[0], stride=v[1], padding=v[2])))
        else:
            out.append((name, nn.Conv2d(v[0], v[1], kernel_size=v[2], stride=v[3], padding=v[4])))
            if name not in no_relu:
                out.append(("relu_" + name, nn.ReLU(inplace=True)))
    return nn.Sequential(OrderedDict(out))


class BodyPoseModel(nn.Module):
    def __init__(self):
        super().__init__()
        no_relu = ["conv5_5_CPM_L1", "conv5_5_CPM_L2"] + [f"Mconv7_stage{i}_L{j}" for i in range(2, 7) for j in (1, 2)]
        block0 = OrderedDict([
            ("conv1_1", [3, 64, 3, 1, 1]), ("conv1_2", [64, 64, 3, 1, 1]), ("pool1_stage1", [2, 2, 0]),
            ("conv2_1", [64, 128, 3, 1, 1]), ("conv2_2", [128, 128, 3, 1, 1]), ("pool2_stage1", [2, 2, 0]),
            ("conv3_1", [128, 256, 3, 1, 1]), ("conv3_2", [256, 256, 3, 1, 1]), ("conv3_3", [256, 256, 3, 1, 1]),
            ("conv3_4", [256, 256, 3, 1, 1]), ("pool3_stage1", [2, 2, 0]),
            ("conv4_1", [256, 512, 3, 1, 1]), ("conv4_2", [512, 512, 3, 1, 1]),
            ("conv4_3_CPM", [512, 256, 3, 1, 1]), ("conv4_4_CPM", [256, 128, 3, 1, 1]),
        ])
        self.model0 = _layers(block0, no_relu)

        def stage1(L, n):
            return OrderedDict([(f"conv5_1_CPM_L{L}", [128, 128, 3, 1, 1]), (f"conv5_2_CPM_L{L}", [128, 128, 3, 1, 1]),
                                (f"conv5_3_CPM_L{L}", [128, 128, 3, 1, 1]), (f"conv5_4_CPM_L{L}", [128, 512, 1, 1, 0]),
                                (f"conv5_5_CPM_L{L}", [512, n, 1, 1, 0])])

        def stage(i, L, n):
            b = OrderedDict([(f"Mconv1_stage{i}_L{L}", [185, 128, 7, 1, 3])])
            for k in range(2, 6):
                b[f"Mconv{k}_stage{i}_L{L}"] = [128, 128, 7, 1, 3]
            b[f"Mconv6_stage{i}_L{L}"] = [128, 128, 1, 1, 0]
            b[f"Mconv7_stage{i}_L{L}"] = [128, n, 1, 1, 0]
            return b

        self.model1_1 = _layers(stage1(1, 38), no_relu)
        self.model1_2 = _layers(stage1(2, 19), no_relu)
        for i in range(2, 7):
            setattr(self, f"model{i}_1", _layers(stage(i, 1, 38), no_relu))
            setattr(self, f"model{i}_2", _layers(stage(i, 2, 19), no_relu))

    def forward(self, x):
        out1 = self.model0(x)
        a, b = self.model1_1(out1), self.model1_2(out1)
        for i in range(2, 7):
            cat = torch.cat([a, b, out1], 1)
            a, b = getattr(self, f"model{i}_1")(cat), getattr(self, f"model{i}_2")(cat)
        return a, b  # PAF (38), mapas de calor (19)


LIMBS = [[2, 3], [2, 6], [3, 4], [4, 5], [6, 7], [7, 8], [2, 9], [9, 10], [10, 11], [2, 12], [12, 13], [13, 14],
         [2, 1], [1, 15], [15, 17], [1, 16], [16, 18], [3, 17], [6, 18]]
MAP_IDX = [[31, 32], [39, 40], [33, 34], [35, 36], [41, 42], [43, 44], [19, 20], [21, 22], [23, 24], [25, 26],
           [27, 28], [29, 30], [47, 48], [49, 50], [53, 54], [51, 52], [55, 56], [37, 38], [45, 46]]
COLORS = [[255, 0, 0], [255, 85, 0], [255, 170, 0], [255, 255, 0], [170, 255, 0], [85, 255, 0], [0, 255, 0],
          [0, 255, 85], [0, 255, 170], [0, 255, 255], [0, 170, 255], [0, 85, 255], [0, 0, 255], [85, 0, 255],
          [170, 0, 255], [255, 0, 255], [255, 0, 170], [255, 0, 85]]


class OpenPose:
    def __init__(self, weights_path, device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        sd = torch.load(weights_path, map_location="cpu", weights_only=True)
        m = BodyPoseModel()
        # los pesos no llevan el prefijo del bloque (model0., model1_1.…): se quita al emparejar
        own = m.state_dict()
        m.load_state_dict({k: sd[".".join(k.split(".")[1:])] for k in own})
        self.model = m.to(self.device).eval()

    @torch.no_grad()
    def maps(self, img):
        """Mapas de calor (H, W, 19) y PAF (H, W, 38) a tamaño de la imagen (una escala, lado corto ~368)."""
        a = np.asarray(img.convert("RGB"), dtype=np.float32)
        H, W = a.shape[:2]
        scale = 368.0 / H
        sw, sh = max(8, int(round(W * scale))), max(8, int(round(H * scale)))
        x = torch.from_numpy(a).permute(2, 0, 1)[None].to(self.device)
        x = F.interpolate(x, size=(sh, sw), mode="bicubic", align_corners=False)
        pad_h, pad_w = (8 - sh % 8) % 8, (8 - sw % 8) % 8
        x = F.pad(x, (0, pad_w, 0, pad_h), value=128.0)
        # el original usa BGR / 256 - 0.5
        x = x[:, [2, 1, 0]] / 256.0 - 0.5
        paf, heat = self.model(x.float())

        def up(t):
            t = F.interpolate(t, scale_factor=8, mode="bicubic", align_corners=False)[:, :, :sh, :sw]
            t = F.interpolate(t, size=(H, W), mode="bicubic", align_corners=False)
            return t[0].permute(1, 2, 0).float().cpu().numpy()

        return up(heat), up(paf)

    def detect(self, img):
        """candidate: [x, y, score, id]; subset: por persona, índice del punto 0..17 (+ puntuación y número)."""
        heat, paf = self.maps(img)
        H = heat.shape[0]
        thre1, thre2, mid_num = 0.1, 0.05, 10
        peaks, counter = [], 0
        for part in range(18):
            m = gaussian_filter(heat[:, :, part], sigma=3)
            l, r, u, d = (np.zeros_like(m) for _ in range(4))
            l[1:, :], r[:-1, :], u[:, 1:], d[:, :-1] = m[:-1, :], m[1:, :], m[:, :-1], m[:, 1:]
            mask = (m >= l) & (m >= r) & (m >= u) & (m >= d) & (m > thre1)
            ys, xs = np.nonzero(mask)
            pk = [(int(x), int(y), float(heat[y, x, part]), counter + i) for i, (x, y) in enumerate(zip(xs, ys))]
            counter += len(pk)
            peaks.append(pk)

        conns, special = [], []
        for k, (ia, ib) in enumerate(MAP_IDX):
            score_mid = paf[:, :, [ia - 19, ib - 19]]
            A, B = peaks[LIMBS[k][0] - 1], peaks[LIMBS[k][1] - 1]
            if not A or not B:
                special.append(k); conns.append(None); continue
            cand = []
            for i, a in enumerate(A):
                for j, b in enumerate(B):
                    vec = np.subtract(b[:2], a[:2]).astype(np.float64)
                    norm = max(0.001, math.hypot(*vec))
                    vec /= norm
                    xs = np.linspace(a[0], b[0], mid_num); ys = np.linspace(a[1], b[1], mid_num)
                    vx = np.array([score_mid[int(round(y)), int(round(x)), 0] for x, y in zip(xs, ys)])
                    vy = np.array([score_mid[int(round(y)), int(round(x)), 1] for x, y in zip(xs, ys)])
                    s = vx * vec[0] + vy * vec[1]
                    prior = s.mean() + min(0.5 * H / norm - 1, 0)
                    if np.count_nonzero(s > thre2) > 0.8 * len(s) and prior > 0:
                        cand.append((i, j, prior, prior + a[2] + b[2]))
            cand.sort(key=lambda c: c[2], reverse=True)
            conn, used_a, used_b = [], set(), set()
            for i, j, s, _ in cand:
                if i not in used_a and j not in used_b:
                    conn.append([A[i][3], B[j][3], s, i, j]); used_a.add(i); used_b.add(j)
                    if len(conn) >= min(len(A), len(B)):
                        break
            conns.append(np.array(conn).reshape(-1, 5))

        candidate = np.array([p for pk in peaks for p in pk], dtype=np.float64).reshape(-1, 4)
        subset = -1 * np.ones((0, 20))
        for k in range(len(MAP_IDX)):
            if k in special:
                continue
            c = conns[k]
            pa, pb = c[:, 0], c[:, 1]
            ia, ib = np.array(LIMBS[k]) - 1
            for i in range(len(c)):
                found, idx = 0, [-1, -1]
                for j in range(len(subset)):
                    if subset[j][ia] == pa[i] or subset[j][ib] == pb[i]:
                        if found < 2: idx[found] = j
                        found += 1
                if found == 1:
                    j = idx[0]
                    if subset[j][ib] != pb[i]:
                        subset[j][ib] = pb[i]; subset[j][-1] += 1
                        subset[j][-2] += candidate[int(pb[i]), 2] + c[i][2]
                elif found == 2:
                    j1, j2 = idx
                    member = ((subset[j1] >= 0).astype(int) + (subset[j2] >= 0).astype(int))[:-2]
                    if not np.any(member == 2):
                        subset[j1][:-2] += subset[j2][:-2] + 1
                        subset[j1][-2:] += subset[j2][-2:]
                        subset[j1][-2] += c[i][2]
                        subset = np.delete(subset, j2, 0)
                    else:
                        subset[j1][ib] = pb[i]; subset[j1][-1] += 1
                        subset[j1][-2] += candidate[int(pb[i]), 2] + c[i][2]
                elif not found and k < 17:
                    row = -1 * np.ones(20)
                    row[ia], row[ib] = pa[i], pb[i]
                    row[-1] = 2
                    row[-2] = candidate[c[i, :2].astype(int), 2].sum() + c[i][2]
                    subset = np.vstack([subset, row])
        keep = [i for i in range(len(subset)) if subset[i][-1] >= 4 and subset[i][-2] / subset[i][-1] >= 0.4]
        return candidate, subset[keep]

    @staticmethod
    def draw(candidate, subset, size):
        """Esqueleto de colores sobre negro, como el anotador de ControlNet 1.1."""
        W, H = size
        stick = max(2, int(round(4 * max(W, H) / 512)))
        limbs = Image.new("RGB", (W, H), (0, 0, 0))
        d = ImageDraw.Draw(limbs)
        for i in range(17):
            for n in subset:
                idx = n[np.array(LIMBS[i]) - 1]
                if -1 in idx:
                    continue
                pts = candidate[idx.astype(int), :2]
                (x1, y1), (x2, y2) = pts
                mx, my = (x1 + x2) / 2, (y1 + y2) / 2
                length = math.hypot(x1 - x2, y1 - y2) / 2
                ang = math.atan2(y1 - y2, x1 - x2)
                poly = [(mx + length * math.cos(t) * math.cos(ang) - stick * math.sin(t) * math.sin(ang),
                         my + length * math.cos(t) * math.sin(ang) + stick * math.sin(t) * math.cos(ang))
                        for t in np.linspace(0, 2 * math.pi, 36, endpoint=False)]
                d.polygon(poly, fill=tuple(COLORS[i]))
        canvas = Image.fromarray((np.asarray(limbs, dtype=np.float32) * 0.6).astype(np.uint8))
        d = ImageDraw.Draw(canvas)
        r = stick
        for i in range(18):
            for n in subset:
                k = int(n[i])
                if k == -1:
                    continue
                x, y = candidate[k, :2]
                d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(COLORS[i]))
        return canvas

    def __call__(self, img):
        cand, subset = self.detect(img)
        return self.draw(cand, subset, img.size), len(subset)
