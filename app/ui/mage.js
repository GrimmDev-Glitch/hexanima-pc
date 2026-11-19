// HexAnima PC: Mage-Flow Edit Turbo (Microsoft, MIT) — editar con una orden en frase y hasta 3 imágenes de
// referencia, como «Editar una foto (Qwen/Mage)» del teléfono. La foto de «Editar una foto» es la imagen 1;
// aquí se añaden la 2 y la 3. Se mandan al motor como ref_images (no es imagen a imagen).
"use strict";

/** Etiquetas de ropa y de pose de WD Tagger (las mismas listas que Tagger.java del teléfono). */
const CopyTags = {
  CLOTH: ["dress", "shirt", "t-shirt", "uniform", "skirt", "jacket", "coat", "kimono", "yukata", "hoodie", "sweater", "pants", "jeans", "shorts", "swimsuit", "bikini", "armor", "suit", "bowtie",
    "bow", "ribbon", "hat", "cap", "gloves", "boots", "sneakers", "shoes", "sandals", "heels", "thighhighs", "socks", "pantyhose", "leggings", "legwear", "scarf", "apron", "cape", "necktie", "vest", "leotard", "sleeves", "collar",
    "choker", "belt", "robe", "cloak", "serafuku", "sailor", "headwear", "lingerie", "panties", "bra", "underwear", "bodysuit", "corset", "top", "crop top", "tank top", "camisole", "blouse", "cardigan", "overalls", "frills",
    "lace", "polka dot", "striped", "plaid", "floral print", "print", "halterneck", "strapless", "string", "side-tie", "o-ring", "bikini top", "bikini bottom", "one-piece", "highleg", "maid", "nurse", "china dress", "gown", "off-shoulder", "trim", "halter", "bandeau", "ruffle", "straps", "ribbon trim", "lace trim"],
  POSE: ["standing", "sitting", "squatting", "kneeling", "lying", "crouching", "jumping", "walking", "running", "leaning", "bent over", "arm", "arms", "hand on", "hands on", "hand up", "hands up",
    "legs apart", "spread legs", "crossed legs", "legs up", "knees up", "knee up", "on back", "on stomach", "on side", "all fours", "from behind", "looking back", "head tilt", "v", "peace sign", "waving", "salute", "seiza",
    "wariza", "indian style", "contrapposto", "stretching", "outstretched", "spread arms", "hugging own legs", "fetal position", "one knee", "straddling", "reaching", "pointing", "hand in own hair", "hand on own head"],
  clean(n) { return n.length <= 3 ? n : n.replace(/_/g, " "); },
  has(n, words) { const s = " " + n + " "; return words.some((w) => s.includes(" " + w + " ")); },
  isCloth(n) { return !/ hair | eyes /.test(" " + n + " ") && this.has(n, this.CLOTH); },
  isPose(n) { return !/ armor |strap|sleeve|band |warmers|armlet/.test(" " + n + " ") && this.has(n, this.POSE); },
  /** tags: [[nombre, puntuación, categoría]] ordenadas por puntuación; categoría 0 = general */
  pick(tags, clothes, max) {
    const o = [];
    for (const [name, , cat] of tags) {
      const n = this.clean(name);
      if (cat !== 0 || n === "swimsuit" || !(clothes ? this.isCloth(n) : this.isPose(n))) continue;
      o.push(n); if (o.length >= max) break;
    }
    return o.filter((a) => !o.some((b) => a !== b && b.includes(a))); // «bikini» sobra si está «black bikini»
  },
};

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

  /** 👗 / 🧍 Copiar ropa o pose, como el teléfono: con las dos imágenes como referencia el modelo suele devolver la
   *  imagen 2 tal cual. En vez de eso, WD Tagger lee la imagen 2, sus etiquetas de ropa o de pose van a un prompt
   *  «cambia solo la ropa / la pose…» y se edita solo la foto 1, a tamaño completo. */
  async template(kind) {
    if (this.all().length < 2) return toast("Añade primero la imagen 2 con «＋ Otra imagen de referencia»", 3500);
    const clothes = kind === "outfit";
    if (!(await downloadAssets(["tagger", "tagger_tags"], clothes ? "👗 Copiar ropa" : "🧍 Copiar pose",
      "WD Tagger lee la imagen 2 y saca su " + (clothes ? "ropa" : "pose") + " para escribir el prompt (SmilingWolf, Apache-2.0)."))) return;
    setStatus("Leyendo la imagen 2…");
    let tags;
    try { tags = await invoke("image_tags", { image: this.extra[0].src, general: 0.25 }); }
    catch (e) { setStatus(""); return toast("No se pudo leer la imagen 2: " + (e.message || e), 7000); }
    const got = CopyTags.pick(tags, clothes, clothes ? 14 : 8);
    if (!got.length) { setStatus(""); return toast(clothes ? "No encontré ropa en la imagen 2" : "No encontré una pose clara en la imagen 2", 5000); }
    const list = got.join(", ");
    $("prompt").value = clothes
      ? `Change only the outfit of the person in the picture to: ${list}. Keep the face, hair, body, pose and background exactly the same.`
      : `Change only the pose of the person in the picture to: ${list}. Keep the face, hair, outfit and background exactly the same, with natural anatomy and hands.`;
    $("prompt").dispatchEvent(new Event("input"));
    this.extra = []; this.render(); // solo la foto 1, a tamaño completo
    setStatus(clothes ? "Listo: para no tocar la cara ni el fondo, pinta la ropa con «✎ Zona a cambiar» y genera." : "Listo: genera para cambiar la pose. Puedes retocar el prompt.", "ok");
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
