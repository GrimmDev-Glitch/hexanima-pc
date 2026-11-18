// HexAnima PC: catálogo predeterminado con los modelos de HexAnima del teléfono, en su versión original.
// El teléfono los convierte para la NPU y les fusiona el LoRA Anima Turbo v1.1 («…_turbo11»); en PC se
// descarga el original de Civitai y el Modo rápido aplica ese mismo LoRA al generar (modelos de 2B).
// Comparten el codificador y el VAE de Anima (paquete «anima_base»), que se descargan si faltan.
"use strict";

const CATALOG = [
  { id: "lh3d11", name: "MiaoMiao 3D Harem · LH3D 1.1", desc: "Estilo 3D / render · 2B", model: 431957, version: 3402714, gb: 3.9, fast: true, match: /lh3d[_ ]?1\.1/i },
  { id: "harem16", name: "MiaoMiao Harem · Anima 1.6", desc: "Anime · 2B", model: 934764, version: 3248362, gb: 3.9, fast: true, match: /harem.*anima[_ ]?1\.6/i },
  { id: "harem29", name: "MiaoMiao Harem · 2.9B BETA 1.1", desc: "Anime · 2.9B: más detalle, más lento (sin Modo rápido)", model: 934764, version: 3360028, prefer: /fp16/i, gb: 5.4, match: /harem.*2\.9b[_ ]?beta[_ ]?1\.1/i },
  { id: "real13", name: "MiaoMiao RealSkin · Anima 1.3", desc: "Realista · 2B", model: 2026594, version: 3265292, gb: 3.9, fast: true, match: /realskin.*anima[_ ]?v1\.3/i },
  { id: "real29", name: "MiaoMiao RealSkin · 2.9B 1.0", desc: "Realista · 2.9B: más detalle, más lento (sin Modo rápido)", model: 2026594, version: 3415563, gb: 5.4, match: /realskin.*anima[_ ]?2\.9b[_ ]?v1/i },
  { id: "moss", name: "MiaoMiao RealSkin / Harem · MOSS", desc: "Necesita MOSS-Image, que aún no funciona en PC", soon: true },
];

