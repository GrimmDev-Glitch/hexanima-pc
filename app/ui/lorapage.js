// HexAnima PC: página completa de LoRAs (barra lateral → LoRAs).
// Tarjetas con vista previa como el prototipo, más carpetas, presets, favoritas, selección
// múltiple y datos de Civitai por huella SHA256 (ideas de ComfyUI-lyw-MA-Loader).
"use strict";

const CAT_ICON = {
  character: '<circle cx="12" cy="7" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  clothing: '<path d="M8 3l4 3 4-3 5 4-3 3v11H6V10L3 7z"/>',
  poses: '<circle cx="12" cy="4" r="2"/><path d="M12 6v7M6 9l6 2 6-2M9 21l3-8 3 8"/>',
  style: '<path d="M12 3a9 9 0 1 0 0 18c1 0 2-1 2-2s-1-1-1-2 1-2 2-2h2a4 4 0 0 0 4-4c0-4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="16.5" cy="11" r="1"/>',
  concept: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z"/>',
  background: '<path d="M3 20l6-9 4 6 3-4 5 7z"/><circle cx="17" cy="6" r="2"/>',
  objects: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  all: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  none: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  preset: '<path d="M4 6h16M4 12h10M4 18h7"/><circle cx="18" cy="16" r="3"/>',
};
const svgIcon = (k, s = 16) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CAT_ICON[k] || ""}</svg>`;
const fmtMB = (b) => (b >= 1073741824 ? (b / 1073741824).toFixed(1) + " GB" : Math.round(b / 1048576) + " MB");
const assetUrl = (p) => (p ? window.__TAURI__.core.convertFileSrc(p) : null);

/** Botón de una lista vertical de filtros (columna izquierda). */
function flistItem(icon, label, count, on, onClick, extra) {
  const b = document.createElement("button");
  b.className = "fitem" + (on ? " on" : "");
  b.innerHTML = `${icon ? svgIcon(icon) : ""}<span class="fname"></span>${count != null ? `<span class="fcount">${count}</span>` : ""}`;
  b.querySelector(".fname").textContent = label;
  b.onclick = onClick;
  if (extra) b.oncontextmenu = extra;
  return b;
}

const LoraPage = {
  folder: "*",        // "*" todas, "" raíz, "sub/carpeta"
  favOnly: false,
  base: "all",
  cat: "all",
  selecting: false,
  sel: new Set(),
  folders: [],
  presets: [],

  async show() {
    await Loras.refresh();
    try { this.folders = await invoke("lora_folders"); } catch { this.folders = []; }
    try { this.presets = await invoke("lora_presets_get"); } catch { this.presets = []; }
    this.render();
  },

  baseKey(l) {
    const b = (l.base || "").toLowerCase();
    if (!b) return "?";
    if (b.includes("anima")) return "Anima";
    if (b.includes("illustrious")) return "Illustrious";
    if (b.includes("noob")) return "NoobAI";
    if (b.includes("pony")) return "Pony";
    if (b.includes("xl")) return "SDXL";
    if (b.includes("flux")) return "Flux";
    return l.base;
  },

  filtered() {
    const q = $("lpSearch").value.trim().toLowerCase();
    const tags = Loras.tags();
    let list = Loras.lib.filter((l) =>
      (this.folder === "*" || (l.folder || "") === this.folder) &&
      (!this.favOnly || l.fav) &&
      (this.base === "all" || this.baseKey(l) === this.base) &&
      (this.cat === "all" || (this.cat === "none" ? !l.cat : l.cat === this.cat)) &&
      (!q || `${l.stem} ${l.title} ${l.words.join(" ")} ${l.note || ""}`.toLowerCase().includes(q)));
    const sort = $("lpSort").value;
    const cmp = {
      name: (a, b) => a.title.localeCompare(b.title, "es", { sensitivity: "base" }),
      new: (a, b) => (b.modified || 0) - (a.modified || 0),
      size: (a, b) => b.bytes - a.bytes,
      active: (a, b) => Number(tags.has(b.stem.toLowerCase())) - Number(tags.has(a.stem.toLowerCase())) || a.title.localeCompare(b.title),
    }[sort];
    return list.sort(cmp);
  },

  render() {
    const lib = Loras.lib;
    // Carpetas + favoritas
    const fl = $("lpFolders"); fl.innerHTML = "";
    const count = (f) => lib.filter((l) => (l.folder || "") === f).length;
    fl.appendChild(flistItem("all", "Todas", lib.length, this.folder === "*" && !this.favOnly, () => { this.folder = "*"; this.favOnly = false; this.render(); }));
    fl.appendChild(flistItem("star", "Favoritas", lib.filter((l) => l.fav).length, this.favOnly, () => { this.favOnly = true; this.folder = "*"; this.render(); }));
    if (this.folders.length) fl.appendChild(flistItem("folder", "Sin carpeta", count(""), this.folder === "" && !this.favOnly, () => { this.folder = ""; this.favOnly = false; this.render(); }));
    for (const f of this.folders) {
      const depth = f.split("/").length - 1;
      const it = flistItem("folder", f.split("/").pop(), count(f), this.folder === f && !this.favOnly, () => { this.folder = f; this.favOnly = false; this.render(); });
      it.style.paddingLeft = 10 + depth * 14 + "px";
      fl.appendChild(it);
    }
    // Presets
    const pl = $("lpPresets"); pl.innerHTML = "";
    if (!this.presets.length) pl.innerHTML = '<div class="lbl fempty">Activa LoRAs y pulsa «+ Guardar» para crear un preset.</div>';
    this.presets.forEach((p, i) => {
      const it = flistItem("preset", p.name, p.loras.length, false, () => this.applyPreset(p, false),
        (e) => { e.preventDefault(); this.presetMenu(i, e.clientX, e.clientY); });
      it.title = p.loras.map((l) => `${l.stem}:${l.w}`).join(", ") + "\nClic: aplicar (reemplaza) · clic derecho: más opciones";
      pl.appendChild(it);
    });
    // Chips de base y categoría (solo los presentes)
    const bases = {}; for (const l of lib) { const k = this.baseKey(l); bases[k] = (bases[k] || 0) + 1; }
    const chipRow = (el, items, cur, set) => {
      el.innerHTML = "";
      for (const it of items) {
        const b = document.createElement("button");
        b.className = "chip" + (cur === it.key ? " on" : "");
        b.innerHTML = `${it.icon ? svgIcon(it.icon, 14) : ""}<span></span>`;
        b.querySelector("span").textContent = it.label;
        b.onclick = () => { set(it.key); this.render(); };
        el.appendChild(b);
      }
    };
    chipRow($("lpBase"), [{ key: "all", label: `Todas  ${lib.length}` }, ...Object.keys(bases).sort().map((k) => ({ key: k, label: `${k === "?" ? "Sin datos" : k}  ${bases[k]}` }))], this.base, (k) => (this.base = k));
    const cats = {}; let none = 0; for (const l of lib) { if (l.cat) cats[l.cat] = (cats[l.cat] || 0) + 1; else none++; }
    chipRow($("lpCats"), [
      { key: "all", label: "Todas", icon: "all" },
      ...CAT_ORDER.map((c) => ({ key: c, label: `${CAT_LABEL[c]}${cats[c] ? "  " + cats[c] : ""}`, icon: c })),
      { key: "none", label: `Sin categoría  ${none}`, icon: "none" },
    ], this.cat, (k) => (this.cat = k));

    const shown = this.filtered();
    const active = Loras.tags();
    $("lpCount").textContent = `${shown.length} de ${lib.length} LoRAs${active.size ? ` · activos en el prompt: ${active.size}` : ""}`;
    $("lpBulk").classList.toggle("hidden", !this.selecting);
    $("lpSelect").textContent = this.selecting ? "Hecho" : "Seleccionar";
    $("lpSelCount").textContent = `Seleccionados: ${this.sel.size}`;

    const grid = $("lpGrid"); grid.innerHTML = "";
    if (!lib.length) grid.innerHTML = '<div class="lbl empty-lib">Vacía: importa un archivo .safetensors o descarga LoRAs desde la sección Civitai.</div>';
    else if (!shown.length) grid.innerHTML = '<div class="lbl empty-lib">Ningún LoRA coincide con los filtros.</div>';
    for (const l of shown) grid.appendChild(this.card(l, active.get(l.stem.toLowerCase())));
  },

  card(l, t) {
    const c = document.createElement("div");
    c.className = "lcard" + (t ? " on" : "") + (this.sel.has(l.file) ? " sel" : "");
    const src = assetUrl(l.preview_local) || (l.preview && !l.nsfw ? String(l.preview).replace(/\/(width=\d+|original=true)\//, "/width=320/") : null);
    c.innerHTML = `
      <div class="lthumb">${src ? '<img loading="lazy" alt="">' : svgIcon(l.cat || "none", 28)}
        <button class="lfav" title="Favorita" aria-label="Favorita"></button>
        ${this.selecting ? '<input type="checkbox" class="lsel" aria-label="Seleccionar">' : ""}
        ${t ? '<span class="luse">En uso</span>' : ""}</div>
      <div class="lbody">
        <div class="ltitle-row"><div class="ltitle"></div><button class="mini lmore" title="Más opciones" aria-label="Más opciones">⋯</button></div>
        <div class="lmeta"><span class="lbase"></span><span>${fmtMB(l.bytes)}</span></div>
        <div class="lwords"></div>
        <div class="lctl">
          <input class="field lora-num" type="number" min="-2" max="2" step="0.05" inputmode="decimal">
          <button class="ghost sm luse-btn"></button>
          <button class="mini" title="Cambiar nombre" aria-label="Cambiar nombre">✎</button>
        </div>
      </div>`;
    if (src) c.querySelector("img").src = src;
    c.querySelector(".lfav").textContent = l.fav ? "★" : "☆";
    c.querySelector(".lfav").classList.toggle("on", !!l.fav);
    c.querySelector(".ltitle").textContent = l.title;
    c.querySelector(".ltitle").title = `${l.title}\n<lora:${l.stem}>${l.folder ? "\nCarpeta: " + l.folder : ""}${l.note ? "\nNota: " + l.note : ""}`;
    const fam = currentOption()?.family;
    const bk = this.baseKey(l);
    const mismatch = l.base && fam && ((fam === "anima") !== /anima/i.test(l.base));
    const base = c.querySelector(".lbase");
    base.textContent = (bk === "?" ? "Sin datos" : bk) + (l.cat ? " · " + CAT_LABEL[l.cat] : "");
    base.classList.toggle("warn", !!mismatch);
    if (mismatch) base.title = "Para otro modelo: puede no funcionar con el modelo cargado";
    c.querySelector(".lwords").textContent = l.words.length ? l.words.join(", ") : "Sin palabras activadoras";
    const w = c.querySelector(".lora-num");
    w.value = t ? String(t.w) : "1.0"; w.setAttribute("aria-label", "Fuerza de " + l.title);
    const use = c.querySelector(".luse-btn");
    use.textContent = t ? "Quitar" : "Usar";
    use.onclick = () => { if (t) Loras.removeTag(l.stem); else Loras.setTag(l.stem, readNum(w) || 1); this.render(); };
    w.onchange = () => { const v = clampNum(w, 1); if (t) { Loras.setTag(l.stem, v); this.render(); } };
    w.onkeydown = (e) => { if (e.key === "Enter") w.blur(); };
    c.querySelector('.lctl .mini').onclick = () => Loras.rename(l).then(() => this.show());
    c.querySelector(".lfav").onclick = async (e) => { e.stopPropagation(); await invoke("lora_set_meta", { file: l.file, patch: { fav: !l.fav } }); await this.show(); };
    const more = (x, y) => this.menu(l, x, y);
    c.querySelector(".lmore").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); more(r.left, r.bottom); };
    c.oncontextmenu = (e) => { e.preventDefault(); more(e.clientX, e.clientY); };
    const chk = c.querySelector(".lsel");
    if (chk) {
      chk.checked = this.sel.has(l.file);
      const toggle = () => { if (this.sel.has(l.file)) this.sel.delete(l.file); else this.sel.add(l.file); this.render(); };
      chk.onchange = toggle;
      c.querySelector(".lthumb").onclick = (e) => { if (e.target === chk || e.target.closest(".lfav")) return; toggle(); };
    }
    return c;
  },

  menu(l, x, y) {
    const after = () => this.show();
    showMenu(x, y, l.title, [
      { label: `Categoría: ${l.cat ? CAT_LABEL[l.cat] : "Sin categoría"}…`, run: () => Loras.category(l).then(after) },
      { label: "Copiar palabras activadoras", run: async () => {
          if (!l.words.length) return toast("No declara palabras activadoras");
          await copyText(l.words.join(", ")); toast("Copiado: " + l.words.join(", "));
        } },
      { label: "Editar palabras activadoras…", run: () => Loras.editWords(l).then(after) },
      { label: "Añadir activadoras al prompt", run: () => { Loras.addWords(l); this.render(); } },
      { label: "Cambiar nombre…", run: () => Loras.rename(l).then(after) },
      { label: l.note ? "Editar nota…" : "Añadir nota…", run: () => this.note(l) },
      { label: "Mover a carpeta…", run: () => this.moveTo([l.file]) },
      { label: l.civitai_checked === "ok" || l.model_id ? "Actualizar datos de Civitai" : "Buscar datos en Civitai", run: () => this.fetchInfo([l.file]) },
      ...(l.model_id ? [{ label: "Abrir en Civitai", run: () => invoke("open_url", { url: `https://civitai.com/models/${l.model_id}${l.version_id ? "?modelVersionId=" + l.version_id : ""}` }) }] : []),
      { label: "Eliminar", danger: true, run: () => Loras.remove(l).then(after) },
    ]);
  },

  async note(l) {
    const r = await ask({ title: `Nota: ${l.title}`, input: { value: l.note || "", placeholder: "p. ej. mejor a 0.6, usar con estilo X" },
      buttons: [{ label: "Cancelar", value: null }, { label: "Guardar", value: "@input", primary: true }] });
    if (!r) return;
    await invoke("lora_set_meta", { file: l.file, patch: { note: r.input } });
    await this.show();
  },

  async moveTo(files) {
    const list = [{ label: "Sin carpeta (raíz)", value: "@root" }, ...this.folders.map((f) => ({ label: f, value: f })), { label: "+ Nueva carpeta…", value: "@new" }];
    let dest = await ask({ title: files.length > 1 ? `Mover ${files.length} LoRAs a…` : "Mover a carpeta", list, buttons: [{ label: "Cancelar", value: null }] });
    if (!dest) return;
    if (dest === "@new") dest = await this.newFolder();
    if (!dest) return;
    let ok = 0;
    for (const f of files) { try { await invoke("lora_move", { file: f, folder: dest === "@root" ? "" : dest }); ok++; } catch (e) { toast(String(e)); } }
    this.sel.clear();
    toast(`Movidos: ${ok}`);
    await this.show();
  },

  async newFolder() {
    const r = await ask({ title: "Nueva carpeta", input: { value: "", placeholder: "p. ej. Personajes/Anime" },
      buttons: [{ label: "Cancelar", value: null }, { label: "Crear", value: "@input", primary: true }] });
    if (!r?.input?.trim()) return null;
    try { const f = await invoke("lora_make_folder", { name: r.input }); this.folders = await invoke("lora_folders"); this.render(); return f; }
    catch (e) { toast(String(e)); return null; }
  },

  async fetchInfo(files) {
    if (!files.length) return toast("Todos los LoRAs ya tienen datos");
    let found = 0, missing = 0;
    for (let i = 0; i < files.length; i++) {
      toast(`Consultando Civitai… ${i + 1} / ${files.length}`, 60000);
      try { const r = await invoke("lora_fetch_info", { file: files[i], key: Civitai.key() }); if (r.found) found++; else missing++; }
      catch (e) { toast("Civitai: " + (e.message || e), 5000); break; }
      await sleep(400); // sin saturar la API
    }
    toast(`Datos de Civitai: ${found} encontrados${missing ? `, ${missing} no están en Civitai` : ""}`, 4500);
    await this.show();
  },

  // ---------- presets ----------
  async savePresets() { await invoke("lora_presets_set", { presets: this.presets }); this.render(); },

  async savePreset(fromFiles) {
    let loras;
    if (fromFiles) {
      const tags = Loras.tags();
      loras = Loras.lib.filter((l) => fromFiles.includes(l.file)).map((l) => ({ stem: l.stem, w: tags.get(l.stem.toLowerCase())?.w ?? 1 }));
    } else {
      loras = [...Loras.tags().values()].map((t) => ({ stem: t.stem, w: t.w }));
    }
    if (!loras.length) return toast("No hay LoRAs activos en el prompt para guardar");
    const r = await ask({ title: "Guardar preset", msg: loras.map((l) => `<lora:${l.stem}:${l.w}>`).join("  "),
      input: { value: "", placeholder: "Nombre del preset" }, buttons: [{ label: "Cancelar", value: null }, { label: "Guardar", value: "@input", primary: true }] });
    if (!r?.input?.trim()) return;
    this.presets.push({ name: r.input.trim(), loras });
    await this.savePresets();
    toast("Preset guardado: " + r.input.trim());
  },

  applyPreset(p, add) {
    if (!add) for (const [, t] of Loras.tags()) Loras.removeTag(t.stem);
    const missing = [];
    for (const l of p.loras) { if (Loras.byStem(l.stem)) Loras.setTag(l.stem, l.w); else missing.push(l.stem); }
    this.render();
    toast(`Preset «${p.name}» ${add ? "añadido" : "aplicado"}${missing.length ? ` · faltan: ${missing.join(", ")}` : ""}`, 4000);
  },

  presetMenu(i, x, y) {
    const p = this.presets[i];
    showMenu(x, y, p.name, [
      { label: "Aplicar (reemplaza los activos)", run: () => this.applyPreset(p, false) },
      { label: "Añadir a los activos", run: () => this.applyPreset(p, true) },
      { label: "Sobrescribir con los activos", run: async () => { p.loras = [...Loras.tags().values()].map((t) => ({ stem: t.stem, w: t.w })); await this.savePresets(); toast("Preset actualizado"); } },
      { label: "Cambiar nombre…", run: async () => {
          const r = await ask({ title: "Cambiar nombre", input: { value: p.name }, buttons: [{ label: "Cancelar", value: null }, { label: "OK", value: "@input", primary: true }] });
          if (r?.input?.trim()) { p.name = r.input.trim(); await this.savePresets(); }
        } },
      { label: "Eliminar", danger: true, run: async () => { this.presets.splice(i, 1); await this.savePresets(); } },
    ]);
  },

  async exportPresets() {
    await copyText(JSON.stringify(this.presets, null, 2));
    toast("Presets copiados al portapapeles (JSON). Pégalos en un archivo o en otra PC.", 4500);
  },

  async importPresets() {
    const r = await ask({ title: "Importar presets", msg: "Pega el JSON exportado desde HexAnima PC.", input: { value: "", placeholder: '[{"name":"…","loras":[{"stem":"…","w":0.8}]}]' },
      buttons: [{ label: "Cancelar", value: null }, { label: "Importar", value: "@input", primary: true }] });
    if (!r) return;
    try {
      const arr = JSON.parse(r.input);
      const ok = (Array.isArray(arr) ? arr : []).filter((p) => p && typeof p.name === "string" && Array.isArray(p.loras));
      this.presets.push(...ok.map((p) => ({ name: p.name, loras: p.loras.filter((l) => l && l.stem).map((l) => ({ stem: String(l.stem), w: +l.w || 1 })) })));
      await this.savePresets();
      toast(`Importados: ${ok.length} presets`);
    } catch { toast("El texto no es un JSON válido de presets", 4000); }
  },
};

