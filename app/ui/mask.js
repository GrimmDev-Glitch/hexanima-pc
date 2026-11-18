// HexAnima PC: «✎ Zona a cambiar» (inpainting) y Hires fix, como en el teléfono.
// La máscara se pinta sobre la foto de partida: lo pintado (blanco) se vuelve a generar,
// el resto se conserva. Herramientas: Pincel / Borrador / Mover, tamaño, Deshacer / Rehacer,
// Limpiar, Invertir y zoom con la rueda.
"use strict";

const Mask = {
  tool: "brush", size: 40, zoom: 1, fit: 1, px: 0, py: 0,
  paint: null,          // lienzo con lo pintado (alfa), a la resolución de la foto
  undo: [], redo: [],
  drawing: false, panning: null, last: null,

  /** t (opcional, p. ej. Correcciones): {img: {src, w, h}, paint, title, hint, done(paint|null)}.
   *  Sin t: la foto de «Editar una foto». */
  open(t) {
    if (!t && !state.editImage) return toast("Elige primero una foto");
    this.t = t || { img: state.editImage, paint: this.paint, title: "✎ Zona a cambiar", hint: "Pinta lo que se debe volver a generar; el resto de la foto se conserva.", done: (p) => this.editDone(p) };
    const im = this.t.img;
    $("maskTitle").textContent = this.t.title;
    $("maskHint").textContent = this.t.hint;
    $("maskImg").src = im.src;
    const cv = $("maskCanvas");
    cv.width = im.w; cv.height = im.h;
    $("maskWrap").style.width = im.w + "px"; $("maskWrap").style.height = im.h + "px";
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, im.w, im.h);
    if (this.t.paint) ctx.drawImage(this.t.paint, 0, 0, im.w, im.h);
    this.undo = []; this.redo = [];
    this.size = store.get("maskSize", Math.round(Math.max(im.w, im.h) / 18));
    $("maskSize").value = String(this.size);
    this.setTool("brush");
    openModal("maskDlg");
    requestAnimationFrame(() => this.fitView());
  },

  fitView() {
    const st = $("maskStage").getBoundingClientRect(), im = this.t.img;
    this.fit = Math.min(st.width / im.w, st.height / im.h) * 0.96;
    this.zoom = 1;
    this.px = (st.width - im.w * this.fit) / 2; this.py = (st.height - im.h * this.fit) / 2;
    this.apply();
  },

  scale() { return this.fit * this.zoom; },
  apply() {
    $("maskWrap").style.transform = `translate(${this.px}px, ${this.py}px) scale(${this.scale()})`;
    $("maskZoom").textContent = Math.round(this.zoom * 100) + " %";
    this.ring();
  },

  setTool(t) {
    this.tool = t;
    for (const b of document.querySelectorAll("#maskTools [data-tool]")) b.classList.toggle("on", b.dataset.tool === t);
    $("maskStage").classList.toggle("moving", t === "move");
  },

  toImage(e) {
    const r = $("maskCanvas").getBoundingClientRect(), im = this.t.img;
    return { x: ((e.clientX - r.left) / r.width) * im.w, y: ((e.clientY - r.top) / r.height) * im.h };
  },

  snapshot() {
    const cv = $("maskCanvas");
    this.undo.push(cv.getContext("2d").getImageData(0, 0, cv.width, cv.height));
    if (this.undo.length > 30) this.undo.shift();
    this.redo = [];
  },

  stroke(a, b) {
    const ctx = $("maskCanvas").getContext("2d");
    ctx.globalCompositeOperation = this.tool === "erase" ? "destination-out" : "source-over";
    ctx.strokeStyle = ctx.fillStyle = "#A38FFD";
    ctx.lineWidth = this.size; ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.beginPath(); ctx.arc(b.x, b.y, this.size / 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  },

  /** Círculo que muestra el tamaño del pincel bajo el puntero. */
  ring(e) {
    const r = $("maskRing");
    if (e) { this.mx = e.clientX; this.my = e.clientY; }
    if (this.tool === "move" || this.mx == null) { r.classList.add("hidden"); return; }
    const st = $("maskStage").getBoundingClientRect();
    const d = this.size * this.scale();
    r.classList.remove("hidden");
    r.style.width = r.style.height = d + "px";
    r.style.left = this.mx - st.left - d / 2 + "px"; r.style.top = this.my - st.top - d / 2 + "px";
  },

  down(e) {
    if (e.button === 1 || e.button === 2 || this.tool === "move") {
      this.panning = { x: e.clientX, y: e.clientY, px: this.px, py: this.py };
    } else if (e.button === 0) {
      this.snapshot();
      this.drawing = true;
      this.last = this.toImage(e);
      this.stroke(this.last, this.last);
    }
    $("maskStage").setPointerCapture(e.pointerId);
    e.preventDefault();
  },
  move(e) {
    this.ring(e);
    if (this.panning) {
      this.px = this.panning.px + e.clientX - this.panning.x; this.py = this.panning.py + e.clientY - this.panning.y;
      this.apply();
    } else if (this.drawing) {
      const p = this.toImage(e);
      this.stroke(this.last, p);
      this.last = p;
    }
  },
  up() { this.drawing = false; this.panning = null; },

  wheel(e) {
    e.preventDefault();
    const st = $("maskStage").getBoundingClientRect();
    const mx = e.clientX - st.left, my = e.clientY - st.top;
    const old = this.scale();
    this.zoom = Math.min(8, Math.max(0.5, this.zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const k = this.scale() / old;
    this.px = mx - (mx - this.px) * k; this.py = my - (my - this.py) * k;
    this.apply();
  },

  step(from, to) {
    const cv = $("maskCanvas"), ctx = cv.getContext("2d");
    if (!from.length) return;
    to.push(ctx.getImageData(0, 0, cv.width, cv.height));
    ctx.putImageData(from.pop(), 0, 0);
  },

  clear() { this.snapshot(); const cv = $("maskCanvas"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height); },

  invert() {
    this.snapshot();
    const cv = $("maskCanvas"), ctx = cv.getContext("2d");
    const t = document.createElement("canvas"); t.width = cv.width; t.height = cv.height;
    const tc = t.getContext("2d");
    tc.fillStyle = "#A38FFD"; tc.fillRect(0, 0, t.width, t.height);
    tc.globalCompositeOperation = "destination-out"; tc.drawImage(cv, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height); ctx.drawImage(t, 0, 0);
  },

  isEmpty(cv) {
    const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 16) if (d[i]) return false;
    return true;
  },

  /** Listo: máscara en blanco y negro (blanco = rehacer) con bordes suaves. */
  done() {
    const cv = $("maskCanvas");
    let paint = null;
    if (!this.isEmpty(cv)) {
      paint = document.createElement("canvas"); paint.width = cv.width; paint.height = cv.height;
      paint.getContext("2d").drawImage(cv, 0, 0);
    }
    closeModal("maskDlg");
    this.t.done(paint);
  },

  /** Máscara en blanco y negro (blanco = rehacer) de W×H a partir de lo pintado, con bordes suaves. */
  maskCanvas(paint, W, H) {
    const white = document.createElement("canvas"); white.width = W; white.height = H;
    const wc = white.getContext("2d");
    wc.fillStyle = "#fff"; wc.fillRect(0, 0, W, H);
    wc.globalCompositeOperation = "destination-in"; wc.drawImage(paint, 0, 0, W, H);
    const out = document.createElement("canvas"); out.width = W; out.height = H;
    const oc = out.getContext("2d");
    oc.fillStyle = "#000"; oc.fillRect(0, 0, W, H);
    oc.filter = `blur(${Math.max(2, Math.round(Math.max(W, H) / 160))}px)`;
    oc.drawImage(white, 0, 0);
    return out;
  },

  editDone(paint) {
    this.paint = paint;
    if (!paint) state.editMask = null;
    else {
      state.editMask = { src: this.maskCanvas(paint, paint.width, paint.height).toDataURL("image/png") };
      // Para rehacer una zona hace falta cambiar bastante: sube "Cuánto cambia" si está bajo.
      if (clampNum($("editStrength"), 45) < 60) { $("editStrength").value = "75"; toast("Zona pintada: «Cuánto cambia» sube a 75 % para que la zona cambie de verdad", 4500); }
    }
    this.refresh();
  },

  reset() { this.paint = null; state.editMask = null; this.refresh(); },

  /** Botón y textos de la sección «Editar una foto». */
  refresh() {
    const has = !!state.editImage, m = !!state.editMask;
    $("maskRow").classList.toggle("hidden", !has);
    $("maskBtn").textContent = m ? "✎ Zona pintada · editar" : "✎ Zona a cambiar";
    $("maskBtn").classList.toggle("on", m);
    $("maskClear").classList.toggle("hidden", !m);
    if (has) $("editHint").textContent = m
      ? `Solo se redibuja la zona pintada; el resto de la foto se conserva (${state.editImage.w} × ${state.editImage.h}).`
      : `Se genera a partir de esta foto (${state.editImage.w} × ${state.editImage.h}). Usa «✎ Zona a cambiar» para cambiar solo una parte.`;
  },
};

$("maskBtn").onclick = () => Mask.open();
$("maskClear").onclick = () => Mask.reset();
for (const b of document.querySelectorAll("#maskTools [data-tool]")) b.onclick = () => Mask.setTool(b.dataset.tool);
$("maskMinus").onclick = () => { $("maskSize").value = String(Math.max(2, Math.round(Mask.size / 1.25))); $("maskSize").onchange(); };
$("maskPlus").onclick = () => { $("maskSize").value = String(Math.min(600, Math.round(Mask.size * 1.25))); $("maskSize").onchange(); };
$("maskSize").onchange = () => { Mask.size = clampNum($("maskSize"), 40); store.set("maskSize", Mask.size); Mask.ring(); };
$("maskUndo").onclick = () => Mask.step(Mask.undo, Mask.redo);
$("maskRedo").onclick = () => Mask.step(Mask.redo, Mask.undo);
$("maskClearAll").onclick = () => Mask.clear();
$("maskInvert").onclick = () => Mask.invert();
$("maskFit").onclick = () => Mask.fitView();
$("maskDone").onclick = () => Mask.done();
const mst = $("maskStage");
mst.addEventListener("pointerdown", (e) => Mask.down(e));
mst.addEventListener("pointermove", (e) => Mask.move(e));
mst.addEventListener("pointerup", () => Mask.up());
mst.addEventListener("pointercancel", () => Mask.up());
mst.addEventListener("pointerleave", () => { $("maskRing").classList.add("hidden"); });
mst.addEventListener("wheel", (e) => Mask.wheel(e), { passive: false });
mst.addEventListener("contextmenu", (e) => e.preventDefault());
document.addEventListener("keydown", (e) => {
  if ($("maskDlg").classList.contains("hidden") || e.target.matches?.("input")) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); Mask.step(e.shiftKey ? Mask.redo : Mask.undo, e.shiftKey ? Mask.undo : Mask.redo); }
  else if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); Mask.step(Mask.redo, Mask.undo); }
  else if (k === "b") Mask.setTool("brush");
  else if (k === "e") Mask.setTool("erase");
  else if (k === "m" || k === " ") { e.preventDefault(); Mask.setTool("move"); }
  else if (k === "[") $("maskMinus").click();
  else if (k === "]") $("maskPlus").click();
  else if (k === "enter") Mask.done();
});

