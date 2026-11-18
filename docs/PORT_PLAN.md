# HexAnima PC · Inventario del teléfono y plan del port

Objetivo: que HexAnima PC tenga las mismas pestañas, ventanas y funciones que **HexAnima Snapdragon 8 Gen 2** (Android), con los mismos textos en español, pero funcionando en PC con stable-diffusion.cpp.

Fuente: el código de la app Android (`Hexanima/app/src/com/hexanima/npu/*.java`, textos en `app/assets/lang/es.tsv`) y la documentación del motor (`stable-diffusion.cpp`, versión `master-532d2c1`).

**Estado:** ✅ hecho · 🟡 parcial · ⬜ falta · ➖ no aplica en PC

> **Avance (17 nov 2026):** fase 1 hecha — barra de la imagen (solo iconos, fuera del lienzo), visor, Otra vez / Variaciones, antes/después, Ampliar (Real-ESRGAN / UltraSharp ×2/×4), selector de modelo con tarjetas, Cargar / Liberar, menú ⋯, plantillas de configuración, ajustes desde PNG, # Etiquetas, autocompletar Danbooru, negativo (Predeterminado / Plantillas / Borrar), contador de tokens, ↺. Historial completo con filtros y selección múltiple; papelera = Papelera de reciclaje de Windows (en lugar de la de 30 días). Exportar ZIP desde el Historial ✅.
>
> **Fase 2 (en curso):** ✎ Zona a cambiar (editor de máscara: Pincel / Borrador / Mover, tamaño, Deshacer / Rehacer, Invertir, Limpiar, zoom con la rueda) ✅ probado con el motor real; Hires fix (escala / denoise / pasos / ampliador) ✅. Extra pedido: **Colecciones de Civitai** (☆ en las tarjetas y en la ficha, carpetas en LoRAs → COLECCIONES, «Descargar las que faltan», «♥ Traer mis favoritos de Civitai»). ADetailer Caras / Manos ✅ (detectores YOLOv8 de Bingsu/adetailer descargados y convertidos por la app, sin Python; un detector por motor, cambiarlo reinicia el motor). Correcciones ✅ (Ruido, Resolución, Cara, Manos, Detalles, Otros; 🔍 Detectar y ✨ Corregir todas con el detector del motor; Usar esta / Descartar / Deshacer / Rehacer / Guardar). Botón ↻ Actualizar para modelos y LoRAs copiados a mano. Siguiente: Comparar 2×2, hojas de contactos, ✦ Estilo ChatGPT.

---

## 1. Pantalla principal (Generar)

En el teléfono es una sola columna con secciones plegables. En PC se reparte en lienzo + panel de controles, sin barra de desplazamiento.

