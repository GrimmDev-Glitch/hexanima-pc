# HexAnima PC

**[🇬🇧 Read in English](README.md)**

Genera imágenes localmente en Windows con tu gráfica, sin una cuenta en la nube. HexAnima es compatible con gráficas NVIDIA, AMD e Intel, y ofrece CPU como alternativa para los trabajos compatibles.

> **Nota sobre el hardware:** El rendimiento y la compatibilidad de los modelos dependen de la RAM y la VRAM disponibles. Los perfiles con poca memoria pueden tardar mucho más y algunos modelos o tamaños podrían no caber. Consulta las notas de cada versión para ver en qué equipos se probó.

## Descargar e instalar

1. Descarga **`HexAnima-PC-<versión>.zip`** desde [Releases](https://github.com/GrimmDev-Glitch/hexanima-pc/releases/latest).
2. Descomprime la carpeta donde quieras. No necesita instalador ni permisos de administrador.
3. Abre **`HexAnima.exe`** y sigue las indicaciones iniciales. La app puede ofrecer el motor PyTorch para gráficas NVIDIA y un modelo inicial.

Requisitos: Windows 10/11 de 64 bits, al menos 8 GB de RAM (se recomiendan 16 GB) y una gráfica NVIDIA, AMD o Intel. Hay un modo CPU para trabajos compatibles, pero es mucho más lento.

## Funciones

- Genera con SDXL, Illustrious, Pony y Anima, con LoRAs, Hires fix, corrección de caras y manos, inpainting, ampliado y correcciones de imagen.
- Busca y descarga modelos y LoRAs de Civitai; organiza LoRAs en colecciones.
- Mantén un historial local con los ajustes guardados y exportación a ZIP.
- Lee etiquetas de una imagen para crear un prompt. En PC, el lector usa CPU para no quitarle VRAM a la generación.
- Cambia el idioma de la interfaz entre español e inglés en **Ajustes → Idioma**.
- Almacenamiento portable: modelos, LoRAs, imágenes generadas y ajustes viven junto a `HexAnima.exe`. Copia la carpeta completa para mover la instalación.

## Perfiles y motores

HexAnima detecta la gráfica, la memoria disponible y el motor compatible. El perfil ajusta los límites térmicos y las comprobaciones de memoria. En Windows, el modo CPU protegido limita el tiempo de CPU del motor y reserva memoria para el sistema. Estas protecciones no garantizan que todos los modelos y tamaños funcionen en cualquier PC.

| Hardware / familia del modelo | Motor |
|---|---|
| NVIDIA con SDXL / Illustrious / Pony | Se puede elegir PyTorch en Ajustes; también está disponible CUDA |
| NVIDIA con Anima | CUDA |
| AMD / Intel | Vulkan |
| Sin gráfica compatible | Modo CPU limitado, cuando sea compatible |

El motor PyTorch se descarga por separado. Algunos modelos necesitan mucha más memoria que otros; en PCs con poca memoria, empieza con dimensiones pequeñas.

## Carpetas

```text
HexAnima.exe
engine/      motores Vulkan y CUDA; PyTorch se descarga por separado
models/      checkpoints, modelos de difusión, codificadores de texto, VAEs y ampliadores
loras/       LoRAs
outputs/     imágenes generadas
config/      ajustes locales
```

Para añadir un modelo manualmente, cópialo a la carpeta correspondiente dentro de `models/` y actualiza la lista en la app.

## Desarrollo

La interfaz usa Tauri v2 (Rust + HTML/JavaScript en `app/`). Compila desde `app/src-tauri` con `cargo build --release`.

- `tools/package_release.py --version X.Y.Z` crea el ZIP portable del release.
- `tools/build_torch_engine.py` y `tools/package_torch_engine.py` compilan y empaquetan el motor PyTorch, que se distribuye por separado.
- `app/dev/preview_server.py` abre una vista previa de la interfaz en el navegador.

## Licencias

- La app (`app/`, `tools/`) usa licencia **MIT**; consulta [LICENSE](LICENSE).
- El motor PyTorch (`torch_engine/`, descargado en `engine/torch`) usa **AGPL-3.0** porque contiene código de Stable Diffusion WebUI Forge. Se ejecuta como proceso separado.
- Las licencias de los motores, modelos y otros componentes están en [THIRD_PARTY.md](THIRD_PARTY.md). Cada modelo conserva su propia licencia.

## Créditos

HexAnima fue creado por [ayanoby](https://github.com/ayanoby). Motores: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp), de leejet, y el backend [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge), de lllyasviel.
