// HexAnima PC: Mage-Flow Edit Turbo (Microsoft, MIT) — editar con una orden en frase y hasta 3 imágenes de
// referencia, como «Editar una foto (Qwen/Mage)» del teléfono. La foto de «Editar una foto» es la imagen 1;
// aquí se añaden la 2 y la 3. Se mandan al motor como ref_images (no es imagen a imagen).
"use strict";

const MageRefs = {
  MAX: 3,
  extra: [],   // [{src, w, h}] imágenes 2 y 3

  isMage() { return REF_FAMILIES.includes(currentOption()?.family); },
  name() { return currentOption()?.family === "qwen" ? "Qwen" : "Mage"; },

  all() { return [state.editImage, ...this.extra].filter(Boolean); },

  /** Añade las referencias a la petición. Devuelve cuántas (0 si no es Mage). */
  apply(body, opt) {
    if (!REF_FAMILIES.includes(opt?.family)) return 0;
    const refs = this.all();
    if (refs.length) body.ref_images = refs.map((r) => r.src);
    return refs.length;
  },

  async add() {
    if (!state.editImage) return toast("Primero elige la imagen 1 (Elegir o ↳ Última imagen)", 3500);
    if (this.all().length >= this.MAX) return toast(this.name() + " admite hasta 3 imágenes de referencia", 3000);
    const src = await pickImage();
    if (!src) return;
    try { this.extra.push(await prepareEditImage(src)); } catch (e) { return toast("No se pudo abrir la imagen: " + (e.message || e), 4000); }
    this.render();
  },

  template(kind) {
    if (this.all().length < 2) return toast("Añade primero la imagen 2 con «＋ Otra imagen de referencia»", 3500);
    const t = kind === "outfit"
      ? "the character from image 1 wearing the outfit from image 2, same face, hairstyle and colors as image 1"
      : "the character from image 1 in the same pose as the person in image 2, same face and outfit as image 1";
    $("prompt").value = t; $("prompt").dispatchEvent(new Event("input")); $("prompt").focus();
  },

  render() {
    const box = $("mageExtra");
    box.innerHTML = "";
    this.extra.forEach((r, i) => {
      const d = document.createElement("div"); d.className = "mage-ref";
      d.innerHTML = `<img alt="Imagen ${i + 2}"><span>${i + 2}</span><button title="Quitar" aria-label="Quitar imagen ${i + 2}">✕</button>`;
      d.querySelector("img").src = r.src;
      d.querySelector("button").onclick = () => { this.extra.splice(i, 1); this.render(); };
      box.appendChild(d);
    });
    $("mageAdd").disabled = !state.editImage || this.all().length >= this.MAX;
    if (this.isMage()) {
      $("editHint").textContent = state.editImage
        ? `${this.name()}: ${this.all().length === 1 ? "1 imagen" : this.all().length + " imágenes"} de referencia. Escribe lo que quieres en una frase (en inglés va mejor): «the character from image 1 singing on a stage, holding a sword».`
        : `${this.name()} edita con una orden en frase. Elige la imagen 1 (o genera sin imágenes, desde cero).`;
    }
  },
};

$("mageAdd").onclick = () => MageRefs.add();
$("mageOutfit").onclick = () => MageRefs.template("outfit");
$("magePose").onclick = () => MageRefs.template("pose");
$("editClear").addEventListener("click", () => { MageRefs.extra = []; MageRefs.render(); });
$("model").addEventListener("change", () => { setMode(state.editImage ? "edit" : "gen"); MageRefs.render(); });
setInterval(() => { if (MageRefs.isMage()) MageRefs.render(); }, 2000);
