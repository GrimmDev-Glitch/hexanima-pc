// HexAnima PC: herramientas de la pantalla principal replicando HexAnima Android:
// selector de modelo con tarjetas, Cargar / Liberar, menú ⋯, Plantillas de configuración,
// Cargar ajustes desde un PNG, paleta # Etiquetas, autocompletar Danbooru, negativo
// (Predeterminado / Plantillas / Borrar), contador de tokens y ↺ Restablecer.
"use strict";

// ---------- nombres propios de los modelos (✎) ----------
let modelNames = {};
invoke("store_get", { key: "model-names" }).then((v) => { modelNames = v && typeof v === "object" ? v : {}; syncModelUi(); }).catch(() => {});
const modelTitle = (o) => modelNames[o.id] || o.label;

// ---------- chip del modelo y Cargar / Liberar ----------
function syncModelUi() {
  const o = currentOption();
  $("modelName").textContent = o ? modelTitle(o) : UiLanguage.text("Sin modelo");
  const loaded = !!o && state.loaded === o.id;
  $("modelDot").className = "dot" + (loaded ? " on" : "");
  $("loadBtn").textContent = loaded ? UiLanguage.text("Liberar modelo") : UiLanguage.text("Cargar modelo");
  $("loadBtn").disabled = !o || state.busy;
  if (!state.busy && o && !/Cargando|Loading|Error|No se pudo|Could not|motor|engine/i.test($("modelStatus").textContent)) {
    setStatus(loaded ? UiLanguage.text("En memoria · lista") : UiLanguage.text("No está en memoria · se carga al generar"), loaded ? "ok" : "");
  }
}
setInterval(syncModelUi, 1000);

$("loadBtn").onclick = async () => {
  const o = currentOption(); if (!o || state.busy) return;
  if (state.loaded === o.id) {
    try { await unloadModel(); setStatus(UiLanguage.text("Modelo liberado: la RAM y la VRAM quedan libres"), "ok"); }
    catch (e) { setStatus(UiLanguage.text("No se pudo liberar: ") + e.message, "err"); }
    refreshMemory(); syncModelUi();
  } else { await loadModel(); syncModelUi(); }
};

