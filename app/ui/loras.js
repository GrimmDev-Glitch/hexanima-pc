// HexAnima PC: LoRAs y Civitai, replicando HexAnima Android (MainLora / Civitai / CivitaiActivity).
// Un LoRA está activo cuando su etiqueta <lora:nombre:fuerza> está en el prompt, como en el teléfono.
"use strict";

const CAT_LABEL = {
  character: "Personaje", clothing: "Ropa", poses: "Pose", style: "Estilo",
  concept: "Concepto", background: "Fondo", objects: "Objeto",
};
const CAT_ORDER = ["character", "clothing", "poses", "style", "concept", "background", "objects"];
const TAG_RE = /<lora:([^:>]+)(?::\s*(-?[\d.,]+))?\s*>/gi;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- utilidades de interfaz compartidas ----------
function toast(text, ms = 2600) {
  const t = $("toast");
  t.textContent = text; t.classList.remove("hidden");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* sin permiso */ }
  const ta = document.createElement("textarea");
  ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  const ok = document.execCommand("copy"); ta.remove(); return ok;
}

function openModal(id) { $(id).classList.remove("hidden"); }
function closeModal(id) { $(id).classList.add("hidden"); }
for (const m of document.querySelectorAll(".modal")) {
  m.addEventListener("mousedown", (e) => { if (e.target === m && m.id !== "askDlg") closeModal(m.id); });
  for (const b of m.querySelectorAll("[data-close]")) b.addEventListener("click", () => closeModal(m.id));
}
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  hideMenu();
  const open = [...document.querySelectorAll(".modal:not(.hidden)")].pop();
  if (open && open.id !== "askDlg") closeModal(open.id);
});

/** Diálogo genérico. opts: {title, msg, input:{value,placeholder}, list:[{label,value}], buttons:[{label,value,primary}]} */
function ask(opts) {
  return new Promise((resolve) => {
    $("askTitle").textContent = opts.title || "";
    $("askMsg").textContent = opts.msg || "";
    $("askMsg").classList.toggle("hidden", !opts.msg);
    const inp = $("askInput");
    inp.classList.toggle("hidden", !opts.input);
    if (opts.input) { inp.value = opts.input.value || ""; inp.placeholder = opts.input.placeholder || ""; }
    const list = $("askList"); list.innerHTML = "";
    list.classList.toggle("hidden", !opts.list);
    const done = (v) => { closeModal("askDlg"); document.removeEventListener("keydown", onKey, true); resolve(v); };
    for (const it of opts.list || []) {
      const b = document.createElement("button");
      b.className = "ask-item" + (it.on ? " on" : ""); b.textContent = it.label;
      b.onclick = () => done(it.value);
      list.appendChild(b);
    }
    const btns = $("askBtns"); btns.innerHTML = "";
    for (const it of opts.buttons || [{ label: "Cancelar", value: null }]) {
      const b = document.createElement("button");
      b.className = it.primary ? "primary sm" : "ghost";
      b.textContent = it.label;
      b.onclick = () => done(it.value === "@input" ? { input: inp.value } : it.value);
      btns.appendChild(b);
    }
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(null); }
      if (e.key === "Enter" && opts.input) { e.preventDefault(); const p = (opts.buttons || []).find((x) => x.primary); if (p) done(p.value === "@input" ? { input: inp.value } : p.value); }
    };
    document.addEventListener("keydown", onKey, true);
    openModal("askDlg");
    if (opts.input) setTimeout(() => { inp.focus(); inp.select(); }, 0);
  });
}

function hideMenu() { $("ctxMenu").classList.add("hidden"); }
document.addEventListener("mousedown", (e) => { if (!$("ctxMenu").contains(e.target)) hideMenu(); });
/** Menú contextual (equivale a la pulsación larga del teléfono). */
function showMenu(x, y, title, items) {
  const m = $("ctxMenu");
  m.innerHTML = "";
  const h = document.createElement("div"); h.className = "ctx-title"; h.textContent = title; m.appendChild(h);
  for (const it of items) {
    const b = document.createElement("button");
    b.className = "ctx-item" + (it.danger ? " danger" : ""); b.textContent = it.label; b.setAttribute("role", "menuitem");
    b.onclick = () => { hideMenu(); it.run(); };
    m.appendChild(b);
  }
  m.classList.remove("hidden");
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}

