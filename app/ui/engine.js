// HexAnima PC: bienvenida y descarga del motor rápido (PyTorch) desde Hugging Face para NVIDIA.
"use strict";

const EngineDl = {
  info: null,
  busy: false,
  t0: 0, d0: 0,

  nvidia() { return isNvidiaGpu(); },
  gb(b) { return (b / 1e9).toLocaleString(UiLanguage.selected, { maximumFractionDigits: 1 }); },

  async refresh() {
    try { this.info = await invoke("engine_dl_info", { cu128: needsCu128() }); } catch (e) { this.info = { error: String(e) }; }
    this.renderSettings();
    return this.info;
  },

  /** Al arrancar: en NVIDIA sin motor rápido, ofrecerlo (salvo «Más tarde»). */
  async maybeWelcome() {
    if (!state.hw || this.checked) return;  // lo llama el arranque de app.js o este archivo, lo que llegue después
    this.checked = true;
    // sin motor, o con el de CUDA 12.1 en una RTX serie 50: ofrecer el que le sirve
    if (!this.nvidia() || ((state.engines || []).includes("torch") && torchSupportsGpu())) { this.renderSettings(); return; }
    await this.refresh();
    if (store.get("engineWelcomeLater", false) && !this.info.partial_bytes) return;
    this.open();
  },

  open() {
    const i = this.info || {}, r = i.remote, gpu = state.hw?.gpu?.name || "NVIDIA";
    $("engTitle").textContent = (state.options || []).length ? UiLanguage.text("Motor rápido para tu gráfica") : "Bienvenido a HexAnima PC";
    $("engGpu").textContent = gpu;
    if (r) {
      const left = r.bytes - (i.partial_bytes || 0);
      $("engSize").textContent = i.partial_bytes
        ? UiLanguage.template`Descarga a medias: quedan ${this.gb(left)} GB de ${this.gb(r.bytes)} GB · ocupa ${this.gb(r.unpacked_bytes)} GB al instalarlo`
        : UiLanguage.template`Descarga de ${this.gb(r.bytes)} GB · ocupa ${this.gb(r.unpacked_bytes)} GB al instalarlo`;
      if (i.free_bytes != null) $("engSize").textContent += ` · libres: ${this.gb(i.free_bytes)} GB`;
      const installed = (state.engines || []).includes("torch");
      $("engGo").textContent = i.partial_bytes
        ? UiLanguage.text(installed ? "Continuar la actualización" : "Continuar la descarga")
        : installed
          ? UiLanguage.template`Actualizar motor (${this.gb(left)} GB)`
          : UiLanguage.template`Descargar (${this.gb(left)} GB)`;
      $("engGo").disabled = false;
      $("engErr").classList.add("hidden");
    } else {
      $("engSize").textContent = "";
      $("engErr").textContent = UiLanguage.text("No se pudo consultar la descarga: ") + (i.error || UiLanguage.text("sin conexión")) + UiLanguage.text(". Revisa tu conexión y pulsa Reintentar.");
      $("engErr").classList.remove("hidden");
      $("engGo").textContent = UiLanguage.text("Reintentar");
      $("engGo").disabled = false;
    }
    this.showProgress(this.busy);
    $("engineDlg").classList.remove("hidden");
  },

  close() { $("engineDlg").classList.add("hidden"); if (typeof Packs !== "undefined") Packs.next(); },

  showProgress(on) {
    $("engProg").classList.toggle("hidden", !on);
    $("engGo").classList.toggle("hidden", on);
    $("engLater").textContent = on ? UiLanguage.text("Seguir usando la app") : UiLanguage.text("Más tarde");
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
      txt = UiLanguage.template`Descargando… ${pct.toFixed(0)} % · ${this.gb(p.done)} de ${this.gb(p.total)} GB`
        + (speed ? ` · ${(speed / 1e6).toFixed(1)} MB/s` : "")
        + (eta != null ? ` · quedan ${eta >= 90 ? Math.round(eta / 60) + " min" : eta + " s"}` : "");
    } else if (p.stage === "verify") txt = UiLanguage.template`Comprobando el archivo… ${pct.toFixed(0)} %`;
    else txt = UiLanguage.template`Instalando… ${pct.toFixed(0)} %`;
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
      await invoke("engine_download", { cu128: needsCu128() });
      $("engTxt").textContent = UiLanguage.text("✓ Motor rápido instalado. Arrancándolo…");
      const info = await invoke("app_info");
      state.engines = info.engines || [];
      state.torchCuda = info.torch_cuda;
      state.loaded = null;
      toast(UiLanguage.text("✓ Motor rápido instalado"), 4000);
      this.close();
      if (await startEngine(engineFor(currentOption() || { family: "sdxl" }))) {
        await refreshEngineMenus(); await scanModels(); await Loras.refresh();
        $("genBtn").disabled = !currentOption();
      }
    } catch (e) {
      const msg = String(e.message || e);
      $("engErr").textContent = msg; $("engErr").classList.remove("hidden");
      if (!/cancelada|cancelled/i.test(msg)) toast(UiLanguage.text("No se pudo instalar el motor: ") + msg, 6000);
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
    if (inst && !torchSupportsGpu()) {
      // motor de CUDA 12.1 en una RTX serie 50: no le sirve, hay que bajar el de CUDA 12.8
      t.textContent = UiLanguage.text("El instalado no funciona en tu gráfica (RTX serie 50): descarga el motor para ella") + (i?.remote ? ` · ${this.gb(i.remote.bytes)} GB` : "");
      b.textContent = i?.partial_bytes ? UiLanguage.text("Continuar la descarga") : UiLanguage.text("Descargar");
      b.classList.remove("hidden");
    } else if (inst) {
      const packageVersion = Number(i?.installed) > 0 ? UiLanguage.template`paquete v${i.installed}` : null;
      const torchVersion = i?.torch_version ? UiLanguage.template`PyTorch ${i.torch_version}` : null;
      const installed = [packageVersion, torchVersion].filter(Boolean).join(" · ") || UiLanguage.text("versión desconocida");
      const cuda = i?.installed_cuda ? `CUDA ${(Number(i.installed_cuda) / 10).toFixed(1)}` : UiLanguage.text("CUDA sin verificar");
      const up = i?.remote && (!Number(i.installed) || i.remote.version > Number(i.installed));
      t.textContent = up
        ? UiLanguage.template`Instalado · ${installed} · ${cuda} · hay una versión nueva (${i.remote.version})`
        : UiLanguage.template`✓ Instalado · ${installed} · ${cuda}`;
      b.textContent = up ? UiLanguage.text("Actualizar") : UiLanguage.text("Buscar actualizaciones");
      b.classList.remove("hidden");
    } else {
      t.textContent = i?.remote ? UiLanguage.template`No instalado · ${this.gb(i.remote.bytes)} GB · hasta 3 veces más rápido en SDXL` : UiLanguage.text("No instalado");
      b.textContent = i?.partial_bytes ? UiLanguage.text("Continuar la descarga") : UiLanguage.text("Descargar");
      b.classList.remove("hidden");
    }
  },
};