// ---------- selector de modelo (tarjetas) ----------
const ModelPicker = {
  sizes: {},
  async open() {
    try { this.sizes = await invoke("model_sizes"); } catch { this.sizes = {}; }
    this.render();
    openModal("modelDlg");
  },
  bytes(o) { return Object.values(o.models).reduce((a, f) => a + (this.sizes[f] || 0), 0); },
  render() {
    const box = $("modelCards"); box.innerHTML = "";
    $("modelCount").textContent = state.options.length ? UiLanguage.template`${state.options.length} instalados` : "";
    if (!state.options.length) box.innerHTML = UiLanguage.text('<div class="lbl empty-lib">No hay modelos: usa ＋ Catálogo, ＋ Civitai o ＋ Importar.</div>');
    for (const o of state.options) {
      const p = FAMILY[o.preset || o.family];
      const sel = $("model").value === o.id, loaded = state.loaded === o.id;
      const est = Object.entries(localStorageSafe()).filter(([k]) => k.startsWith("hx.bench:" + o.id + ":")).map(([, v]) => { try { const b = JSON.parse(v); return b.fixed + b.step * p.steps; } catch { return null; } }).filter(Boolean)[0];
      const c = document.createElement("div");
      c.className = "mcard" + (sel ? " on" : "");
      c.innerHTML = UiLanguage.template`<div class="mtop"><span class="mname"></span>${sel ? '<span class="mcheck">✓</span>' : ""}<button class="mini mreveal" title="Mostrar el archivo en la carpeta" aria-label="Mostrar en la carpeta">⌕</button><button class="mini medit" title="Cambiar nombre" aria-label="Cambiar nombre">✎</button></div>
        <div class="mbadges"></div><div class="lbl mfile"></div>`;
      c.querySelector(".mname").textContent = modelTitle(o);
      const fam = { anima: "Anima", mage: "Mage", qwen: "Qwen-Image", moss: "MOSS" }[o.family] || "SDXL";
      const badges = [fam, o.preset === "anima" || o.preset === "qwen" ? `Turbo · ${p.steps}` : UiLanguage.template`CFG ${p.cfg} · ${p.steps} pasos`];
      const gb = this.bytes(o); if (gb) badges.push((gb / 1073741824).toFixed(1) + " GB");
      if (est) badges.push("~" + fmtS(est));
      if (loaded) badges.push(UiLanguage.text("En memoria"));
      for (const b of badges) { const s = document.createElement("span"); s.className = "badge" + (b === "En memoria" ? " ok" : ""); s.textContent = b; c.querySelector(".mbadges").appendChild(s); }
      c.querySelector(".mfile").textContent = Object.values(o.models)[0];
      c.onclick = (e) => {
        if (e.target.closest(".medit, .mreveal")) return;
        $("model").value = o.id; $("model").dispatchEvent(new Event("change"));
        closeModal("modelDlg"); syncModelUi();
      };
      c.querySelector(".mreveal").onclick = () => invoke("reveal_file", { path: "models/" + Object.values(o.models)[0] }).catch((e) => toast(String(e)));
      c.querySelector(".medit").onclick = async () => {
        const r = await ask({ title: UiLanguage.text("Cambiar nombre"), input: { value: modelTitle(o) },
          buttons: [{ label: UiLanguage.text("Cancelar"), value: null }, { label: UiLanguage.text("Restablecer"), value: "reset" }, { label: "OK", value: "@input", primary: true }] });
        if (!r) return;
        if (r === "reset" || !r.input.trim()) delete modelNames[o.id]; else modelNames[o.id] = r.input.trim();
        await invoke("store_set", { key: "model-names", value: modelNames });
        this.render(); syncModelUi();
      };
      box.appendChild(c);
    }
  },
};
function localStorageSafe() { try { return { ...localStorage }; } catch { return {}; } }
$("modelBtn").onclick = () => ModelPicker.open();
$("mdFolders").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const open = (w) => invoke("open_folder", { which: w }).catch((er) => toast(String(er)));
  showMenu(r.left, r.top - 8, UiLanguage.text("Abrir carpeta"), [
    { label: "Checkpoints (SDXL / Illustrious / Pony)", run: () => open("models/checkpoints") },
    { label: "Anima (diffusion_models)", run: () => open("models/diffusion_models") },
    { label: "Codificadores de texto", run: () => open("models/text_encoders") },
    { label: "VAE", run: () => open("models/vae") },
    { label: UiLanguage.text("Ampliadores"), run: () => open("models/upscalers") },
    { label: "Detectores (ADetailer)", run: () => open("models/detectors") },
    { label: UiLanguage.text("Toda la carpeta models"), run: () => open("models") },
  ]);
};
// ＋ Catálogo: el catálogo predeterminado (Anima, Mage, Qwen, MOSS y los MiaoMiao), el mismo de la bienvenida
$("mdCatalog").onclick = () => { closeModal("modelDlg"); Packs.open(); };
$("mdCivitai").onclick = () => {
  closeModal("modelDlg");
  Civitai.type = "Checkpoint";
  const family = currentOption()?.family;
  if (FAMILIES.some((f) => f.key === family)) Civitai.family = family;
  document.querySelector('.nav[data-page="civitai"]').click();
};
// ＋ Importar: detecta la familia por los tensores del archivo y deja confirmarla o cambiarla.
const IMPORT_KINDS = [
  { value: "sdxl", label: UiLanguage.text("SDXL · Illustrious · Pony (checkpoint completo)") },
  { value: "anima", label: "Anima" },
  { value: "qwen-image", label: "Qwen-Image 2.1" },
  { value: "moss", label: "MOSS-Image" },
  { value: "mage", label: "Mage-Flow" },
];
$("mdImport").onclick = async () => {
  try {
    const f = await invoke("model_pick");
    if (!f) return;
    if (f.kind === "lora") return toast(UiLanguage.text("Ese archivo es una LoRA: impórtalo desde LoRAs → Importar."), 6000);
    const found = IMPORT_KINDS.find((k) => k.value === f.kind);
    const gb = (f.bytes / 1e9).toLocaleString(UiLanguage.selected, { maximumFractionDigits: 1 });
    const kind = await ask({
      title: "Importar " + f.name,
      msg: (found ? UiLanguage.template`Parece un modelo ${found.label} (${gb} GB). Confírmalo o elige otra familia:` : UiLanguage.template`No se reconoce la familia de este modelo (${gb} GB). Elige cuál es:`),
      list: IMPORT_KINDS.map((k) => ({ ...k, label: k.label + (k.value === f.kind ? UiLanguage.text("  ✓ detectado") : ""), on: k.value === f.kind })),
    });
    if (!kind) return;
    setStatus(UiLanguage.template`Copiando ${f.name}…`);
    const dst = await invoke("model_import", { path: f.path, kind });
    await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    await scanModels();
    ModelPicker.render();
    const shown = state.options.some((o) => o.models && Object.values(o.models).some((id) => String(id).includes(dst.split("/").pop())));
    setStatus(shown ? UiLanguage.text("Modelo importado: ") + dst : UiLanguage.template`Importado en ${dst}, pero faltan archivos de la familia (codificador de texto o VAE) para usarlo: descárgalos desde ⋯ → Descargar modelos.`, shown ? "ok" : "warn");
  } catch (e) { toast(UiLanguage.text("No se pudo importar: ") + (e.message || e), 5000); }
};

