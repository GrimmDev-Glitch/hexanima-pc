// HexAnima PC: bienvenida y descarga del motor rápido (PyTorch) desde Hugging Face para NVIDIA.
"use strict";

const EngineDl = {
  info: null,
  busy: false,
  t0: 0, d0: 0,

  nvidia() { return state.hw?.gpu?.vendor === "nvidia"; },
  gb(b) { return (b / 1e9).toLocaleString("es", { maximumFractionDigits: 1 }); },

  async refresh() {
    try { this.info = await invoke("engine_dl_info"); } catch (e) { this.info = { error: String(e) }; }
    this.renderSettings();
    return this.info;
  },

  /** Al arrancar: en NVIDIA sin motor rápido, ofrecerlo (salvo «Más tarde»). */
  async maybeWelcome() {
    if (!state.hw || this.checked) return;  // lo llama el arranque de app.js o este archivo, lo que llegue después
    this.checked = true;
    if (!this.nvidia() || (state.engines || []).includes("torch")) { this.renderSettings(); return; }
    await this.refresh();
    if (store.get("engineWelcomeLater", false) && !this.info.partial_bytes) return;
    this.open();
  },

  open() {
    const i = this.info || {}, r = i.remote, gpu = state.hw?.gpu?.name || "NVIDIA";
    $("engTitle").textContent = (state.options || []).length ? "Motor rápido para tu gráfica" : "Bienvenido a HexAnima PC";
    $("engGpu").textContent = gpu;
    if (r) {
      const left = r.bytes - (i.partial_bytes || 0);
      $("engSize").textContent = i.partial_bytes
        ? `Descarga a medias: quedan ${this.gb(left)} GB de ${this.gb(r.bytes)} GB · ocupa ${this.gb(r.unpacked_bytes)} GB al instalarlo`
        : `Descarga de ${this.gb(r.bytes)} GB · ocupa ${this.gb(r.unpacked_bytes)} GB al instalarlo`;
      if (i.free_bytes != null) $("engSize").textContent += ` · libres: ${this.gb(i.free_bytes)} GB`;
      $("engGo").textContent = i.partial_bytes ? "Continuar la descarga" : `Descargar (${this.gb(left)} GB)`;
      $("engGo").disabled = false;
      $("engErr").classList.add("hidden");
    } else {
      $("engSize").textContent = "";
      $("engErr").textContent = "No se pudo consultar la descarga: " + (i.error || "sin conexión") + ". Revisa tu conexión y pulsa Reintentar.";
      $("engErr").classList.remove("hidden");
      $("engGo").textContent = "Reintentar";
      $("engGo").disabled = false;
    }
    this.showProgress(this.busy);
    $("engineDlg").classList.remove("hidden");
  },

  close() { $("engineDlg").classList.add("hidden"); if (typeof Packs !== "undefined") Packs.next(); },

  showProgress(on) {
    $("engProg").classList.toggle("hidden", !on);
    $("engGo").classList.toggle("hidden", on);
    $("engLater").textContent = on ? "Seguir usando la app" : "Más tarde";
    $("engCancel").classList.toggle("hidden", !on);
  },

  onProgress(p) {
    const pct = p.total ? Math.min(100, (100 * p.done) / p.total) : 0;
    let txt;
    if (p.stage === "download") {
      const now = performance.now();
      if (!this.t0 || p.done < this.d0) { this.t0 = now; this.d0 = p.done; }
      const secs = (now - this.t0) / 1000, speed = secs > 2 ? (p.done - this.d0) / secs : 0;
      const eta = speed > 0 ? Math.round((p.total - p.done) / speed) : null;
      txt = `Descargando… ${pct.toFixed(0)} % · ${this.gb(p.done)} de ${this.gb(p.total)} GB`
        + (speed ? ` · ${(speed / 1e6).toFixed(1)} MB/s` : "")
        + (eta != null ? ` · quedan ${eta >= 90 ? Math.round(eta / 60) + " min" : eta + " s"}` : "");
    } else if (p.stage === "verify") txt = `Comprobando el archivo… ${pct.toFixed(0)} %`;
    else txt = `Instalando… ${pct.toFixed(0)} %`;
    $("engBar").style.width = pct + "%";
    $("engTxt").textContent = txt;
    $("engSet").textContent = txt;
  },

  async start() {
    if (this.busy) return;
    if (!this.info?.remote) { await this.refresh(); return this.open(); }
    this.busy = true; this.t0 = 0;
    store.set("engineWelcomeLater", false);
    this.showProgress(true); this.renderSettings();
    const off = await window.__TAURI__.event.listen("dl-progress", (ev) => { if (ev.payload.id === "engine-torch") this.onProgress(ev.payload); });
    try {
      await invoke("engine_download");
      $("engTxt").textContent = "✓ Motor rápido instalado. Arrancándolo…";
      const info = await invoke("app_info");
      state.engines = info.engines || [];
      state.loaded = null;
      toast("✓ Motor rápido instalado", 4000);
      this.close();
      if (await startEngine(engineFor(currentOption() || { family: "sdxl" }))) {
        await refreshEngineMenus(); await scanModels(); await Loras.refresh();
        $("genBtn").disabled = !currentOption();
      }
    } catch (e) {
      const msg = String(e.message || e);
      $("engErr").textContent = msg; $("engErr").classList.remove("hidden");
      if (!/cancelada/.test(msg)) toast("No se pudo instalar el motor: " + msg, 6000);
      // el motor anterior pudo pararse justo antes de cambiar la carpeta: volver a arrancarlo
      if (!(await api("/sdcpp/v1/models/status").catch(() => null))) {
        if (await startEngine(engineFor(currentOption() || { family: "sdxl" }))) await scanModels();
      }
    } finally {
      off(); this.busy = false;
      await this.refresh();
      if (!$("engineDlg").classList.contains("hidden")) this.open();
    }
  },

  renderSettings() {
    const i = this.info, b = $("engSetBtn"), t = $("engSet");
    $("engSetRow").classList.toggle("hidden", !this.nvidia());
    if (this.busy) { b.textContent = "Ver progreso"; b.disabled = false; return; }
    const inst = (state.engines || []).includes("torch");
    if (inst) {
      const up = i?.remote && i.installed != null && i.remote.version > i.installed;
      t.textContent = up ? `Instalado · hay una versión nueva (${i.remote.version})` : "✓ Instalado";
      b.textContent = "Actualizar"; b.classList.toggle("hidden", !up);
    } else {
      t.textContent = i?.remote ? `No instalado · ${this.gb(i.remote.bytes)} GB · hasta 3 veces más rápido en SDXL` : "No instalado";
      b.textContent = i?.partial_bytes ? "Continuar la descarga" : "Descargar";
      b.classList.remove("hidden");
    }
  },
};

