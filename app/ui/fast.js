// HexAnima PC: ⚡ Modo rápido para SDXL / Illustrious / Pony con el LoRA DMD2 de 4 pasos (tianweiy).
// 8 pasos, CFG 1 (un solo cálculo por paso) y sampler LCM. Medido en una GTX 1650 a 640×960:
// 29,5 s frente a 160 s con 28 pasos y CFG 5,5, con calidad muy parecida.
// No toca los pasos / CFG / sampler del usuario: solo cambia lo que se envía al motor.
"use strict";

const Fast = {
  FILE: "dmd2_sdxl_4step_lora_fp16.safetensors",
  WEIGHT: 0.8,        // los autores recomiendan bajarlo en modelos de la comunidad (Illustrious, Pony…)
  installed: false,

  isOwn(path) { return String(path || "").toLowerCase() === this.FILE.toLowerCase(); },
  supported(opt) { return opt?.family === "sdxl"; },
  on() { return $("fastMode").checked && this.supported(currentOption()); },

  /** Cambia la petición si el modo está activo. Devuelve {steps, lora} para los metadatos, o null. */
  apply(body, opt) {
    if (!$("fastMode").checked || !this.supported(opt) || !this.installed) return null;
    const steps = Number($("fastSteps").value) || 8;
    body.sample_params = { ...body.sample_params, sample_method: "lcm", scheduler: "discrete", sample_steps: steps, guidance: { txt_cfg: 1 } };
    body.lora = [...(body.lora || []).filter((l) => !this.isOwn(l.path)), { path: this.FILE, multiplier: this.WEIGHT }];
    // el Hires fix y ADetailer usan los mismos pasos y CFG 1: el LoRA también acelera esos pasos
    if (body.hires) body.hires = { ...body.hires, steps: Math.min(body.hires.steps || steps, steps) };
    return { steps, lora: "DMD2", weight: this.WEIGHT };
  },

  async refresh() {
    try { this.installed = !!(await invoke("asset_status")).find((a) => a.kind === "dmd2")?.installed; } catch { this.installed = false; }
    this.render();
  },

  render() {
    const opt = currentOption(), ok = this.supported(opt), on = $("fastMode").checked;
    $("fastRow").classList.toggle("on", on && ok);
    $("fastRow").classList.toggle("off-family", !!opt && !ok);
    $("fastSteps").disabled = !on;
    $("fastInfo").textContent = !opt || ok
      ? (on ? `Activo: DMD2 · ${$("fastSteps").value} pasos · CFG 1 · sampler LCM. Tus ajustes de Muestreo se usan al apagarlo.`
            : "DMD2 · CFG 1 · unas 5 veces más rápido en SDXL, Illustrious y Pony. Tus pasos, CFG y sampler se guardan para cuando lo apagues.")
      : "Solo para modelos SDXL, Illustrious y Pony (Anima ya es rápido: 8 pasos).";
  },

  async toggle() {
    const box = $("fastMode");
    if (box.checked && !this.installed) {
      box.checked = false;
      const go = await ask({ title: "⚡ Modo rápido", msg: "Necesita el LoRA DMD2 (394 MB, una sola vez). Genera en 8 pasos con CFG 1: unas 5 veces más rápido con calidad muy parecida. Licencia no comercial (CC BY-NC 4.0).", buttons: [{ label: "Cancelar", value: false }, { label: "Descargar (394 MB)", value: true, primary: true }] });
      if (!go) return this.render();
      $("fastInfo").textContent = "Descargando DMD2…";
      const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
        const p = ev.payload; if (p.id !== "asset-dmd2") return;
        $("fastInfo").textContent = `Descargando DMD2… ${p.total ? Math.round((100 * p.done) / p.total) + " %" : ""}`;
      });
      try { await invoke("asset_download", { kind: "dmd2" }); this.installed = true; box.checked = true; toast("✓ Modo rápido listo", 3000); }
      catch (e) { toast("No se pudo descargar DMD2: " + (e.message || e), 5000); }
      finally { off(); }
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
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