// ---------- Hires fix (como EXTRAS del teléfono: escala 1.5, denoise 0.45, 4 pasos) ----------
const Hires = {
  load() {
    const s = store.get("hires", {});
    $("hiresOn").checked = !!s.on;
    $("hiresScale").value = String(s.scale ?? 1.5);
    $("hiresDen").value = String(s.den ?? 0.45);
    $("hiresSteps").value = String(s.steps ?? 4);
    this.fillUpscalers(s.up || "Latent");
    this.refresh();
  },
  save() {
    store.set("hires", { on: $("hiresOn").checked, scale: +$("hiresScale").value, den: +$("hiresDen").value, steps: +$("hiresSteps").value, up: $("hiresUp").value });
    this.refresh();
  },
  fillUpscalers(cur) {
    const sel = $("hiresUp"), keep = cur || sel.value || "Latent";
    sel.innerHTML = "";
    sel.add(new Option("Latent (rápido)", "Latent"));
    sel.add(new Option("Lanczos", "Lanczos"));
    for (const u of state.upscalers || []) sel.add(new Option(u, u));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "Latent";
  },
  /** Tamaño final del segundo paso (múltiplos de 64). */
  target(w, h) {
    const s = Math.min(2.5, Math.max(1.1, +$("hiresScale").value || 1.5));
    const a = (n) => Math.max(64, Math.round((n * s) / 64) * 64);
    return [a(w), a(h)];
  },
  refresh() {
    const on = $("hiresOn").checked;
    $("hiresOpts").classList.toggle("hidden", !on);
    $("hiresBox").classList.toggle("on", on);
    const [w, h] = state.mode === "edit" && state.editImage ? [state.editImage.w, state.editImage.h] : currentSize();
    const [tw, th] = this.target(w, h);
    $("hiresSum").textContent = on ? `${w}×${h} → ${tw}×${th} · más lento` : "Un segundo paso a mayor tamaño (más lento)";
  },
  /** Parte "hires" del cuerpo de /sdcpp/v1/img_gen (o nada). */
  body(w, h) {
    if (!$("hiresOn").checked) return null;
    const [tw, th] = this.target(w, h);
    return {
      enabled: true, upscaler: $("hiresUp").value || "Latent", target_width: tw, target_height: th,
      steps: Math.max(0, parseInt($("hiresSteps").value, 10) || 0),
      denoising_strength: Math.min(0.95, Math.max(0.05, +$("hiresDen").value || 0.45)),
    };
  },
};
for (const id of ["hiresOn", "hiresScale", "hiresDen", "hiresSteps", "hiresUp"]) $(id).addEventListener("change", () => Hires.save());
$("hiresUp").addEventListener("pointerdown", () => Hires.fillUpscalers());
Hires.load();

