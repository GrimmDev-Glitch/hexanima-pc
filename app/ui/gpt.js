// HexAnima PC: ✦ Estilo ChatGPT (como el teléfono). Descarga la LoRA de Anima «Style > gpt-image-2» de
// AgileNumbers (Civitai, modelo 2564225, versión 2998634; uso comercial y derivados permitidos, 22 MB) y la
// añade al prompt con su palabra activadora y fuerza 0.8. Pulsarlo otra vez la quita.
"use strict";

const Gpt = {
  STEM: "gpt-image-2",
  TRIGGER: "@gpt-image-2",
  URL: "https://civitai.red/api/download/models/2998634?fileId=2878107",
  busy: false,

  /** Solo para Anima: la LoRA es de esa familia. */
  sync() {
    const b = $("gptStyle"); if (!b) return;
    b.classList.toggle("hidden", currentOption()?.family !== "anima");
    b.classList.toggle("on", this.active());
  },

  active() { return Loras.tags().has(this.STEM); },

  tokens(p) { return p.split(",").map((t) => t.trim()).filter(Boolean); },

  remove() {
    const re = new RegExp(`<lora:${this.STEM}(:[^>]*)?>`, "gi");
    const keep = this.tokens($("prompt").value.replace(re, "")).filter((t) => t.toLowerCase() !== this.TRIGGER);
    $("prompt").value = keep.join(", ");
  },

  apply() {
    const cur = [this.TRIGGER, ...this.tokens($("prompt").value).filter((t) => t.toLowerCase() !== this.TRIGGER), `<lora:${this.STEM}:0.8>`];
    $("prompt").value = cur.join(", ");
    toast(UiLanguage.text("Estilo ChatGPT añadido al prompt (fuerza 0.8). Púlsalo otra vez para quitarlo."), 5000);
  },

  async toggle() {
    if (this.busy) return;
    if (this.active()) { this.remove(); toast(UiLanguage.text("Estilo ChatGPT quitado")); return this.after(); }
    if (!Loras.byStem(this.STEM)) {
      const ok = await ask({ title: "Estilo ChatGPT", msg: UiLanguage.text("Descarga la LoRA «Style > gpt-image-2» de AgileNumbers desde Civitai (22 MB) y la añade al prompt. Da el acabado de ilustración del ChatGPT actual: líneas finas, ojos detallados y luz suave."), buttons: [{ label: UiLanguage.text("Cancelar"), value: false }, { label: UiLanguage.text("Descargar"), value: true, primary: true }] });
      if (!ok) return;
      this.busy = true; $("gptStyle").disabled = true;
      const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
        const p = ev.payload;
        if (p.id === "gpt-style" && p.state === "downloading") setStatus(UiLanguage.template`Estilo ChatGPT · descargando ${(p.done / 1048576).toFixed(0)}${p.total ? " / " + (p.total / 1048576).toFixed(0) : ""} MB`);
      });
      try {
        await invoke("civitai_download", { req: { id: "gpt-style", url: this.URL, kind: "lora", file_name: this.STEM + ".safetensors",
          meta: { name: "Style > gpt-image-2", version: "Anima-base1 v1.1", model_id: 2564225, version_id: 2998634, type: "LORA", base: "Anima", words: [this.TRIGGER], tags: ["style"] } }, key: Civitai.key() });
        await Loras.refresh();
        setStatus(UiLanguage.text("✓ Estilo ChatGPT descargado"), "ok");
      } catch (e) { setStatus(UiLanguage.text("No se pudo descargar el Estilo ChatGPT: ") + (e.message || e), "err"); return; }
      finally { off(); this.busy = false; $("gptStyle").disabled = false; }
      if (!Loras.byStem(this.STEM)) { setStatus(UiLanguage.text("La LoRA descargada no aparece en la carpeta de LoRAs"), "err"); return; }
    }
    this.apply();
    this.after();
  },

  after() { $("prompt").dispatchEvent(new Event("input")); this.sync(); },
};

$("gptStyle").onclick = () => Gpt.toggle();
$("model").addEventListener("change", () => Gpt.sync());
$("prompt").addEventListener("input", () => Gpt.sync());
