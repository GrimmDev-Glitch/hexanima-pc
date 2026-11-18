// HexAnima PC: «Personaje de referencia». Dos herramientas que se combinan:
//  · 🔍 Leer rasgos: WD Tagger v3 (como «Prompt desde una imagen» del teléfono) propone las etiquetas del
//    personaje (pelo, ojos, ropa, accesorios…) sin el fondo, la pose ni la expresión, para añadirlas al prompt.
//  · Usar como referencia: IP-Adapter (noobIPA Mark1, para NoobAI / Illustrious) copia su aspecto mientras
//    el prompt y los LoRAs deciden la escena y el estilo. Solo motor PyTorch y modelos SDXL.
"use strict";

// Etiquetas que describen la escena, el encuadre, la pose o la expresión, no al personaje
const REF_SCENE = /(background|outdoors|indoors|sky|cloud|field|flower|tree|grass|water|ocean|night|day|sunlight|sunset|light_rays|shadow|room|scenery|city|street|building|window|nature|forest|beach|snow|rain|petal|leaf|leaves|bokeh|blurry|depth_of_field|lens_flare|border|letterboxed|watermark|signature|text|artist_name|dated|web_address)/;
const REF_POSE = /^(solo|looking_at_viewer|looking_.+|upper_body|full_body|cowboy_shot|portrait|close-up|smile|grin|open_mouth|closed_mouth|blush|standing|sitting|lying|kneeling|walking|running|.+_focus|from_.+|holding.*|hand_.*|hands_.*|arm_.*|arms_.*|parted_lips|teeth|:d|;d|:o|closed_eyes|one_eye_closed|head_tilt|v|w|light_smile|expressionless|happy|sad|crying|tears|outstretched_.+|reaching.*|pointing.*|salute|dutch_angle|straight-on|profile|facing_.+|turning_head|leaning_.+|on_.+|in_.+|simple_background|white_background|gradient_background)$/;