// ---------- ADetailer (caras / manos), como EXTRAS del teléfono ----------
// El motor carga un solo detector (--ad-model): elegir otro reinicia el motor y recarga el modelo.
const Ad = {
  mode: "off", installed: {},

  async load() {
    const s = store.get("adetailer", {});
    this.mode = ["face", "hand"].includes(s.mode) ? s.mode : "off";
    $("adDen").value = String(s.den ?? 40);
    try { for (const d of await invoke("detector_status")) this.installed[d.kind] = d.installed; } catch { /* vista previa */ }
    if (this.mode !== "off" && !this.installed[this.mode]) this.mode = "off";
    this.refresh();
  },
  save() { store.set("adetailer", { mode: this.mode, den: this.den() }); this.refresh(); },
  den() { return Math.min(90, Math.max(10, clampNum($("adDen"), 40))); },
  active() { return this.mode !== "off" && state.adLoaded === this.mode; },
  /** Detector con el que arrancar el motor: el elegido o, si está en "No", el que ya estaba cargado. */
  wanted() { return this.force || (this.mode !== "off" ? this.mode : null); },
  args() {
    return this.active() ? `confidence=0.3,denoising_strength=${(this.den() / 100).toFixed(2)},mask_blur=4,inpaint_padding=32` : "confidence=0.999";
  },
  refresh() {
    for (const b of document.querySelectorAll("#adSeg button")) b.classList.toggle("on", b.dataset.ad === this.mode);
    const on = this.mode !== "off";
    $("adOpts").classList.toggle("hidden", !on);
    $("adBox").classList.toggle("on", on);
    $("adSum").textContent = on ? (this.mode === "face" ? "Caras: se redibujan al terminar cada imagen" : "Manos: se redibujan al terminar cada imagen") : "Redibuja caras o manos con más detalle";
  },

  /** Descarga y convierte el detector si falta (pregunta antes). */
  async install(mode) {
    if (this.installed[mode]) return true;
    {
      const name = mode === "face" ? "caras" : "manos";
      const ok = await ask({ title: `Detector de ${name}`, msg: `ADetailer necesita un detector de ${name} (YOLOv8, unos 6 MB, de huggingface.co/Bingsu/adetailer). Se descarga una sola vez y se guarda en models\\detectors.`,
        buttons: [{ label: "Cancelar", value: false }, { label: "Descargar", value: true, primary: true }] });
      if (!ok) return false;
      try {
        this.dl = "det-" + mode;
        toast(`Descargando el detector de ${name}…`, 60000);
        await invoke("detector_install", { kind: mode });
        this.installed[mode] = true;
        toast(`✓ Detector de ${name} listo`, 3000);
        return true;
      } catch (e) { toast("No se pudo instalar el detector: " + (e.message || e), 6000); return false; }
      finally { this.dl = null; }
    }
  },

  /** Correcciones: deja cargado el detector `kind` (reinicia el motor y recarga el modelo si hace falta). */
  async ensureKind(kind) {
    if (state.adLoaded === kind) return true;
    if (!(await this.install(kind))) return false;
    this.force = kind;
    try {
      state.loaded = null;
      if (!(await startEngine(engineFor(currentOption())))) return false;
      await refreshEngineMenus();
      await loadModel();
      return state.adLoaded === kind && !!state.loaded;
    } finally { this.force = null; }
  },

  async pick(mode) {
    if (mode === this.mode) return;
    if (mode !== "off" && !(await this.install(mode))) return;
    this.mode = mode;
    this.save();
    if (mode !== "off" && state.adLoaded !== mode) setStatus(`ADetailer (${mode === "face" ? "caras" : "manos"}): el motor se reinicia al generar para cargar el detector.`);
  },

  /** Antes de generar: si el detector cargado no es el elegido, reinicia el motor y recarga el modelo. */
  async ensure() {
    if (this.mode === "off" || state.adLoaded === this.mode) return true;
    if (state.busy) return false;
    setStatus("Reiniciando el motor para cargar el detector de ADetailer…");
    state.loaded = null;
    if (!(await startEngine(engineFor(currentOption())))) return false;
    await refreshEngineMenus();
    return true;
  },
};
for (const b of document.querySelectorAll("#adSeg button")) b.onclick = () => Ad.pick(b.dataset.ad);
$("adDen").addEventListener("change", () => Ad.save());
window.__TAURI__?.event?.listen?.("dl-progress", (ev) => {
  const p = ev.payload;
  if (!Ad.dl || p.id !== Ad.dl || p.state !== "downloading") return;
  toast(`Descargando el detector… ${(p.done / 1048576).toFixed(1)}${p.total ? " / " + (p.total / 1048576).toFixed(1) : ""} MB`, 60000);
});
Ad.load();
