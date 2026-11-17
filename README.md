# HexAnima PC

Versión para Windows de [HexAnima · Snapdragon 8 Gen 2](https://github.com/GrimmDev-Glitch/hexanima) (fork de [HexAnima de ayanoby](https://github.com/ayanoby/hexanima)). Genera imágenes en local con tu gráfica, sin nube ni cuenta, y está pensada para funcionar también en PCs modestos.

> Estado: **prototipo**. Ya funcionan el motor, la detección de hardware, la verificación de requisitos y un lanzador por línea de comandos. La interfaz está en diseño ([mockups](https://claude.ai/artifact/3hCLdFM6BFfVKXL4PT4UMM)).

## Cómo funciona

- **Motor:** [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (C++/ggml) con CUDA, Vulkan o CPU. Sin Python ni PyTorch en el equipo del usuario.
- **Portable:** una carpeta con `HexAnima.exe`; modelos, LoRAs e imágenes viven en las carpetas de al lado.
- **Perfiles por hardware:** al abrir, detecta la gráfica y la RAM y recomienda un perfil (el usuario puede elegir otro).

| Perfil | Cuándo | Ajustes |
|---|---|---|
| Bajo | ≤ 2 GB de VRAM o sin GPU | q4, offload a RAM, VAE por mosaicos, hasta 768 px |
| Medio | 3–7 GB | q8, offload a RAM, hasta 1024 px (SDXL hasta 1216) |
| Alto | ≥ 8 GB | f16 en GPU, hasta 1536 px |

## Carpeta

```
HexAnima.exe        (pendiente)
config.json         ajustes, perfil y resultado de la verificación (se genera)
engine/             motor: cuda/, vulkan/, cpu/   (ver engine/README.md)
models/             checkpoints/, text_encoders/, vae/, upscalers/, detectors/
loras/              LoRAs
outputs/            imágenes generadas
cache/ logs/ lang/
tools/              scripts del prototipo
```

## Prototipo

Requiere Python 3.10+ (solo para estos scripts; la app final no lo necesitará).

```bash
python tools/check_setup.py --write         # verificación de bienvenida + perfil recomendado
python tools/generate.py anima "1girl, silver hair, cherry blossoms" --seed 42
python tools/generate.py sdxl "masterpiece, 1girl" --model "ruta/a/checkpoint_illustrious.safetensors"
```

Opciones extra para el motor (como `COMMANDLINE_ARGS` de Forge): `config.json` → `manual.extra_args`.

### Modo adaptativo

Antes de cada imagen, `tools/adaptive.py` mide la VRAM y RAM **libres** y elige el primer escalón que entra. Nunca rechaza; en equipos chicos solo tarda más.

1. Pesos en VRAM → 2. pesos en RAM con offload → 3. q8 → q5 → q4 → 4. VAE por mosaicos y ~0,45 MP → 5. pesos leídos del disco (mmap).

Protecciones: deja 0,5 GB de VRAM y 1,5 GB de RAM para Windows, corre el motor con prioridad baja, en CPU deja 2 núcleos libres y en lotes pausa si la GPU llega a 83 °C (sigue al bajar de 72 °C). El tiempo estimado aprende de las generaciones anteriores (`cache/bench.json`).

```bash
python tools/generate.py sdxl "1girl" --model ruta.safetensors --count 4      # lote con pausas por temperatura
python tools/generate.py sdxl "1girl" --model ruta.safetensors --sim-vram 2 --sim-ram 8 --dry   # ver qué haría en otro equipo
python tools/generate.py anima "1girl" --no-adaptive                          # perfil fijo, sin medir
```

## Modelos probados (GTX 1650 4 GB, 16 GB RAM)

| Modelo | Ajustes | Tiempo |
|---|---|---|
| Anima Turbo v1.1 | 640×1024, 8 pasos, CFG 1, q8 + offload | ~120 s |
| Nova3DCG IL v9 (SDXL / Illustrious) | 832×1216, 28 pasos, CFG 5,5, q8 + offload | ~620 s |

## Créditos

HexAnima es obra de [ayanoby](https://github.com/ayanoby). Motor: stable-diffusion.cpp de leejet (MIT). Cada modelo conserva su propia licencia.