$("engGo").onclick = () => EngineDl.start();
$("engLater").onclick = () => { if (!EngineDl.busy) store.set("engineWelcomeLater", true); EngineDl.close(); };
$("engCancel").onclick = () => invoke("engine_dl_cancel");
$("engSetBtn").onclick = async () => { if (!EngineDl.busy) await EngineDl.refresh(); EngineDl.open(); };
EngineDl.maybeWelcome();

// ---------- Bienvenida, paso 2: modelo para empezar (Anima; Qwen y MOSS próximamente) ----------
const Packs = {
  status: {},
  busy: null,
  modelsKnown: false,
  t0: 0, d0: 0,

  /** Lo llama el arranque tras leer los modelos, y al cerrar el paso del motor. */
  async next() {
    if (!this.modelsKnown || !$("engineDlg").classList.contains("hidden") || this.shown) return;
    if ((state.options || []).length || store.get("packsSkip", false)) return;
    this.shown = true;
    await this.open();
  },

  async open() {
    try { this.status = await invoke("pack_status"); } catch { this.status = {}; }
    for (const card of document.querySelectorAll("#packDlg .pack[data-pack]")) this.renderCard(card);
    $("packErr").classList.add("hidden");
    $("packDlg").classList.remove("hidden");
  },

  renderCard(card) {
    const st = this.status[card.dataset.pack] || {}, btn = card.querySelector(".pack-btn");
    const left = (st.bytes || 0) - (st.have || 0);
    card.querySelector(".pack-size").textContent = st.installed ? "✓ Instalado" : st.have ? `Descarga a medias: quedan ${EngineDl.gb(left)} GB` : `Descarga de ${EngineDl.gb(st.bytes || 0)} GB`;
    btn.textContent = st.installed ? "Usar" : st.have ? "Continuar" : "Descargar";
    btn.disabled = !!this.busy;
    card.querySelector(".pack-prog").classList.toggle("hidden", this.busy !== card.dataset.pack);
    $("packCancel").classList.toggle("hidden", !this.busy);
    $("packSkip").textContent = this.busy ? "Seguir usando la app" : "Omitir";
  },

  onProgress(card, p) {
    const now = performance.now();
    if (!this.t0 || p.done < this.d0) { this.t0 = now; this.d0 = p.done; }
    const secs = (now - this.t0) / 1000, speed = secs > 2 ? (p.done - this.d0) / secs : 0;
    const eta = speed > 0 ? Math.round((p.total - p.done) / speed) : null;
    const pct = p.total ? (100 * p.done) / p.total : 0;
    card.querySelector(".bar > i").style.width = pct + "%";
    const txt = `${pct.toFixed(0)} % · ${EngineDl.gb(p.done)} de ${EngineDl.gb(p.total)} GB`
      + (speed ? ` · ${(speed / 1e6).toFixed(1)} MB/s` : "") + (eta != null ? ` · quedan ${eta >= 90 ? Math.round(eta / 60) + " min" : eta + " s"}` : "");
    card.querySelector(".pack-txt").textContent = txt;
    setStatus(`Descargando ${card.querySelector(".pack-name").textContent}… ${txt}`);
  },

  async download(card) {
    const pack = card.dataset.pack;
    if (this.busy) return;
    if (!this.status[pack]?.installed) {
      this.busy = pack; this.t0 = 0; this.renderCard(card);
      const off = await window.__TAURI__.event.listen("dl-progress", (ev) => { if (ev.payload.id === "pack-" + pack) this.onProgress(card, ev.payload); });
      try {
        await invoke("pack_download", { pack });
        toast("✓ " + card.querySelector(".pack-name").textContent + " descargado", 4000);
      } catch (e) {
        const msg = String(e.message || e);
        $("packErr").textContent = msg; $("packErr").classList.remove("hidden");
        this.busy = null; off();
        try { this.status = await invoke("pack_status"); } catch { /* sigue */ }
        return this.renderCard(card);
      }
      off(); this.busy = null;
    }
    // usarlo: leer los modelos, elegir el nuevo y cargarlo (Anima arranca el motor CUDA solo)
    $("packDlg").classList.add("hidden");
    await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    await scanModels();
    const opt = state.options.find((o) => o.family === pack);
    if (opt) { $("model").value = opt.id; $("model").dispatchEvent(new Event("change")); store.set("model", opt.id); }
  },
};

for (const card of document.querySelectorAll("#packDlg .pack[data-pack]")) card.querySelector(".pack-btn").onclick = () => Packs.download(card);
$("packSkip").onclick = () => { if (!Packs.busy) store.set("packsSkip", true); $("packDlg").classList.add("hidden"); };
$("packCancel").onclick = () => invoke("engine_dl_cancel");
