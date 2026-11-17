"""HexAnima PC - lanzador de prueba.

Lee config.json (perfil y motor detectados por detect_hw.py), arma la llamada a
engine/<motor>/sd-cli.exe con los ajustes del perfil y guarda la imagen en outputs/.

Ejemplos:
  python tools/generate.py anima "1girl, silver hair, cherry blossoms, masterpiece"
  python tools/generate.py sdxl "a cat in a garden" --lora "mi_lora:0.8"
  python tools/generate.py anima "..." --steps 10 --seed 42 -W 832 -H 1216
"""
import argparse
import json
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
M = ROOT / "models"

# Familias de modelo: archivos y muestreo por defecto (como en la app del telefono).
FAMILIES = {
    "anima": {
        "files": {
            "--diffusion-model": M / "checkpoints" / "anima-turbo-v1.1.safetensors",
            "--llm": M / "text_encoders" / "qwen_3_06b_base.safetensors",
            "--vae": M / "vae" / "qwen_image_vae.safetensors",
        },
        # Turbo: CFG 1, 8-12 pasos (tarjeta del modelo). Los no turbo: 20+ pasos, CFG 4.
        "steps": 8, "cfg": 1.0, "sampler": "euler", "w": 832, "h": 1216,
    },
    # SDXL / Illustrious / Pony: checkpoint completo (UNet + CLIP + VAE incluido).
    "sdxl": {
        "files": {"-m": M / "checkpoints" / "sdxl.safetensors"},
        "model_flag": "-m",
        "steps": 28, "cfg": 5.5, "sampler": "euler_a", "w": 832, "h": 1216,
        # SDXL pierde calidad por debajo de su resolucion nativa (~1 MP):
        # en perfiles medio/alto se permite hasta 1216 aunque el perfil diga menos.
        "native_max": 1216,
        # A 832x1216 el VAE de SDXL no cabe entero en 4 GB (fallo medido en GTX 1650).
        "vae_tiling": True,
        "negative": "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digits, blurry, jpeg artifacts, watermark, signature",
    },
}


def load_config():
    cfg_path = ROOT / "config.json"
    if not cfg_path.exists():
        sys.exit("No hay config.json: ejecuta antes  python tools/detect_hw.py --write")
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    hw = cfg["hardware"]
    manual = cfg.get("manual", {})
    engine = manual.get("engine") or hw["engine"]
    profile = manual.get("profile") or hw["profile"]
    rules = dict(hw["profile_rules"]) if profile == hw["profile"] else None
    if rules is None:
        sys.path.insert(0, str(ROOT / "tools"))
        from detect_hw import PROFILES
        rules = dict(PROFILES[profile])
    return engine, profile, rules, manual.get("vram_limit_gb"), manual.get("extra_args", "")


def fit(side, max_side):
    """Escala W/H para que el lado mayor no pase del limite del perfil, en multiplos de 64."""
    return max(256, (min(side, max_side) // 64) * 64)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("family", choices=FAMILIES)
    ap.add_argument("prompt")
    ap.add_argument("-n", "--negative", default="")
    ap.add_argument("--steps", type=int)
    ap.add_argument("--cfg", type=float)
    ap.add_argument("--sampler")
    ap.add_argument("--seed", type=int, default=-1)
    ap.add_argument("-W", "--width", type=int)
    ap.add_argument("-H", "--height", type=int)
    ap.add_argument("--lora", action="append", default=[], help="nombre:fuerza (archivo en loras/)")
    ap.add_argument("--model", help="ruta a otro checkpoint de la misma familia")
    ap.add_argument("--dry", action="store_true", help="solo muestra el comando")
    a = ap.parse_args()

    engine, profile, rules, vram_limit, extra_args = load_config()
    fam = dict(FAMILIES[a.family])
    fam["files"] = dict(fam["files"])
    if a.model:
        flag = fam.get("model_flag", "--diffusion-model")
        fam["files"][flag] = Path(a.model).resolve()  # el motor corre desde engine/<motor>
        if a.family == "anima" and "turbo" not in Path(a.model).name.lower():
            fam.update(steps=20, cfg=4.0, sampler="dpm++2m")  # Anima no turbo
    exe = ROOT / "engine" / engine / "sd-cli.exe"
    if not exe.exists():
        sys.exit(f"Falta el motor: {exe}")
    for flag, path in fam["files"].items():
        if not path.exists():
            sys.exit(f"Falta el modelo ({flag}): {path}")

    w = a.width or fam["w"]
    h = a.height or fam["h"]
    ms = rules["max_side"]
    if profile != "bajo" and fam.get("native_max"):
        ms = max(ms, fam["native_max"])
    if max(w, h) > ms:  # mantener proporcion
        k = ms / max(w, h)
        w, h = int(w * k), int(h * k)
    w, h = fit(w, ms), fit(h, ms)

    prompt = a.prompt + "".join(f" <lora:{l.rsplit(':', 1)[0]}:{l.rsplit(':', 1)[1] if ':' in l else '1'}>" for l in a.lora)
    out_dir = ROOT / "outputs"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{datetime.now():%Y%m%d-%H%M%S}-{a.family}.png"

    cmd = [str(exe)]
    for flag, path in fam["files"].items():
        cmd += [flag, str(path)]
    cmd += ["-p", prompt, "-o", str(out),
            "-W", str(w), "-H", str(h),
            "--steps", str(a.steps or fam["steps"]),
            "--cfg-scale", str(a.cfg if a.cfg is not None else fam["cfg"]),
            "--sampling-method", a.sampler or fam["sampler"],
            "-s", str(a.seed),
            "--lora-model-dir", str(ROOT / "loras")]
    if fam.get("scheduler"):
        cmd += ["--scheduler", fam["scheduler"]]
    negative = a.negative or fam.get("negative", "")
    if negative:
        cmd += ["-n", negative]
    # Ajustes del perfil
    if rules["weight_type"] != "f16":
        cmd += ["--type", rules["weight_type"]]
    if rules["offload_to_cpu"]:
        cmd += ["--offload-to-cpu"]
    if rules["vae_tiling"] or fam.get("vae_tiling"):
        cmd += ["--vae-tiling"]
    cmd += ["--flash-attn", "on" if rules["flash_attn"] else "auto"]
    if engine == "cpu":
        cmd += ["--backend", "cpu"]
    if vram_limit:
        cmd += ["--max-vram", str(vram_limit)]
    if extra_args:
        import shlex
        cmd += shlex.split(extra_args, posix=False)

    print(f"Motor {engine} · perfil {profile} · {w}x{h}")
    print(" ".join(f'"{c}"' if " " in c else c for c in cmd))
    if a.dry:
        return
    t0 = time.time()
    log = ROOT / "logs" / f"{out.stem}.log"
    log.parent.mkdir(exist_ok=True)
    # buffering=1: el registro se escribe linea a linea para poder seguir el progreso en vivo.
    with open(log, "w", encoding="utf-8", errors="replace", buffering=1) as lf:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                             encoding="utf-8", errors="replace", cwd=str(exe.parent))
        for line in p.stdout:
            lf.write(line)
            sys.stdout.write(line)
        p.wait()
    dt = time.time() - t0
    if p.returncode == 0 and out.exists():
        print(f"\nListo en {dt:.1f} s -> {out}")
    else:
        print(f"\nFallo (codigo {p.returncode}) tras {dt:.1f} s. Registro: {log}")
        sys.exit(p.returncode or 1)


if __name__ == "__main__":
    main()
