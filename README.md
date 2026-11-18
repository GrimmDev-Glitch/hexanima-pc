# HexAnima PC

Versión para Windows de [HexAnima · Snapdragon 8 Gen 2](https://github.com/GrimmDev-Glitch/hexanima) (fork de [HexAnima de ayanoby](https://github.com/ayanoby/hexanima)). Genera imágenes en local con tu gráfica, sin nube ni cuenta, y está pensada para funcionar también en PCs modestos (probada en una GTX 1650 de 4 GB con 16 GB de RAM).

## Descargar e instalar

1. Descarga **`HexAnima-PC-<versión>.zip`** desde [Releases](https://github.com/GrimmDev-Glitch/hexanima-pc/releases/latest).
2. Descomprímelo donde quieras (por ejemplo en el Escritorio). No necesita instalación ni permisos de administrador.
3. Abre **`HexAnima.exe`**. La bienvenida te guía:
   - **Gráfica NVIDIA:** ofrece el **motor rápido** (PyTorch, 2,5 GB), hasta 3 veces más rápido en SDXL / Illustrious / Pony.
   - **Primer modelo:** descarga **Anima Turbo** (5,6 GB) con un botón, o pulsa *Omitir* y busca modelos en la pestaña **Civitai**.

Requisitos: Windows 10/11 de 64 bits, 8 GB de RAM como mínimo (16 GB recomendado) y una gráfica NVIDIA, AMD o Intel. Sin gráfica compatible usa el procesador (muy lento).

## Qué hace

- **Generar** con SDXL, Illustrious, Pony y Anima, LoRAs (también desde Civitai), Hires fix, ADetailer (caras y manos), zona a cambiar (inpainting), ampliar ×2/×4 y correcciones.
- **Civitai** integrado: buscar y descargar modelos y LoRAs, guardar colecciones como carpetas.
- **Historial** con favoritas, ajustes guardados en cada PNG y exportar a ZIP.
- **Portable:** todo vive en la carpeta de `HexAnima.exe` (modelos, LoRAs, imágenes). Para llevártela a otro PC, copia la carpeta.

## Carpeta

```
HexAnima.exe
engine/      motores: vulkan/ y cuda/ (stable-diffusion.cpp), torch/ (motor rápido, se descarga)
models/      checkpoints/, diffusion_models/, text_encoders/, vae/, upscalers/, detectors/
loras/       LoRAs
outputs/     imágenes generadas
config/      tus ajustes (se crean al usarla)
```

Para añadir modelos a mano, cópialos en su carpeta de `models/` y pulsa **↻** en la app.

## Motores

| Gráfica | Motor |
|---|---|
| NVIDIA | **PyTorch** (motor rápido, como Forge) para SDXL; CUDA para Anima |
| AMD / Intel | Vulkan |
| Sin gráfica compatible | CPU |

En una GTX 1650, SDXL 832×1216: PyTorch 8,5 s/paso, Forge ~15 s/paso, CUDA (sd.cpp) 24 s/paso.

## Desarrollo

La interfaz es Tauri v2 (Rust + HTML/JS en `app/`). Compilar: `cd app/src-tauri && cargo build --release` y copiar `target/release/hexanima.exe` como `HexAnima.exe`.

- `tools/package_release.py --version X`: zip para Releases.
- `tools/build_torch_engine.py` y `tools/package_torch_engine.py`: arman y empaquetan el motor PyTorch, que se publica en [Hugging Face](https://huggingface.co/GrimmDev-Glitch/hexanima-packs/tree/main/pc_torch).
- `app/dev/preview_server.py`: vista previa de la interfaz en el navegador.

## Licencias

- La app (`app/`, `tools/`): **MIT** (ver [LICENSE](LICENSE)).
- El motor PyTorch (`torch_engine/`, descargado en `engine/torch`): **AGPL-3.0**, porque usa el backend de Stable Diffusion WebUI Forge. Se ejecuta como un programa aparte.
- Motores, modelos y demás componentes: ver [THIRD_PARTY.md](THIRD_PARTY.md). Cada modelo conserva su propia licencia.

## Créditos

HexAnima es obra de [ayanoby](https://github.com/ayanoby). Motores: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) de leejet y el backend de [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) de lllyasviel.