| Elemento del teléfono | Estado PC | Notas |
|---|---|---|
| Cabecera: botón **Historial** y menú **⋯** | 🟡 | Barra lateral con Generar / LoRAs / Historial / Ajustes. Falta el menú ⋯ (ver §2). |
| Línea de avisos (calor, memoria…) | 🟡 | Hay línea de estado; faltan avisos de calor y memoria baja. |
| **Selector de modelo** con tarjetas, insignias (2B/2.9B/Turbo·4/CFG·20/~s), ✎ renombrar, **＋ Catálogo / ＋ Civitai / ＋ Importar** | 🟡 | Hoy es un desplegable. Falta el diálogo con tarjetas. |
| Fila de **RAM** + **Cargar modelo / Liberar modelo** + estado ("lista", "se carga al generar") | 🟡 | Tarjeta de hardware con barras. Falta el botón cargar/liberar (el motor tiene `models/unload`). |
| Barra de la imagen: **‹ n/N ›**, ★ Favorita, ⬇ Guardar en la galería, Ampliar, **Correcciones**, Compartir, ✕ | 🟡 | Hay "Abrir carpeta" y "Ampliar" (sin modelo ESRGAN aún). Faltan pager, favorita, exportar, copiar al portapapeles (= Compartir), ✕. |
| Imagen: "Tu imagen aparecerá aquí", clic abre el **Visor**, deslizar entre imágenes, vista previa en vivo | 🟡 | Vista previa en vivo ✅. Falta visor y paginar. |
| Fila de resultado: seed, **⇆ Antes/después**, **✎ Editar esta imagen**, **↻ Otra vez** (pulsación larga: **Variaciones** 1–16, *Con semillas nuevas* / *Parecidas a esta imagen* img2img 0,45) | ⬜ | "Usar la última" existe en Editar foto. |
| DESCRIPCIÓN: **LoRAs**, **Plantillas** (guardadas / recientes ☆★ / borrar recientes), **Borrar** | 🟡 | LoRAs ✅. Plantillas y recientes ✅ en desplegables. Falta "Borrar" y el diálogo de plantillas como en el teléfono. |
| Autocompletar etiquetas Danbooru (`assets/tags.txt`) | ⬜ | Se puede copiar el archivo del teléfono. |
| **# Etiquetas** (paleta: Calidad, Encuadre, Luz, Estilo, Expresión, Fondo) | 🟡 | Hoy hay chips fijos por familia. |
| **( − ) / ( + )** peso de la etiqueta | ✅ | |
| Contador de tokens "≈n / 512" | 🟡 | Hoy cuenta etiquetas. |
| PROMPT NEGATIVO: **Predeterminado**, **Plantillas**, **Borrar**, contador | 🟡 | Campo con negativo por familia. |
| MUESTREO: PASOS, CFG, Sampler, Scheduler, **↺**, ⓘ ayuda, **CFG solo al principio** (100/80/70 %) | 🟡 | Pasos/CFG/sampler/scheduler ✅ (22 samplers y 19 schedulers del motor). Faltan ↺, ayudas y "CFG solo al principio" (por confirmar en el motor). |
| Modo RealSkin (4 pasos / 8 pasos DMD) | ⬜ | Requiere MOSS (fase 4). |
| EDITAR UNA FOTO (Anima): miniatura, **Elegir**, **↳ Última imagen**, **✎ Zona a cambiar** (máscara), **Cuánto cambia** | ✅ | Elegir, última, %, ✎ Zona a cambiar (máscara con bordes suaves → `mask_image`). |
| EDITAR UNA FOTO (Qwen/Mage): referencias 2–3, *solo pose*, 👗 Copiar ropa, 🧍 Copiar pose, **Área a cambiar**, Forma de la foto, Alta fidelidad, Guardar comparación | ⬜ | Fase 4. El motor soporta `ref_images` y `mask_image`. |
| POSE (fuerza 0,5–2,5) | ⬜ | Fase 5. |
| LORA: biblioteca / importar / Civitai / intensidad | ✅ | Igual que el teléfono, con `<lora:nombre:fuerza>` en el prompt. |
| **✦ Estilo ChatGPT** (descarga el LoRA gpt-image-2) | ⬜ | Fase 2. |
| EXTRAS: vista previa en vivo, **Hires fix** (escala/denoise/pasos), **ADetailer caras / manos**, **Detector…**, **Presets**, **+ Cola**, **⊞ Comparar 2×2**, **▶** cola | 🟡 | Vista previa ✅, + Cola ✅, Hires fix ✅, ADetailer caras / manos ✅ (Controles; el detector se descarga y se convierte solo). |
| IMAGEN: TAMAÑO (Vertical / Horizontal / Cuadrado / Personalizado, por familia), **⇄**, SEED + 🎲 | ✅ | Presets por familia: parcial. |
| Barra inferior: progreso, estado "(i/N) Paso x/y · quedan ~", **×N** (1–999, cambia en marcha), **Generar · ~Ns** / **Detener** / **Obtener un modelo** | 🟡 | Falta "Obtener un modelo" sin modelos. |
| Comodines `{a|b}`, **hojas de contacto** de 9, cuadrícula 2×2 rotulada | 🟡 | Comodines ✅. |
| Diálogo **Poca memoria libre** (Liberar y continuar / Igual / Cancelar) | 🟡 | El modo adaptativo decide solo; falta el diálogo. |
| Pausa por calor | ✅ | 83 °C → sigue a 72 °C. |

## 2. Menú ⋯

| Ítem | Estado | Notas |
|---|---|---|
| **Modelos** (catálogo) | ⬜ | Fase 3. |
| Vídeo (experimental) | ⬜ | Oculto también en el teléfono. Fase 5. |
| **Civitai** | ✅ | Desde LoRAs. |
| **Plantillas de configuración** (guardar / cargar / sobrescribir / borrar: modelo, prompt, negativo, muestreo, tamaño, seed, cantidad, LoRAs, extras) | ⬜ | Fase 1. |
| **Ampliar una imagen de la galería** | ⬜ | Fase 2. |
| **Prompt desde una imagen** (WD Tagger: Etiquetas/Frase, Corto/Medio/Largo, Solo el personaje, Copiar/Añadir/Usar) | ⬜ | Fase 5: el motor no trae tagger. |
| **Cargar ajustes desde un PNG** | ⬜ | Fase 1. El motor ya guarda los metadatos en el PNG. |
| **Ajustes** | 🟡 | Ver §6. |
| **Info** (20 tarjetas de ayuda + Acerca de + licencias) | ⬜ | Fase 3. |

