// HexAnima PC: ⬆ Buscar actualizaciones. Mira la última versión en GitHub y, si es más nueva, baja solo el
// HexAnima.exe nuevo (unos 6 MB), lo cambia por este y reinicia la app. Se comprueba solo una vez al día al abrir
// la app (sin molestar: un aviso por versión), y cuando se pulsa el botón (Ajustes, Info o el menú ⋯).
"use strict";

const Update = {
  busy: false,

  async check(manual) {
    if (this.busy) return;
    if (manual) setStatus("Buscando actualizaciones…");
    let r;
    try { r = await invoke("update_check"); }
    catch (e) { if (manual) { setStatus(""); toast("No se pudo buscar: " + (e.message || e), 6000); } return; }
    store.set("updLast", Date.now());
    $("updInfo").textContent = r.newer ? `Hay una versión nueva: ${r.latest} (tienes la ${r.current})` : `HexAnima PC ${r.current} · tienes la última versión`;
    $("updBtn").classList.toggle("primary", !!r.newer);
    if (manual) setStatus("");
    if (!r.newer) { if (manual) toast(`Tienes la última versión (${r.current})`); return; }
    if (!manual && store.get("updSeen", "") === r.latest) return; // ya se avisó de esta versión
    store.set("updSeen", r.latest);
    this.offer(r);
  },

  async offer(r) {
    const notes = String(r.notes || "").replace(/\r/g, "").split(/^##\s*Instalar/m)[0].replace(/^#+\s*/gm, "").replace(/\*\*/g, "").trim();
    const short = notes.length > 900 ? notes.slice(0, 900) + "…" : notes;
    if (!r.exe) {
      const go = await ask({ title: `HexAnima PC ${r.latest}`, msg: `${short}\n\nEsta versión no trae el .exe suelto: hay que bajarla de GitHub.`,
        buttons: [{ label: "Más tarde", value: false }, { label: "Abrir la página", value: true, primary: true }] });
      if (go) invoke("open_url", { url: r.page }).catch(() => {});
      return;
    }
    const mb = Math.max(1, Math.round(r.exe.size / 1048576));
    const go = await ask({ title: `HexAnima PC ${r.latest} disponible`, msg: `${short}\n\nSe descarga solo HexAnima.exe (${mb} MB) y la app se reinicia. Tus modelos, LoRAs, imágenes y ajustes no se tocan.`,
      buttons: [{ label: "Más tarde", value: false }, { label: `Actualizar y reiniciar (${mb} MB)`, value: true, primary: true }] });
    if (go) this.install(r);
  },

  async install(r) {
    if (state.busy) return toast("Espera a que termine la generación y vuelve a intentarlo", 5000);
    this.busy = true;
    const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
      const p = ev.payload;
      if (p.id === "app-update" && p.total) setStatus(`Descargando la versión ${r.latest}… ${Math.round((100 * p.done) / p.total)} %`);
    });
    try {
      setStatus(`Descargando la versión ${r.latest}…`);
      await invoke("update_install", { url: r.exe.url, size: r.exe.size, sha256: r.exe.sha256 || null });
      setStatus("Reiniciando…", "ok"); // la app se cierra y se abre la versión nueva
    } catch (e) {
      setStatus("");
      toast("No se pudo actualizar: " + (e.message || e), 8000);
    } finally { off(); this.busy = false; }
  },
};

$("updBtn").onclick = () => Update.check(true);
$("infoUpdate").onclick = () => Update.check(true);
// una vez al día, unos segundos después de abrir (sin frenar el arranque)
setTimeout(() => { if (Date.now() - Number(store.get("updLast", 0)) > 20 * 3600 * 1000) Update.check(false); }, 8000);