$("lpSearch").oninput = () => LoraPage.render();
$("lpSort").onchange = () => LoraPage.render();
$("lpImport").onclick = async () => { await Loras.import(); await LoraPage.show(); };
$("lpNewFolder").onclick = () => LoraPage.newFolder();
$("lpSavePreset").onclick = () => LoraPage.savePreset(null);
$("lpExport").onclick = () => LoraPage.exportPresets();
$("lpImportPresets").onclick = () => LoraPage.importPresets();
$("lpFetchAll").onclick = () => LoraPage.fetchInfo(Loras.lib.filter((l) => !l.model_id && l.civitai_checked !== "not_found").map((l) => l.file));
$("lpSelect").onclick = () => { LoraPage.selecting = !LoraPage.selecting; LoraPage.sel.clear(); LoraPage.render(); };
$("lpSelAll").onclick = () => { for (const l of LoraPage.filtered()) LoraPage.sel.add(l.file); LoraPage.render(); };
const selLibs = () => Loras.lib.filter((l) => LoraPage.sel.has(l.file));
$("lpBulkUse").onclick = () => { for (const l of selLibs()) if (!Loras.tags().has(l.stem.toLowerCase())) Loras.setTag(l.stem, 1); LoraPage.render(); };
$("lpBulkOff").onclick = () => { for (const l of selLibs()) Loras.removeTag(l.stem); LoraPage.render(); };
$("lpBulkCat").onclick = async () => {
  const items = selLibs(); if (!items.length) return;
  const v = await ask({ title: `Categoría de ${items.length} LoRAs`, list: [{ label: "Sin categoría", value: "none" }, ...CAT_ORDER.map((c) => ({ label: CAT_LABEL[c], value: c }))], buttons: [{ label: "Cancelar", value: null }] });
  if (!v) return;
  for (const l of items) await invoke("lora_set_meta", { file: l.file, patch: { cat: v } });
  await LoraPage.show();
};
$("lpBulkMove").onclick = () => { if (LoraPage.sel.size) LoraPage.moveTo([...LoraPage.sel]); };
$("lpBulkInfo").onclick = () => LoraPage.fetchInfo([...LoraPage.sel]);
$("lpBulkPreset").onclick = () => { if (LoraPage.sel.size) LoraPage.savePreset([...LoraPage.sel]); };
$("lpBulkTrash").onclick = async () => {
  const items = selLibs(); if (!items.length) return;
  const ok = await ask({ title: `¿Eliminar ${items.length} LoRAs?`, msg: "Se envían a la Papelera de reciclaje con su .json y su vista previa (se pueden recuperar).", buttons: [{ label: "Cancelar", value: false }, { label: "Eliminar", value: true, primary: true }] });
  if (!ok) return;
  for (const l of items) { try { await invoke("lora_trash", { file: l.file }); Loras.removeTag(l.stem); } catch (e) { toast(String(e)); } }
  LoraPage.sel.clear();
  await LoraPage.show();
};