## 3. Visor a pantalla completa

| Elemento | Estado |
|---|---|
| Deslizar, zoom hasta 6×, ocultar barras, "n / N", línea de info (modelo · tamaño · seed · fecha · segundos), clic en el prompt lo copia | ⬜ |
| Guardar en la galería, Compartir, Copiar prompt, Correcciones, Ampliar, ★, ⇆, **↻ Usar estos ajustes**, 🗑 Papelera | ⬜ |
| Modo papelera: Restaurar, Eliminar para siempre | ⬜ |

## 4. Historial

| Elemento | Estado |
|---|---|
| Pestañas **Todas / ★ Favoritas / Papelera** con contador | 🟡 (lista + favoritas) |
| Filtros **Todos los modelos ▾**, **Todas las LoRA ▾**, "Buscar en los prompts…" | 🟡 (filtro por nombre de archivo) |
| Cuadrícula de 3 columnas con miniaturas, insignias ★ / ⇆ | ⬜ |
| Selección múltiple: favorita, exportar, **ZIP**, papelera; en papelera: restaurar / eliminar | ✅ | Papelera = Papelera de reciclaje de Windows. |
| Papelera que se vacía a los 30 días, **Vaciar** | ⬜ |

## 5. Correcciones

| Elemento | Estado | Notas |
|---|---|---|
| Comparar antes/después (línea arrastrable, zoom 3×), tira Original / Base / Alt. n, **Usar esta / Descartar**, **Deshacer / Rehacer**, **Guardar en el Historial** | ⬜ | Fase 2. |
| **Ruido** (Real-ESRGAN 1× mezclado, intensidad) y **Resolución** (×2/×4) | ⬜ | Fase 2: necesita un modelo ESRGAN en `models/upscalers`. |
| **Cara / Manos / Detalles / Otros** con zona pintada, **🔍 Detectar automáticamente**, **✨ Corregir todas** | ⬜ | En el teléfono usa Qwen. En PC se puede hacer con inpainting del modelo cargado + detector YOLO, y con Qwen cuando esté (fase 4). |

## 6. Ajustes

