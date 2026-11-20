# HexAnima PC 0.2.4

## What's new

- **Hardware-aware resource protection:** detect the GPU actually used, check available RAM and VRAM before accepting generation, apply profile-based thermal limits, and use a Windows CPU hard cap and RAM budget in protected fallback mode.
- **Engine and resource protection:** reserve the engine to one HexAnima instance, handle engine shutdown explicitly, and apply Windows RAM and CPU limits in protected fallback mode.
- **Low-memory image editing and upscaling:** open the Qwen mask editor from the history/edit controls and process CPU upscaling in tiles to reduce peak memory use.
- **Image prompt reader:** show an “Obtaining image tags” dialog while the image is analyzed; use CPU int8 linear layers to reduce the tagger's memory footprint without taking GPU memory.
- **English interface:** switch between Spanish and English from Settings. The app's README is now in English with a Spanish-language link.

## Validation and known limits

The exact Windows ZIP passed its integrity check, and both CUDA and Vulkan engines started with the CPU limit on the GTX 1050 2 GB / 16 GB RAM PC. The 2.5 GiB Windows memory reserve stopped the Anima run before image generation when free RAM fell below the limit. A complete generation and cancellation cycle on this exact ZIP, a second-PC Vulkan run, and the 8 GB compatibility matrix remain unverified. Model, resolution, and available memory still determine whether a job can run. Do not treat the 8 GB minimum as a guarantee that every model will fit.

The PyTorch runtime is downloaded separately and is not included in this GitHub release. **Search for updates** replaces only `HexAnima.exe`; it does not update an existing PyTorch runtime. PyTorch worker-queue changes in the repository source are not active for existing installations until that separate runtime package is published.

## Novedades (español)

- **Protección según el hardware:** detecta la gráfica que realmente se usa, revisa RAM y VRAM libres antes de aceptar una generación, aplica límites térmicos por perfil y limita CPU y RAM del motor en el modo protegido de Windows.
- **Protección del motor y los recursos:** reserva el motor para una sola instancia de HexAnima, maneja explícitamente su cierre y aplica límites de RAM y CPU de Windows en el modo protegido.
- **Edición y ampliado con poca memoria:** abre la máscara de Qwen desde el historial y los controles de edición; amplía en mosaicos por CPU para reducir el pico de memoria.
- **Prompt desde una imagen:** muestra una ventana de “Obteniendo etiquetas” mientras analiza la imagen; usa capas lineales int8 en CPU para reducir la memoria del lector sin ocupar la GPU.
- **Interfaz en inglés:** permite cambiar entre español e inglés en Ajustes. El README principal ahora está en inglés e incluye un enlace a la versión española.

## Validación y límites conocidos

El ZIP exacto de Windows pasó la comprobación de integridad y los motores CUDA y Vulkan arrancaron con límite de CPU en el PC con GTX 1050 de 2 GB y 16 GB de RAM. La reserva de 2,5 GiB para Windows detuvo la prueba de Anima antes de generar cuando la RAM libre cayó bajo el margen. En este ZIP aún no se verificaron una generación completa ni su cancelación, una prueba de Vulkan en un segundo PC ni la matriz de compatibilidad con 8 GB. El modelo, la resolución y la memoria disponible siguen determinando si un trabajo puede ejecutarse. El mínimo de 8 GB no garantiza que quepa cualquier modelo.

El motor PyTorch se descarga por separado y no está incluido en este release de GitHub. **Buscar actualizaciones** reemplaza solo `HexAnima.exe`; no actualiza un motor PyTorch que ya esté instalado. Los cambios de cola del worker PyTorch que están en el código fuente no llegan a las instalaciones existentes hasta publicar ese paquete por separado.
