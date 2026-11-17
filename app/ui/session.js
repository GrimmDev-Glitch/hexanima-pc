// HexAnima PC: imágenes de esta sesión en la pantalla principal (como el teléfono):
// barra de la imagen (‹ n/N ›, ★, copiar, carpeta, ampliar, ver en grande, ✕), fila de
// resultado (seed, ⇆ Antes/después, ✎ Editar esta imagen, ↻ Otra vez, Variaciones),
// visor a pantalla completa y comparación antes/después.
"use strict";

const Session = {
  list: [],   // [{name, src, meta, before}]
  i: -1,

  cur() { return this.list[this.i] || null; },

  add(item) {
    this.list.push(item);
    if (this.list.length > 30) this.list.shift(); // la sesión no crece sin límite (el historial guarda todo)
    this.i = this.list.length - 1;
    this.render();
  },

  go(d) {
    if (!this.list.length) return;
    this.i = Math.max(0, Math.min(this.list.length - 1, this.i + d));
    this.render();
  },

  render() {
    const c = this.cur();
    $("pgTxt").textContent = this.list.length ? `${this.i + 1} / ${this.list.length}` : "0 / 0";
    $("pgPrev").disabled = this.i <= 0;
    $("pgNext").disabled = this.i >= this.list.length - 1;
    for (const id of ["resVar", "resEdit", "upscaleBtn", "imgFav", "imgCopy", "imgFull", "imgClear"]) $(id).disabled = !c;
    if (!c) { $("resSeed").textContent = ""; $("resCompare").classList.add("hidden"); return; }
    if (!state.busy) showImage(c.src);
    $("imgFav").textContent = c.meta?.fav ? "★" : "☆";
    $("imgFav").classList.toggle("on", !!c.meta?.fav);
    $("resSeed").textContent = c.meta?.seed != null ? `seed ${c.meta.seed}${c.meta.width ? ` · ${c.meta.width} × ${c.meta.height}` : ""}` : "";
    $("resCompare").classList.toggle("hidden", !c.before);
  },

  clear() {
    $("result").removeAttribute("src");
    $("canvas").classList.remove("has");
    state.currentImage = null;
    this.i = -1; this.list = [];
    this.render();
  },

  async fav() {
    const c = this.cur(); if (!c) return;
    const fav = !c.meta?.fav;
    try { await invoke("gallery_fav", { name: c.name, fav }); c.meta = { ...(c.meta || {}), fav }; this.render(); toast(fav ? "★ Favorita" : "Quitada de favoritas"); }
    catch (e) { toast(String(e.message || e)); }
  },

  async copy() {
    const c = this.cur(); if (!c) return;
    try {
      const blob = await (await fetch(c.src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Imagen copiada: pégala con Ctrl+V en otra app");
    } catch { toast("No se pudo copiar la imagen; usa «Mostrar en la carpeta»", 4000); }
  },

  /** ↻ Otra vez: mismo prompt con una seed nueva. */
  again() { generate({ count: 1, newSeed: true }); },

  /** Variaciones (como el teléfono): Cuántas 1–16, Con semillas nuevas / Parecidas a esta imagen (img2img 0,45). */
  async variations() {
    const c = this.cur();
    let n = Math.max(1, Math.min(16, store.get("varCount", 4)));
    const r = await ask({
      title: "Variaciones",
      msg: "«Parecidas» parte de esta imagen y cambia poco (img2img); «semillas nuevas» repite el prompt desde cero.",
      input: { value: String(n), placeholder: "Cuántas (1–16)" },
      buttons: [{ label: "Cancelar", value: null }, { label: "Con semillas nuevas", value: "seeds" }, ...(c ? [{ label: "Parecidas a esta imagen", value: "close", primary: true }] : [])],
    });
    if (!r) return;
    n = Math.max(1, Math.min(16, parseInt($("askInput").value, 10) || n));
    store.set("varCount", n);
    if (r === "seeds") return generate({ count: n, newSeed: true });
    const init = await prepareEditImage(c.src);
    generate({ count: n, newSeed: true, init, strength: 0.45 });
  },

  edit() {
    const c = this.cur(); if (!c) return;
    setEditImage(c.src).then(() => setMode("edit"));
    toast("Imagen lista en Editar foto: escribe qué cambiar y pulsa Generar desde la foto", 4000);
  },
};

// ---------- Visor a pantalla completa ----------
const Viewer = {
  items: [],     // [{src, name, meta, path?}]
  i: 0,
  z: 1, x: 0, y: 0,
  source: "session",

  open(items, i, source) {
    if (!items.length) return;
    this.items = items; this.i = i; this.source = source;
    $("viewer").classList.remove("hidden");
    this.show();
  },

  close() { $("viewer").classList.add("hidden"); },

  it() { return this.items[this.i]; },

  show() {
    const it = this.it(); if (!it) return this.close();
    this.z = 1; this.x = 0; this.y = 0; this.apply();
    $("vImg").src = it.src;
    $("vCount").textContent = `${this.i + 1} / ${this.items.length}`;
    const m = it.meta || {};
    const date = m.created ? new Date(m.created).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "";
    $("vInfo").textContent = [m.model_label, m.width && m.height ? `${m.width} × ${m.height}` : "", m.seed != null ? `seed ${m.seed}` : "", date, m.seconds ? `${m.seconds} s` : ""].filter(Boolean).join(" · ");
    $("vPrompt").textContent = m.prompt || "";
    $("vPrompt").classList.toggle("hidden", !m.prompt);
    $("vFav").textContent = m.fav ? "★ Favorita" : "☆ Favorita";
    $("vPrev").disabled = this.i <= 0;
    $("vNext").disabled = this.i >= this.items.length - 1;
  },

  step(d) { const n = this.i + d; if (n >= 0 && n < this.items.length) { this.i = n; this.show(); } },
  apply() { $("vImg").style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.z})`; },
};

$("vClose").onclick = () => Viewer.close();
$("vPrev").onclick = () => Viewer.step(-1);
$("vNext").onclick = () => Viewer.step(1);
$("vStage").addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  Viewer.z = Math.max(1, Math.min(6, Viewer.z * k));
  if (Viewer.z === 1) { Viewer.x = 0; Viewer.y = 0; }
  Viewer.apply();
}, { passive: false });
$("vStage").addEventListener("dblclick", () => { Viewer.z = Viewer.z > 1 ? 1 : 2.5; Viewer.x = 0; Viewer.y = 0; Viewer.apply(); });
let vDrag = null;
$("vStage").addEventListener("mousedown", (e) => { if (Viewer.z > 1) vDrag = { x: e.clientX - Viewer.x, y: e.clientY - Viewer.y }; });
window.addEventListener("mousemove", (e) => { if (vDrag) { Viewer.x = e.clientX - vDrag.x; Viewer.y = e.clientY - vDrag.y; Viewer.apply(); } });
window.addEventListener("mouseup", () => { vDrag = null; });
document.addEventListener("keydown", (e) => {
  if ($("viewer").classList.contains("hidden")) return;
  if (e.key === "Escape") Viewer.close();
  if (e.key === "ArrowLeft") Viewer.step(-1);
  if (e.key === "ArrowRight") Viewer.step(1);
}, true);
$("vPrompt").onclick = async () => { const p = Viewer.it()?.meta?.prompt; if (p) { await copyText(p); toast("Prompt copiado"); } };
const vItem = () => Viewer.it();
const vHist = (it) => History.items.find((h) => h.name === it.name) || { name: it.name, path: it.path, meta: it.meta };
$("vFav").onclick = async () => {
  const it = vItem(); if (!it) return;
  const fav = !it.meta?.fav;
  await invoke("gallery_fav", { name: it.name, fav });
  it.meta = { ...(it.meta || {}), fav };
  const s = Session.list.find((x) => x.name === it.name); if (s) s.meta = it.meta;
  Viewer.show(); Session.render();
  if (Viewer.source === "history") History.show();
};
$("vUse").onclick = () => { const it = vItem(); if (it) { Viewer.close(); History.useSettings(vHist(it)); } };
/** Las imágenes del historial se ven por asset:, pero para editarlas o copiarlas se leen como data URL. */
async function asDataUrl(it) { return it.src.startsWith("data:") ? it.src : "data:image/png;base64," + (await invoke("read_output", { name: it.name })); }
$("vEdit").onclick = async () => {
  const it = vItem(); if (!it) return;
  Viewer.close();
  await setEditImage(await asDataUrl(it)); setMode("edit");
  document.querySelector('.nav[data-page="gen"]').click();
};
$("vCopy").onclick = async () => {
  const it = vItem(); if (!it) return;
  try { const blob = await (await fetch(await asDataUrl(it))).blob(); await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast("Imagen copiada"); }
  catch { toast("No se pudo copiar la imagen", 3000); }
};
$("vReveal").onclick = () => { const it = vItem(); if (it) invoke("gallery_reveal", { name: it.name }); };
$("vTrash").onclick = async () => {
  const it = vItem(); if (!it) return;
  Viewer.close();
  await History.trash([it.name]);
  const k = Session.list.findIndex((x) => x.name === it.name);
  if (k >= 0) { Session.list.splice(k, 1); Session.i = Math.min(Session.i, Session.list.length - 1); if (Session.i < 0) Session.clear(); else Session.render(); }
};

// ---------- Antes / después ----------
const Compare = {
  pos: 0.5,
  open(before, after) {
    $("cmpBefore").src = before; $("cmpAfter").src = after;
    this.pos = 0.5; this.apply();
    openModal("cmpDlg");
  },
  apply() {
    const p = (this.pos * 100).toFixed(2) + "%";
    $("cmpClip").style.width = p; $("cmpLine").style.left = p;
    // la imagen recortada mide exactamente lo mismo que la de fondo (aunque su resolución sea otra)
    $("cmpBefore").style.width = $("cmpAfter").clientWidth + "px";
    $("cmpBefore").style.height = $("cmpAfter").clientHeight + "px";
  },
  async saveSideBySide() {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [a, b] = await Promise.all([load($("cmpBefore").src), load($("cmpAfter").src)]);
    const h = Math.max(a.naturalHeight, b.naturalHeight);
    const wa = Math.round(a.naturalWidth * h / a.naturalHeight), wb = Math.round(b.naturalWidth * h / b.naturalHeight);
    const cv = document.createElement("canvas"); cv.width = wa + wb; cv.height = h;
    const g = cv.getContext("2d"); g.drawImage(a, 0, 0, wa, h); g.drawImage(b, wa, 0, wb, h);
    const name = await invoke("save_image", { b64: cv.toDataURL("image/png"), prefix: "comparacion", meta: { ...(Session.cur()?.meta || {}), comparison: true } });
    toast("Guardada lado a lado: " + name);
  },
};
let cmpDrag = false;
const cmpMove = (e) => { const r = $("cmpAfter").getBoundingClientRect(); Compare.pos = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); Compare.apply(); };
$("cmpBox").addEventListener("mousedown", (e) => { cmpDrag = true; cmpMove(e); });
window.addEventListener("mousemove", (e) => { if (cmpDrag) cmpMove(e); });
window.addEventListener("mouseup", () => { cmpDrag = false; });
window.addEventListener("resize", () => { if (!$("cmpDlg").classList.contains("hidden")) Compare.apply(); });
$("cmpAfter").addEventListener("load", () => Compare.apply());
$("cmpSave").onclick = () => Compare.saveSideBySide();

// ---------- botones de la pantalla principal ----------
$("pgPrev").onclick = () => Session.go(-1);
$("pgNext").onclick = () => Session.go(1);
$("imgFav").onclick = () => Session.fav();
$("imgCopy").onclick = () => Session.copy();
$("openOut").onclick = () => { const c = Session.cur(); if (c) invoke("gallery_reveal", { name: c.name }); else invoke("open_folder", { which: "outputs" }); };
$("imgClear").onclick = () => Session.clear();
$("imgFull").onclick = () => { if (Session.list.length) Viewer.open(Session.list, Session.i, "session"); };
$("result").addEventListener("click", () => { if (Session.list.length && !state.busy) Viewer.open(Session.list, Session.i, "session"); });
$("resAgain").onclick = () => Session.again();
$("resAgain").oncontextmenu = (e) => { e.preventDefault(); Session.variations(); };
$("resVar").onclick = () => Session.variations();
$("resEdit").onclick = () => Session.edit();
$("resCompare").onclick = () => { const c = Session.cur(); if (c?.before) Compare.open(c.before, c.src); };
document.addEventListener("keydown", (e) => {
  if (!$("page-gen").classList.contains("on") || e.target.closest("input,textarea,select") || document.querySelector(".modal:not(.hidden)") || !$("viewer").classList.contains("hidden")) return;
  if (e.key === "ArrowLeft") Session.go(-1);
  if (e.key === "ArrowRight") Session.go(1);
});
// Historial: clic en la imagen grande abre el visor sobre la lista filtrada.
$("hImg").addEventListener("click", () => {
  const list = History.visible().map((h) => ({ name: h.name, path: h.path, src: assetUrl(h.path), meta: h.meta }));
  const i = list.findIndex((x) => x.name === History.cur);
  if (i >= 0) Viewer.open(list, i, "history");
});
Session.render();

// ---------- Ampliar: Rápido · Real-ESRGAN / Detallado · UltraSharp, ×2 / ×4 (como el teléfono) ----------
const UP_INFO = {
  fast: { label: "Rápido · Real-ESRGAN", desc: "Para anime e ilustración; el más ligero.", mb: 18 },
  detail: { label: "Detallado · UltraSharp", desc: "Conserva mejor texturas, ojos y líneas finas; más lento.", mb: 67 },
};
const Upscale = {
  kind: store.get("upKind", "fast"),
  status: [],
  src: null, w: 0, h: 0,
  busy: false,

  async open(src) {
    this.src = src || Session.cur()?.src || state.currentImage;
    if (!this.src) return;
    const im = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = this.src; });
    this.w = im.naturalWidth; this.h = im.naturalHeight;
    try { this.status = await invoke("upscaler_status"); } catch { this.status = []; }
    $("upMsg").textContent = "";
    this.render();
    openModal("upDlg");
  },

  installed(kind) { return this.status.find((s) => s.kind === kind)?.installed; },
  stem(kind) { return this.status.find((s) => s.kind === kind)?.stem; },

  render() {
    const box = $("upOpts"); box.innerHTML = "";
    for (const kind of ["fast", "detail"]) {
      const info = UP_INFO[kind], ok = this.installed(kind);
      const row = document.createElement("label");
      row.className = "up-opt" + (this.kind === kind ? " on" : "");
      row.innerHTML = '<input type="radio" name="upk"><div><div class="t"></div><div class="d"></div></div>';
      row.querySelector(".t").textContent = info.label;
      row.querySelector(".d").textContent = ok ? info.desc : `${info.desc} Hay que descargarlo una vez (${info.mb} MB).`;
      const r = row.querySelector("input"); r.checked = this.kind === kind;
      r.onchange = () => { this.kind = kind; store.set("upKind", kind); this.render(); };
      if (!ok) {
        const b = document.createElement("button");
        b.className = "ghost sm"; b.textContent = `Descargar ${info.mb} MB`;
        b.onclick = (e) => { e.preventDefault(); this.download(kind, b); };
        row.appendChild(b);
      }
      box.appendChild(row);
    }
    const ok = this.installed(this.kind);
    const lim = 8192;
    for (const [id, f] of [["up2", 2], ["up4", 4]]) {
      const W = this.w * f, H = this.h * f, big = W > lim || H > lim;
      $(id).textContent = big ? `×${f} · demasiado grande` : `×${f} · ${W} × ${H}`;
      $(id).disabled = !ok || big || this.busy;
    }
  },

  async download(kind, btn) {
    btn.disabled = true; btn.textContent = "Descargando…";
    const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
      const p = ev.payload; if (p.id !== "up-" + kind) return;
      btn.textContent = p.total ? `${Math.round((100 * p.done) / p.total)} %` : "Descargando…";
    });
    try {
      await invoke("upscaler_download", { kind });
      this.status = await invoke("upscaler_status");
      // El motor lee la carpeta de ampliadores al arrancar: se reinicia si todavía no lo ve.
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
      await refreshEngineMenus();
      if (!state.upscalers.includes(this.stem(kind)) && !state.busy) {
        $("upMsg").textContent = "Reiniciando el motor para que vea el ampliador…";
        if (await startEngine(engineFor(currentOption()))) { await refreshEngineMenus(); await loadModel(); }
      }
      $("upMsg").textContent = state.upscalers.includes(this.stem(kind)) ? "✓ Listo para ampliar" : "Descargado; reinicia el motor desde Ajustes si no aparece.";
    } catch (e) { $("upMsg").textContent = "Falló la descarga: " + (e.message || e); }
    finally { off(); this.render(); }
  },

  async run(f) {
    if (this.busy || state.busy) return;
    this.busy = true; this.render();
    $("upMsg").textContent = "Ampliando… (por trozos; puede tardar en equipos modestos)";
    state.busy = true;
    try {
      const r = await api("/sdcpp/v1/upscale", { method: "POST", body: JSON.stringify({ image: this.src, upscaler: this.stem(this.kind), repeats: 1, output_format: "png" }) });
      let b64 = r.images?.[0]?.b64_json;
      if (!b64) throw new Error("El motor no devolvió una imagen");
      let W = r.width, H = r.height;
      if (f === 2) { // el modelo amplía ×4: para ×2 se reduce a la mitad con buena calidad
        const im = await new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.src = "data:image/png;base64," + b64; });
        W = this.w * 2; H = this.h * 2;
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const g = cv.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(im, 0, 0, W, H);
        b64 = cv.toDataURL("image/png").split(",")[1];
      }
      const meta = { ...(Session.cur()?.meta || {}), width: W, height: H, upscaled: `${UP_INFO[this.kind].label} ×${f}`, created: new Date().toISOString() };
      const name = await invoke("save_image", { b64, prefix: "ampliada", meta });
      Session.add({ name, src: "data:image/png;base64," + b64, meta, before: this.src });
      closeModal("upDlg");
      toast(`Ampliada ×${f} · ${W} × ${H} · guardada en el Historial`, 4000);
    } catch (e) { $("upMsg").textContent = "No se pudo ampliar: " + (e.message || e); }
    finally { this.busy = false; state.busy = false; this.render(); }
  },
};
$("up2").onclick = () => Upscale.run(2);
$("up4").onclick = () => Upscale.run(4);