| Opción del teléfono | Estado |
|---|---|
| **Idioma** Español / English | ⬜ |
| **Tema** Seguir el sistema / Claro / Oscuro (paleta clara #E9E5F1 / #8672ED…) | ⬜ (solo oscuro) |
| **Fondo de pantalla** propio, posición y tamaño, transparencia de los bloques, oscurecimiento | ⬜ |
| Cargar el modelo al iniciar · Liberar memoria al estar inactivo (Nunca/3/5/10/30 min) | 🟡 (siempre carga al abrir) |
| **Almacenamiento** | ⬜ |
| **Exportar registros** (ZIP) · GitHub / versión | ⬜ |
| Guardar metadatos en la imagen | 🟡 (siempre activado) |
| Modo fresco (Automático / Siempre / Nunca) | 🟡 (pausa por calor fija) |
| Modo de poca memoria | ✅ (modo adaptativo) |
| Etiquetas de calidad antes del prompt (por modelo Anima) | ⬜ |
| Clave API de Civitai | ✅ |
| Específico de PC: motor, offload, opciones extra (COMMANDLINE_ARGS) | ✅ |

## 7. Otras pantallas

| Pantalla | Estado | Notas |
|---|---|---|
| **Modelos** (catálogo con tarjetas, Descargar con progreso y reanudar, Eliminar, archivos compartidos, importar checkpoint) | ⬜ | Los packs del teléfono son para la NPU: en PC hace falta un catálogo propio (safetensors/GGUF). |
| **Bienvenido** (Tu equipo ✓/⚠, Conviene saber, Obtener un modelo / Más tarde) | ⬜ | Mockup y lógica ya hechos (`tools/check_setup.py`); falta pasarlo a la app. |
| **Almacenamiento** (modelos, cachés, papelera, originales) | ⬜ | |
| **Info** | ⬜ | Textos adaptados a PC. |
| Widget de RAM | ➖ | En PC lo cubre la tarjeta de hardware. |
| Vídeo | ⬜ | Fase 5 (motor: Wan 2.1/2.2, LTX). |

## 8. Tema

| Elemento | Estado |
|---|---|
| Paleta oscura, Barlow Semi Condensed, botón principal violeta → rosa | ✅ |
| Paleta clara | ⬜ |
| Tarjetas con la escuadra violeta arriba a la izquierda y rosa abajo a la derecha | ⬜ |
| Títulos de sección en mayúsculas con "▸" violeta | 🟡 |
| Fondo de pantalla con bloques semitransparentes | ⬜ |

---

## Qué soporta el motor de PC (stable-diffusion.cpp)

| Familia / función | Motor | Comentario para PCs modestos |
|---|---|---|
| Anima (2B / 2.9B, turbo y base), img2img, inpainting | ✅ | Probado en GTX 1650. |
| SDXL / Illustrious / Pony / NoobAI + LoRA | ✅ | Probado (Nova + Frieren). |
| **Mage-Flow** turbo / edición (4B + Qwen3-VL-4B) | ✅ receta `mage-flow-*` | Manejable con offload. |
| **Qwen-Image 2.1** turbo / edición, hasta 3 referencias | ✅ receta `qwen-image-21*` | Pesado (≈20B + Qwen3-VL-8B): perfil Alto o muy lento. |
| **MOSS-Image** base / SFT (+ LoRA) | ✅ receta `moss-image-*` | Pesado (5B + Qwen3.5-9B). |
| Hires fix, ESRGAN (ampliar) | ✅ | Falta descargar el modelo ESRGAN. |
| ADetailer (YOLOv8 caras / manos) | ✅ | Hay que convertir `face_yolov8n` / `hand_yolov8n` a safetensors una vez. |
| Vídeo: Wan 2.1 / 2.2, LTX | ✅ | Muy pesado en 4 GB. |
| Prompt desde una imagen (WD Tagger) | ❌ | Habría que integrarlo aparte (ONNX). |
| Pose (RTMW + control) | ❌ directo | Investigar ControlNet / LoRA de pose para Anima. |

---

## Orden de trabajo

**Fase 1 · Pantalla principal y flujo diario** (todo con lo que ya hay)
1. Visor a pantalla completa y barra de la imagen (‹ n/N ›, ★, exportar, copiar, ✕).
2. ↻ Otra vez y Variaciones; ⇆ Antes/después.
3. Historial completo: cuadrícula, pestañas, papelera de 30 días, filtros por modelo, LoRA y prompt (leyendo los metadatos del PNG), selección múltiple y ZIP.
4. Cargar / Liberar modelo y estado del modelo.
5. Menú ⋯: Plantillas de configuración, Cargar ajustes desde un PNG.
6. Prompt: autocompletar Danbooru, paleta # Etiquetas, Borrar, negativo Predeterminado / Plantillas, contador de tokens, ↺ y ayudas ⓘ.
7. Selector de modelo con tarjetas e insignias.

**Fase 2 · Extras y edición**
1. Editor de máscara (Pincel / Borrador / Mover, deshacer, zoom) → Zona a cambiar (inpainting).
2. Hires fix y ADetailer caras / manos (con los detectores convertidos).
3. Ampliar ×2 / ×4 (Rápido · Real-ESRGAN / Detallado · UltraSharp) y Ampliar una imagen de la galería.
4. Correcciones: Ruido, Resolución, Cara / Manos / Detalles / Otros con el modelo cargado.
5. Comparar 2×2, hojas de contacto, ✦ Estilo ChatGPT.

**Fase 3 · Modelos, bienvenida y ajustes**
1. Catálogo de modelos para PC (descargas con progreso y reanudar, eliminar, importar).
2. Pantalla de Bienvenida (verificación + perfil, ya diseñada).
3. Ajustes completos: idioma, tema claro, fondo de pantalla, metadatos, etiquetas de calidad, liberar al estar inactivo.
4. Almacenamiento, Exportar registros, Info.
5. Detalles del tema: escuadras en tarjetas, "▸" en secciones.

**Fase 4 · Familias pesadas**
1. Mage-Flow: editar foto, área, referencias.
2. Qwen-Image 2.1: editar foto, referencias hasta 3, alta fidelidad, forma de la foto, guardar comparación; correcciones con Qwen.
3. MOSS-Image (+ RealSkin / Harem, DMD 8 pasos).

**Fase 5 · Extras avanzados**
1. Prompt desde una imagen (WD Tagger), Copiar ropa / pose.
2. Pose.
3. Vídeo.
