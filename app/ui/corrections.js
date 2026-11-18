// HexAnima PC: «Correcciones», como la pantalla del teléfono.
// Una cadena de versiones (Original → aceptadas) y, sobre la versión actual, alternativas para comparar:
// Usar esta / Descartar, ↶ Deshacer / Rehacer ↷ y Guardar en el Historial (la original no se toca).
// Ruido y Resolución usan el ampliador (Real-ESRGAN / UltraSharp). Cara, Manos, Detalles y Otros
// redibujan solo la zona pintada con el modelo cargado (recorte ampliado, como ADetailer), y
// 🔍 Detectar usa el detector YOLOv8 del motor.
"use strict";

const FIX_CATS = [
  { key: "noise", label: "Ruido" }, { key: "resolution", label: "Resolución" },
  { key: "face", label: "Cara" }, { key: "hands", label: "Manos" }, { key: "details", label: "Detalles" }, { key: "other", label: "Otros" },
];
const FIX_HINT = {
  noise: "Limpia ruido, grano y artefactos sin cambiar el tamaño (Real-ESRGAN mezclado con la imagen; no inventa caras). Demasiada fuerza borra textura fina.",
  resolution: "Aumenta la resolución y la nitidez con el ampliador. Puede inventar textura; no arregla dedos ni rasgos.",
  face: "Pinta la cara (o solo los ojos o la boca). Se redibuja con más detalle y el mismo estilo; el resto queda igual. Genera varias alternativas y quédate con la mejor.",
  hands: "Pinta las manos que quieras rehacer. Solo cambia esa zona. No garantiza una anatomía perfecta: genera varias alternativas y quédate con la mejor.",
  details: "Pinta una zona pequeña (ojos, joyas, un objeto) y escribe cómo debe quedar. Solo cambia lo pintado.",
  other: "Cualquier cambio en una zona: píntala y describe el cambio (por ejemplo «una rosa azul en la mano»).",
};
const FIX_PH = {
  face: "Opcional: p. ej. ojos azules, sonrisa suave",
  hands: "Opcional: p. ej. manos naturales con cinco dedos",
  details: "Qué debe cambiar en la zona pintada",
  other: "Qué debe cambiar en la zona pintada",
};
const FIX_STR = { face: 40, hands: 50, details: 55, other: 75 };

const loadImg = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("No se pudo abrir la imagen")); i.src = src; });