// ---------- LoRAs ----------
const Loras = {
  lib: [],          // [{file, stem, title, alias, name, cat, words, base, ...}]
  cat: "all",       // chip elegido

  async refresh() {
    try { this.lib = await invoke("lora_list"); } catch { this.lib = []; }
    this.renderPanel();
    if (!$("loraDlg").classList.contains("hidden")) this.renderLib();
  },

  byStem(stem) {
    const s = stem.trim().toLowerCase();
    return this.lib.find((l) => l.stem.toLowerCase() === s);
  },

  /** Etiquetas del prompt: Map stem(minúsculas) -> {stem, w} */
  tags(prompt = $("prompt").value) {
    const out = new Map();
    for (const m of prompt.matchAll(TAG_RE)) {
      const w = m[2] == null ? 1 : parseFloat(m[2].replace(",", "."));
      out.set(m[1].trim().toLowerCase(), { stem: m[1].trim(), w: Number.isFinite(w) ? w : 1 });
    }
    return out;
  },

  /** Para generar: lista estructurada para el motor y prompt sin etiquetas. */
  fromPrompt(prompt) {
    const lora = [], missing = [];
    for (const [, t] of this.tags(prompt)) {
      if (t.w === 0) continue; // fuerza 0 = desactivado (como en el teléfono)
      const l = this.byStem(t.stem);
      if (l) lora.push({ path: l.file, multiplier: t.w, is_high_noise: false });
      else missing.push(t.stem);
    }
    const clean = prompt.replace(TAG_RE, "").replace(/\s*,\s*(,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
    return { prompt: clean, lora, missing };
  },

  setPrompt(text) {
    $("prompt").value = text;
    $("prompt").dispatchEvent(new Event("input"));
    store.set("prompt", text);
  },

  /** Activa (añade la etiqueta al final, separada por comas) o cambia la fuerza. */
  setTag(stem, w) {
    const p = $("prompt").value;
    const re = new RegExp(`<lora:${esc(stem)}(?::([^>]*))?>`, "i");
    const n = +w;
    const tag = `<lora:${stem}:${Number.isInteger(n) ? n.toFixed(1) : String(+n.toFixed(2))}>`;
    if (re.test(p)) this.setPrompt(p.replace(re, tag));
    else this.setPrompt(p.trim() ? p.replace(/[,\s]*$/, "") + ", " + tag : tag);
  },

  removeTag(stem) {
    const re = new RegExp(`\\s*,?\\s*<lora:${esc(stem)}(?::([^>]*))?>`, "ig");
    this.setPrompt($("prompt").value.replace(re, "").replace(/^\s*,\s*/, ""));
  },

  /** Panel lateral: LoRAs activos leídos del prompt, con su fuerza editable. */
  renderPanel() {
    const tags = this.tags();
    $("loraCount").textContent = tags.size ? `· activos: ${tags.size}` : "";
    const list = $("loraList");
    list.innerHTML = "";
    for (const [, t] of tags) {
      const l = this.byStem(t.stem);
      const d = document.createElement("div");
      d.className = "lora" + (l ? "" : " missing");
      d.innerHTML = `<div class="row"><span class="name"></span><span class="lora-ctl">
        <input class="field lora-num" type="number" min="-2" max="2" step="0.05" inputmode="decimal">
        <button class="x" aria-label="Quitar">×</button></span></div>`;
      const name = d.querySelector(".name");
      name.textContent = l ? l.title : t.stem + " (no está)";
      name.title = l ? `<lora:${l.stem}> · ${l.words.join(", ") || "sin palabras activadoras"}` : "Este LoRA no está en la carpeta loras";
      const inp = d.querySelector("input");
      inp.value = String(t.w); inp.setAttribute("aria-label", "Fuerza de " + (l ? l.title : t.stem));
      inp.onchange = () => this.setTag(t.stem, clampNum(inp, 1));
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
      d.querySelector(".x").onclick = () => this.removeTag(t.stem);
      list.appendChild(d);
    }
  },

  open() {
    hideMenu();
    $("loraFilter").value = "";
    this.renderLib();
    openModal("loraDlg");
    setTimeout(() => $("loraFilter").focus(), 0);
  },

  renderLib() {
    const tags = this.tags();
    $("loraActive").textContent = tags.size ? `activos: ${tags.size}` : "";
    // Chips de categoría: Todas N, las presentes con su número, Sin categoría N.
    const counts = {}; let none = 0;
    for (const l of this.lib) { if (l.cat) counts[l.cat] = (counts[l.cat] || 0) + 1; else none++; }
    const cats = $("loraCats"); cats.innerHTML = "";
    const present = CAT_ORDER.filter((c) => counts[c]);
    if (present.length) {
      const chip = (key, label) => {
        const b = document.createElement("button");
        b.className = "chip" + (this.cat === key ? " on" : ""); b.textContent = label;
        b.onclick = () => { this.cat = key; this.renderLib(); };
        cats.appendChild(b);
      };
      chip("all", `Todas  ${this.lib.length}`);
      for (const c of present) chip(c, `${CAT_LABEL[c]}  ${counts[c]}`);
      if (none) chip("none", `Sin categoría  ${none}`);
    } else this.cat = "all";
    cats.classList.toggle("hidden", !present.length);

    const q = $("loraFilter").value.trim().toLowerCase();
    const rows = $("loraRows"); rows.innerHTML = "";
    const shown = this.lib.filter((l) =>
      (this.cat === "all" || (this.cat === "none" ? !l.cat : l.cat === this.cat)) &&
      (!q || `${l.stem} ${l.title} ${l.words.join(" ")}`.toLowerCase().includes(q)));
    if (!this.lib.length) {
      rows.innerHTML = '<div class="lbl empty-lib">Vacía: descarga LoRAs de Civitai o importa un archivo.</div>';
    }
    const fam = currentOption()?.family;
    for (const l of shown) {
      const t = tags.get(l.stem.toLowerCase());
      const r = document.createElement("div");
      r.className = "lora-row" + (t ? " on" : "");
      r.innerHTML = `<input type="checkbox" class="lora-chk">
        <div class="lora-txt"><div class="lora-title"></div><div class="lora-sub"></div></div>
        <span class="badge"></span>
        <button class="mini lora-edit" title="Cambiar nombre" aria-label="Cambiar nombre">✎</button>
        <input class="field lora-num" type="number" min="-2" max="2" step="0.05" inputmode="decimal">
        <button class="mini lora-more" title="Más opciones" aria-label="Más opciones">⋯</button>`;
      const chk = r.querySelector(".lora-chk"); chk.checked = !!t; chk.setAttribute("aria-label", "Activar " + l.title);
      r.querySelector(".lora-title").textContent = l.title;
      r.querySelector(".lora-sub").textContent = l.words.length ? l.words.join(", ") : l.stem;
      const badge = r.querySelector(".badge");
      badge.textContent = l.base || "";
      const mismatch = l.base && fam && ((fam === "anima") !== /anima/i.test(l.base));
      badge.classList.toggle("warn", !!mismatch);
      badge.title = mismatch ? "Este LoRA es para otro modelo: puede no funcionar con el modelo cargado" : "";
      if (!l.base) badge.remove();
      const w = r.querySelector(".lora-num");
      w.value = t ? String(t.w) : "1.0"; w.setAttribute("aria-label", "Fuerza de " + l.title);
      const toggle = (on) => { if (on) this.setTag(l.stem, readNum(w) || 1); else this.removeTag(l.stem); this.renderLib(); this.renderPanel(); };
      chk.onchange = () => toggle(chk.checked);
      r.onclick = (e) => { if (e.target.closest("input,button")) return; chk.checked = !chk.checked; toggle(chk.checked); };
      w.oninput = () => { const v = readNum(w); if (chk.checked && Number.isFinite(v)) { this.setTag(l.stem, v); this.renderPanel(); } };
      w.onkeydown = (e) => { if (e.key === "Enter") w.blur(); };
      r.querySelector(".lora-edit").onclick = () => this.rename(l);
      r.querySelector(".lora-more").onclick = (e) => { const b = e.currentTarget.getBoundingClientRect(); this.menu(l, b.left, b.bottom); };
      r.oncontextmenu = (e) => { e.preventDefault(); this.menu(l, e.clientX, e.clientY); };
      rows.appendChild(r);
    }
    $("loraHint").textContent = this.lib.length ? "Clic derecho o ⋯ para más opciones" : "";
  },

  menu(l, x, y) {
    showMenu(x, y, l.title, [
      { label: `Categoría: ${l.cat ? CAT_LABEL[l.cat] : "Sin categoría"}…`, run: () => this.category(l) },
      { label: "Copiar palabras activadoras", run: async () => {
          if (!l.words.length) return toast("No declara palabras activadoras");
          await copyText(l.words.join(", ")); toast("Copiado: " + l.words.join(", "));
        } },
      { label: "Editar palabras activadoras…", run: () => this.editWords(l) },
      { label: "Añadir activadoras al prompt", run: () => this.addWords(l) },
      { label: "Cambiar nombre…", run: () => this.rename(l) },
      { label: "Eliminar", danger: true, run: () => this.remove(l) },
    ]);
  },

  async category(l) {
    const list = [{ label: "Sin categoría", value: "none", on: !l.cat }, ...CAT_ORDER.map((c) => ({ label: CAT_LABEL[c], value: c, on: l.cat === c }))];
    const v = await ask({ title: "Categoría", list, buttons: [{ label: "Cancelar", value: null }] });
    if (!v) return;
    await invoke("lora_set_meta", { file: l.file, patch: { cat: v } });
    await this.refresh();
  },

  async editWords(l) {
    const r = await ask({
      title: `Activadoras: ${l.title}`,
      msg: "Palabras o frase que activan la LoRA, separadas por comas. Se añaden al prompt con «Añadir activadoras al prompt».",
      input: { value: l.words.join(", "), placeholder: "p. ej. estilo3d, personaje x" },
      buttons: [{ label: "Cancelar", value: null }, { label: "Guardar", value: "@input", primary: true }],
    });
    if (!r) return;
    await invoke("lora_set_meta", { file: l.file, patch: { words: r.input.split(",") } });
    await this.refresh();
  },

  addWords(l) {
    if (!l.words.length) return toast("Sin palabras activadoras: usa «Editar palabras activadoras…»");
    const p = $("prompt").value;
    const have = new Set(p.split(",").map((x) => x.trim().toLowerCase()));
    const add = l.words.filter((w) => !have.has(w.trim().toLowerCase()));
    if (add.length) this.setPrompt(p.trim() ? p.replace(/[,\s]*$/, "") + ", " + add.join(", ") : add.join(", "));
    toast("Palabras activadoras de la LoRA añadidas al prompt");
  },

  async rename(l) {
    const r = await ask({
      title: "Cambiar nombre", input: { value: l.title },
      buttons: [{ label: "Cancelar", value: null }, { label: "Restablecer", value: "reset" }, { label: "OK", value: "@input", primary: true }],
    });
    if (!r) return;
    await invoke("lora_set_meta", { file: l.file, patch: { alias: r === "reset" ? "" : r.input } });
    await this.refresh();
  },

  async remove(l) {
    const ok = await ask({
      title: `¿Eliminar ${l.title}?`, msg: "Se envía a la Papelera de reciclaje junto con su .json (se puede recuperar).",
      buttons: [{ label: "Cancelar", value: false }, { label: "Eliminar", value: true, primary: true }],
    });
    if (!ok) return;
    try {
      await invoke("lora_trash", { file: l.file });
      this.removeTag(l.stem);
      await this.refresh();
      toast("Eliminado: " + l.title);
    } catch (e) { toast(String(e.message || e)); }
  },

  async import() {
    try {
      const r = await invoke("lora_import");
      await this.refresh();
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
      for (const f of r.failed) toast(`El LoRA «${f.file}» no sirve: ${f.error}`, 5000);
      if (r.imported.length) {
        const last = r.imported[r.imported.length - 1];
        toast(`✓ ${r.imported.length === 1 ? last.stem : r.imported.length + " LoRAs"} · En el prompt: <lora:${last.stem}:1.0>`, 4500);
      }
    } catch (e) { toast("No se pudo importar: " + (e.message || e), 5000); }
  },
};

$("loraOpen").onclick = () => Loras.open();
$("loraFilter").oninput = () => Loras.renderLib();
$("loraImport").onclick = () => Loras.import();
$("prompt").addEventListener("input", () => Loras.renderPanel());

// ---------- Civitai ----------
const FAMILIES = [
  { key: "anima", label: "Anima", base: ["Anima"] },
  { key: "illustrious", label: "Illustrious", base: ["Illustrious"] },
  { key: "noobai", label: "NoobAI", base: ["NoobAI"] },
  { key: "pony", label: "Pony", base: ["Pony"] },
  { key: "sdxl", label: "SDXL", base: ["SDXL 1.0"] },
];
const SORTS = [
  { key: "Most Downloaded", label: "Más descargados" },
  { key: "Highest Rated", label: "Mejor valorados" },
  { key: "Newest", label: "Más recientes" },
];

const Civitai = {
  family: null, cat: "", type: "LORA", sort: "Most Downloaded",
  cursor: null, items: [], index: { ids: [], names: [] }, model: null, dl: null,

  key() { return store.get("civitaiKey", "") || null; },

  async open() {
    if (!this.family) this.family = currentOption()?.family === "anima" ? "anima" : "illustrious";
    $("civNsfw").checked = !!this.key() && store.get("civitaiNsfw", false);
    $("civSort").value = this.sort;
    this.renderChips();
    if (!this.items.length) this.search();
  },

  /** Filtros en columna (página Civitai): TIPO, FAMILIA y CATEGORÍA con iconos y una línea resumen. */
  renderChips() {
    const group = (el, opts, cur, set) => {
      el.innerHTML = "";
      for (const o of opts) el.appendChild(flistItem(o.icon, o.label, null, cur === o.key, () => { set(o.key); this.renderChips(); this.search(); }));
    };
    group($("civType"), [{ key: "LORA", label: "LoRA", icon: "preset" }, { key: "Checkpoint", label: "Modelos (checkpoints)", icon: "objects" }], this.type, (k) => (this.type = k));
    group($("civFamily"), FAMILIES.map((f) => ({ ...f, icon: null })), this.family, (k) => (this.family = k));
    group($("civCat"), [{ key: "", label: "Todas", icon: "all" }, ...CAT_ORDER.map((c) => ({ key: c, label: CAT_LABEL[c], icon: c }))], this.cat, (k) => (this.cat = k));
    const fam = FAMILIES.find((f) => f.key === this.family)?.label;
    $("civFilterTxt").textContent = [this.type === "LORA" ? "LoRA" : "Modelos", fam, this.cat ? CAT_LABEL[this.cat] : "", $("civNsfw").checked ? "+18" : ""].filter(Boolean).join(" · ");
  },

  /** Enlace o id de civitai.com / civitai.red -> abre la ficha directamente. */
  parseLink(q) {
    const m = q.match(/civitai\.(?:com|red|green)\/models\/(\d+)(?:[^?]*\?(?:.*&)?modelVersionId=(\d+))?/i);
    if (m) return { id: +m[1], version: m[2] ? +m[2] : null };
    if (/^\d{3,9}$/.test(q.trim())) return { id: +q.trim(), version: null };
    return null;
  },

  async search(more = false) {
    const q = $("civQuery").value.trim();
    const link = !more && this.parseLink(q);
    if (link) return this.openModel(link.id, link.version);
    if (!more) { this.cursor = null; this.items = []; $("civGrid").innerHTML = ""; }
    $("civInfo").textContent = "Buscando…";
    $("civMore").classList.add("hidden");
    try {
      [this.index] = await Promise.all([invoke("downloaded_index"), Promise.resolve()]);
      const fam = FAMILIES.find((f) => f.key === this.family);
      const r = await invoke("civitai_search", {
        params: { query: q || null, tag: this.cat || null, types: [this.type], base_models: fam ? fam.base : [], sort: $("civSort").value, nsfw: $("civNsfw").checked, cursor: this.cursor },
        key: this.key(),
      });
      const items = r.items || [];
      this.items.push(...items);
      this.cursor = r.metadata?.nextCursor || null;
      for (const m of items) $("civGrid").appendChild(this.card(m));
      $("civInfo").textContent = this.items.length ? `Encontrados: ${this.items.length}` : "No se encontraron resultados";
      $("civMore").classList.toggle("hidden", !this.cursor);
    } catch (e) { $("civInfo").textContent = "Error: " + (e.message || e); }
  },

  isDownloaded(m, v) {
    const ids = new Set(this.index.ids);
    if (ids.has("model_id:" + m.id)) return true;
    for (const ver of v ? [v] : m.modelVersions || []) {
      if (ids.has("version_id:" + ver.id)) return true;
      const f = this.mainFile(ver);
      if (f && this.index.names.includes(fileName(f.name).toLowerCase())) return true;
    }
    return false;
  },

  /** Primer archivo "Model" .safetensors; si no, el primario; si no, el primer .safetensors. */
  mainFile(ver) {
    const fs = ver?.files || [];
    return fs.find((f) => f.type === "Model" && /\.safetensors$/i.test(f.name)) || fs.find((f) => f.primary) ||
      fs.find((f) => /\.safetensors$/i.test(f.name)) || fs[0] || null;
  },

  thumb(m) {
    const img = (m.modelVersions?.[0]?.images || m.images || []).find((i) => i.type !== "video" && !/\.(mp4|webm)$/i.test(i.url || ""));
    if (!img) return null;
    if (!$("civNsfw").checked && (img.nsfwLevel || 0) > 1) return null;
    // Miniatura de 320 px (Civitai a veces da el original a tamaño completo: varios MB).
    return img.url.replace(/\/(width=\d+|original=true)\//, "/width=320/");
  },

  /** Tarjeta estilo prototipo: imagen arriba, datos y botón abajo. */
  card(m) {
    const v = m.modelVersions?.[0] || {};
    const c = document.createElement("div");
    c.className = "ccard";
    const src = this.thumb(m);
    const done = this.isDownloaded(m);
    c.innerHTML = `<div class="cthumb">${src ? '<img loading="lazy" alt="">' : '<span class="lbl">sin vista previa</span>'}
        ${done ? '<span class="cok">✓ Descargada</span>' : ""}${m.nsfw ? '<span class="c18">18+</span>' : ""}</div>
      <div class="cbody"><div class="cname"></div>
        <div class="lmeta"><span class="cbase"></span><span class="csize"></span></div>
        <div class="lbl cby"></div><div class="lbl ctrig"></div>
        <button class="ghost sm cbtn"></button></div>`;
    if (src) c.querySelector("img").src = src;
    c.querySelector(".cname").textContent = m.name;
    const tw = v.trainedWords || [];
    c.title = [m.name, [m.type, v.baseModel].filter(Boolean).join(" · "), tw.length ? "Activadoras: " + tw.join(", ") : "", "Clic: ver versiones y descargar"].filter(Boolean).join("\n");
    c.querySelector(".cbase").textContent = [m.type === "LORA" ? "LoRA" : m.type, v.baseModel].filter(Boolean).join(" · ");
    const f = this.mainFile(v);
    c.querySelector(".csize").textContent = f?.sizeKB ? fmtMB(f.sizeKB * 1024) : "";
    c.querySelector(".cby").textContent = `${m.creator?.username || ""} · ⬇ ${(m.stats?.downloadCount || 0).toLocaleString("es")}`;
    const words = v.trainedWords || [];
    c.querySelector(".ctrig").textContent = words.length ? "Activador: " + words[0] + (words.length > 1 ? "…" : "") : "";
    c.querySelector(".cbtn").textContent = done ? "Ver · ya la tienes" : "Ver y descargar";
    c.onclick = () => this.openModel(m.id, null, m);
    return c;
  },

  async openModel(id, versionId, cached) {
    let m = cached;
    try { if (!m || !m.modelVersions?.[0]?.files) m = await invoke("civitai_model", { id, key: this.key() }); }
    catch (e) { return toast("Error: " + (e.message || e), 4000); }
    this.model = m;
    $("sheetTitle").textContent = m.name;
    const sel = $("sheetVersion"); sel.innerHTML = "";
    for (const v of m.modelVersions || []) sel.add(new Option(`${v.name} · ${v.baseModel || "?"}`, String(v.id)));
    if (versionId) sel.value = String(versionId);
    const src = this.thumb(m);
    $("sheetImg").classList.toggle("hidden", !src);
    if (src) $("sheetImg").src = src;
    this.renderSheet();
    openModal("sheetDlg");
  },

  version() { return (this.model?.modelVersions || []).find((v) => String(v.id) === $("sheetVersion").value); },

  renderSheet() {
    const m = this.model, v = this.version();
    if (!v) return;
    const f = this.mainFile(v);
    const done = this.isDownloaded(m, v);
    $("sheetInfo").textContent = [done ? "✓ Esta versión ya está descargada" : "", [m.type, v.baseModel, f ? `${(f.sizeKB / 1024).toFixed(0)} MB` : ""].filter(Boolean).join(" · ")].filter(Boolean).join("\n");
    const words = v.trainedWords || [];
    const w = $("sheetWords"); w.innerHTML = "";
    if (words.length) {
      const lbl = document.createElement("div"); lbl.className = "lbl"; lbl.textContent = "Palabras activadoras:"; w.appendChild(lbl);
      const chips = document.createElement("div"); chips.className = "chips";
      for (const t of words) { const b = document.createElement("button"); b.className = "chip"; b.textContent = t; b.title = "Copiar"; b.onclick = async () => { await copyText(t); toast("Copiado: " + t); }; chips.appendChild(b); }
      w.appendChild(chips);
    }
    const busy = !!this.dl;
    $("sheetDl").disabled = busy || !f;
    $("sheetDl").textContent = f ? (done ? "Descargar de nuevo" : "Descargar") : "Esta versión no contiene ningún archivo";
    $("sheetCancel").classList.toggle("hidden", !busy);
    $("sheetProgress").classList.toggle("hidden", !busy);
  },

  async download() {
    const m = this.model, v = this.version(), f = this.mainFile(v);
    if (!f || this.dl) return;
    if (m.nsfw && !this.key()) {
      toast("Este modelo es +18: añade tu clave API de Civitai en Ajustes", 4500);
      return;
    }
    const isLora = /^(LORA|LoCon|DoRA|LyCORIS)$/i.test(m.type);
    const anima = /anima/i.test(v.baseModel || "");
    const kind = isLora ? "lora" : anima ? "diffusion_model" : "checkpoint";
    const img = (v.images || []).find((i) => i.type !== "video");
    const meta = {
      name: m.name, version: v.name, model_id: m.id, version_id: v.id, type: m.type, base: v.baseModel || null,
      words: v.trainedWords || [], preview: img ? img.url : null, nsfw: !!m.nsfw, tags: m.tags || [],
    };
    this.dl = String(v.id);
    this.renderSheet();
    $("sheetProgTxt").textContent = "Descargando…";
    try {
      const file = await invoke("civitai_download", { req: { id: this.dl, url: f.downloadUrl, kind, file_name: f.name, meta }, key: this.key() });
      this.index = await invoke("downloaded_index");
      if (isLora) {
        await Loras.refresh();
        const stem = file.replace(/^.*\//, "").replace(/\.(safetensors|gguf)$/i, "");
        toast(`✓ ${m.name}\nEn el prompt: <lora:${stem}:1.0>${meta.words.length ? "\nPalabras activadoras: " + meta.words.join(", ") : ""}`, 6000);
      } else {
        await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
        await scanModels();
        toast(`✓ ${m.name}: ya aparece en Modelo`, 5000);
      }
      // Volver a dibujar las tarjetas para marcar "✓ Descargada".
      $("civGrid").innerHTML = ""; for (const it of this.items) $("civGrid").appendChild(this.card(it));
    } catch (e) {
      if (!/cancelada/i.test(String(e))) toast("Falló la descarga: " + (e.message || e), 5000);
    } finally {
      this.dl = null;
      this.renderSheet();
    }
  },
};

/** Igual que fileName() del teléfono: [^A-Za-z0-9._-]+ -> "_". */
function fileName(n) {
  return n.replace(/\.safetensors$/i, "").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "lora";
}

$("civGo").onclick = () => Civitai.search();
$("civSort").onchange = () => { Civitai.sort = $("civSort").value; Civitai.search(); };
$("civQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") Civitai.search(); });
$("civMore").onclick = () => Civitai.search(true);
$("civNsfw").onchange = () => {
  if ($("civNsfw").checked && !Civitai.key()) {
    $("civNsfw").checked = false;
    toast("Para ver +18 añade tu clave API de Civitai en Ajustes", 4000);
    return;
  }
  store.set("civitaiNsfw", $("civNsfw").checked);
  Civitai.renderChips();
  Civitai.search();
};
$("sheetVersion").onchange = () => Civitai.renderSheet();
$("sheetDl").onclick = () => Civitai.download();
$("sheetCancel").onclick = () => { if (Civitai.dl) invoke("civitai_cancel", { id: Civitai.dl }); };
$("sheetWeb").onclick = () => {
  const m = Civitai.model, v = Civitai.version();
  if (m) invoke("open_url", { url: `https://civitai.com/models/${m.id}${v ? "?modelVersionId=" + v.id : ""}` });
};
window.__TAURI__?.event?.listen?.("dl-progress", (ev) => {
  const p = ev.payload;
  if (!Civitai.dl || p.id !== Civitai.dl) return;
  const mb = (b) => (b / 1048576).toFixed(0);
  $("sheetProgTxt").textContent = p.state === "downloading"
    ? `Descargando · ${mb(p.done)}${p.total ? " / " + mb(p.total) : ""} MB` : p.state === "done" ? "✓ Descargado" : p.state === "cancelled" ? "Cancelada" : "Falló la descarga";
  $("sheetBar").style.width = p.total ? `${(100 * p.done) / p.total}%` : "0%";
});

// Ajustes: clave API de Civitai
$("optCivitaiKey").value = store.get("civitaiKey", "");
$("optCivitaiKey").onchange = () => { store.set("civitaiKey", $("optCivitaiKey").value.trim()); };
$("openCivitaiAccount").onclick = () => invoke("open_url", { url: "https://civitai.com/user/account" });

// Páginas de la barra lateral: LoRAs (completa), Civitai e Historial se preparan al abrirlas.
for (const n of document.querySelectorAll(".nav")) {
  n.addEventListener("click", () => {
    const p = n.dataset.page;
    if (p === "loras") LoraPage.show();
    if (p === "civitai") Civitai.open();
    if (p === "history") History.show();
  });
}
Loras.renderPanel();