// ---------- menú ⋯ (como el del teléfono) ----------
$("menuBtn").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 250, r.bottom + 4, "HexAnima", [
    { label: UiLanguage.text("Modelos"), run: () => ModelPicker.open() },
    { label: "Civitai", run: () => document.querySelector('.nav[data-page="civitai"]').click() },
    { label: UiLanguage.text("Plantillas de configuración"), run: () => CfgTemplates.open() },
    { label: UiLanguage.text("Ampliar una imagen de la galería"), run: () => pickImage().then((src) => src && Upscale.open(src)) },
    { label: UiLanguage.text("Prompt desde una imagen"), run: () => PicPrompt.open() },
    { label: UiLanguage.text("Catálogo de modelos"), run: () => Packs.open() },
    { label: UiLanguage.text("Leer metadatos de una imagen"), run: () => Meta.open() },
    { label: "Almacenamiento", run: () => Storage.open() },
    { label: "Info", run: () => Info.open() },
    { label: UiLanguage.text("Buscar actualizaciones"), run: () => Update.check(true) },
    { label: UiLanguage.text("Ajustes"), run: () => document.querySelector('.nav[data-page="settings"]').click() },
  ]);
};

function pickImage() {
  return new Promise((resolve) => {
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/png,image/jpeg,image/webp";
    inp.onchange = async () => { const f = inp.files?.[0]; resolve(f ? await readFileDataUrl(f) : null); };
    inp.click();
  });
}