const Fix = {
  chain: [], pos: 0, alts: [], sel: -1,
  cat: "face", noise: 60, up: 2, text: "", str: { ...FIX_STR },
  paint: null,       // zona pintada (a ≤1024 px) sobre la versión actual
  meta: null, saved: true, running: false, stopFlag: false,

  /** src: data URL o URL de la imagen; meta: sus ajustes (prompt, modelo…). */
  async open(src, meta) {
    if (!src) return;
    if (src.startsWith("asset:") || src.startsWith("http://asset")) src = await toDataUrl(src);
    const im = await loadImg(src);
    this.chain = [{ src, w: im.naturalWidth, h: im.naturalHeight, step: null }];
    this.pos = 0; this.alts = []; this.sel = -1; this.paint = null;
    this.meta = meta || {}; this.saved = true; this.text = "";
    this.renderCats(); this.renderPanel(); this.render();
    this.status("");
    openModal("fixDlg");
  },

  base() { return this.chain[this.pos]; },
  cur() { return this.sel >= 0 ? this.alts[this.sel] : null; },
  status(t) { $("fixStatus").textContent = t; },

  // ---------- vista ----------
  render() {
    const b = this.base(), a = this.cur();
    $("fixBefore").src = b.src;
    $("fixAfter").src = a ? a.src : b.src;
    $("fixTagL").textContent = this.pos ? "Base" : "Original";
    $("fixTagR").textContent = a ? `Alt. ${this.sel + 1}` : (this.pos ? "Base" : "Original");
    $("fixTagR").classList.toggle("hidden", !a);
    $("fixLine").classList.toggle("hidden", !a);
    this.cmp = a ? (this.cmp ?? 0.5) : 0;
    this.applyCmp();
    // tira: Original · Base · Alt. n
    const strip = $("fixStrip"); strip.innerHTML = "";
    const add = (label, src, on, click, title) => {
      const t = document.createElement("button");
      t.className = "fix-thumb" + (on ? " on" : "");
      t.innerHTML = '<img alt=""><span></span>';
      t.querySelector("img").src = src; t.querySelector("span").textContent = label; t.title = title || label;
      t.onclick = click; strip.appendChild(t);
    };
    add("Original", this.chain[0].src, this.pos === 0 && this.sel < 0, () => { if (this.pos !== 0) { this.pos = 0; this.clearAlts(); } this.sel = -1; this.render(); },
      `Original · ${this.chain[0].w}×${this.chain[0].h}`);
    if (this.pos > 0) add("Base", b.src, this.sel < 0, () => { this.sel = -1; this.render(); }, `Base · ${b.w}×${b.h} · ${this.chain.slice(1, this.pos + 1).map((c) => c.step).join(" → ")}`);
    this.alts.forEach((x, i) => add(`Alt. ${i + 1}`, x.src, i === this.sel, () => { this.sel = i; this.render(); }, `Alternativa ${i + 1} · ${x.step} · ${x.w}×${x.h}`));
    $("fixUse").disabled = !a || this.running;
    $("fixDrop").disabled = !a || this.running;
    $("fixUndo").disabled = this.pos === 0 || this.running;
    $("fixRedo").disabled = this.pos + 1 >= this.chain.length || this.running;
    $("fixSave").disabled = this.pos === 0 || this.running;
    $("fixGen").disabled = this.running;
    $("fixStop").classList.toggle("hidden", !this.running);
    $("fixGen").classList.toggle("hidden", this.running);
    for (const b2 of $("fixPanel").querySelectorAll("button")) b2.disabled = this.running;
  },

  applyCmp() {
    const img = $("fixAfter"), w = img.clientWidth;
    $("fixClip").style.width = (this.cur() ? this.cmp * w : 0) + "px";
    $("fixBefore").style.width = w + "px";
    $("fixLine").style.left = this.cmp * w + "px";
  },

  clearAlts() { this.alts = []; this.sel = -1; },

  // ---------- categorías y panel ----------
  renderCats() {
    const el = $("fixCats"); el.innerHTML = "";
    for (const c of FIX_CATS) {
      const b = document.createElement("button");
      b.className = "chip" + (c.key === this.cat ? " on" : "");
      b.textContent = c.label;
      b.onclick = () => { if (this.running) return; this.cat = c.key; this.renderCats(); this.renderPanel(); };
      el.appendChild(b);
    }
  },

  renderPanel() {
    const p = $("fixPanel"), c = this.cat;
    p.innerHTML = "";
    const hint = document.createElement("div"); hint.className = "lbl fix-hint"; hint.textContent = FIX_HINT[c]; p.appendChild(hint);
    const num = (label, val, min, max, step, on) => {
      const r = document.createElement("div"); r.className = "row lbl edit-strength fix-num";
      r.innerHTML = '<label></label><div class="num"><input class="field" type="number" inputmode="numeric"><span>%</span></div>';
      r.querySelector("label").textContent = label;
      const i = r.querySelector("input"); Object.assign(i, { min, max, step, value: String(val) });
      i.onchange = () => on(clampNum(i, val));
      p.appendChild(r);
    };
    const btn = (label, cls, on, title) => {
      const b = document.createElement("button"); b.className = cls; b.textContent = label; if (title) b.title = title;
      b.onclick = on; p.appendChild(b); return b;
    };
    if (c === "noise") {
      num("Fuerza", this.noise, 10, 100, 5, (v) => (this.noise = v));
    } else if (c === "resolution") {
      const seg = document.createElement("div"); seg.className = "seg fix-up";
      const b = this.base();
      for (const f of [2, 4]) {
        const x = document.createElement("button");
        const big = b.w * f > 8192 || b.h * f > 8192;
        x.className = "ghost sm" + (this.up === f ? " on" : "");
        x.textContent = big ? `×${f} · demasiado grande` : `×${f} · ${b.w * f}×${b.h * f}`;
        x.disabled = big;
        x.onclick = () => { this.up = f; this.renderPanel(); };
        seg.appendChild(x);
      }
      p.appendChild(seg);
      const k = document.createElement("div"); k.className = "lbl";
      k.textContent = `Ampliador: ${UP_INFO[Upscale.kind].label} (se cambia en Ampliar)`;
      p.appendChild(k);
    } else {
      btn(this.paint ? "✎ Zona pintada · editar" : "✎ Pintar la zona", this.paint ? "ghost" : "primary sm", () => this.paintArea());
      if (c === "face" || c === "hands") {
        const kind = c === "face" ? "face" : "hand";
        btn(c === "face" ? "🔍 Detectar caras automáticamente" : "🔍 Detectar manos automáticamente", "ghost", () => this.detect(kind, false),
          "Busca con el detector YOLOv8 y pinta la zona por ti (descarga de 6 MB la primera vez)");
        btn(c === "face" ? "✨ Detectar y corregir todas las caras" : "✨ Detectar y corregir todas las manos", "ghost", () => this.detect(kind, true),
          "Encuentra cada una y la redibuja por separado; el resultado es una alternativa para comparar");
      }
      const t = document.createElement("textarea");
      t.className = "field fix-text"; t.rows = 2; t.placeholder = FIX_PH[c]; t.value = this.text;
      t.oninput = () => (this.text = t.value);
      p.appendChild(t);
      num("Fuerza", this.str[c], 10, 100, 5, (v) => (this.str[c] = v));
    }
    this.render();
  },

  // ---------- zona pintada ----------
  paintSize() { const b = this.base(), s = Math.min(1, 1024 / Math.max(b.w, b.h)); return [Math.round(b.w * s), Math.round(b.h * s)]; },

  paintArea() {
    const [w, h] = this.paintSize();
    Mask.open({
      img: { src: this.base().src, w, h }, paint: this.paint, title: "Zona a corregir",
      hint: "Pinta solo lo que quieres cambiar; el resto de la imagen se queda exactamente igual.",
      done: (p) => { this.paint = p; this.renderPanel(); },
    });
  },

  // ---------- motor ----------
  needModel() {
    if (state.loaded && state.loaded === currentOption()?.id) return true;
    toast("Carga primero un modelo en Generar (botón Cargar modelo)", 4500);
    return false;
  },

  /** Lanza un trabajo img_gen y espera (con progreso en la barra de estado de Correcciones). */
  async job(body, label) {
    if (state.adLoaded && !body.extra_ad_args) body.extra_ad_args = "confidence=0.999"; // que ADetailer no toque nada
    const sub = await api("/sdcpp/v1/img_gen", { method: "POST", body: JSON.stringify(body) });
    state.job = sub.id;
    for (;;) {
      await sleep(400);
      if (this.stopFlag) { await api(`/sdcpp/v1/jobs/${sub.id}/cancel`, { method: "POST" }).catch(() => {}); throw new Error("Detenido"); }
      const j = await api(`/sdcpp/v1/jobs/${sub.id}`);
      const pr = j.progress || {};
      const st = { sampling: "Generando", vae_decode: "Decodificando", vae_encode: "Preparando", conditioning: "Leyendo el prompt" }[pr.stage] || "Preparando";
      this.status(`${label} · ${st}${pr.unit === "steps" && pr.total ? ` ${pr.completed}/${pr.total}` : ""} · ${fmtS((pr.elapsed_ms || 0) / 1000)}`);
      if (j.status === "completed") return "data:image/png;base64," + j.result.images[0].b64_json;
      if (j.status === "failed") throw new Error(j.error?.message || "falló");
    }
  },

  basePrompt() {
    const p = this.meta?.prompt || $("prompt").value || "";
    return p.trim();
  },

  /** Redibuja la zona pintada de `src` (W×H) recortando alrededor de la zona y ampliando el recorte. */
  async inpaint(src, paint, label) {
    const im = await loadImg(src), W = im.naturalWidth, H = im.naturalHeight;
    const mask = Mask.maskCanvas(paint, W, H);
    // caja de lo pintado (en píxeles de la imagen)
    const d = paint.getContext("2d").getImageData(0, 0, paint.width, paint.height).data;
    let x0 = paint.width, y0 = paint.height, x1 = -1, y1 = -1;
    for (let y = 0; y < paint.height; y++) for (let x = 0; x < paint.width; x++) if (d[(y * paint.width + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < 0) throw new Error("Pinta primero la zona a cambiar");
    const sx = W / paint.width, sy = H / paint.height;
    let bx = x0 * sx, by = y0 * sy, bw = (x1 - x0 + 1) * sx, bh = (y1 - y0 + 1) * sy;
    const pad = Math.max(32, 0.25 * Math.max(bw, bh));
    bx -= pad; by -= pad; bw += 2 * pad; bh += 2 * pad;
    // tamaño de trabajo: lado largo como el máximo del modelo (más detalle en zonas pequeñas)
    const T = Math.min(maxSide(currentOption()?.family), currentOption()?.family === "anima" ? 768 : 1024);
    const a64 = (n) => Math.max(256, Math.round(n / 64) * 64);
    let k = T / Math.max(bw, bh);
    if (Math.max(bw, bh) > Math.max(W, H)) k = T / Math.max(W, H);
    const tw = a64(bw * k), th = a64(bh * k);
    // ajustar el recorte a la proporción exacta del tamaño de trabajo y dejarlo dentro de la imagen
    let cw = tw / k, ch = th / k;
    if (cw > W || ch > H) { const f = Math.min(W / cw, H / ch); cw *= f; ch *= f; k = tw / cw; }
    let cx = Math.min(Math.max(0, bx + bw / 2 - cw / 2), W - cw), cy = Math.min(Math.max(0, by + bh / 2 - ch / 2), H - ch);
    const crop = (srcEl) => { const c = document.createElement("canvas"); c.width = tw; c.height = th; const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(srcEl, cx, cy, cw, ch, 0, 0, tw, th); return c.toDataURL("image/png"); };

    const cat = this.cat, extra = this.text.trim();
    if ((cat === "details" || cat === "other") && !extra) throw new Error("Escribe qué debe cambiar");
    const suffix = { face: "detailed face, detailed eyes", hands: "detailed hands, five fingers" }[cat];
    const prompt = [extra, this.basePrompt(), suffix].filter(Boolean).join(", ");
    const spec = Loras.fromPrompt(prompt);
    const body = {
      prompt: spec.prompt, negative_prompt: this.meta?.negative ?? $("neg").value.trim(),
      init_image: crop(im), mask_image: crop(mask), strength: (this.str[cat] ?? 50) / 100,
      width: tw, height: th, seed: Math.floor(Math.random() * 2 ** 31), batch_count: 1, clip_skip: +$("clipskip").value,
      sample_params: { scheduler: $("scheduler").value, sample_method: $("sampler").value, sample_steps: clampNum($("steps"), 20), guidance: { txt_cfg: clampNum($("cfg"), 5) } },
      lora: spec.lora,
      vae_tiling_params: { enabled: vaeTiling() },
      output_format: "png",
    };
    const out = await loadImg(await this.job(body, label));
    // pegar el resultado solo donde está la máscara (bordes suaves): el resto queda idéntico
    const res = document.createElement("canvas"); res.width = W; res.height = H;
    const rg = res.getContext("2d"); rg.imageSmoothingQuality = "high"; rg.drawImage(out, cx, cy, cw, ch);
    const alpha = document.createElement("canvas"); alpha.width = W; alpha.height = H;
    const ag = alpha.getContext("2d"); ag.drawImage(mask, 0, 0);
    const md = ag.getImageData(0, 0, W, H);
    for (let i = 0; i < md.data.length; i += 4) { md.data[i + 3] = md.data[i]; }
    ag.putImageData(md, 0, 0);
    rg.globalCompositeOperation = "destination-in"; rg.drawImage(alpha, 0, 0);
    const fin = document.createElement("canvas"); fin.width = W; fin.height = H;
    const fg = fin.getContext("2d"); fg.drawImage(im, 0, 0); fg.drawImage(res, 0, 0);
    return { src: fin.toDataURL("image/png"), w: W, h: H };
  },

  /** Cajas de caras / manos con el detector del motor (sobre una copia de ≤640 px). */
  async findBoxes(kind) {
    if (!this.needModel()) return null;
    if (!(await Ad.ensureKind(kind))) { toast("No se pudo cargar el detector", 4000); return null; }
    const b = this.base(), im = await loadImg(b.src);
    const s = Math.min(1, 640 / Math.max(b.w, b.h));
    const a64 = (n) => Math.max(256, Math.round(n / 64) * 64);
    const w = a64(b.w * s), h = a64(b.h * s);
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    c.getContext("2d").drawImage(im, 0, 0, w, h);
    if (state.engine === "torch") {
      // motor PyTorch: detección directa (YOLOv8 en PyTorch), sin pasada de generación
      this.status("Buscando…");
      const r = await api("/hexanima/v1/detect", { method: "POST", body: JSON.stringify({ image: c.toDataURL("image/png"), kind, confidence: kind === "face" ? 0.35 : 0.3 }) });
      const [pw0, ph0] = this.paintSize();
      return (r.items || []).map((d) => ({ x1: d.x1 * pw0 / w, y1: d.y1 * ph0 / h, x2: d.x2 * pw0 / w, y2: d.y2 * ph0 / h }));
    }
    const before = (await invoke("ad_detections")).seq;
    // pasada casi nula (no cambia nada) solo para que el detector mire la imagen; mask_min_ratio impide que pinte
    await this.job({
      prompt: "x", negative_prompt: "", init_image: c.toDataURL("image/png"), strength: 0.01, width: w, height: h, seed: 1, batch_count: 1,
      sample_params: { scheduler: $("scheduler").value, sample_method: $("sampler").value, sample_steps: 2, guidance: { txt_cfg: 1 } },
      vae_tiling_params: { enabled: false }, output_format: "png",
      extra_ad_args: `confidence=${kind === "face" ? 0.35 : 0.3},mask_min_ratio=0.999`,
    }, "Buscando…");
    const r = await invoke("ad_detections");
    if (r.seq === before) return [];
    const [pw, ph] = this.paintSize();
    return r.items.map((d) => ({ x1: d.x1 * pw / w, y1: d.y1 * ph / h, x2: d.x2 * pw / w, y2: d.y2 * ph / h }));
  },

  /** Zona pintada a partir de cajas (óvalos un poco más grandes, como el teléfono). */
  paintBoxes(boxes, kind) {
    const [pw, ph] = this.paintSize();
    const c = document.createElement("canvas"); c.width = pw; c.height = ph;
    const g = c.getContext("2d"); g.fillStyle = "#A38FFD";
    const grow = kind === "face" ? 1.15 : 1.25;
    for (const b of boxes) {
      const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2, rx = (b.x2 - b.x1) / 2 * grow, ry = (b.y2 - b.y1) / 2 * grow;
      g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill();
    }
    return c;
  },

  async detect(kind, fixAll) {
    if (this.running || state.busy) return toast("Espera a que termine la generación");
    this.running = true; this.stopFlag = false; state.busy = true; this.render();
    const name = kind === "face" ? "caras" : "manos";
    try {
      const boxes = await this.findBoxes(kind);
      if (!boxes) return;
      if (!boxes.length) { this.status(""); return toast(kind === "face" ? "No encontré caras: píntala a mano" : "No encontré manos: píntalas a mano", 4500); }
      if (!fixAll) {
        this.paint = this.paintBoxes(boxes, kind);
        this.status("");
        toast(`${kind === "face" ? "Caras" : "Manos"} encontradas: ${boxes.length}. Revisa la zona con ✎ si quieres y genera.`, 5000);
        return;
      }
      // ✨ una por una, cada una sobre el resultado anterior; queda como alternativa
      let cur = { src: this.base().src, w: this.base().w, h: this.base().h };
      for (let i = 0; i < boxes.length && !this.stopFlag; i++) {
        cur = await this.inpaint(cur.src, this.paintBoxes([boxes[i]], kind), `Corrigiendo ${i + 1} de ${boxes.length}`);
      }
      this.alts.push({ ...cur, step: `${kind === "face" ? "Caras" : "Manos"} ×${boxes.length}` });
      this.sel = this.alts.length - 1;
      this.status("");
      toast(`Corregidas: ${boxes.length} ${name}. Compara y elige «Usar esta» si te gusta.`, 5000);
    } catch (e) { this.status(""); if (!/Detenido/.test(e.message)) toast("No se pudo: " + (e.message || e), 5000); }
    finally { this.running = false; state.busy = false; this.renderPanel(); }
  },

  // ---------- Generar alternativa ----------
  async generate() {
    if (this.running || state.busy) return toast("Espera a que termine la generación");
    const c = this.cat, b = this.base();
    if (!["noise", "resolution"].includes(c)) {
      if (!this.needModel()) return;
      if (!this.paint) return toast("Pinta primero la zona a cambiar");
    }
    this.running = true; this.stopFlag = false; state.busy = true; this.render();
    const t0 = Date.now();
    try {
      let r, step;
      if (c === "noise" || c === "resolution") {
        const up = await this.upscale(b.src);
        const f = c === "noise" ? 1 : this.up;
        const W = b.w * f, H = b.h * f;
        const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
        const g = cv.getContext("2d"); g.imageSmoothingQuality = "high";
        if (c === "noise") { g.drawImage(await loadImg(b.src), 0, 0); g.globalAlpha = this.noise / 100; }
        g.drawImage(up, 0, 0, W, H);
        r = { src: cv.toDataURL("image/png"), w: W, h: H };
        step = c === "noise" ? `Ruido ${this.noise} %` : `Resolución ×${f}`;
      } else {
        r = await this.inpaint(b.src, this.paint, "Generando alternativa");
        step = FIX_CATS.find((x) => x.key === c).label + (this.text.trim() ? ` · ${this.text.trim().slice(0, 30)}` : "");
      }
      this.alts.push({ ...r, step });
      this.sel = this.alts.length - 1;
      this.status(`Alternativa ${this.alts.length} · ${step} · ${r.w}×${r.h} · ${fmtS((Date.now() - t0) / 1000)}`);
    } catch (e) { this.status(""); if (!/Detenido/.test(e.message)) toast("No se pudo corregir: " + (e.message || e), 5000); }
    finally { this.running = false; state.busy = false; this.render(); }
  },

  /** Ampliación ×4 con el ampliador elegido en «Ampliar» (lo descarga si hace falta, desde ese diálogo). */
  async upscale(src) {
    let st = [];
    try { st = await invoke("upscaler_status"); } catch { /* vista previa */ }
    const stem = st.find((s) => s.kind === Upscale.kind && s.installed)?.stem || st.find((s) => s.installed)?.stem;
    if (!stem || !state.upscalers.includes(stem)) {
      Upscale.open(src);
      throw new Error("Hace falta un ampliador: descárgalo en la ventana Ampliar y vuelve a intentarlo");
    }
    this.status("Ampliando… (por trozos)");
    const r = await api("/sdcpp/v1/upscale", { method: "POST", body: JSON.stringify({ image: src, upscaler: stem, repeats: 1, output_format: "png" }) });
    const b64 = r.images?.[0]?.b64_json;
    if (!b64) throw new Error("El motor no devolvió una imagen");
    return loadImg("data:image/png;base64," + b64);
  },

  // ---------- cadena ----------
  accept() {
    const a = this.cur(); if (!a) return;
    this.chain = this.chain.slice(0, this.pos + 1);
    this.chain.push(a); this.pos++;
    this.clearAlts(); this.paint = null; this.saved = false;
    toast("Aceptada: la siguiente corrección parte de esta versión");
    this.renderPanel();
  },
  discard() {
    if (this.sel < 0) return;
    this.alts.splice(this.sel, 1);
    this.sel = this.alts.length ? Math.min(this.sel, this.alts.length - 1) : -1;
    this.render();
  },
  undo() { if (this.pos > 0) { this.pos--; this.clearAlts(); this.paint = null; this.renderPanel(); } },
  redo() { if (this.pos + 1 < this.chain.length) { this.pos++; this.clearAlts(); this.paint = null; this.renderPanel(); } },

  async save() {
    if (this.pos === 0) return;
    const b = this.base();
    this.status("Guardando…");
    const meta = {
      ...(this.meta || {}), width: b.w, height: b.h, mode: "fix",
      corrections: this.chain.slice(1, this.pos + 1).map((c) => c.step), created: new Date().toISOString(),
    };
    try {
      const name = await invoke("save_image", { b64: b.src.split(",")[1], prefix: "corregida", meta });
      Session.add({ name, src: b.src, meta, before: this.chain[0].src });
      this.saved = true;
      this.status("Guardada en el Historial");
      toast("Guardada en el Historial", 3000);
    } catch (e) { this.status(""); toast("No se pudo guardar: " + (e.message || e), 5000); }
  },

  async close() {
    if (this.running) return toast("Espera a que termine o pulsa Detener");
    if (!this.saved && this.pos > 0) {
      const ok = await ask({ title: "¿Salir sin guardar?", msg: "Se pierden las correcciones de esta sesión.", buttons: [{ label: "Cancelar", value: false }, { label: "Salir", value: true, primary: true }] });
      if (!ok) return;
    }
    closeModal("fixDlg");
  },
};

/** Convierte una URL local (asset:) en data URL para poder recortar y pintar en lienzos. */
async function toDataUrl(src) {
  const name = decodeURIComponent(src).split(/[\\/]/).pop();
  try { return "data:image/png;base64," + (await invoke("read_output", { name })); } catch { return src; }
}

let fixDrag = false;
const fixMove = (e) => { const r = $("fixAfter").getBoundingClientRect(); Fix.cmp = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); Fix.applyCmp(); };
$("fixBox").addEventListener("mousedown", (e) => { if (!Fix.cur()) return; fixDrag = true; fixMove(e); });
window.addEventListener("mousemove", (e) => { if (fixDrag) fixMove(e); });
window.addEventListener("mouseup", () => { fixDrag = false; });
window.addEventListener("resize", () => { if (!$("fixDlg").classList.contains("hidden")) Fix.applyCmp(); });
$("fixAfter").addEventListener("load", () => Fix.applyCmp());
$("fixUse").onclick = () => Fix.accept();
$("fixDrop").onclick = () => Fix.discard();
$("fixUndo").onclick = () => Fix.undo();
$("fixRedo").onclick = () => Fix.redo();
$("fixGen").onclick = () => Fix.generate();
$("fixStop").onclick = () => { Fix.stopFlag = true; };
$("fixSave").onclick = () => Fix.save();
$("fixClose").onclick = () => Fix.close();

// Abrir: barra de la imagen y Historial
$("resFix").onclick = () => { const c = Session.cur(); if (c) Fix.open(c.src, c.meta); };
$("hFix").onclick = async () => { const it = History.item(); if (it) Fix.open(await History.dataUrl(it), it.meta); };

// Esc en Correcciones pregunta antes de salir si hay cambios sin guardar.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const top = [...document.querySelectorAll(".modal:not(.hidden)")].sort((a, b) => (+getComputedStyle(a).zIndex || 0) - (+getComputedStyle(b).zIndex || 0)).pop();
  if (top?.id === "fixDlg") { e.stopImmediatePropagation(); e.preventDefault(); Fix.close(); }
}, true);
