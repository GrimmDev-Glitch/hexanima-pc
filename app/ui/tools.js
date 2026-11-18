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
  $("modelName").textContent = o ? modelTitle(o) : "Sin modelo";
  const loaded = !!o && state.loaded === o.id;
  $("modelDot").className = "dot" + (loaded ? " on" : "");
  $("loadBtn").textContent = loaded ? "Liberar modelo" : "Cargar modelo";
  $("loadBtn").disabled = !o || state.busy;
  if (!state.busy && o && !/Cargando|Error|No se pudo|motor/i.test($("modelStatus").textContent)) {
    setStatus(loaded ? "En memoria · lista" : "No está en memoria · se carga al generar", loaded ? "ok" : "");
  }
}
setInterval(syncModelUi, 1000);

$("loadBtn").onclick = async () => {
  const o = currentOption(); if (!o || state.busy) return;
  if (state.loaded === o.id) {
    try { await api("/sdcpp/v1/models/unload", { method: "POST" }); state.loaded = null; setStatus("Modelo liberado: la RAM y la VRAM quedan libres", "ok"); }
    catch (e) { setStatus("No se pudo liberar: " + e.message, "err"); }
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
    $("modelCount").textContent = state.options.length ? `${state.options.length} instalados` : "";
    if (!state.options.length) box.innerHTML = '<div class="lbl empty-lib">No hay modelos: usa ＋ Civitai o ＋ Importar.</div>';
    for (const o of state.options) {
      const p = FAMILY[o.preset || o.family];
      const sel = $("model").value === o.id, loaded = state.loaded === o.id;
      const est = Object.entries(localStorageSafe()).filter(([k]) => k.startsWith("hx.bench:" + o.id + ":")).map(([, v]) => { try { const b = JSON.parse(v); return b.fixed + b.step * p.steps; } catch { return null; } }).filter(Boolean)[0];
      const c = document.createElement("div");
      c.className = "mcard" + (sel ? " on" : "");
      c.innerHTML = `<div class="mtop"><span class="mname"></span>${sel ? '<span class="mcheck">✓</span>' : ""}<button class="mini mreveal" title="Mostrar el archivo en la carpeta" aria-label="Mostrar en la carpeta">⌕</button><button class="mini medit" title="Cambiar nombre" aria-label="Cambiar nombre">✎</button></div>
        <div class="mbadges"></div><div class="lbl mfile"></div>`;
      c.querySelector(".mname").textContent = modelTitle(o);
      const badges = [o.family === "anima" ? "Anima" : "SDXL", o.preset === "anima" ? `Turbo · ${p.steps}` : `CFG ${p.cfg} · ${p.steps} pasos`];
      const gb = this.bytes(o); if (gb) badges.push((gb / 1073741824).toFixed(1) + " GB");
      if (est) badges.push("~" + fmtS(est));
      if (loaded) badges.push("En memoria");
      for (const b of badges) { const s = document.createElement("span"); s.className = "badge" + (b === "En memoria" ? " ok" : ""); s.textContent = b; c.querySelector(".mbadges").appendChild(s); }
      c.querySelector(".mfile").textContent = Object.values(o.models)[0];
      c.onclick = (e) => {
        if (e.target.closest(".medit, .mreveal")) return;
        $("model").value = o.id; $("model").dispatchEvent(new Event("change"));
        closeModal("modelDlg"); syncModelUi();
      };
      c.querySelector(".mreveal").onclick = () => invoke("reveal_file", { path: "models/" + Object.values(o.models)[0] }).catch((e) => toast(String(e)));
      c.querySelector(".medit").onclick = async () => {
        const r = await ask({ title: "Cambiar nombre", input: { value: modelTitle(o) },
          buttons: [{ label: "Cancelar", value: null }, { label: "Restablecer", value: "reset" }, { label: "OK", value: "@input", primary: true }] });
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
  showMenu(r.left, r.top - 8, "Abrir carpeta", [
    { label: "Checkpoints (SDXL / Illustrious / Pony)", run: () => open("models/checkpoints") },
    { label: "Anima (diffusion_models)", run: () => open("models/diffusion_models") },
    { label: "Codificadores de texto", run: () => open("models/text_encoders") },
    { label: "VAE", run: () => open("models/vae") },
    { label: "Ampliadores", run: () => open("models/upscalers") },
    { label: "Detectores (ADetailer)", run: () => open("models/detectors") },
    { label: "Toda la carpeta models", run: () => open("models") },
  ]);
};
$("mdCatalog").onclick = () => toast("El catálogo de modelos para PC llega en la fase 3; por ahora usa ＋ Civitai o ＋ Importar", 4500);
$("mdCivitai").onclick = () => {
  closeModal("modelDlg");
  Civitai.type = "Checkpoint";
  document.querySelector('.nav[data-page="civitai"]').click();
};
$("mdImport").onclick = async () => {
  try {
    const f = await invoke("model_import");
    if (!f) return;
    await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    await scanModels();
    ModelPicker.render();
    toast("Modelo importado: " + f);
  } catch (e) { toast("No se pudo importar: " + (e.message || e), 5000); }
};

// ---------- menú ⋯ (como el del teléfono) ----------
$("menuBtn").onclick = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showMenu(r.right - 250, r.bottom + 4, "HexAnima", [
    { label: "Modelos", run: () => ModelPicker.open() },
    { label: "Civitai", run: () => document.querySelector('.nav[data-page="civitai"]').click() },
    { label: "Plantillas de configuración", run: () => CfgTemplates.open() },
    { label: "Ampliar una imagen de la galería", run: () => pickImage().then((src) => src && Upscale.open(src)) },
    { label: "Cargar ajustes desde un PNG", run: loadPngSettings },
    { label: "Ajustes", run: () => document.querySelector('.nav[data-page="settings"]').click() },
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

async function loadPngSettings() {
  try {
    const meta = await invoke("png_pick_settings");
    if (meta) History.useSettings({ meta });
  } catch (e) { toast(String(e.message || e), 4500); }
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
    if (!this.list.length) box.innerHTML = '<div class="lbl">Todavía no hay plantillas.</div>';
    this.list.forEach((t, i) => {
      const b = document.createElement("button");
      b.className = "ask-item"; b.textContent = t.name;
      b.title = `${t.data.prompt.slice(0, 120)}\n${t.data.steps} pasos · CFG ${t.data.cfg}`;
      b.onclick = () => { this.apply(t.data); closeModal("cfgDlg"); toast("Plantilla cargada: " + t.name); };
      b.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, t.name, [
          { label: "Sobrescribir con la configuración actual", run: async () => { t.data = this.snapshot(); await this.save(); toast("Plantilla actualizada"); } },
          { label: "Cambiar nombre…", run: async () => { const r = await ask({ title: "Cambiar nombre", input: { value: t.name }, buttons: [{ label: "Cancelar", value: null }, { label: "OK", value: "@input", primary: true }] }); if (r?.input?.trim()) { t.name = r.input.trim(); await this.save(); } } },
          { label: "Eliminar", danger: true, run: async () => { this.list.splice(i, 1); await this.save(); } },
        ]);
      };
      box.appendChild(b);
    });
  },
};
$("cfgSave").onclick = async () => {
  const r = await ask({ title: "Guardar plantilla", input: { value: "", placeholder: "Nombre de la plantilla" }, buttons: [{ label: "Cancelar", value: null }, { label: "Guardar", value: "@input", primary: true }] });
  if (!r?.input?.trim()) return CfgTemplates.open();
  CfgTemplates.list.push({ name: r.input.trim(), data: CfgTemplates.snapshot() });
  await CfgTemplates.save();
  openModal("cfgDlg");
};

// ---------- # Etiquetas (paleta del teléfono) ----------
const PALETTE = [
  ["Calidad", "masterpiece", "best quality", "very aesthetic", "absurdres", "highres", "newest", "detailed", "score_9"],
  ["Encuadre", "portrait", "upper body", "cowboy shot", "full body", "close-up", "looking at viewer", "from above", "from below", "from side", "dutch angle", "wide shot"],
  ["Luz", "soft lighting", "cinematic lighting", "dramatic lighting", "rim light", "backlighting", "sunlight", "golden hour", "volumetric lighting", "neon lights", "night"],
  ["Estilo", "anime coloring", "flat color", "watercolor (medium)", "oil painting (medium)", "sketch", "3d", "realistic", "pixel art", "chibi", "retro artstyle"],
  ["Expresión", "smile", "blush", "open mouth", "closed eyes", "serious", "smug", "surprised", "angry", "crying", "wink"],
  ["Fondo", "simple background", "white background", "outdoors", "indoors", "city", "forest", "beach", "sky", "bedroom", "cherry blossoms"],
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
  toast("Prompt borrado · Ctrl+Z lo recupera");
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
  if (o?.family === "anima") {
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
  sel.add(new Option("＋ Guardar el negativo actual", "@save"));
  negStore.saved.forEach((n, i) => sel.add(new Option("★ " + n.slice(0, 60), "s" + i)));
  negStore.recent.forEach((n, i) => sel.add(new Option("↺ " + n.slice(0, 60), "r" + i)));
  if (negStore.saved.length) sel.add(new Option("Quitar una guardada…", "@del"));
}
const saveNeg = () => invoke("store_set", { key: "negatives", value: negStore }).catch(() => {});
$("negPick").onchange = async () => {
  const v = $("negPick").value; $("negPick").value = "";
  if (v === "@save") {
    const n = $("neg").value.trim(); if (!n) return toast("El negativo está vacío");
    if (!negStore.saved.includes(n)) negStore.saved.unshift(n);
    await saveNeg(); fillNeg(); toast("Negativo guardado");
  } else if (v === "@del") {
    const r = await ask({ title: "Quitar un negativo guardado", list: negStore.saved.map((n, i) => ({ label: n.slice(0, 90), value: String(i) })), buttons: [{ label: "Cancelar", value: null }] });
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
  showEstimate(); toast(`Muestreo del modelo: ${p.steps} pasos · CFG ${p.cfg}`);
};

$("model").addEventListener("change", syncModelUi);
updatePromptMeta();
syncModelUi();