// ---------- Plantillas de configuración ----------
const CfgTemplates = {
  list: [],
  async open() {
    try { const v = await invoke("store_get", { key: "config-templates" }); this.list = Array.isArray(v) ? v : []; } catch { this.list = []; }
    this.render(); openModal("cfgDlg");
  },
  snapshot() {
    return {
      model: $("model").value, prompt: $("prompt").value, neg: $("neg").value,
      steps: $("steps").value, cfg: $("cfg").value, sampler: $("sampler").value, scheduler: $("scheduler").value,
      clip: $("clipskip").value, aspect: state.aspect, w: $("customW").value, h: $("customH").value,
      seed: $("seed").value, count: $("count").value,
    };
  },
  apply(d) {
    if (d.model && state.options.some((o) => o.id === d.model) && $("model").value !== d.model) { $("model").value = d.model; $("model").dispatchEvent(new Event("change")); }
    Loras.setPrompt(d.prompt || ""); $("neg").value = d.neg || "";
    for (const [k, id] of [["steps", "steps"], ["cfg", "cfg"], ["sampler", "sampler"], ["scheduler", "scheduler"], ["clip", "clipskip"], ["seed", "seed"], ["count", "count"], ["w", "customW"], ["h", "customH"]]) if (d[k] != null) $(id).value = d[k];
    const b = document.querySelector(`#aspect button[data-a="${d.aspect || "p"}"]`); if (b) b.click();
    updatePromptMeta(); syncModelUi();
  },
  async save() { await invoke("store_set", { key: "config-templates", value: this.list }); this.render(); },
  render() {
    const box = $("cfgList"); box.innerHTML = "";
    if (!this.list.length) box.innerHTML = UiLanguage.text('<div class="lbl">Todavía no hay plantillas.</div>');
    this.list.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "ask-item"; b.textContent = t.name;
      b.title = UiLanguage.template`${t.data.prompt.slice(0, 120)}\n${t.data.steps} pasos · CFG ${t.data.cfg}`;
      b.onclick = () => { this.apply(t.data); closeModal("cfgDlg"); toast(UiLanguage.text("Plantilla cargada: ") + t.name); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, t.name, [
          { label: UiLanguage.text("Sobrescribir con la configuración actual"), run: async () => { t.data = this.snapshot(); await this.save(); toast(UiLanguage.text("Plantilla actualizada")); } },
          { label: UiLanguage.text("Cambiar nombre…"), run: async () => { const r = await ask({ title: UiLanguage.text("Cambiar nombre"), input: { value: t.name }, buttons: [{ label: UiLanguage.text("Cancelar"), value: null }, { label: "OK", value: "@input", primary: true }] }); if (r?.input?.trim()) { t.name = r.input.trim(); await this.save(); } } },
          { label: UiLanguage.text("Eliminar"), danger: true, run: async () => { this.list.splice(i, 1); await this.save(); } },
        ]);
      };
      box.appendChild(b);
    });
  },
};
$("cfgSave").onclick = async () => {
  const r = await ask({ title: UiLanguage.text("Guardar plantilla"), input: { value: "", placeholder: UiLanguage.text("Nombre de la plantilla") }, buttons: [{ label: UiLanguage.text("Cancelar"), value: null }, { label: UiLanguage.text("Guardar"), value: "@input", primary: true }] });
  if (!r?.input?.trim()) return CfgTemplates.open();
  CfgTemplates.list.push({ name: r.input.trim(), data: CfgTemplates.snapshot() });
  await CfgTemplates.save();
  openModal("cfgDlg");
};

// ---------- # Etiquetas (paleta del teléfono) ----------
const PALETTE = [
  [UiLanguage.text("Calidad"), "masterpiece", "best quality", "very aesthetic", "absurdres", "highres", "newest", "detailed", "score_9"],
  [UiLanguage.text("Encuadre"), "portrait", "upper body", "cowboy shot", "full body", "close-up", "looking at viewer", "from above", "from below", "from side", "dutch angle", "wide shot"],
  ["Luz", "soft lighting", "cinematic lighting", "dramatic lighting", "rim light", "backlighting", "sunlight", "golden hour", "volumetric lighting", "neon lights", "night"],
  [UiLanguage.text("Estilo"), "anime coloring", "flat color", "watercolor (medium)", "oil painting (medium)", "sketch", "3d", "realistic", "pixel art", "chibi", "retro artstyle"],
  [UiLanguage.text("Expresión"), "smile", "blush", "open mouth", "closed eyes", "serious", "smug", "surprised", "angry", "crying", "wink"],
  [UiLanguage.text("Fondo"), "simple background", "white background", "outdoors", "indoors", "city", "forest", "beach", "sky", "bedroom", "cherry blossoms"],
];
const promptTokens = () => $("prompt").value.split(",").map((t) => t.trim()).filter(Boolean);
function toggleTag(tag) {
  const toks = promptTokens();
  const i = toks.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
  if (i >= 0) toks.splice(i, 1); else toks.push(tag);
  Loras.setPrompt(toks.join(", "));
}
function renderTags() {
  const have = new Set(promptTokens().map((t) => t.toLowerCase()));
  const body = $("tagsBody"); body.innerHTML = "";
  for (const [cat, ...tags] of PALETTE) {
    const sec = document.createElement("div"); sec.className = "tag-sec";
    sec.innerHTML = `<div class="chip-lbl"></div><div class="chips"></div>`;
    sec.querySelector(".chip-lbl").textContent = cat.toUpperCase();
    for (const t of tags) {
      const b = document.createElement("button");
      b.className = "chip" + (have.has(t) ? " on" : ""); b.textContent = t;
      b.onclick = () => { toggleTag(t); renderTags(); };
      sec.querySelector(".chips").appendChild(b);
    }
    body.appendChild(sec);
  }
}
$("tagsBtn").onclick = () => { renderTags(); openModal("tagsDlg"); };
$("clearPrompt").onclick = () => {
  const old = $("prompt").value; if (!old) return;
  Loras.setPrompt("");
  toast(UiLanguage.text("Prompt borrado · Ctrl+Z lo recupera"));
  $("prompt").focus();
};

