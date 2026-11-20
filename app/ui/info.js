// HexAnima PC: ⋯ → Almacenamiento, Info (ayuda + Acerca de) y Exportar registros, como el teléfono.
"use strict";

const GB = (b) => (b >= 1e9 ? (b / 1e9).toLocaleString(UiLanguage.selected, { maximumFractionDigits: 1 }) + " GB" : Math.round(b / 1e6).toLocaleString(UiLanguage.selected) + " MB");

const Storage = {
  async open() { openModal("storageDlg"); await this.refresh(); },

  async refresh() {
    const box = $("storageList");
    box.innerHTML = UiLanguage.text('<div class="lbl">Calculando…</div>');
    let r;
    try { r = await invoke("storage_info"); } catch (e) { box.innerHTML = ""; return toast(String(e.message || e)); }
    box.innerHTML = "";
    $("storageFree").textContent = r.free != null ? UiLanguage.template`Libre en el disco: ${GB(r.free)}` : "";
    for (const g of r.groups || []) {
      if (!g.items.length) continue;
      const sum = g.items.reduce((a, it) => a + it.bytes, 0);
      const h = document.createElement("div"); h.className = "lbl st-head"; h.textContent = `${UiLanguage.text(g.title)}  ·  ${GB(sum)}`;
      const card = document.createElement("div"); card.className = "st-card";
      for (const it of g.items) {
        const row = document.createElement("div"); row.className = "st-row";
        const t = document.createElement("div"); t.className = "st-t";
        const name = document.createElement("b"); name.textContent = `${UiLanguage.text(it.title)}  ·  ${GB(it.bytes)}`;
        const sub = document.createElement("div"); sub.className = "lbl"; sub.textContent = UiLanguage.text(it.sub);
        t.append(name, sub); row.append(t);
        if (it.action) {
          const b = document.createElement("button");
          b.className = "ghost sm"; b.textContent = it.action === "clear" ? UiLanguage.text("Liberar") : UiLanguage.text("Abrir carpeta");
          b.disabled = it.action === "clear" && !it.bytes;
          b.onclick = () => this.act(it);
          row.append(b);
        }
        card.append(row);
      }
      box.append(h, card);
    }
  },

  async act(it) {
    if (it.action === "open") return invoke("open_folder", { which: it.id }).catch((e) => toast(String(e.message || e)));
    if (state.busy) return toast(UiLanguage.text("Espera a que termine la generación"));
    try { const freed = await invoke("storage_clear", { id: it.id }); toast(UiLanguage.text("Liberado: ") + GB(freed)); }
    catch (e) { toast(String(e.message || e)); }
    this.refresh();
  },
};

