# HexAnima PC

## 0.3.2 — Qwen and MOSS LoRAs in Civitai

### What's new

- Added Civitai LoRA family filters for Qwen-Image (`Qwen`, `Qwen 2.1`) and MOSS-Image (`MOSS Image`).
- Opening Civitai from the model picker now follows the selected Qwen or MOSS family.
- The local LoRA library recognizes these bases when showing compatibility badges.

### Validation and known limits

- The user confirmed the local test executable shows the new Qwen and MOSS filters.
- This release changes Civitai discovery and local LoRA labeling. It does not change model inference or guarantee every community LoRA works with every model version.

## 0.3.1 — Forge-style low-VRAM PyTorch

### What's new

- PyTorch can keep SDXL safetensors weights mapped from disk instead of cloning the UNet and VAE into private RAM.
- Systems with 4 GB of VRAM or less automatically use Forge's low-VRAM model management with a smaller CUDA inference budget.
- Low-VRAM generations reduce image dimensions when needed and skip Hires, pose, character reference, and ADetailer to leave room for the base image.
- A CUDA out-of-memory error gets one retry at a lower resolution. The Windows RAM/commit reserve, process memory limit, CPU cap, and thermal threshold remain active.

### Validation and known limits

- Rust release and Python/JavaScript syntax checks completed. A full model generation on the GTX 1050 2 GB was not run.
- Disk-mapped safetensors may become much slower when Windows has to page model weights. Checkpoints in other formats do not use this low-RAM loading path.
- At 2 GB of VRAM, HexAnima may reduce the image below its requested dimensions or stop if the system reaches the protected memory or thermal limit.

## 0.3.0 — safer CPU fallback and faster ×2 upscale

### What's new

- Automatic PyTorch fallback can use the CPU backend shipped with the CUDA/Vulkan engine package. CPU inference remains capped, RAM-limited, and uses disk-mapped weights when appropriate.
- Fast ×2 Real-ESRGAN reduces the source before inference, cutting the tile count for a 768 × 768 image from 64 to about 16, with a small detail tradeoff.
- Added an instant, no-AI resize option for cases where speed matters more than reconstructing detail.

### Validation and known limits

- The optimized Windows executable was built in Rust release mode. End-to-end generation and AI upscaling were not run for this release.
- CPU fallback and AI upscaling can remain slow on low-end hardware. The no-AI resize enlarges the image but does not invent detail.
- The Windows memory reserve, RAM/commit preflight, managed-process limits, and thermal checks remain active.

## 0.2.9 — PyTorch memory preflight

### What's new

- Automatic mode estimates PyTorch's checkpoint and runtime memory before loading. If the estimate would cross the Windows reserve, it switches to capped CPU with disk-mapped weights.
- A manually selected PyTorch engine now reports the estimated peak and available safe memory before starting the load.
- The load status identifies capped CPU and disk-mapped weights so users know why generation may take longer.

### Validation and known limits

- The Windows reserve and managed-engine memory watchdog remain active.
- CPU generation remains slow and still requires enough free memory, commit headroom, and disk space for the selected model and resolution.
- This fallback path has not yet been confirmed by a complete generation on the GTX 1050 2 GB system.

## 0.2.8 — laptop thermal telemetry handling

### What's new

- A readable current GPU temperature is enough to apply HexAnima's thermal profile. Missing driver target-temperature metadata no longer blocks PyTorch/CUDA on otherwise cool laptops.
- When the driver reports a valid lower target temperature, HexAnima uses that stricter limit. Missing current-temperature telemetry still falls back to the protected CPU path in Automatic mode or reports why a manually selected GPU engine cannot start.

### Validation and known limits

- The profile thresholds remain 75 °C (Low), 78 °C (Medium), and 80 °C (High), capped further by a valid lower driver target.
- A complete image generation on a GTX 1050 2 GB / 8 GB RAM PC remains unverified.

## 0.2.7 — PyTorch engine updates from Settings