const Catalog = {
  index: { ids: [] },
  busy: null,

  async refresh() {
    try { this.index = await invoke("downloaded_index"); } catch { this.index = { ids: [] }; }
    this.render();
  },

  have(e) { return (this.index.ids || []).includes("version_id:" + e.version) || state.options.some((o) => o.family === "anima" && e.match?.test(o.id)); },

  render() {
    const box = $("catList");
    box.innerHTML = "";
    for (const e of CATALOG) {
      const d = document.createElement("div");
      d.className = "pack" + (e.soon ? " soon" : "");
      const have = !e.soon && this.have(e);
      d.innerHTML = `<div class="pack-info"><div class="pack-name"></div><div class="lbl pack-desc"></div><div class="lbl pack-size"></div>
        <div class="pack-prog hidden"><div class="bar"><i></i></div><div class="lbl pack-txt"></div></div></div><button></button>`;
      d.querySelector(".pack-name").textContent = e.name;
      if (e.fast) d.querySelector(".pack-name").insertAdjacentHTML("beforeend", '<span class="pack-tag">⚡ 8 pasos</span>');
      d.querySelector(".pack-desc").textContent = e.desc;
      d.querySelector(".pack-size").textContent = e.soon ? "" : have ? "✓ Descargado" : `Descarga de ${String(e.gb).replace(".", ",")} GB (+ codificador y VAE de Anima si faltan)`;
      const b = d.querySelector("button");
      b.className = e.soon ? "ghost" : "primary pack-btn";
      b.textContent = e.soon ? "Próximamente" : have ? "Usar" : "Descargar";
      b.disabled = !!e.soon || (!!this.busy && this.busy !== e.id);
      if (this.busy === e.id) { b.textContent = "Cancelar"; d.querySelector(".pack-prog").classList.remove("hidden"); }
      b.onclick = () => (this.busy === e.id ? invoke("civitai_cancel", { id: String(e.version) }).catch(() => {}) : have ? this.use(e) : this.download(e, d));
      box.appendChild(d);
    }
  },

  progress(card, txt, pct) {
    card.querySelector(".bar > i").style.width = pct + "%";
    card.querySelector(".pack-txt").textContent = txt;
    setStatus(txt);
  },

  async download(e, card) {
    if (this.busy) return;
    this.busy = e.id; this.render();
    card = [...$("catList").children][CATALOG.indexOf(e)];
    const offs = [];
    try {
      // 1) codificador y VAE de Anima (compartidos), si faltan
      const st = (await invoke("pack_status")).anima_base;
      if (st && !st.installed) {
        offs.push(await window.__TAURI__.event.listen("dl-progress", (ev) => {
          const p = ev.payload; if (p.id !== "pack-anima_base" || !p.total) return;
          this.progress(card, `Codificador y VAE de Anima… ${Math.round((100 * p.done) / p.total)} %`, (100 * p.done) / p.total);
        }));
        await invoke("pack_download", { pack: "anima_base" });
      }
      // 2) el modelo original desde Civitai
      const m = await invoke("civitai_model", { id: e.model, key: Civitai.key() });
      const v = (m.modelVersions || []).find((x) => x.id === e.version);
      if (!v) throw new Error("Civitai ya no tiene esta versión");
      const files = (v.files || []).filter((f) => f.type === "Model");
      const f = (e.prefer && files.find((x) => e.prefer.test(x.name))) || files[0];
      if (!f) throw new Error("La versión no tiene archivo del modelo");
      const img = (v.images || []).find((i) => i.type !== "video");
      const meta = { name: m.name, version: v.name, model_id: m.id, version_id: v.id, type: m.type, base: v.baseModel || null,
        words: v.trainedWords || [], preview: img ? img.url : null, nsfw: !!m.nsfw, tags: m.tags || [] };
      const t0 = performance.now();
      offs.push(await window.__TAURI__.event.listen("dl-progress", (ev) => {
        const p = ev.payload; if (p.id !== String(v.id) || !p.total) return;
        const secs = (performance.now() - t0) / 1000, speed = secs > 2 ? p.done / secs : 0;
        const eta = speed ? Math.round((p.total - p.done) / speed) : null;
        this.progress(card, `${e.name}: ${Math.round((100 * p.done) / p.total)} % · ${(p.done / 1e9).toFixed(1).replace(".", ",")} de ${(p.total / 1e9).toFixed(1).replace(".", ",")} GB`
          + (speed ? ` · ${(speed / 1e6).toFixed(1)} MB/s` : "") + (eta != null ? ` · quedan ${eta >= 90 ? Math.round(eta / 60) + " min" : eta + " s"}` : ""), (100 * p.done) / p.total);
      }));
      await invoke("civitai_download", { req: { id: String(v.id), url: f.downloadUrl, kind: "diffusion_model", file_name: f.name, meta }, key: Civitai.key() });
      toast(`✓ ${e.name} descargado`, 4000);
      await this.refresh();
      this.busy = null;
      await this.use(e);
    } catch (err) {
      if (!/cancelada/i.test(String(err))) toast("No se pudo descargar: " + (err.message || err), 6000);
    } finally {
      offs.forEach((o) => o());
      this.busy = null;
      this.render();
    }
  },

  /** Elegir el modelo descargado y activar el Modo rápido si es de 2B. */
  async use(e) {
    await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    await scanModels();
    const opt = state.options.find((o) => o.family === "anima" && e.match.test(o.id));
    $("packDlg").classList.add("hidden");
    if (!opt) return toast("Descargado: elígelo en Modelo", 4000);
    $("model").value = opt.id; $("model").dispatchEvent(new Event("change")); store.set("model", opt.id);
    if (e.fast && !$("fastMode").checked) toast("Consejo: activa ⚡ Modo rápido (Muestreo) para generar en 8 pasos, como en el teléfono", 6000);
  },
};

// se dibuja cada vez que se abre el panel de descargas
const _packsOpen = Packs.open.bind(Packs);
Packs.open = async function () { await _packsOpen(); await Catalog.refresh(); };
