"""HexAnima PC - modo adaptativo.

Antes de cada imagen mide la memoria LIBRE (no la total), estima cuanto ocupa el
modelo y elige el primer escalon de la escalera que entra. Nunca rechaza: el
ultimo escalon lee los pesos desde el disco, que siempre funciona aunque tarde.

Escalera (de mas rapido a mas lento):
  1. pesos en VRAM            (cabe todo en la grafica)
  2. pesos en RAM + offload   (se suben a la grafica por partes)
  3. cuantizacion menor       q8 -> q5 -> q4
  4. VAE por mosaicos + resolucion algo menor
  5. pesos desde el disco     (mmap: casi no usa RAM)

Protecciones: margen de VRAM para Windows, prioridad baja del proceso, hilos
limitados en CPU y pausas por temperatura entre imagenes de un lote.
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

from detect_hw import ROOT, system_ram_gb

GB = 1024 ** 3
VRAM_RESERVE_GB = 0.5      # lo que se deja libre para Windows y el navegador
RAM_RESERVE_GB = 1.5       # idem en RAM: por debajo Windows empieza a paginar
RAM_OVERFLOW_GB = 1.0      # cuanto puede pasarse antes de ir al disco (medido: ok con 0,9 GB libres)
TEMP_PAUSE_C = 83          # pausa entre imagenes si la GPU llega aqui...
TEMP_RESUME_C = 72         # ...y sigue cuando baja de aqui
BENCH_FILE = ROOT / "cache" / "bench.json"

# Tamano relativo a f16 de cada tipo de peso (aprox. ggml).
QUANT_RATIO = {"f16": 1.0, "q8_0": 0.53, "q5_K": 0.36, "q4_K": 0.30}
# Medido en GTX 1650 (SDXL 832x1216, offload): q8 17 s/paso, f16 37 s, q4_K 61 s.
# En graficas sin tensor cores q4/q5 ahorran memoria pero triplican el tiempo, asi
# que la escalera automatica no baja de q8: primero baja resolucion y luego usa disco.
# config.json -> manual.allow_low_quant = true los vuelve a habilitar (p.ej. en RTX).
LADDER_TYPES = ["f16", "q8_0"]
LADDER_TYPES_LOWQ = ["f16", "q8_0", "q5_K", "q4_K"]

# Memoria de calculo en la GPU (activaciones) a 1 megapixel, medida/estimada.
COMPUTE_GB_PER_MP = {"anima": 0.9, "sdxl": 1.4}
VAE_GB_PER_MP = {"anima": 1.6, "sdxl": 2.6}      # sin mosaicos
VAE_TILED_GB = 0.6


def _nvidia_query(fields):
    if not shutil.which("nvidia-smi"):
        return None
    try:
        out = subprocess.run(["nvidia-smi", f"--query-gpu={fields}", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=10,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
        return [x.strip() for x in out.strip().splitlines()[0].split(",")]
    except (OSError, subprocess.TimeoutExpired, IndexError):
        return None


def measure():
    """Recursos libres AHORA."""
    _, ram_free = system_ram_gb()
    q = _nvidia_query("memory.free,temperature.gpu")
    vram_free = round(int(q[0]) / 1024, 1) if q else None
    temp = int(q[1]) if q and q[1].isdigit() else None
    return {"ram_free_gb": ram_free, "vram_free_gb": vram_free, "gpu_temp_c": temp}


def model_f16_gb(files):
    """Tamano de los pesos en f16. Los .safetensors bf16/f16 pesan eso en disco."""
    total = 0.0
    for p in files:
        p = Path(p)
        if p.exists():
            size = p.stat().st_size / GB
            total += size if p.suffix == ".safetensors" else size / 0.53  # gguf ~q8
    return total


def plan(family, files, w, h, rules, engine, vram_limit_gb=None, sim=None, allow_low_quant=False):
    """Elige escalon. Devuelve dict con args extra, tamano final, notas y estimacion.

    rules: perfil (techo de calidad: tipo de peso minimo y lado maximo).
    sim:   {"vram_gb": 2, "ram_gb": 8} para simular otro equipo.
    """
    res = measure()
    if sim:
        res["vram_free_gb"] = sim.get("vram_gb", res["vram_free_gb"])
        res["ram_free_gb"] = sim.get("ram_gb", res["ram_free_gb"])
    vram = res["vram_free_gb"] if engine != "cpu" else 0.0
    if vram is None:
        vram = 0.0  # AMD/Intel: no medimos; auto-fit del motor decide
    if vram_limit_gb:
        vram = min(vram, vram_limit_gb)
    vram_usable = max(0.0, vram - VRAM_RESERVE_GB)
    ram_usable = max(0.0, res["ram_free_gb"] - RAM_RESERVE_GB)

    f16 = model_f16_gb(files)
    mp = w * h / 1e6
    compute = COMPUTE_GB_PER_MP.get(family, 1.2) * mp
    notes = []

    # El perfil marca el mejor tipo permitido; la escalera solo baja desde ahi.
    ladder = LADDER_TYPES_LOWQ if allow_low_quant else LADDER_TYPES
    best = rules["weight_type"] if rules["weight_type"] in ladder else "q8_0"
    start = ladder.index(best)
    chosen = None
    # f16 solo si cabe entero en VRAM: con offload es mas lento que q8.
    for t in ladder[start:]:
        weights = f16 * QUANT_RATIO[t]
        if engine != "cpu" and weights + compute <= vram_usable:
            chosen = {"type": t, "place": "vram", "weights_gb": weights}
            break
    if chosen is None:
        for t in ladder[max(start, 1):]:
            weights = f16 * QUANT_RATIO[t]
            if weights <= ram_usable:
                chosen = {"type": t, "place": "ram", "weights_gb": weights}
                break
    if chosen is None:
        # Se pasa por poco: RAM igual (Windows pagina un poco, como en Forge). Es mas
        # rapido que leer todo del disco; solo avisamos.
        t = ladder[max(start, 1)]
        weights = f16 * QUANT_RATIO[t]
        if weights <= res["ram_free_gb"] + RAM_OVERFLOW_GB:
            chosen = {"type": t, "place": "ram", "weights_gb": weights}
            notes.append("RAM justa: cierra el navegador u otros programas para que vaya más rápido.")
    if chosen is None:
        t = ladder[-1]
        chosen = {"type": t, "place": "disk", "weights_gb": f16 * QUANT_RATIO[t]}
        notes.append("Poca RAM libre: los pesos se leen desde el disco. Funciona, pero tarda bastante más.")

    # VAE: mosaicos si no cabe entero en lo que queda de VRAM.
    vae_need = VAE_GB_PER_MP.get(family, 2.0) * mp
    vae_tiling = rules.get("vae_tiling", False) or engine == "cpu" or vae_need > vram_usable
    # Resolucion: la palanca mas grande en equipos chicos (la atencion crece mas rapido
    # que los pixeles). Con disco o <2 GB de VRAM util, ~0.45 MP (p.ej. 576x768),
    # como se usa en Forge con GTX 1050 de 2 GB.
    target_mp = 0.45 if (chosen["place"] == "disk" or vram_usable < 2.0) else None
    if target_mp and mp > target_mp * 1.1:
        k = (target_mp / mp) ** 0.5
        w, h = int(w * k) // 64 * 64, int(h * k) // 64 * 64
        notes.append(f"Resolución ajustada a {w}×{h} para tu memoria.")

    args = []
    if chosen["type"] != "f16":
        args += ["--type", chosen["type"]]
    if chosen["place"] == "ram":
        args += ["--offload-to-cpu"]
    elif chosen["place"] == "disk":
        args += ["--mmap", "--params-backend", "disk"]
    if vae_tiling:
        args += ["--vae-tiling"]
    if engine != "cpu":
        # Negativo = reservar esa VRAM libre para el sistema.
        args += ["--max-vram", f"-{VRAM_RESERVE_GB}"]
    else:
        cores = os.cpu_count() or 4
        args += ["-t", str(max(2, cores - 2))]   # deja nucleos libres para Windows

    if chosen["type"] != rules["weight_type"]:
        notes.append(f"Modelo en {chosen['type']} (más liviano) por la memoria disponible.")

    return {"args": args, "w": w, "h": h, "type": chosen["type"], "place": chosen["place"],
            "vae_tiling": vae_tiling, "weights_gb": round(chosen["weights_gb"], 2),
            "resources": res, "notes": notes}


# ---- Estimacion de tiempo: aprende de las generaciones anteriores en este equipo ----

def _bench_key(family, place, t, mp):
    return f"{family}|{place}|{t}|{round(mp, 1)}"


def estimate(family, p, steps):
    """Segundos estimados, o None si no hay datos aun de este equipo."""
    try:
        bench = json.loads(BENCH_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    mp = p["w"] * p["h"] / 1e6
    exact = bench.get(_bench_key(family, p["place"], p["type"], mp))
    if exact:
        return exact["fixed_s"] + exact["step_s"] * steps
    # Escalar desde cualquier medicion de la misma familia por megapixeles.
    same = [v for k, v in bench.items() if k.startswith(family + "|")]
    if not same:
        return None
    v = same[-1]
    k = mp / v["mp"]
    slow = 3.0 if p["place"] == "disk" and v.get("place") != "disk" else 1.0
    return (v["fixed_s"] * k + v["step_s"] * k * steps) * slow


def record(family, p, steps, sampling_s, total_s):
    """Guarda la velocidad medida para afinar las proximas estimaciones."""
    try:
        bench = json.loads(BENCH_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        bench = {}
    mp = p["w"] * p["h"] / 1e6
    bench[_bench_key(family, p["place"], p["type"], mp)] = {
        "step_s": round(sampling_s / max(1, steps), 2),
        "fixed_s": round(total_s - sampling_s, 1),
        "mp": round(mp, 2), "place": p["place"], "when": time.strftime("%Y-%m-%d %H:%M"),
    }
    BENCH_FILE.parent.mkdir(exist_ok=True)
    BENCH_FILE.write_text(json.dumps(bench, indent=2), encoding="utf-8")


def wait_if_hot(log=print):
    """Entre imagenes de un lote: si la GPU esta muy caliente, espera a que baje."""
    t = measure()["gpu_temp_c"]
    if t is None or t < TEMP_PAUSE_C:
        return 0
    log(f"GPU a {t} °C: pausa para enfriar (sigue al bajar de {TEMP_RESUME_C} °C)...")
    t0 = time.time()
    while True:
        time.sleep(10)
        t = measure()["gpu_temp_c"]
        if t is None or t <= TEMP_RESUME_C or time.time() - t0 > 600:
            break
    log(f"Seguimos ({t} °C, {time.time() - t0:.0f} s de pausa).")
    return time.time() - t0
