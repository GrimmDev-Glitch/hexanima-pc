// HexAnima PC: elegir el VAE (del modelo, uno de models/vae, descargar el de SDXL o importar uno)
// y mejorar la vista previa con TAESD.
"use strict";

const Vae = {
  files: [],        // ids "vae/archivo.safetensors"
  assets: [],

  /** VAEs compatibles con la familia (los de Qwen Image son de Anima). */
  forFamily(family) {
    const qwen = (f) => /qwen|wan|flux|anima|\bae\b/i.test(f);
    return this.files.filter((f) => (family === "anima" ? qwen(f) : !qwen(f)));
  },

  chosen(opt) { return opt ? store.get("vae:" + opt.id, "") : ""; },

  /** Modelos que se mandan al motor al cargar (añade el VAE elegido en SDXL). */
  modelsFor(opt) {
    const m = { ...opt.models };
    const v = this.chosen(opt);
    if (opt.family === "sdxl" && v && this.files.includes(v)) m.vae = v;
    return m;
  },

  async refresh() {
    try { const r = await api("/sdcpp/v1/model-files"); this.files = (r.files || []).filter((f) => f.category === "vae").map((f) => f.id); }
    catch { /* motor arrancando */ }
    try { this.assets = await invoke("asset_status"); } catch { this.assets = []; }
    this.render();
  },

  render() {
    const sel = $("vaePick"), opt = currentOption();
    sel.innerHTML = "";
    if (!opt) { sel.disabled = true; return; }
    if (opt.family === "qwen" || opt.family === "moss") {
      sel.add(new Option(opt.family === "qwen" ? "VAE de Qwen-Image 2.1 (necesario)" : "VAE de FLUX.2 (necesario para MOSS)", ""));
      sel.disabled = true;
      return;
    }
    if (opt.family === "mage") {
      sel.add(new Option("VAE de Mage (necesario para Mage)", ""));
      sel.disabled = true;
      return;
    }
    if (opt.family === "anima") {
      sel.add(new Option(`Qwen Image (necesario para Anima)`, ""));
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.add(new Option("Del modelo (el que trae incluido)", ""));
    for (const f of this.forFamily("sdxl")) sel.add(new Option(f.replace(/^vae\//, ""), f));
    const dl = this.assets.find((a) => a.kind === "sdxl_vae");
    if (dl && !dl.installed) sel.add(new Option(`＋ Descargar SDXL VAE (fp16 fix, ${dl.mb} MB)…`, "@download"));
    sel.add(new Option("＋ Importar un VAE…", "@import"));
    const v = this.chosen(opt);
    sel.value = [...sel.options].some((o) => o.value === v) ? v : "";
    sel.title = "El VAE convierte el resultado en imagen. «Del modelo» usa el que trae el checkpoint; uno externo (p. ej. sdxl_vae) puede mejorar colores y detalles.";
  },

  async pick() {
    const opt = currentOption(), sel = $("vaePick"), v = sel.value;
    if (!opt) return;
    let id = v;
    if (v === "@download") {
      sel.disabled = true;
      const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
        const p = ev.payload; if (p.id !== "asset-sdxl_vae") return;
        setStatus(`Descargando el VAE de SDXL… ${p.total ? Math.round((100 * p.done) / p.total) + " %" : ""}`);
      });
      try { id = await invoke("asset_download", { kind: "sdxl_vae" }); toast("✓ VAE de SDXL descargado", 3000); }
      catch (e) { toast("No se pudo descargar: " + (e.message || e), 5000); id = this.chosen(opt); }
      finally { off(); sel.disabled = false; }
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    } else if (v === "@import") {
      try { id = (await invoke("vae_import")) || this.chosen(opt); } catch (e) { toast(String(e), 5000); id = this.chosen(opt); }
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    }
    store.set("vae:" + opt.id, id || "");
    await this.refresh();
    // el VAE se carga con el modelo: si ya estaba cargado, se recarga al generar
    if (state.loaded === opt.id) {
      state.loaded = null;
      setStatus(id ? `VAE: ${id.replace(/^vae\//, "")} · se aplica al generar (recarga el modelo)` : "VAE del modelo · se aplica al generar (recarga el modelo)");
    }
  },
};

// ---------- Vista previa de alta calidad (TAESD) ----------
async function renderPreviewOpt() {
  let a = null;
  try { a = (await invoke("asset_status")).find((x) => x.kind === "taesdxl"); } catch { /* vista previa */ }
  const b = $("taesdBtn");
  if (!a) { b.classList.add("hidden"); return; }
  b.disabled = a.installed;
  b.textContent = a.installed ? "✓ Vista previa de alta calidad instalada (TAESD)" : `Mejorar la vista previa (TAESD, ${a.mb} MB)`;
}
$("taesdBtn").onclick = async () => {
  $("taesdBtn").disabled = true; $("taesdBtn").textContent = "Descargando…";
  try { await invoke("asset_download", { kind: "taesdxl" }); toast("✓ Vista previa de alta calidad lista (motor PyTorch, SDXL)", 4000); }
  catch (e) { toast("No se pudo descargar: " + (e.message || e), 5000); }
  renderPreviewOpt();
};

$("vaePick").onchange = () => Vae.pick();
$("model").addEventListener("change", () => Vae.render());
setTimeout(() => renderPreviewOpt(), 1500);  // la lista de VAEs se llena al leer los modelos (scanModels)
