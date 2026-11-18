"""Arma el zip de HexAnima PC para un release de GitHub (lo que se descarga para instalar la app).

    python tools/package_release.py --version 0.1.0

Incluye HexAnima.exe, los motores stable-diffusion.cpp (engine/vulkan, engine/cuda), carpetas vacías
y licencias. NO incluye engine/torch (se descarga desde la bienvenida), modelos, LoRAs, imágenes,
historial ni ajustes del usuario (config.json, config/*.json con la clave de Civitai).
"""
import argparse
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENGINES = ["vulkan", "cuda"]
EMPTY = ["models/checkpoints", "models/diffusion_models", "models/text_encoders", "models/vae", "models/vae_approx",
         "models/upscalers", "models/detectors", "loras", "outputs", "logs", "cache", "config", "lang"]
FILES = ["HexAnima.exe", "README.md", "LICENSE", "THIRD_PARTY.md", "engine/README.md"]
SKIP_ENGINE = (".bat", ".sh")  # lanzadores de ejemplo de sd.cpp


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    a = ap.parse_args()
    out_dir = os.path.join(ROOT, "dist", "release")
    os.makedirs(out_dir, exist_ok=True)
    top = f"HexAnima-PC-{a.version}"
    zpath = os.path.join(out_dir, top + ".zip")
    n = 0
    with zipfile.ZipFile(zpath + ".tmp", "w", zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as z:
        for f in FILES:
            p = os.path.join(ROOT, f)
            if not os.path.isfile(p):
                sys.exit(f"Falta {f}")
            z.write(p, f"{top}/{f}"); n += 1
        for e in ENGINES:
            d = os.path.join(ROOT, "engine", e)
            if not os.path.isfile(os.path.join(d, "sd-server.exe")):
                sys.exit(f"Falta engine/{e}/sd-server.exe")
            for name in sorted(os.listdir(d)):
                p = os.path.join(d, name)
                if os.path.isfile(p) and not name.endswith(SKIP_ENGINE):
                    z.write(p, f"{top}/engine/{e}/{name}"); n += 1
        for d in EMPTY:
            z.writestr(f"{top}/{d}/.gitkeep", ""); n += 1
    os.replace(zpath + ".tmp", zpath)
    print(f"Listo: {zpath} · {n} archivos · {os.path.getsize(zpath) / 2**20:.0f} MB")


if __name__ == "__main__":
    main()
