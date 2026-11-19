// HexAnima PC: ✨ Detallar. Escribes en pocas palabras lo que quieres («cambia la ropa de la imagen 1 por la de la
// imagen 2», en español o inglés) y se arma un prompt en inglés MUY específico con lo que de verdad hay en las
// imágenes: WD Tagger lee la imagen 1 (lo que hay que conservar: pelo, ojos, accesorios, pose, fondo) y la imagen 2
// (cada prenda con su color y estampado, o su pose, o su fondo). La petición se traduce con el traductor ES→EN.
// Se revisa y se puede editar antes de usarlo. Sin internet: el ayudante en la CPU (Python del motor rápido).
"use strict";

const Detail = {
  LOOK: ["hair", "eyes", "ears", "tail", "wings", "horns", "halo", "skin", "freckles", "mole", "fang", "pupils", "eyelashes", "eyebrows", "bangs", "ponytail",
    "twintails", "braid", "bun", "ahoge", "sidelocks", "drill", "glasses", "earrings", "necklace", "choker", "hairband", "headband", "hairclip", "hair ornament",
    "crown", "mask", "jewelry", "bracelet", "nail polish", "tattoo", "makeup", "lipstick", "elf", "animal ears", "cat ears", "fox ears", "breasts", "tan", "piercing"],
  BG: ["background", "sky", "outdoors", "indoors", "city", "street", "room", "forest", "beach", "night", "day", "cloud", "tree", "water", "building", "window",
    "scenery", "field", "grass", "flower", "snow", "rain", "sunset", "ocean", "mountain", "classroom", "bedroom", "cityscape", "stage"],
  FACE: ["smile", "blush", "open mouth", "closed mouth", "tongue", "grin", "crying", "tears", "angry", "wink", "teeth", "frown", "surprised", "expressionless", "happy", "sad"],
  SUBJECT: { "1girl": "girl", "1boy": "boy", "2girls": "two girls", "2boys": "two boys", "multiple girls": "girls", "multiple boys": "boys" },

  /** Qué pide el texto (español o inglés). */
  intents(t) {
    const s = t.toLowerCase();
    return {
      outfit: /ropa|vestimenta|vestid|traje|outfit|cloth|uniforme|disfraz|atuendo|prenda|bikini|falda|camisa/.test(s),
      pose: /pose|postura|posici[oó]n|sentad|parad|acostad|agachad/.test(s),
      background: /fondo|escenario|lugar|background|scene|paisaje/.test(s),
      hair: /pelo|cabello|peinado|hair/.test(s),
      face: /expresi|sonr|cara|smile|expression|face|llor|enojad/.test(s),
      image2: /imagen\s*2|image\s*2|segunda|second|referencia|reference/.test(s),
    };
  },

  clean(n) { return n.length <= 3 ? n : n.replace(/_/g, " "); },
  has(n, words) { const s = " " + n + " "; return words.some((w) => s.includes(" " + w + " ") || s.includes(" " + w + "s ")); },

  /** Etiquetas generales (sin clasificación) agrupadas por tipo, más fuertes primero. */
  groups(tags) {
    const g = { subject: null, look: [], cloth: [], pose: [], bg: [], face: [] };
    for (const [name, , cat] of tags || []) {
      const n = this.clean(name);
      if (cat === 9) continue;
      if (this.SUBJECT[n] && !g.subject) { g.subject = this.SUBJECT[n]; continue; }
      if (cat === 4) { g.look.unshift(n); continue; } // personaje conocido: va primero
      if (/^(solo|general|sensitive|questionable|explicit|realistic|looking at viewer|simple background|white background)$/.test(n)) continue;
      if (CopyTags.isCloth(n)) g.cloth.push(n);
      else if (CopyTags.isPose(n)) g.pose.push(n);
      else if (this.has(n, this.FACE)) g.face.push(n);
      else if (this.has(n, this.BG)) g.bg.push(n);
      else if (this.has(n, this.LOOK)) g.look.push(n);
    }
    const tidy = (a, max) => { const o = a.slice(0, max * 2); return o.filter((x) => !o.some((y) => x !== y && y.includes(x))).slice(0, max); };
    return { subject: g.subject, look: tidy(g.look, 10), cloth: tidy(g.cloth, 16), pose: tidy(g.pose, 6), bg: tidy(g.bg, 6), face: tidy(g.face, 4) };
  },

  list(a) { return a.join(", "); },

  /** Prompt detallado para editar (Qwen / Mage): una sola imagen, con todo escrito. */
  forEdit(instr, it, a, b) {
    const who = a?.subject || "character";
    const out = [];
    // con la imagen 2, el pedido («…de la imagen 2») confundiría al editar solo la imagen 1: va todo escrito abajo
    if (instr && !b) out.push(instr.replace(/\s*[.!]?\s*$/, "."));
    const changed = [];
    if (it.outfit && b?.cloth.length) { out.push(`Replace the outfit of the ${who} in the picture with exactly this outfit: ${this.list(b.cloth)}. Reproduce every garment faithfully, with the same colors, patterns, materials, trims and accessories.`); changed.push("outfit"); }
    if (it.pose && b?.pose.length) { out.push(`Change the pose of the ${who} to: ${this.list(b.pose)}.`); changed.push("pose"); }
    if (it.background && b?.bg.length) { out.push(`Change the background to: ${this.list(b.bg)}.`); changed.push("background"); }
    if (it.hair && b?.look.some((x) => /hair|bangs|braid|ponytail|twintails|drill/.test(x))) { out.push(`Change the hairstyle to: ${this.list(b.look.filter((x) => /hair|bangs|braid|ponytail|twintails|drill|sidelocks|ahoge/.test(x)))}.`); changed.push("hair"); }
    if (it.face && b?.face.length) { out.push(`Change the facial expression to: ${this.list(b.face)}.`); changed.push("face"); }
    if (a) {
      const keep = [];
      const look = it.hair ? a.look.filter((x) => !/hair|bangs|braid|ponytail|twintails|drill|sidelocks|ahoge/.test(x)) : a.look;
      if (look.length) keep.push(`the same identity and features (${this.list(look)})`);
      if (!changed.includes("face")) keep.push(a.face.length ? `the same face and expression (${this.list(a.face)})` : "the same face and expression");
      if (!changed.includes("outfit") && a.cloth.length) keep.push(`the same outfit (${this.list(a.cloth)})`);
      if (!changed.includes("pose")) keep.push(a.pose.length ? `the same pose (${this.list(a.pose)})` : "the same pose");
      if (!changed.includes("background")) keep.push(a.bg.length ? `the same background (${this.list(a.bg)})` : "the same background");
      keep.push("the same art style, lighting, framing and body proportions");
      out.push(`Keep exactly from the original picture: ${keep.join("; ")}.`);
    }
    if (changed.includes("outfit")) out.push("The new clothes must fit the body naturally, with realistic folds and seams.");
    out.push("Natural anatomy and hands, clean details, high quality.");
    return out.join(" ");
  },

  /** Para SDXL / Illustrious / Anima (etiquetas): sujeto, rasgos de la imagen 1 y lo pedido de la imagen 2. */
  forTags(instr, it, a, b) {
    const t = [];
    if (a?.subject || b?.subject) t.push({ girl: "1girl", boy: "1boy" }[a?.subject || b?.subject] || "solo");
    if (a) t.push(...(it.hair && b ? b.look : a.look));
    t.push(...((it.outfit && b?.cloth.length ? b : a)?.cloth || []));
    t.push(...((it.pose && b?.pose.length ? b : a)?.pose || []));
    t.push(...((it.face && b?.face.length ? b : a)?.face || []));
    t.push(...((it.background && b?.bg.length ? b : a)?.bg || []));
    if (instr && !a && !b) t.push(instr.replace(/[.!]+$/, ""));
    return [...new Set(t)].join(", ");
  },

  async open() {
    const raw = $("prompt").value.trim();
    if (!raw) { $("prompt").focus(); return toast("Escribe primero qué quieres (por ejemplo «cambia la ropa de la imagen 1 por la de la imagen 2») y pulsa ✨ Detallar.", 6000); }
    const opt = currentOption(), edit = REF_FAMILIES.includes(opt?.family);
    const it = this.intents(raw);
    const img1 = state.editImage?.src || null, img2 = MageRefs.extra[0]?.src || null;
    if ((img1 || img2) && !(await downloadAssets(["tagger", "tagger_tags"], "✨ Detallar", "WD Tagger lee las imágenes para escribir los detalles (SmilingWolf, Apache-2.0)."))) return;
    setStatus("✨ Detallando: leyendo las imágenes…");
    try {
      // 1) la petición en inglés (si está en español, con el traductor ES→EN)
      let instr = raw;
      if (EsEn.isSpanish(raw)) {
        if (!(await EsEn.ensure())) return setStatus("");
        instr = (await invoke("translate_text", { texts: [raw] }))[0] || raw;
      }
      // 2) qué hay en cada imagen
      const read = async (src) => (src ? this.groups(await invoke("image_tags", { image: src, general: 0.3 })) : null);
      const a = await read(img1), b = await read(img2);
      // 3) el prompt
      const text = edit ? this.forEdit(instr, it, a, b) : this.forTags(instr, it, a, b);
      const used = [];
      if (b && (it.outfit || it.pose || it.background || it.hair || it.face)) used.push("de la imagen 2: " + [it.outfit && `${b.cloth.length} prendas`, it.pose && `${b.pose.length} rasgos de pose`, it.background && "el fondo", it.hair && "el peinado", it.face && "la expresión"].filter(Boolean).join(", "));
      if (a) used.push(`de la imagen 1: ${a.look.length} rasgos que se conservan`);
      if (instr !== raw) used.push("tu pedido traducido al inglés");
      setStatus("");
      this.show(text, used.join(" · "), edit && !!b);
    } catch (e) { setStatus(""); toast("No se pudo detallar: " + (e.message || e), 7000); }
  },

  show(text, info, dropRefs) {
    $("detailOut").value = text;
    $("detailInfo").textContent = (info ? "Usé " + info + ". " : "") + (dropRefs ? "Al usarlo se edita solo la imagen 1 (con dos referencias Qwen tiende a copiar la imagen 2): todo lo de la imagen 2 ya va escrito." : "Revísalo y edítalo si quieres.");
    this.dropRefs = dropRefs;
    openModal("detailDlg");
    $("detailOut").focus();
  },

  use() {
    $("prompt").value = $("detailOut").value.trim();
    $("prompt").dispatchEvent(new Event("input"));
    if (this.dropRefs) { MageRefs.extra = []; MageRefs.render(); }
    closeModal("detailDlg");
    toast("✨ Prompt detallado listo: genera cuando quieras");
  },
};

$("detailBtn").onclick = () => Detail.open();
$("detailUse").onclick = () => Detail.use();