const Ref = {
  image: null,       // data URL
  tags: [],          // [{name, score, category, on}]
  status: {},        // archivos instalados en el motor
  busy: false,

  isTorch() { return state.engine === "torch"; },
  supported(opt) { return this.isTorch() && opt?.family === "sdxl"; },

  summary() {
    if (!this.image) return "sin imagen";
    const use = $("refUse").checked && this.supported(currentOption());
    return use ? `referencia · ${Number($("refWeight").value).toFixed(2).replace(".", ",")}` : "con imagen";
  },

  async refreshStatus() {
    if (!this.isTorch()) { this.status = {}; return this.render(); }
    try { this.status = await api("/hexanima/v1/reference/status"); } catch { this.status = {}; }
    this.render();
  },

  set(src) {
    this.image = src; this.tags = [];
    $("refPreview").src = src || ""; $("refPreview").classList.toggle("on", !!src);
    $("refEmpty").classList.toggle("off", !!src);
    $("refClear").classList.toggle("hidden", !src);
    if (!src) $("refUse").checked = false;
    this.render();
  },

  /** Descarga archivos del personaje de referencia (con confirmación y progreso). */
  async download(kinds, title, msg) {
    const assets = await invoke("asset_status");
    const missing = kinds.map((k) => assets.find((a) => a.kind === k)).filter((a) => a && !a.installed);
    if (!missing.length) return true;
    const mb = missing.reduce((n, a) => n + a.mb, 0);
    const go = await ask({ title, msg: `${msg}\n\nDescarga: ${(mb / 1024).toFixed(1).replace(".", ",")} GB, una sola vez (se puede reanudar si se corta).`,
      buttons: [{ label: "Cancelar", value: false }, { label: `Descargar (${mb >= 1024 ? (mb / 1024).toFixed(1).replace(".", ",") + " GB" : mb + " MB"})`, value: true, primary: true }] });
    if (!go) return false;
    this.busy = true; this.render();
    let base = 0;
    const total = mb * 1048576;
    const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
      const p = ev.payload;
      if (!missing.some((a) => p.id === "asset-" + a.kind)) return;
      $("refInfo").textContent = `Descargando… ${Math.min(100, Math.round((100 * (base + p.done)) / total))} % · ${((base + p.done) / 1e9).toFixed(2)} de ${(total / 1e9).toFixed(1)} GB`;
    });
    try {
      for (const a of missing) { await invoke("asset_download", { kind: a.kind }); base += a.mb * 1048576; }
      toast("✓ Listo", 2500);
      return true;
    } catch (e) {
      toast("No se pudo descargar: " + (e.message || e), 6000);
      return false;
    } finally {
      off(); this.busy = false;
      await this.refreshStatus();
    }
  },

  async read() {
    if (!this.image || this.busy) return;
    if (!this.isTorch()) return toast("Leer rasgos necesita el motor rápido (PyTorch, NVIDIA)", 4000);
    if (!(await this.download(["tagger", "tagger_tags"], "🔍 Leer rasgos", "Necesita el lector de etiquetas WD Tagger v3 (el mismo que el teléfono)."))) return;
    this.busy = true; this.render();
    $("refInfo").textContent = "Leyendo los rasgos…";
    try {
      const r = await api("/hexanima/v1/tag", { method: "POST", body: JSON.stringify({ image: this.image }) });
      this.tags = r.tags.filter((t) => t.category !== 9).map((t) => ({ ...t, on: t.category === 4 || !(REF_SCENE.test(t.name) || REF_POSE.test(t.name)) }));
      $("refInfo").textContent = `${this.tags.filter((t) => t.on).length} rasgos marcados (en ${r.seconds} s). Toca una etiqueta para marcarla o desmarcarla y pulsa «＋ Añadir al prompt».`;
    } catch (e) {
      $("refInfo").textContent = "No se pudieron leer los rasgos: " + (e.message || e);
    } finally { this.busy = false; this.render(); }
  },

  /** «silver_hair» → «silver hair»; los paréntesis se escapan para que no cuenten como peso. */
  promptTag(n) { return (/^[:;]/.test(n) ? n : n.replace(/_/g, " ")).replace(/([()])/g, "\\$1"); },

  addToPrompt() {
    const t = $("prompt"), have = new Set(t.value.toLowerCase().split(",").map((x) => x.trim()));
    const add = this.tags.filter((x) => x.on).map((x) => this.promptTag(x.name)).filter((x) => !have.has(x.toLowerCase()));
    if (!add.length) return toast("Esos rasgos ya están en el prompt", 2500);
    t.value = t.value.trim() ? t.value.replace(/[,\s]*$/, "") + ", " + add.join(", ") : add.join(", ");
    t.dispatchEvent(new Event("input"));
    toast(`＋ ${add.length} rasgos añadidos al prompt`, 2500);
  },

  async toggleUse() {
    const box = $("refUse");
    if (!box.checked) return this.render();
    if (!this.supported(currentOption())) { box.checked = false; return toast("La referencia funciona con el motor rápido (NVIDIA) y modelos SDXL, Illustrious o Pony", 5000); }
    box.checked = false;
    const ok = await this.download(["ipadapter", "clip_vision"], "Personaje de referencia",
      "Necesita el IP-Adapter para NoobAI / Illustrious (noobIPA Mark1) y el codificador de imágenes CLIP ViT-bigG. La primera imagen con cada referencia tarda un poco más (se prepara una vez y se guarda).");
    box.checked = ok;
    this.render();
  },

  /** Añade la referencia a la petición si está activa. */
  apply(body, opt) {
    if (!this.image || !$("refUse").checked || !this.supported(opt)) return false;
    body.ip_adapter = { image: this.image, weight: Number($("refWeight").value) };
    return true;
  },

  render() {
    const opt = currentOption(), has = !!this.image;
    $("refRead").disabled = !has || this.busy;
    $("refAdd").disabled = !this.tags.some((t) => t.on) || this.busy;
    $("refUse").disabled = !has || this.busy;
    $("refLast").disabled = !state.currentImage;
    $("refWeightTxt").textContent = Number($("refWeight").value).toFixed(2).replace(".", ",");
    const box = $("refTags");
    box.innerHTML = "";
    for (const t of this.tags) {
      const b = document.createElement("button");
      b.className = "ref-tag" + (t.on ? " on" : "") + (t.category === 4 ? " char" : "");
      b.textContent = this.promptTag(t.name);
      b.title = `${Math.round(t.score * 100)} %${t.category === 4 ? " · personaje" : ""}`;
      b.onclick = () => { t.on = !t.on; this.render(); };
      box.appendChild(b);
    }
    if (has && opt && !this.supported(opt) && $("refUse").checked) $("refUse").checked = false;
    if (typeof Acc !== "undefined") Acc.summaries();
  },
};

$("refFile").onchange = async () => {
  const f = $("refFile").files?.[0];
  if (f) Ref.set(await readFileDataUrl(f));
  $("refFile").value = "";
};
$("refLast").onclick = () => { if (state.currentImage) Ref.set(state.currentImage); };
$("refClear").onclick = () => Ref.set(null);
$("refRead").onclick = () => Ref.read();
$("refAdd").onclick = () => Ref.addToPrompt();
$("refUse").onchange = () => Ref.toggleUse();
$("refWeight").oninput = () => Ref.render();
setTimeout(() => Ref.refreshStatus(), 2500);
setInterval(() => { $("refLast").disabled = !state.currentImage; }, 1500);