### What's new

- Settings always offers **Check for updates** for the PyTorch engine. If a newer package is available, open the built-in update dialog and install it from the app.
- The installed status now reads the package manifest and PyTorch/CUDA runtime metadata. Older engine installs without `motor.json` still show their runtime version and can be updated.
- The update download resumes if interrupted, verifies the SHA-256, and swaps the engine only after extraction succeeds.

### Validation and known limits

- The update package is downloaded separately from the HexAnima app release. The first version check and update need internet access and enough free disk space for the download and extracted engine.
- A complete image generation on a GTX 1050 2 GB / 8 GB RAM PC remains unverified.

## 0.2.6 — low-memory SDXL and backend selection

### What's new

- Automatic mode no longer silently routes NVIDIA SDXL jobs to Vulkan when PyTorch or CUDA is unavailable, or when GPU thermal telemetry is missing. It uses a capped CPU fallback when available.
- When a checkpoint exceeds the safe RAM budget, native CUDA/CPU loading maps weights from disk instead of rejecting the model based on total checkpoint size. The Windows reserve and pressure watchdog remain active.
- PyTorch remains the explicitly selected engine. If its private-memory loading path cannot fit the checkpoint, the app explains the constraint; automatic mode can use the disk-mapped native path.
- Settings now shows the installed PyTorch package version and detected CUDA runtime.

### Verification and known limits

- The low-memory path relies on stable-diffusion.cpp memory mapping and still requires free disk space, an available page file, and enough memory for the selected resolution's working buffers.
- A complete image generation on a GTX 1050 2 GB / 8 GB RAM system has not yet been verified. The engine remains subject to the Windows memory reserve and stop watchdog.

## 0.2.5 — backend, memory and cancellation safeguards

### What's new

- Manual backend selection is now authoritative. If the selected engine, model, device, or required telemetry is unavailable, HexAnima reports the reason instead of silently switching engines.
- Generation preflight checks both available physical RAM and Windows commit headroom. A system-wide watchdog requests cancellation under critical memory pressure and terminates only HexAnima's managed engine process if pressure persists.
- Windows memory and process limits are configured before starting the inference engine. Stop sends cancellation immediately and closes the managed process after a bounded timeout if it stalls.
- Backend logs identify the selected engine and device. The PyTorch engine reports whether it is actually using CUDA or CPU.

### Verification and known limits

Eight automated tests pass; seven network, installation, or real-model tests remain ignored. JavaScript and Python syntax checks and the production Rust build pass. A full generation and cancellation cycle on the GTX 1650 has not yet been verified. The PyTorch engine is distributed separately; after updating HexAnima PC, update it from Settings → PyTorch Engine to receive the runtime diagnostic endpoint.

## 0.2.4 — previous release

## What's new

- **Hardware-aware resource protection:** detect the GPU actually used, check available RAM and VRAM before accepting generation, apply profile-based thermal limits, and use a Windows CPU hard cap and RAM budget in protected fallback mode.
- **Engine and resource protection:** reserve the engine to one HexAnima instance, handle engine shutdown explicitly, and apply Windows RAM and CPU limits in protected fallback mode.
- **Low-memory image editing and upscaling:** open the Qwen mask editor from the history/edit controls and process CPU upscaling in tiles to reduce peak memory use.
- **Image prompt reader:** show an “Obtaining image tags” dialog while the image is analyzed; use CPU int8 linear layers to reduce the tagger's memory footprint without taking GPU memory.
- **English interface:** switch between Spanish and English from Settings. The app's README is now in English with a Spanish-language link.

## Validation and known limits

The exact Windows ZIP passed its integrity check, and both CUDA and Vulkan engines started with the CPU limit on the GTX 1050 2 GB / 16 GB RAM PC. The 2.5 GiB Windows memory reserve stopped the Anima run before image generation when free RAM fell below the limit. A complete generation and cancellation cycle on this exact ZIP, a second-PC Vulkan run, and the 8 GB compatibility matrix remain unverified. Model, resolution, and available memory still determine whether a job can run. Do not treat the 8 GB minimum as a guarantee that every model will fit.