$("engGo").onclick = () => EngineDl.start();
$("engLater").onclick = () => { if (!EngineDl.busy) store.set("engineWelcomeLater", true); EngineDl.close(); };
$("engCancel").onclick = () => invoke("engine_dl_cancel");
$("engSetBtn").onclick = async () => {
  if (EngineDl.busy) return;
  const info = await EngineDl.refresh();
  const installed = Number(info?.installed || 0);
  if ((state.engines || []).includes("torch") && info?.remote && installed > 0 && info.remote.version <= installed) {
    toast(UiLanguage.text("El motor PyTorch ya está actualizado"), 4000);
    return;
  }
  EngineDl.open();
};
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
    $("packTitle").textContent = (state.options || []).length ? UiLanguage.text("Catálogo de modelos") : UiLanguage.text("Elige un modelo para empezar");
    try { this.status = await invoke("pack_status"); } catch { this.status = {}; }
    for (const card of document.querySelectorAll("#packDlg .pack[data-pack]")) this.renderCard(card);
    $("packErr").classList.add("hidden");
    $("packDlg").classList.remove("hidden");
  },

  renderCard(card) {
    const st = this.status[card.dataset.pack] || {}, btn = card.querySelector(".pack-btn");
    const left = (st.bytes || 0) - (st.have || 0);
    card.querySelector(".pack-size").textContent = st.installed ? UiLanguage.text("✓ Instalado") : st.have ? UiLanguage.template`Descarga a medias: quedan ${EngineDl.gb(left)} GB` : UiLanguage.template`Descarga de ${EngineDl.gb(st.bytes || 0)} GB`;
    btn.textContent = st.installed ? UiLanguage.text("Usar") : st.have ? UiLanguage.text("Continuar") : UiLanguage.text("Descargar");
    btn.disabled = !!this.busy;
    card.querySelector(".pack-prog").classList.toggle("hidden", this.busy !== card.dataset.pack);
    $("packCancel").classList.toggle("hidden", !this.busy);
    $("packSkip").textContent = this.busy ? UiLanguage.text("Seguir usando la app") : (state.options || []).length ? "Cerrar" : "Omitir";
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
    setStatus(UiLanguage.template`Descargando ${card.querySelector(".pack-name").textContent}… ${txt}`);
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
