// HexAnima PC: ⚡ Modo rápido. No toca los pasos / CFG / sampler del usuario: solo cambia lo que se envía.
//  · SDXL / Illustrious / Pony: LoRA DMD2 de 4 pasos (tianweiy) a 0,8, 8 pasos, CFG 1, sampler LCM.
//    GTX 1650 a 640×960: 29,5 s frente a 160 s con 28 pasos y CFG 5,5, con calidad muy parecida.
//  · Anima normal de 2B (MiaoMiao del catálogo, Anima base…): LoRA Anima Turbo v1.1, como las versiones
//    «turbo11» del teléfono (que lo traen fusionado): 8 pasos, CFG 1, Euler. Los 2.9B usan otro turbo: no.
"use strict";

const FAST_KINDS = {
  sdxl: { kind: "dmd2", file: "dmd2_sdxl_4step_lora_fp16.safetensors", weight: 0.8, sampler: "lcm", name: "DMD2", mb: 394,
          msg: "Necesita el LoRA DMD2 (394 MB, una sola vez). Genera en 8 pasos con CFG 1: unas 5 veces más rápido con calidad muy parecida. Licencia no comercial (CC BY-NC 4.0)." },
  anima: { kind: "anima_turbo", file: "anima-turbo-v11-rank32-bias.safetensors", weight: 1.0, sampler: "euler", name: "Anima Turbo", mb: 142,
           msg: "Necesita el LoRA Anima Turbo v1.1 (142 MB, una sola vez), el mismo que traen fusionado los modelos del teléfono. Genera en 8 pasos con CFG 1: unas 3 veces más rápido." },
};

const Fast = {
  installed: {},      // kind -> bool

  /** Configuración del modo rápido para el modelo, o null si no aplica. */
  cfg(opt) {
    if (opt?.family === "sdxl") return FAST_KINDS.sdxl;
    // Anima normal de 2B: los turbo ya van en 8 pasos y los 2.9B necesitan su propio turbo
    if (opt?.family === "anima" && !/turbo/i.test(opt.id) && !/2[._]?9\s*b/i.test(opt.id)) return FAST_KINDS.anima;
    return null;
  },
  isOwn(path) { const p = String(path || "").toLowerCase(); return Object.values(FAST_KINDS).some((k) => p === k.file.toLowerCase()); },
  supported(opt) { return !!this.cfg(opt); },
  on() { return $("fastMode").checked && this.supported(currentOption()); },

  /** Cambia la petición si el modo está activo. Devuelve {steps, lora} para los metadatos, o null. */
  apply(body, opt) {
    const k = this.cfg(opt);
    if (!$("fastMode").checked || !k || !this.installed[k.kind]) return null;
    const steps = Number($("fastSteps").value) || 8;
    body.sample_params = { ...body.sample_params, sample_method: k.sampler, scheduler: "discrete", sample_steps: steps, guidance: { txt_cfg: 1 } };
    body.lora = [...(body.lora || []).filter((l) => !this.isOwn(l.path)), { path: k.file, multiplier: k.weight }];
    // el Hires fix y ADetailer usan los mismos pasos y CFG 1: el LoRA también acelera esos pasos
    if (body.hires) body.hires = { ...body.hires, steps: Math.min(body.hires.steps || steps, steps) };
    return { steps, lora: k.name, weight: k.weight };
  },

  async refresh() {
    try {
      const a = await invoke("asset_status");
      for (const k of Object.values(FAST_KINDS)) this.installed[k.kind] = !!a.find((x) => x.kind === k.kind)?.installed;
    } catch { /* vista previa */ }
    this.render();
  },

  render() {
    const opt = currentOption(), k = this.cfg(opt), on = $("fastMode").checked;
    $("fastRow").classList.toggle("on", on && !!k);
    $("fastRow").classList.toggle("off-family", !!opt && !k);
    $("fastSteps").disabled = !on;
    const anima = k === FAST_KINDS.anima;
    $("fastInfo").textContent = !opt || k
      ? (on ? `Activo: ${k ? k.name : "DMD2"} · ${$("fastSteps").value} pasos · CFG 1 · ${k?.sampler === "lcm" ? "sampler LCM" : "Euler"}. Tus ajustes de Muestreo se usan al apagarlo.`
            : anima ? "Anima Turbo · CFG 1 · como los modelos del teléfono, unas 3 veces más rápido. Tus ajustes se guardan para cuando lo apagues."
            : "DMD2 · CFG 1 · unas 5 veces más rápido en SDXL, Illustrious y Pony. Tus pasos, CFG y sampler se guardan para cuando lo apagues.")
      : opt.family === "anima" ? "Este modelo Anima ya es rápido (turbo) o es de 2.9B, que necesita su propio turbo."
      : "No disponible para este modelo.";
  },

  async toggle() {
    const box = $("fastMode"), k = this.cfg(currentOption());
    if (box.checked && k && !this.installed[k.kind]) {
      box.checked = false;
      const go = await ask({ title: "⚡ Modo rápido", msg: k.msg, buttons: [{ label: "Cancelar", value: false }, { label: `Descargar (${k.mb} MB)`, value: true, primary: true }] });
      if (!go) return this.render();
      $("fastInfo").textContent = `Descargando ${k.name}…`;
      const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
        const p = ev.payload; if (p.id !== "asset-" + k.kind) return;
        $("fastInfo").textContent = `Descargando ${k.name}… ${p.total ? Math.round((100 * p.done) / p.total) + " %" : ""}`;
      });
      try { await invoke("asset_download", { kind: k.kind }); this.installed[k.kind] = true; box.checked = true; toast("✓ Modo rápido listo", 3000); }
      catch (e) { toast(`No se pudo descargar ${k.name}: ` + (e.message || e), 5000); }
      finally { off(); }
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
      if (typeof Loras !== "undefined") Loras.refresh();
    }
    store.set("fastMode", box.checked);
    this.render();
    if (typeof Acc !== "undefined") Acc.summaries();
  },
};

$("fastMode").checked = store.get("fastMode", false);
$("fastSteps").value = String(store.get("fastSteps", 8));
$("fastMode").onchange = () => Fast.toggle();
$("fastSteps").onchange = () => { store.set("fastSteps", Number($("fastSteps").value)); Fast.render(); if (typeof Acc !== "undefined") Acc.summaries(); };
$("model").addEventListener("change", () => Fast.render());
setTimeout(() => Fast.refresh(), 1200);
setInterval(() => Fast.render(), 1500);  // el modelo también cambia por código (al leer los modelos)