The PyTorch runtime is downloaded separately and is not included in this GitHub release. **Search for updates** replaces only `HexAnima.exe`; it does not update an existing PyTorch runtime. PyTorch worker-queue changes in the repository source are not active for existing installations until that separate runtime package is published.

## Español

## 0.3.0 — fallback seguro por CPU y ampliado ×2 más rápido

### Novedades

- El fallback automático de PyTorch puede usar el backend CPU que viene con el paquete CUDA/Vulkan. La inferencia CPU mantiene el límite de uso, los límites de RAM y el mapeo de pesos desde disco cuando corresponde.
- Real-ESRGAN rápido ×2 reduce la imagen antes de inferir. En una imagen de 768 × 768 baja de 64 a unos 16 mosaicos, con una pequeña pérdida de detalle.
- Se añadió una opción de redimensionado instantáneo sin IA para priorizar velocidad sobre reconstrucción de detalles.

### Validación y límites conocidos

- El ejecutable optimizado de Windows se compiló en modo Rust release. No se ejecutaron generaciones ni ampliados de IA completos para esta release.
- El fallback CPU y el ampliado con IA aún pueden tardar mucho en equipos modestos. El redimensionado sin IA aumenta el tamaño, pero no inventa detalles.
- Siguen activos la reserva de memoria para Windows, las comprobaciones de RAM y memoria comprometida, los límites del proceso administrado y las comprobaciones térmicas.

## 0.2.8 — lectura térmica en laptops

### Novedades

- Una lectura válida de la temperatura actual basta para aplicar el perfil térmico de HexAnima. Si el driver omite la temperatura objetivo, eso ya no bloquea PyTorch/CUDA en laptops que están dentro del límite.
- Si el driver informa un límite objetivo válido más bajo, HexAnima aplica ese límite más estricto. Si falta la lectura de temperatura actual, el modo Automático sigue usando la ruta protegida por CPU o el motor GPU seleccionado manualmente explica por qué no puede iniciar.

### Validación y límites conocidos

- Se mantienen los umbrales de 75 °C (Bajo), 78 °C (Medio) y 80 °C (Alto), limitados por una temperatura objetivo válida más baja que indique el driver.
- Sigue sin verificarse una generación completa en un PC con GTX 1050 de 2 GB y 8 GB de RAM.

## 0.2.7 — actualización del motor PyTorch desde Ajustes

### Novedades

- Ajustes siempre ofrece **Buscar actualizaciones** para el motor PyTorch. Si hay una versión nueva, abre el diálogo de actualización integrado y permite instalarla desde la app.
- El estado instalado ahora lee el manifiesto del paquete y los metadatos de PyTorch/CUDA. Las instalaciones antiguas sin `motor.json` muestran la versión del runtime y también se pueden actualizar.
- La descarga se reanuda si se interrumpe, verifica el SHA-256 y reemplaza el motor solo después de extraerlo correctamente.

### Validación y límites conocidos

- El paquete del motor se descarga separado del release de HexAnima. La primera consulta y actualización necesitan internet y espacio libre suficiente para la descarga y la extracción.
- Sigue pendiente verificar una generación completa en un PC con GTX 1050 de 2 GB y 8 GB de RAM.

## 0.2.6 — SDXL con poca RAM y selección del motor

### Novedades

- El modo Automático ya no envía silenciosamente trabajos SDXL de NVIDIA a Vulkan si PyTorch o CUDA no están disponibles, o si falta la telemetría térmica. Usa CPU limitada cuando está disponible.
- Si un checkpoint supera el margen seguro de RAM, la carga nativa con CUDA/CPU mapea los pesos desde el disco en vez de rechazar el modelo por su tamaño total. Se mantienen la reserva de Windows y el monitor de presión.
- PyTorch respeta la selección manual. Si la carga privada de memoria no cabe, la app explica el límite; el modo Automático puede usar la ruta nativa con pesos desde disco.
- Ajustes ahora muestra la versión instalada del paquete PyTorch y la versión CUDA detectada.

