"""HexAnima PC - deteccion de hardware y eleccion de perfil.

Lee la grafica, la VRAM y la RAM del sistema, elige motor (cuda / vulkan / cpu)
y perfil (bajo / medio / alto), y guarda el resultado en config.json junto al exe.

Sin dependencias externas: usa nvidia-smi para NVIDIA, vulkaninfo si existe y
WMI (PowerShell) como ultimo recurso.

Uso:  python tools/detect_hw.py [--write]
"""
import ctypes
import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config.json"

# Reglas por perfil. Se pasan tal cual a sd-cli / sd-server.
PROFILES = {
    "bajo": {
        "descripcion": "Hasta 2 GB de VRAM o sin GPU compatible",
        "weight_type": "q4_K",      # --type: cuantiza al cargar
        "offload_to_cpu": True,     # --offload-to-cpu
        "vae_tiling": True,         # --vae-tiling
        "flash_attn": False,
        "max_side": 768,
    },
    "medio": {
        "descripcion": "3 a 7 GB de VRAM",
        # Medido en GTX 1650 (Anima Turbo 640x1024): q8 + offload = 10 s/paso,
        # q8 en VRAM = 15 s/paso, f16 + offload = 27 s/paso. VAE sin mosaicos: 16-22 s vs 44 s.
        "weight_type": "q8_0",
        "offload_to_cpu": True,
        "vae_tiling": False,
        "flash_attn": True,         # --flash-attn on
        "max_side": 1024,
    },
    "alto": {
        "descripcion": "8 GB de VRAM o mas",
        "weight_type": "f16",
        "offload_to_cpu": False,
        "vae_tiling": False,
        "flash_attn": True,
        "max_side": 1536,
    },
}


def _run(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=15,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return out.stdout if out.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def system_ram_gb():
    class MEMSTAT(ctypes.Structure):
        _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]
    m = MEMSTAT()
    m.dwLength = ctypes.sizeof(MEMSTAT)
    if sys.platform == "win32" and ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
        return round(m.ullTotalPhys / 1024**3, 1), round(m.ullAvailPhys / 1024**3, 1)
    return 0.0, 0.0


def detect_nvidia():
    if not shutil.which("nvidia-smi"):
        return []
    out = _run(["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version",
                "--format=csv,noheader,nounits"])
    gpus = []
    for line in out.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 4:
            gpus.append({"name": parts[0], "vendor": "nvidia",
                         "vram_gb": round(int(parts[1]) / 1024, 1),
                         "vram_free_gb": round(int(parts[2]) / 1024, 1),
                         "driver": parts[3], "engine": "cuda"})
    return gpus


def detect_vulkan():
    if not shutil.which("vulkaninfo"):
        return []
    out = _run(["vulkaninfo", "--summary"])
    gpus = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("deviceName"):
            name = line.split("=", 1)[1].strip()
            if "llvmpipe" in name.lower() or "microsoft basic" in name.lower():
                continue
            gpus.append({"name": name, "vendor": "other", "vram_gb": None, "engine": "vulkan"})
    return gpus


def detect_wmi():
    # AdapterRAM se queda en 4 GB como maximo (32 bits): solo sirve de respaldo.
    out = _run(["powershell", "-NoProfile", "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json"])
    try:
        data = json.loads(out) if out.strip() else []
    except json.JSONDecodeError:
        return []
    if isinstance(data, dict):
        data = [data]
    gpus = []
    for d in data:
        name = d.get("Name") or ""
        low = name.lower()
        if "basic" in low or "virtual" in low or "remote" in low:
            continue
        vendor = "amd" if ("amd" in low or "radeon" in low) else "intel" if "intel" in low else "nvidia" if "nvidia" in low else "other"
        ram = d.get("AdapterRAM") or 0
        gpus.append({"name": name, "vendor": vendor,
                     "vram_gb": round(ram / 1024**3, 1) if ram else None,
                     "engine": "cuda" if vendor == "nvidia" else "vulkan"})
    return gpus


def pick_profile(gpu, ram_total):
    if gpu is None:
        return "cpu", "bajo"
    vram = gpu.get("vram_gb") or 0
    # Integradas Intel/AMD sin VRAM dedicada conocida: Vulkan con perfil bajo.
    if vram <= 2.5:
        profile = "bajo"
    elif vram < 7.5:
        profile = "medio"
    else:
        profile = "alto"
    # Con poca RAM el offload no tiene adonde ir: bajar un escalon.
    if ram_total and ram_total < 12 and profile != "bajo" and PROFILES[profile]["offload_to_cpu"]:
        profile = "bajo"
    return gpu["engine"], profile


def detect():
    ram_total, ram_free = system_ram_gb()
    gpus = detect_nvidia() or detect_vulkan() or detect_wmi()
    # La de mas VRAM primero (portatiles con integrada + dedicada).
    gpus.sort(key=lambda g: g.get("vram_gb") or 0, reverse=True)
    gpu = gpus[0] if gpus else None
    engine, profile = pick_profile(gpu, ram_total)
    engine_dir = ROOT / "engine" / engine
    return {
        "gpu": gpu,
        "all_gpus": gpus,
        "ram_gb": ram_total,
        "ram_free_gb": ram_free,
        "engine": engine,
        "engine_present": (engine_dir / "sd-cli.exe").exists(),
        "profile": profile,
        "profile_rules": PROFILES[profile],
    }


def main():
    info = detect()
    print(json.dumps(info, indent=2, ensure_ascii=False))
    if "--write" in sys.argv:
        cfg = {}
        if CONFIG.exists():
            try:
                cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                cfg = {}
        cfg.setdefault("language", "es")
        cfg["hardware"] = info
        # El usuario puede fijar motor/perfil a mano; si no, se usa lo detectado.
        cfg.setdefault("manual", {"engine": None, "profile": None, "vram_limit_gb": None})
        # Como COMMANDLINE_ARGS de Forge: se pasan tal cual a sd-cli, despues del perfil.
        cfg["manual"].setdefault("extra_args", "")
        CONFIG.write_text(json.dumps(cfg, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"\nGuardado en {CONFIG}")


if __name__ == "__main__":
    main()
