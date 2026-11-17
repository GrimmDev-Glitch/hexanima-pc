"""HexAnima PC - verificacion para la pantalla de bienvenida.

Revisa que el equipo tenga lo necesario para generar y devuelve una lista de
comprobaciones (ok / aviso / error) con el arreglo sugerido para cada una.
La UI la muestra como checklist; el JSON tambien se guarda en config.json.

Uso:  python tools/check_setup.py [--json] [--write]
"""
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from detect_hw import ROOT, CONFIG, detect  # noqa: E402

SYS32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
# El motor CUDA trae cudart 12.x; por compatibilidad de version menor basta un driver 12.0+.
MIN_NVIDIA_DRIVER = (528, 33)
MIN_FREE_DISK_GB = 10
ENGINE_FILES = {
    "cuda": ["sd-cli.exe", "stable-diffusion.dll", "ggml-cuda.dll", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
    "cuda-gtx": ["sd-cli.exe", "stable-diffusion.dll", "ggml-cuda.dll", "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll"],
    "vulkan": ["sd-cli.exe", "stable-diffusion.dll", "ggml-vulkan.dll"],
    "cpu": ["sd-cli.exe", "stable-diffusion.dll"],
}
# Lo minimo para la primera imagen con el modelo recomendado (Anima Turbo).
STARTER_MODELS = [
    ("models/diffusion_models/anima-turbo-v1.1.safetensors", "Anima Turbo"),
    ("models/text_encoders/qwen_3_06b_base.safetensors", "Codificador de texto Qwen3 0.6B"),
    ("models/vae/qwen_image_vae.safetensors", "VAE de Anima"),
]


def item(id_, level, title, detail="", fix=""):
    return {"id": id_, "level": level, "title": title, "detail": detail, "fix": fix}


def check_os():
    v = sys.getwindowsversion() if sys.platform == "win32" else None
    if not v:
        return item("os", "error", "Sistema operativo", "Esta version es solo para Windows.")
    if v.major >= 10:
        return item("os", "ok", "Windows 10 u 11", f"build {v.build}")
    return item("os", "error", "Windows antiguo", f"{v.major}.{v.minor}", "Se necesita Windows 10 u 11 de 64 bits.")


def check_vcredist():
    missing = [d for d in ("vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll") if not (SYS32 / d).exists()]
    if not missing:
        return item("vcredist", "ok", "Visual C++ Redistributable")
    return item("vcredist", "error", "Falta Visual C++ Redistributable", ", ".join(missing),
                "Instala 'Microsoft Visual C++ Redistributable 2015-2022 (x64)' desde la web de Microsoft.")


def check_gpu_driver(hw):
    gpu = hw.get("gpu")
    if not gpu:
        return item("driver", "warn", "Sin grafica compatible",
                    "Se usara el procesador (perfil Bajo): funciona, pero tarda minutos por imagen.")
    if gpu["vendor"] == "nvidia":
        drv = gpu.get("driver") or ""
        nums = tuple(int(x) for x in re.findall(r"\d+", drv)[:2]) or (0, 0)
        if not (SYS32 / "nvcuda.dll").exists():
            return item("driver", "error", "Driver NVIDIA sin CUDA", gpu["name"],
                        "Instala el driver mas reciente desde nvidia.com o GeForce Experience / NVIDIA App.")
        if nums < MIN_NVIDIA_DRIVER:
            return item("driver", "error", "Driver NVIDIA antiguo", f"{gpu['name']} · driver {drv}",
                        f"Actualiza el driver a {MIN_NVIDIA_DRIVER[0]}.{MIN_NVIDIA_DRIVER[1]} o mas reciente.")
        return item("driver", "ok", f"Driver NVIDIA {drv}", gpu["name"])
    # AMD / Intel: Vulkan
    if not (SYS32 / "vulkan-1.dll").exists():
        return item("driver", "error", "Falta soporte Vulkan", gpu["name"],
                    "Actualiza el driver de la grafica (AMD Adrenalin o Intel Arc/Graphics).")
    return item("driver", "ok", "Driver con Vulkan", gpu["name"])


def check_engine(hw):
    engine = hw["engine"]
    edir = ROOT / "engine" / engine
    missing = [f for f in ENGINE_FILES[engine] if not (edir / f).exists()]
    if missing:
        return item("engine", "error", f"Motor {engine.upper()} incompleto", ", ".join(missing),
                    "Vuelve a descargar el motor desde Ajustes > Motor, o reinstala HexAnima.")
    return item("engine", "ok", f"Motor {engine.upper()} instalado", str(edir.relative_to(ROOT)))


def check_engine_runs(hw):
    """Prueba real: el motor arranca y ve la grafica."""
    engine = hw["engine"]
    exe = ROOT / "engine" / engine / "sd-cli.exe"
    if not exe.exists():
        return item("engine_run", "error", "No se pudo probar el motor", "Falta sd-cli.exe")
    try:
        out = subprocess.run([str(exe), "--list-devices"], capture_output=True, text=True, timeout=60,
                             cwd=str(exe.parent), errors="replace",
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.TimeoutExpired) as e:
        return item("engine_run", "error", "El motor no arranca", str(e),
                    "Revisa el antivirus (puede bloquear sd-cli.exe) y el Visual C++ Redistributable.")
    text = out.stdout + out.stderr
    devices = [l.split("\t", 1) for l in out.stdout.splitlines() if "\t" in l]
    gpu_dev = [d for d in devices if d[0].upper().startswith(("CUDA", "VULKAN"))]
    if out.returncode != 0:
        return item("engine_run", "error", "El motor falla al arrancar", text.strip()[-300:],
                    "Actualiza el driver de la grafica; si sigue, usa el motor CPU desde Ajustes.")
    if engine != "cpu" and not gpu_dev:
        return item("engine_run", "error", "El motor no ve la grafica", text.strip()[-300:],
                    "Actualiza el driver; mientras tanto se puede usar el motor CPU.")
    chosen = hw.get("backend_device")
    names = ", ".join(f"{d[0]} ({d[1]})" + (" ← se usa esta" if d[0].lower() == chosen and len(gpu_dev) > 1 else "")
                      for d in gpu_dev) or "CPU"
    warn = "lack of tensor cores" in text
    return item("engine_run", "ok", "El motor arranca y ve la grafica", names +
                (" · sin tensor cores: rinde menos que una RTX" if warn else ""))


def check_memory(hw):
    ram = hw.get("ram_gb") or 0
    if ram < 8:
        return item("ram", "error", f"RAM: {ram} GB", "Con menos de 8 GB no caben los modelos.",
                    "Cierra otros programas; se recomiendan 16 GB.")
    if ram < 12:
        return item("ram", "warn", f"RAM: {ram} GB", "Se usara el perfil Bajo con modelos q4.")
    return item("ram", "ok", f"RAM: {ram} GB", f"{hw.get('ram_free_gb')} GB libres ahora")


def check_disk():
    free = shutil.disk_usage(ROOT).free / 1024**3
    if free < MIN_FREE_DISK_GB:
        return item("disk", "warn", f"Poco espacio: {free:.0f} GB libres",
                    "Cada modelo ocupa entre 2 y 7 GB.", "Libera espacio o mueve la carpeta de HexAnima a otra unidad.")
    return item("disk", "ok", f"Espacio libre: {free:.0f} GB", str(ROOT.anchor))


def check_write():
    test = ROOT / "cache" / ".write_test"
    try:
        test.parent.mkdir(exist_ok=True)
        test.write_text("ok")
        test.unlink()
        return item("write", "ok", "La carpeta permite guardar archivos")
    except OSError:
        return item("write", "error", "No se puede escribir en la carpeta", str(ROOT),
                    "Mueve HexAnima fuera de 'Archivos de programa' o a otra unidad.")


def check_models():
    missing = [name for rel, name in STARTER_MODELS if not (ROOT / rel).exists()]
    if missing:
        return item("models", "warn", "Falta el primer modelo", ", ".join(missing),
                    "Descargalo desde el catalogo (unos 5,4 GB) o copia el tuyo en models\\checkpoints.")
    return item("models", "ok", "Modelo inicial listo", "Anima Turbo")


def run_checks():
    hw = detect()
    checks = [check_os(), check_vcredist(), check_gpu_driver(hw), check_engine(hw),
              check_engine_runs(hw), check_memory(hw), check_disk(), check_write(), check_models()]
    worst = "error" if any(c["level"] == "error" for c in checks) else \
            "warn" if any(c["level"] == "warn" for c in checks) else "ok"
    return {"status": worst, "ready": worst != "error", "hardware": hw, "checks": checks}


def main():
    res = run_checks()
    if "--json" in sys.argv:
        print(json.dumps(res, indent=2, ensure_ascii=False))
    else:
        icon = {"ok": "[OK]   ", "warn": "[AVISO]", "error": "[ERROR]"}
        hw = res["hardware"]
        print(f"Perfil recomendado: {hw['profile'].upper()} · motor {hw['engine'].upper()}\n")
        for c in res["checks"]:
            print(f"{icon[c['level']]} {c['title']}" + (f" — {c['detail']}" if c["detail"] else ""))
            if c["fix"] and c["level"] != "ok":
                print(f"         -> {c['fix']}")
        print("\nListo para generar." if res["ready"] else "\nHay que resolver los errores antes de generar.")
    if "--write" in sys.argv:
        cfg = json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {}
        cfg["hardware"] = res["hardware"]
        cfg["setup_check"] = {"status": res["status"], "checks": res["checks"]}
        cfg.setdefault("manual", {"engine": None, "profile": None, "vram_limit_gb": None, "extra_args": ""})
        CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