### Validación y límites conocidos

- La ruta de poca RAM usa el mapeo de memoria de stable-diffusion.cpp y requiere espacio libre en disco, archivo de paginación disponible y memoria suficiente para los buffers de trabajo de la resolución.
- Aún no se verificó una generación completa en un equipo con GTX 1050 de 2 GB y 8 GB de RAM. Siguen activos la reserva de Windows y el monitor de detención.

## 0.2.5 — protección de backend, memoria y cancelación

### Novedades

- La selección manual del motor ahora se respeta. Si el motor, modelo, dispositivo o telemetría necesarios no están disponibles, HexAnima explica el motivo en vez de cambiar de motor sin avisar.
- La comprobación previa revisa la RAM física disponible y el margen de memoria comprometida de Windows. Un monitor del sistema pide cancelar ante presión crítica y, si persiste, termina solo el proceso del motor administrado por HexAnima.
- Los límites de memoria y procesos de Windows se configuran antes de iniciar el motor. Detener envía la cancelación de inmediato y cierra el proceso administrado si deja de responder.
- Los registros identifican el motor y dispositivo seleccionados. El motor PyTorch informa si realmente usa CUDA o CPU.

### Validación y límites

Pasaron ocho pruebas automatizadas; siete pruebas de red, instalación o modelos reales siguen ignoradas. También pasaron la compilación Rust de producción y las comprobaciones de sintaxis de JavaScript y Python. Aún no se verificó una generación completa y su cancelación en la GTX 1650. El motor PyTorch se distribuye por separado; después de actualizar HexAnima PC, actualízalo desde Ajustes → Motor PyTorch para recibir el diagnóstico de dispositivo.

## 0.2.4 — versión anterior (español)

- **Protección según el hardware:** detecta la gráfica que realmente se usa, revisa RAM y VRAM libres antes de aceptar una generación, aplica límites térmicos por perfil y limita CPU y RAM del motor en el modo protegido de Windows.
- **Protección del motor y los recursos:** reserva el motor para una sola instancia de HexAnima, maneja explícitamente su cierre y aplica límites de RAM y CPU de Windows en el modo protegido.
- **Edición y ampliado con poca memoria:** abre la máscara de Qwen desde el historial y los controles de edición; amplía en mosaicos por CPU para reducir el pico de memoria.
- **Prompt desde una imagen:** muestra una ventana de “Obteniendo etiquetas” mientras analiza la imagen; usa capas lineales int8 en CPU para reducir la memoria del lector sin ocupar la GPU.
- **Interfaz en inglés:** permite cambiar entre español e inglés en Ajustes. El README principal ahora está en inglés e incluye un enlace a la versión española.

## Validación y límites conocidos

El ZIP exacto de Windows pasó la comprobación de integridad y los motores CUDA y Vulkan arrancaron con límite de CPU en el PC con GTX 1050 de 2 GB y 16 GB de RAM. La reserva de 2,5 GiB para Windows detuvo la prueba de Anima antes de generar cuando la RAM libre cayó bajo el margen. En este ZIP aún no se verificaron una generación completa ni su cancelación, una prueba de Vulkan en un segundo PC ni la matriz de compatibilidad con 8 GB. El modelo, la resolución y la memoria disponible siguen determinando si un trabajo puede ejecutarse. El mínimo de 8 GB no garantiza que quepa cualquier modelo.

El motor PyTorch se descarga por separado y no está incluido en este release de GitHub. **Buscar actualizaciones** reemplaza solo `HexAnima.exe`; no actualiza un motor PyTorch que ya esté instalado. Los cambios de cola del worker PyTorch que están en el código fuente no llegan a las instalaciones existentes hasta publicar ese paquete por separado.