// ---------- autocompletar etiquetas Danbooru (assets/tags.txt del teléfono) ----------
const AC = {
  tags: null, items: [], i: 0, start: 0, end: 0,
  async load() { if (!this.tags) { try { this.tags = (await (await fetch("tags.txt")).text()).split(/\r?\n/).filter(Boolean); } catch { this.tags = []; } } },
  hide() { $("acBox").classList.add("hidden"); this.items = []; },
  async update() {
    const ta = $("prompt"), pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return this.hide();
    const before = ta.value.slice(0, pos);
    const start = before.lastIndexOf(",") + 1;
    const raw = before.slice(start);
    const q = raw.trimStart();
    if (q.length < 2 || q.startsWith("<") || q.startsWith("(") || /\{/.test(q)) return this.hide();
    await this.load();
    const k = q.toLowerCase().replace(/_/g, " ");
    const pre = [], mid = [];
    for (const t of this.tags) {
      const tl = t.toLowerCase();
      if (tl.startsWith(k)) { if (pre.push(t) >= 8) break; } else if (mid.length < 8 && tl.includes(k)) mid.push(t);
    }
    this.items = [...pre, ...mid].slice(0, 8);
    if (!this.items.length || (this.items.length === 1 && this.items[0].toLowerCase() === k)) return this.hide();
    this.start = start + (raw.length - q.length); this.end = pos; this.i = 0;
    this.render();
  },
  pretty(t) { return t.length > 3 ? t.replace(/_/g, " ") : t; },
  render() {
    const box = $("acBox"); box.innerHTML = "";
    this.items.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "ac-item" + (i === this.i ? " on" : ""); b.textContent = this.pretty(t); b.setAttribute("role", "option");
      b.onmousedown = (e) => { e.preventDefault(); this.i = i; this.accept(); };
      box.appendChild(b);
    });
    box.classList.remove("hidden");
  },
  accept() {
    const ta = $("prompt"), t = this.pretty(this.items[this.i]);
    const after = ta.value.slice(this.end).replace(/^[^,]*/, "");
    const ins = t + (after.startsWith(",") ? "" : ", ");
    ta.value = ta.value.slice(0, this.start) + ins + after.replace(/^,\s*/, after ? ", " : "").replace(/^, $/, "");
    const caret = this.start + ins.length;
    ta.setSelectionRange(caret, caret);
    ta.dispatchEvent(new Event("input"));
    this.hide();
  },
};
$("prompt").addEventListener("input", () => AC.update());
$("prompt").addEventListener("click", () => AC.hide());
$("prompt").addEventListener("blur", () => setTimeout(() => AC.hide(), 120));
$("prompt").addEventListener("keydown", (e) => {
  if ($("acBox").classList.contains("hidden")) return;
  if (e.key === "ArrowDown") { e.preventDefault(); AC.i = (AC.i + 1) % AC.items.length; AC.render(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); AC.i = (AC.i - 1 + AC.items.length) % AC.items.length; AC.render(); }
  else if ((e.key === "Enter" && !e.ctrlKey) || e.key === "Tab") { e.preventDefault(); AC.accept(); }
  else if (e.key === "Escape") { e.preventDefault(); AC.hide(); }
}, true);

