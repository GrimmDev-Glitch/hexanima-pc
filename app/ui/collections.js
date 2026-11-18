// HexAnima PC: colecciones de Civitai. Guardan modelos de Civitai (LoRAs o checkpoints) como si
// fueran carpetas, sin descargarlos: se ven en LoRAs → COLECCIONES y se descargan cuando quieras.
// Se guardan en config/civitai-collections.json. También importa los favoritos de tu cuenta.
"use strict";

const Collections = {
  list: [],          // [{id, name, items: [snapshot del modelo]}]
  loaded: false,
  dl: null,          // descarga en curso de "Descargar las que faltan"

  async load() {
    if (this.loaded) return this.list;
    try { const v = await invoke("store_get", { key: "civitai-collections" }); this.list = Array.isArray(v?.list) ? v.list : []; }
    catch { this.list = []; }
    this.loaded = true;
    return this.list;
  },

  async save() {
    await invoke("store_set", { key: "civitai-collections", value: { list: this.list } });
    if (typeof LoraPage !== "undefined" && LoraPage.visible()) LoraPage.render();
    this.renderCivSide();
  },

  byId(id) { return this.list.find((c) => c.id === id); },
  has(c, modelId) { return c.items.some((i) => i.id === modelId); },
  inAny(modelId) { return this.list.some((c) => this.has(c, modelId)); },

  /** Copia mínima del modelo: lo justo para dibujar la tarjeta sin volver a preguntar a Civitai. */
  snap(m, v) {
    const ver = v || m.modelVersions?.[0] || {};
    const img = (ver.images || m.images || []).find((i) => i.type !== "video" && !/\.(mp4|webm)$/i.test(i.url || ""));
    const f = Civitai.mainFile(ver);
    return {
      id: m.id, name: m.name, type: m.type, nsfw: !!m.nsfw, tags: m.tags || [],
      creator: { username: m.creator?.username || "" }, stats: { downloadCount: m.stats?.downloadCount || 0 },
      modelVersions: [{
        id: ver.id, name: ver.name, baseModel: ver.baseModel, trainedWords: ver.trainedWords || [],
        images: img ? [{ url: img.url, nsfwLevel: img.nsfwLevel || 0, type: "image" }] : [],
        files: f ? [{ name: f.name, sizeKB: f.sizeKB, type: f.type, primary: !!f.primary }] : [],
      }],
      added: Date.now(),
    };
  },

  async create(name) {
    if (!name) {
      const r = await ask({ title: "Nueva colección", input: { value: "", placeholder: "p. ej. Personajes anime, Estilos 3D…" },
        buttons: [{ label: "Cancelar", value: null }, { label: "Crear", value: "@input", primary: true }] });
      name = r?.input?.trim();
    }
    if (!name) return null;
    const c = { id: "c" + Date.now().toString(36), name, items: [] };
    this.list.push(c);
    await this.save();
    return c;
  },

  async toggle(c, m, v) {
    const i = c.items.findIndex((x) => x.id === m.id);
    if (i >= 0) { c.items.splice(i, 1); toast(`Quitado de «${c.name}»`); }
    else { c.items.unshift(this.snap(m, v)); toast(`Guardado en «${c.name}»`); }
    await this.save();
  },

  /** Menú «Guardar en colección» de una tarjeta o de la ficha de Civitai. */
  async menu(m, v, x, y, after) {
    await this.load();
    showMenu(x, y, "Guardar en colección", [
      ...this.list.map((c) => ({ label: `${this.has(c, m.id) ? "✓ " : ""}${c.name}  (${c.items.length})`, run: () => this.toggle(c, m, v).then(after) })),
      { label: "＋ Nueva colección…", run: async () => { const c = await this.create(); if (c) { await this.toggle(c, m, v); after?.(); } } },
    ]);
  },

  async rename(c) {
    const r = await ask({ title: "Cambiar nombre", input: { value: c.name }, buttons: [{ label: "Cancelar", value: null }, { label: "OK", value: "@input", primary: true }] });
    if (r?.input?.trim()) { c.name = r.input.trim(); await this.save(); }
  },

  async remove(c) {
    const ok = await ask({ title: `¿Eliminar la colección «${c.name}»?`, msg: "Solo se borra la lista. Los LoRAs que ya descargaste se quedan en tu biblioteca.",
      buttons: [{ label: "Cancelar", value: false }, { label: "Eliminar", value: true, primary: true }] });
    if (!ok) return false;
    this.list.splice(this.list.indexOf(c), 1);
    await this.save();
    return true;
  },

  sideMenu(c, x, y) {
    showMenu(x, y, c.name, [
      { label: "Descargar las que faltan", run: () => this.downloadMissing(c) },
      { label: "Cambiar nombre…", run: () => this.rename(c) },
      { label: "Exportar (copiar enlaces)", run: async () => {
          await copyText(c.items.map((i) => `https://civitai.com/models/${i.id}${i.modelVersions?.[0]?.id ? "?modelVersionId=" + i.modelVersions[0].id : ""}`).join("\n"));
          toast("Enlaces copiados al portapapeles");
        } },
      { label: "Eliminar colección", danger: true, run: async () => { if (await this.remove(c) && LoraPage.coll === c.id) { LoraPage.coll = null; LoraPage.render(); } } },
    ]);
  },

  /** Importa los favoritos (♥) de tu cuenta de Civitai a la colección «Favoritos de Civitai». */
  async importFavorites() {
    const key = Civitai.key();
    if (!key) return toast("Para traer tus favoritos añade tu clave API de Civitai en Ajustes", 4500);
    await this.load();
    let c = this.byId("civitai-favs");
    if (!c) { c = { id: "civitai-favs", name: "Favoritos de Civitai", items: [] }; this.list.unshift(c); }
    let cursor = null, added = 0;
    try {
      for (let page = 0; page < 15; page++) {
        toast(`Trayendo tus favoritos de Civitai… ${c.items.length}`, 60000);
        const r = await invoke("civitai_search", { params: { query: null, tag: null, types: [], base_models: [], sort: null, nsfw: true, cursor, favorites: true }, key });
        for (const m of r.items || []) if (!this.has(c, m.id)) { c.items.push(this.snap(m)); added++; }
        cursor = r.metadata?.nextCursor || null;
        if (!cursor) break;
        await sleep(300);
      }
    } catch (e) { toast("Civitai: " + (e.message || e), 5000); }
    await this.save();
    toast(added ? `Favoritos de Civitai: ${added} nuevos (${c.items.length} en total)` : `Favoritos de Civitai: no hay nuevos (${c.items.length} en total)`, 4500);
    return c;
  },

  /** Descarga, una por una, las de la colección que aún no tienes. */
  async downloadMissing(c) {
    if (this.dl || Civitai.dl) return toast("Ya hay una descarga en curso");
    Civitai.index = await invoke("downloaded_index");
    const todo = c.items.filter((s) => !Civitai.isDownloaded(s, s.modelVersions?.[0]));
    if (!todo.length) return toast("Ya tienes todos los modelos de esta colección");
    const ok = await ask({ title: `¿Descargar ${todo.length} de «${c.name}»?`, msg: todo.map((s) => "· " + s.name).join("\n"),
      buttons: [{ label: "Cancelar", value: false }, { label: "Descargar", value: true, primary: true }] });
    if (!ok) return;
    let done = 0, fail = 0, lora = false, ckpt = false;
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      this.dl = { n: i + 1, total: todo.length, name: s.name };
      toast(`Descargando ${i + 1} / ${todo.length}: ${s.name}`, 60000);
      try {
        const m = await invoke("civitai_model", { id: s.id, key: Civitai.key() });
        const v = (m.modelVersions || []).find((x) => x.id === s.modelVersions?.[0]?.id) || m.modelVersions?.[0];
        const r = Civitai.request(m, v);
        if (!r) { fail++; continue; }
        if (m.nsfw && !Civitai.key()) { fail++; continue; }
        this.dl.id = r.req.id;
        await invoke("civitai_download", { req: r.req, key: Civitai.key() });
        if (r.isLora) lora = true; else ckpt = true;
        done++;
      } catch (e) { if (/cancelada/i.test(String(e))) break; fail++; }
    }
    this.dl = null;
    Civitai.index = await invoke("downloaded_index");
    if (lora) await Loras.refresh();
    if (ckpt) { await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {}); await scanModels(); }
    toast(`Colección «${c.name}»: ${done} descargadas${fail ? `, ${fail} fallaron (¿+18 sin clave API o sin archivo?)` : ""}`, 5000);
    if (LoraPage.visible()) LoraPage.render();
  },

  /** Columna de Civitai: acceso rápido a las colecciones (abre LoRAs → colección). */
  renderCivSide() {
    const el = $("civColls");
    if (!el) return;
    el.innerHTML = "";
    if (!this.list.length) { el.innerHTML = '<div class="lbl fempty">Guarda modelos con ☆ en las tarjetas.</div>'; return; }
    for (const c of this.list) el.appendChild(flistItem("folder", c.name, c.items.length, false, () => LoraPage.openCollection(c.id)));
  },
};

window.__TAURI__?.event?.listen?.("dl-progress", (ev) => {
  const d = Collections.dl, p = ev.payload;
  if (!d || p.id !== d.id || p.state !== "downloading") return;
  const mb = (b) => (b / 1048576).toFixed(0);
  toast(`Descargando ${d.n} / ${d.total}: ${d.name} · ${mb(p.done)}${p.total ? " / " + mb(p.total) : ""} MB`, 60000);
});
