// HexAnima PC: Historial (como el del teléfono): cuadrícula, Todas / Favoritas, filtros por
// modelo, LoRA y prompt, selección múltiple y las acciones de cada imagen.
"use strict";

const History = {
  items: [],       // [{name, path, bytes, modified, meta}]
  tab: "all",
  cur: null,       // nombre de la imagen abierta
  selecting: false,
  sel: new Set(),

  async show() {
    try { this.items = await invoke("gallery_list"); } catch (e) { this.items = []; toast("No se pudo leer outputs: " + (e.message || e)); }
    this.buildFilters();
    this.render();
    if (this.cur && !this.items.some((i) => i.name === this.cur)) this.cur = null;
    if (!this.cur && this.visible()[0]) this.open(this.visible()[0].name);
    else this.renderDetail();
  },

  loraNames(it) {
    const m = it.meta || {};
    if (Array.isArray(m.loras) && m.loras.length) return m.loras.map((l) => String(l.file).replace(/^.*\//, "").replace(/\.(safetensors|gguf)$/i, ""));
    return [...String(m.prompt || "").matchAll(/<lora:([^:>]+)/gi)].map((x) => x[1]);
  },

  buildFilters() {
    const models = [...new Set(this.items.map((i) => i.meta?.model_label).filter(Boolean))].sort();
    const loras = [...new Set(this.items.flatMap((i) => this.loraNames(i)))].sort((a, b) => a.localeCompare(b));
    const fill = (el, first, vals) => {
      const cur = el.value;
      el.innerHTML = "";
      el.add(new Option(first, ""));
      for (const v of vals) el.add(new Option(v, v));
      if (vals.includes(cur)) el.value = cur;
    };
    fill($("hModel"), "Todos los modelos", models);
    fill($("hLora"), "Todas las LoRA", loras);
  },

  visible() {
    const q = $("hSearch").value.trim().toLowerCase();
    const mod = $("hModel").value, lo = $("hLora").value;
    return this.items.filter((i) =>
      (this.tab === "all" || i.meta?.fav) &&
      (!mod || i.meta?.model_label === mod) &&
      (!lo || this.loraNames(i).includes(lo)) &&
      (!q || `${i.meta?.prompt || ""} ${i.name}`.toLowerCase().includes(q)));
  },

  render() {
    $("hCountAll").textContent = this.items.length;
    $("hCountFav").textContent = this.items.filter((i) => i.meta?.fav).length;
    for (const t of document.querySelectorAll("[data-htab]")) t.classList.toggle("on", t.dataset.htab === this.tab);
    $("hBulk").classList.toggle("hidden", !this.selecting);
    $("hSelect").textContent = this.selecting ? "Hecho" : "Seleccionar";
    $("hSelCount").textContent = `Seleccionadas: ${this.sel.size}`;
    const grid = $("hGrid"); grid.innerHTML = "";
    const list = this.visible();
    if (!list.length) grid.innerHTML = `<div class="lbl empty-lib">${this.items.length ? "Ninguna imagen coincide con los filtros." : "Todavía no hay imágenes: genera la primera en Generar."}</div>`;
    for (const it of list) {
      const b = document.createElement("button");
      b.className = "hcell" + (it.name === this.cur ? " on" : "") + (this.sel.has(it.name) ? " sel" : "");
      b.innerHTML = `<img loading="lazy" alt="">${it.meta?.fav ? '<span class="hstar">★</span>' : ""}${this.selecting ? '<span class="hchk"></span>' : ""}`;
      b.querySelector("img").src = assetUrl(it.path);
      b.title = it.meta?.prompt ? it.meta.prompt.slice(0, 160) : it.name;
      b.onclick = () => {
        if (this.selecting) { if (this.sel.has(it.name)) this.sel.delete(it.name); else this.sel.add(it.name); this.render(); }
        else this.open(it.name);
      };
      grid.appendChild(b);
    }
  },

  open(name) {
    this.cur = name;
    this.render();
    this.renderDetail();
  },

  item() { return this.items.find((i) => i.name === this.cur); },

  renderDetail() {
    const it = this.item();
    $("hActions").classList.toggle("hidden", !it);
    $("hPrompt").classList.toggle("hidden", !it?.meta?.prompt);
    $("hEmpty").classList.toggle("hidden", !!it);
    $("hImg").classList.toggle("hidden", !it);
    if (!it) { $("hInfo").textContent = ""; return; }
    const m = it.meta || {};
    $("hImg").src = assetUrl(it.path);
    const date = m.created ? new Date(m.created) : new Date((it.modified || 0) * 1000);
    $("hInfo").textContent = [m.model_label, m.width && m.height ? `${m.width} × ${m.height}` : "", m.seed != null ? `seed ${m.seed}` : "",
      date.toLocaleString("es", { dateStyle: "short", timeStyle: "short" }), m.seconds ? `${m.seconds} s` : ""].filter(Boolean).join(" · ");
    $("hPrompt").textContent = m.prompt || "";
    $("hFav").textContent = m.fav ? "★ Favorita" : "☆ Favorita";
    $("hFav").classList.toggle("on", !!m.fav);
    $("hUpscale").classList.remove("hidden");
    $("hUse").disabled = !m.prompt;
  },

  step(d) {
    const list = this.visible();
    const i = list.findIndex((x) => x.name === this.cur);
    const n = list[i + d];
    if (n) this.open(n.name);
  },

  async dataUrl(it) { return "data:image/png;base64," + (await invoke("read_output", { name: it.name })); },

  /** ↻ Usar estos ajustes: prompt (con LoRAs), negativo, muestreo, seed, tamaño y modelo. */
  useSettings(it) {
    const m = it.meta || {};
    if (m.prompt != null) Loras.setPrompt(m.prompt);
    if (m.negative != null) $("neg").value = m.negative;
    if (m.steps) $("steps").value = m.steps;
    if (m.cfg != null) $("cfg").value = m.cfg;
    const pick = (sel, val, labels) => {
      if (!val) return;
      if ([...sel.options].some((o) => o.value === val)) sel.value = val;
      else { const o = [...sel.options].find((x) => x.text.toLowerCase() === String(labels || val).toLowerCase()); if (o) sel.value = o.value; }
    };
    pick($("sampler"), m.sampler, m.sampler_label);
    pick($("scheduler"), m.scheduler, m.scheduler_label);
    if (!m.sampler && m.sampler_label) pick($("sampler"), null, m.sampler_label);
    if (m.seed != null) $("seed").value = String(m.seed);
    if (m.clip_skip != null) $("clipskip").value = String(m.clip_skip);
    if (m.width && m.height) {
      $("customW").value = m.width; $("customH").value = m.height;
      document.querySelector('#aspect button[data-a="c"]').click();
    }
    let note = "";
    if (m.model && state.options.some((o) => o.id === m.model)) {
      if ($("model").value !== m.model) { $("model").value = m.model; $("model").dispatchEvent(new Event("change")); note = " · pulsa Cargar para usar ese modelo"; }
    } else if (m.model_label) note = ` · el modelo «${m.model_label}» no está instalado`;
    document.querySelector('.nav[data-page="gen"]').click();
    toast("Ajustes cargados" + note, 4000);
  },

  async edit(it) {
    try {
      await setEditImage(await this.dataUrl(it));
      setMode("edit");
      document.querySelector('.nav[data-page="gen"]').click();
      toast("Imagen lista para editar: escribe qué cambiar y pulsa Aplicar a la foto", 4500);
    } catch (e) { toast("No se pudo abrir la imagen: " + (e.message || e)); }
  },

  async copyImage(it) {
    try {
      const blob = await (await fetch(await this.dataUrl(it))).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Imagen copiada al portapapeles");
    } catch { toast("No se pudo copiar la imagen; usa «Mostrar en la carpeta»", 4000); }
  },

  async trash(names) {
    const ok = await ask({
      title: names.length > 1 ? `¿Mover ${names.length} imágenes a la papelera?` : "¿Mover a la papelera?",
      msg: "Van a la Papelera de reciclaje de Windows con sus ajustes; desde ahí se pueden restaurar.",
      buttons: [{ label: "Cancelar", value: false }, { label: "Mover a la papelera", value: true, primary: true }],
    });
    if (!ok) return;
    try { await invoke("gallery_trash", { names }); } catch (e) { return toast(String(e.message || e), 4500); }
    const list = this.visible();
    const i = list.findIndex((x) => x.name === this.cur);
    this.sel.clear();
    await this.show();
    const next = this.visible()[Math.min(i, this.visible().length - 1)];
    if (next) this.open(next.name);
    toast(names.length > 1 ? `${names.length} imágenes en la papelera` : "Imagen en la papelera");
  },
};

for (const t of document.querySelectorAll("[data-htab]")) t.onclick = () => { History.tab = t.dataset.htab; History.render(); };
$("hModel").onchange = () => History.render();
$("hLora").onchange = () => History.render();
$("hSearch").oninput = () => History.render();
$("hSelect").onclick = () => { History.selecting = !History.selecting; History.sel.clear(); History.render(); };
$("hSelAll").onclick = () => { for (const i of History.visible()) History.sel.add(i.name); History.render(); };
$("hBulkFav").onclick = async () => {
  const items = History.items.filter((i) => History.sel.has(i.name));
  const fav = !items.every((i) => i.meta?.fav);
  for (const i of items) await invoke("gallery_fav", { name: i.name, fav });
  await History.show();
};
$("hBulkTrash").onclick = () => { if (History.sel.size) History.trash([...History.sel]); };
$("hFav").onclick = async () => { const it = History.item(); if (!it) return; await invoke("gallery_fav", { name: it.name, fav: !it.meta?.fav }); await History.show(); };
$("hUse").onclick = () => { const it = History.item(); if (it) History.useSettings(it); };
$("hEdit").onclick = () => { const it = History.item(); if (it) History.edit(it); };
$("hCopyPrompt").onclick = async () => { const p = History.item()?.meta?.prompt; if (!p) return toast("Esta imagen no tiene prompt guardado"); await copyText(p); toast("Prompt copiado"); };
$("hPrompt").onclick = () => $("hCopyPrompt").click();
$("hCopyImg").onclick = () => { const it = History.item(); if (it) History.copyImage(it); };
$("hReveal").onclick = () => { const it = History.item(); if (it) invoke("gallery_reveal", { name: it.name }); };
$("hTrash").onclick = () => { const it = History.item(); if (it) History.trash([it.name]); };
$("hUpscale").onclick = async () => {
  const it = History.item(); if (!it) return;
  await Upscale.open(await History.dataUrl(it));
};
document.addEventListener("keydown", (e) => {
  if (!$("page-history").classList.contains("on") || e.target.closest("input,textarea,select") || document.querySelector(".modal:not(.hidden)")) return;
  if (e.key === "ArrowRight") History.step(1);
  if (e.key === "ArrowLeft") History.step(-1);
  if (e.key === "Delete" && History.cur) History.trash([History.cur]);
});