const Info = {
  ITEMS: [
    [UiLanguage.text("Pasos y muestreo"), UiLanguage.text("Cada modelo guarda sus propios ajustes. SDXL, Illustrious y Pony suelen ir bien con 20–30 pasos, CFG 4–6 y Euler a o DPM++ 2M. Anima Turbo parte de 4 pasos, Euler y CFG 1; Anima normal, de 20 pasos, DPM++ 2M y CFG 4. Mage Edit Turbo usa 4 pasos. ⚡ Modo rápido baja los pasos a 4–10 con CFG 1 (DMD2 en SDXL, Anima Turbo en Anima) y tus ajustes vuelven al apagarlo. Usa los pasos para los que se entrenó el modelo o su LoRA.")],
    [UiLanguage.text("Qué tamaño usar"), UiLanguage.text("SDXL y sus derivados están hechos para cerca de 1 megapíxel: 832×1216, 1024×1024, 1216×832… Anima y Mage aceptan cualquier tamaño múltiplo de 16. Más grande tarda más y pide más memoria; para más detalle es mejor el Hires fix o Ampliar. ⇄ cambia vertical por horizontal.")],
    ["Seed", UiLanguage.text("-1 es aleatoria cada vez. Un número repite la misma imagen con el mismo prompt, tamaño, modelo y ajustes. La seed usada se ve debajo de la imagen y en el Historial; ↻ Otra vez usa una nueva y Variaciones parte de la actual.")],
    [UiLanguage.text("Motores"), UiLanguage.text("Automático elige el mejor para tu gráfica: el motor rápido (PyTorch) para SDXL en NVIDIA, CUDA para el resto en NVIDIA y Vulkan en AMD e Intel. Las RTX serie 50 usan su propio motor rápido (CUDA 12.8). En Ajustes puedes forzar uno; si una gráfica falla con Vulkan, prueba CUDA.")],
    [UiLanguage.text("Cargar y liberar el modelo"), UiLanguage.text("El modelo cargado ocupa varios GB de RAM y de memoria de la gráfica. Se carga solo al pulsar Generar y en Ajustes puedes hacer que se libere tras unos minutos sin generar. «Pesos en RAM (offload)» deja en la RAM lo que no cabe en la gráfica: más lento, pero permite modelos grandes con 4–8 GB de VRAM. Cierra el navegador o Discord si la RAM está casi llena.")],
    [UiLanguage.text("Dónde se guardan las imágenes"), UiLanguage.text("En la carpeta outputs junto a HexAnima.exe, cada una con un .json con todos sus ajustes (también van dentro del PNG). Lo que borras en el Historial va a la Papelera de reciclaje de Windows. Todo es portable: para llevarte la app a otro PC copia la carpeta entera.")],
    [UiLanguage.text("Negativo y CFG"), UiLanguage.text("Con CFG 1 (modelos turbo y ⚡ Modo rápido) el negativo no cambia nada. Con CFG 3–7 el negativo sí cuenta y cada paso tarda casi el doble. Un CFG alto da colores quemados; uno bajo, imágenes lavadas o sin seguir el prompt.")],
    ["LoRAs", UiLanguage.text("Copia tus .safetensors a la carpeta loras (o usa Civitai e Importar) y elígelos en LoRAs; en el prompt se escriben como <lora:nombre:fuerza>. Una LoRA solo funciona con la familia para la que se hizo (SDXL/Illustrious/Pony o Anima). Fuerza 0 la desactiva sin quitarla; ✦ Estilo ChatGPT añade la LoRA gpt-image-2 para Anima.")],
    [UiLanguage.text("Editar una foto"), UiLanguage.text("En «Editar una foto» elige una imagen o «Última imagen» y escribe solo el cambio. Con fuerza 25–40 % se conserva casi toda la foto; con 60 % o más cambian también la pose y la cara. «✎ Zona a cambiar» limita el cambio a lo que pintes. Con Mage Edit puedes dar una orden («ponle un vestido rojo») y hasta 3 imágenes de referencia.")],
    [UiLanguage.text("Comparar y hojas de contacto"), UiLanguage.text("⊞ 2×2 genera 4 imágenes cambiando una sola cosa (seed, CFG o pasos) y las junta en una cuadrícula rotulada. Un lote de 2 o más imágenes termina con una hoja de contacto numerada (hasta 9 por hoja). Las dos se guardan en el Historial y se recorren con ‹ ›.")],
    ["🌐 ES→EN", UiLanguage.text("Con el botón 🌐 ES→EN encendido escribes el prompt y el negativo en español y se genera con su versión en inglés, que ves debajo de cada cuadro. Solo se traducen los trozos en español: las etiquetas en inglés (1girl, masterpiece…), las LoRAs y los pesos (…:1.2) se quedan igual. Traduce sin internet con OPUS-MT (300 MB, se descarga la primera vez) y el Python del motor rápido, así que necesita NVIDIA. La primera traducción tarda unos segundos; después, menos de uno. Liberar el modelo también cierra el traductor.")],
    [UiLanguage.text("Metadatos de una imagen"), UiLanguage.text("⋯ → Leer metadatos de una imagen muestra el prompt, el negativo, los pasos, el CFG, la seed, el tamaño, el modelo y las LoRAs que guardó HexAnima, A1111, Forge, ComfyUI, NovelAI o InvokeAI, y «Usar estos ajustes» los pasa a Generar. Las redes sociales suelen borrar estos datos.")],
    [UiLanguage.text("Importar modelos"), UiLanguage.text("＋ Importar reconoce la familia del archivo (SDXL, Anima, Qwen-Image 2.1, MOSS-Image o Mage-Flow) y lo copia a su carpeta. Los modelos de difusión necesitan además el codificador de texto y el VAE de su familia: se descargan una sola vez desde ⋯ → Descargar modelos y los comparten todos los modelos de la familia.")],
    [UiLanguage.text("Qué equipos sirven"), UiLanguage.text("Probada en GTX 1650 de 4 GB y GTX 1050 con 16 GB de RAM. Con NVIDIA va mejor (CUDA y el motor rápido); AMD e Intel usan Vulkan. Con 4 GB de VRAM, SDXL y Anima funcionan con offload; Qwen-Image y MOSS piden más memoria y van mucho mejor con 8 GB o más.")],
    ["Licencias", UiLanguage.text("Los modelos MiaoMiao (MIAOKA, Civitai) se basan en Anima de CircleStone Labs y NVIDIA Cosmos: solo uso no comercial. Cada modelo y LoRA de Civitai conserva la licencia de su autor. El motor rápido usa código de Stable Diffusion WebUI Forge (AGPL-3.0); stable-diffusion.cpp es MIT. Detalles en THIRD_PARTY.md.")],
  ],

  open() {
    const box = $("infoList");
    if (!box.childElementCount) {
      for (const [t, body] of this.ITEMS) {
        const c = document.createElement("div"); c.className = "st-card info-card";
        const h = document.createElement("b"); h.textContent = t;
        const p = document.createElement("div"); p.className = "lbl"; p.textContent = body;
        c.append(h, p); box.append(c);
      }
    }
    const hw = state.hw || {}, g = hw.gpu;
    $("infoAbout").textContent = `HexAnima PC ${state.version || ""}\n${g ? `${g.name}${g.vram_gb ? ` · ${g.vram_gb} GB` : ""}` : UiLanguage.text("Sin gráfica dedicada")} · ${hw.ram_gb ? hw.ram_gb + " GB de RAM · " : ""}motor ${(state.engine || hw.engine || "").toUpperCase()}`;
    openModal("infoDlg");
  },

  async exportLogs() {
    try {
      const p = await invoke("logs_export", { info: { engine: state.engine, engines: state.engines, torch_cuda: state.torchCuda, model: currentOption()?.label || null } });
      if (p) toast(UiLanguage.text("Registros guardados en ") + p, 6000);
    } catch (e) { toast(UiLanguage.text("No se pudieron exportar: ") + (e.message || e), 5000); }
  },
};

$("infoExport").onclick = () => Info.exportLogs();
$("setExport").onclick = () => Info.exportLogs();
$("storageRefresh").onclick = () => Storage.refresh();
for (const [id, url] of [["infoGithub", "https://github.com/GrimmDev-Glitch/hexanima-pc"], ["infoReleases", "https://github.com/GrimmDev-Glitch/hexanima-pc/releases"], ["infoLicenses", "https://github.com/GrimmDev-Glitch/hexanima-pc/blob/main/THIRD_PARTY.md"]])
  $(id).onclick = () => invoke("open_url", { url }).catch((e) => toast(String(e.message || e)));