// ---------- contador de tokens (≈ caracteres / 3,6, como el teléfono) ----------
updatePromptMeta = function () {
  const o = currentOption();
  const p = $("prompt").value.replace(/<lora:[^>]*>/gi, "");
  const n = Math.ceil(p.length / 3.6);
  const el = $("promptMeta");
  if (!p.trim()) { el.textContent = ""; el.className = "prompt-meta"; return; }
  if (o?.family === "anima" || o?.family === "qwen" || o?.family === "moss" || o?.family === "mage") {
    el.textContent = `≈${n} / 512 tokens`;
    el.className = "prompt-meta" + (n > 512 ? " err" : n > 435 ? " warn" : "");
  } else {
    el.textContent = `≈${n} tokens · CLIP lee de a 75`;
    el.className = "prompt-meta";
  }
  const nn = Math.ceil($("neg").value.length / 3.6);
  $("negMeta").textContent = $("neg").value ? `≈${nn}` : "";
};
$("prompt").addEventListener("input", () => updatePromptMeta());
$("neg").addEventListener("input", () => updatePromptMeta());

// ---------- negativo: Predeterminado, Plantillas, Borrar ----------
let negStore = { saved: [], recent: [] };
invoke("store_get", { key: "negatives" }).then((v) => { if (v && typeof v === "object") negStore = { saved: v.saved || [], recent: v.recent || [] }; fillNeg(); }).catch(fillNeg);
function fillNeg() {
  const sel = $("negPick"); sel.innerHTML = "";
  sel.add(new Option("Plantillas", ""));
  sel.add(new Option(UiLanguage.text("＋ Guardar el negativo actual"), "@save"));
  negStore.saved.forEach((n, i) => sel.add(new Option("★ " + n.slice(0, 60), "s" + i)));
  negStore.recent.forEach((n, i) => sel.add(new Option("↺ " + n.slice(0, 60), "r" + i)));
  if (negStore.saved.length) sel.add(new Option(UiLanguage.text("Quitar una guardada…"), "@del"));
}
const saveNeg = () => invoke("store_set", { key: "negatives", value: negStore }).catch(() => {});
$("negPick").onchange = async () => {
  const v = $("negPick").value; $("negPick").value = "";
  if (v === "@save") {
    const n = $("neg").value.trim(); if (!n) return toast(UiLanguage.text("El negativo está vacío"));
    if (!negStore.saved.includes(n)) negStore.saved.unshift(n);
    await saveNeg(); fillNeg(); toast(UiLanguage.text("Negativo guardado"));
  } else if (v === "@del") {
    const r = await ask({ title: UiLanguage.text("Quitar un negativo guardado"), list: negStore.saved.map((n, i) => ({ label: n.slice(0, 90), value: String(i) })), buttons: [{ label: UiLanguage.text("Cancelar"), value: null }] });
    if (r != null) { negStore.saved.splice(+r, 1); await saveNeg(); fillNeg(); }
  } else if (v) {
    $("neg").value = (v[0] === "s" ? negStore.saved : negStore.recent)[+v.slice(1)] || "";
    updatePromptMeta();
  }
};
$("negDefault").onclick = () => { const o = currentOption(); $("neg").value = FAMILY[o?.preset || o?.family || "sdxl"].neg; updatePromptMeta(); };
$("negClear").onclick = () => { $("neg").value = ""; updatePromptMeta(); };
$("genBtn").addEventListener("click", () => {
  const n = $("neg").value.trim(); if (!n) return;
  negStore.recent = [n, ...negStore.recent.filter((x) => x !== n)].slice(0, 10);
  saveNeg(); fillNeg();
}, true);

// ---------- ↺ Restablecer muestreo ----------
$("resetSampling").onclick = () => {
  const o = currentOption(); if (!o) return;
  const p = FAMILY[o.preset || o.family];
  $("steps").value = p.steps; $("cfg").value = p.cfg; $("sampler").value = p.sampler; $("scheduler").value = p.scheduler;
  store.set("params:" + o.id, null);
  showEstimate(); toast(UiLanguage.template`Muestreo del modelo: ${p.steps} pasos · CFG ${p.cfg}`);
};

$("model").addEventListener("change", syncModelUi);
updatePromptMeta();
syncModelUi();
