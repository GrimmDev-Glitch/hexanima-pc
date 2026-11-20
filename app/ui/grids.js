// HexAnima PC: ⊞ Comparar (cuadrícula 2×2) y hojas de contacto de los lotes, como el teléfono.
// - Comparar: 4 imágenes que cambian una sola cosa (seed, CFG o pasos), rotuladas, en una imagen 2×2.
// - Hoja de contacto: al terminar un lote de 2 o más, hojas de hasta 9 imágenes numeradas
//   (repartidas: 10 imágenes dan dos hojas de 5), de 2048 px como mucho por el lado largo.
// Las dos se guardan en el historial como cualquier imagen y se ven con ‹ › en la sesión.
"use strict";

const Grids = {
  CFG: [1, 3, 5, 7],
  STEPS: [4, 8, 12, 20],
  KINDS: [
    { value: 1, label: "4 seeds" },
    { value: 2, label: "CFG  1 · 3 · 5 · 7" },
    { value: 3, label: UiLanguage.text("Pasos  4 · 8 · 12 · 20") },
  ],

  async menu() {
    if (state.busy || !currentOption()) return;
    const k = await ask({ title: UiLanguage.text("Comparar (cuadrícula 2×2)"), msg: UiLanguage.text("Genera 4 imágenes cambiando una sola cosa y las junta en una cuadrícula rotulada."), list: this.KINDS });
    if (k) generate({ grid: k });
  },

  /** Ajustes de la imagen i de una comparación: seed, y CFG o pasos si es lo que se compara. */
  plan(kind, i, seed) {
    if (kind === 1) return { seed: seed + i, label: `seed ${seed + i}` };
    if (kind === 2) return { seed, cfg: this.CFG[i], label: `CFG ${this.CFG[i]}` };
    return { seed, steps: this.STEPS[i], label: UiLanguage.template`${this.STEPS[i]} pasos` };
  },

  img(src) {
    return new Promise((ok, bad) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => bad(new Error(UiLanguage.text("imagen no válida"))); im.src = src; });
  },

  async save(cv, meta) {
    const src = cv.toDataURL("image/png");
    const name = await invoke("save_image", { b64: src, prefix: "cuadricula", meta });
    return { name, src, meta, sheet: true };
  },

  /** Las cuatro imágenes con su rótulo debajo (celdas de 512 px de ancho como mucho). */
  async saveCompare(items, labels, base) {
    const ims = await Promise.all(items.map((it) => this.img(it.src)));
    const cw = Math.min(512, ims[0].width), ch = Math.round((cw * ims[0].height) / ims[0].width), lh = 44;
    const cv = document.createElement("canvas");
    cv.width = cw * 2; cv.height = (ch + lh) * 2;
    const c = cv.getContext("2d");
    c.fillStyle = "#1B172F"; c.fillRect(0, 0, cv.width, cv.height);
    c.imageSmoothingQuality = "high";
    c.fillStyle = "#E9E6F5"; c.font = "600 28px 'Barlow Semi Condensed', system-ui, sans-serif"; c.textAlign = "center";
    ims.slice(0, 4).forEach((im, i) => {
      const x = (i % 2) * cw, y = Math.floor(i / 2) * (ch + lh);
      c.drawImage(im, x, y, cw, ch);
      c.fillText(labels[i], x + cw / 2, y + ch + 31);
    });
    return this.save(cv, { ...base, grid: labels.join(" | "), count: ims.length });
  },

  /** Hojas de contacto de un lote: hasta 9 por hoja, repartidas; los números siguen de una hoja a otra. */
  async saveSheets(items, base) {
    if (items.length < 2) return [];
    const pages = Math.ceil(items.length / 9), per = Math.ceil(items.length / pages), out = [];
    for (let i = 0; i < items.length; i += per) out.push(await this.saveSheet(items.slice(i, i + per), base, i, items.length));
    return out;
  },

  /** Elige columnas para que las imágenes salgan lo más grandes posible; cada celda vacía cuesta un 12 %
   *  (3 verticales van en una fila en vez de 2×2 con un hueco). La última fila incompleta va centrada. */
  async saveSheet(items, base, offset, total) {
    const ims = await Promise.all(items.map((it) => this.img(it.src)));
    const n = ims.length, side = 2048, gap = 8, aspect = ims[0].width / ims[0].height || 1;
    let cols = 1, cellW = 1, cellH = 1, best = -1;
    for (let k = 1; k <= n; k++) {
      const r = Math.ceil(n / k);
      if (r > 1 && k > 1 && (r - 1) * k >= n) continue; // sin una fila entera vacía
      const mw = Math.max(1, Math.floor((side - gap * (k - 1)) / k)), mh = Math.max(1, Math.floor((side - gap * (r - 1)) / r));
      let cw, ch;
      if (aspect >= mw / mh) { cw = mw; ch = Math.max(1, Math.round(mw / aspect)); } else { ch = mh; cw = Math.max(1, Math.round(mh * aspect)); }
      const score = cw * ch * (1 - 0.12 * (k * r - n));
      if (score > best + 1e-6) { best = score; cols = k; cellW = cw; cellH = ch; }
    }
    const rows = Math.ceil(n / cols);
    const cv = document.createElement("canvas");
    cv.width = cellW * cols + gap * (cols - 1); cv.height = cellH * rows + gap * (rows - 1);
    const c = cv.getContext("2d");
    c.fillStyle = "#181522"; c.fillRect(0, 0, cv.width, cv.height);
    c.imageSmoothingQuality = "high";
    const fs = Math.max(18, Math.min(44, cellW * 0.08));
    c.font = `600 ${fs}px 'Barlow Semi Condensed', system-ui, sans-serif`; c.textAlign = "center";
    ims.forEach((im, i) => {
      const row = Math.floor(i / cols), inRow = row === rows - 1 ? n - row * cols : cols;
      const rowStart = Math.floor((cv.width - (inRow * cellW + gap * (inRow - 1))) / 2);
      const x = rowStart + (i % cols) * (cellW + gap), y = row * (cellH + gap);
      const s = Math.min(cellW / im.width, cellH / im.height), dw = Math.round(im.width * s), dh = Math.round(im.height * s);
      const dx = x + Math.floor((cellW - dw) / 2), dy = y + Math.floor((cellH - dh) / 2);
      c.drawImage(im, dx, dy, dw, dh);
      const r = fs * 0.9, cx = dx + r + 14, cy = dy + r + 14;
      c.fillStyle = "rgba(0,0,0,.69)"; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
      c.fillStyle = "#fff"; c.fillText(String(offset + i + 1), cx, cy + fs * 0.35);
    });
    return this.save(cv, { ...base, seed: "batch", grid: `batch ${total}`, count: n, first: offset + 1 });
  },

  /** Al terminar un lote o una comparación: arma la cuadrícula o las hojas y las añade a la sesión. */
  async finish(kind, made, labels) {
    if (made.length < 2) return;
    const m = made[0].meta || {};
    const base = { prompt: m.prompt, negative: m.negative, model: m.model, model_label: m.model_label, family: m.family, width: m.width, height: m.height, created: new Date().toISOString() };
    try {
      if (kind) {
        const g = await this.saveCompare(made, labels, { ...base, seed: m.seed });
        Session.add(g);
        setStatus(UiLanguage.text("Cuadrícula guardada en el historial · ‹ › para ver las imágenes"), "ok");
      } else {
        const gs = await this.saveSheets(made, base);
        for (const g of gs) Session.add(g);
        if (gs.length) Session.i = Session.list.length - gs.length, Session.render();
        setStatus(gs.length > 1 ? UiLanguage.template`Cuadrícula 1/${gs.length} · ${made.length} imágenes · ‹ › para ver más` : UiLanguage.template`Cuadrícula · ${made.length} imágenes · ‹ › para recorrerlas`, "ok");
      }
    } catch (e) { toast(UiLanguage.text("No se pudo guardar la cuadrícula: ") + (e.message || e), 5000); }
  },
};

$("gridBtn").onclick = () => Grids.menu();
