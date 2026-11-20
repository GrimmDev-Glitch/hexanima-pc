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
    "scenery", "field", "grass", "flower", "snow", "rain", "sunset", "ocean", "mountain", "classroom", "bedroom", "cityscape", "stage",
    "castle", "palace", "throne", "garden", "ruins", "temple", "church", "library", "cafe", "park", "bridge"],
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

  /** «cambia a Zelda por la princesa Peach», «reemplaza a X por Y», «conviértela en Y», «replace X with Y».
   *  Devuelve {from, to} o null. No cuenta si X o Y son ropa, pose, fondo… («cambia la ropa por la de la imagen 2»). */
  swap(t) {
    const s = t.replace(/\s+/g, " ").trim();
    const pats = [
      /\b(?:cambia(?:r)?|reemplaza(?:r)?|sustituye|sustituir|intercambia)\s+(?:a\s+)?(.+?)\s+por\s+(?:a\s+)?(.+)/i,
      /\b(?:convi[ée]rte(?:la|lo|los|las)?|transf[óo]rma(?:la|lo)?|haz(?:la|lo)?)\s+(?:a\s+(.+?)\s+)?en\s+(.+)/i,
      /\b(?:replace|swap|change)\s+(.+?)\s+(?:with|for|by|into)\s+(.+)/i,
      /\b(?:turn|transform|make)\s+(?:(.+?)\s+)?into\s+(.+)/i,
    ];
    for (const re of pats) {
      const m = s.match(re);
      if (!m) continue;
      const cut = (x) => (x || "").replace(/\s+(?:de|en|from|in)\s+(?:la\s+)?(?:imagen|image|foto|photo|picture)\s*\d?.*$/i, "")
        .replace(/\s*(?:,|\.|;|\s+pero\s|\s+but\s|\s+y que\s|\s+and keep\s|\s+manteniendo\s|\s+keeping\s).*$/i, "")
        .replace(/^(?:la|el|los|las|a|al|the|this|that|esta|este)\s+/i, "").trim();
      const from = cut(m[1]), to = cut(m[2]);
      const notChar = /ropa|vestid|traje|outfit|cloth|pose|postura|fondo|background|pelo|cabello|hair|expresi|expression|color|colou?r|cielo|sky/i;
      if (!to || notChar.test(to) || notChar.test(from)) return null;
      return { from, to };
    }
    return null;
  },

  clean(n) { return n.length <= 3 ? n : n.replace(/_/g, " "); },
  has(n, words) { const s = " " + n + " "; return words.some((w) => s.includes(" " + w + " ") || s.includes(" " + w + "s ")); },

  /** Etiquetas generales (sin clasificación) agrupadas por tipo, más fuertes primero. */
  groups(tags) {
    const g = { subject: null, chars: [], look: [], cloth: [], pose: [], bg: [], face: [] };
    for (const [name, , cat] of tags || []) {
      const n = this.clean(name);
      if (cat === 9) continue;
      if (this.SUBJECT[n] && !g.subject) { g.subject = this.SUBJECT[n]; continue; }
      if (cat === 4) { g.chars.push(n.replace(/\s*\(.*\)$/, "")); continue; } // personaje conocido (sin «(serie)»)
      if (/^(solo|general|sensitive|questionable|explicit|realistic|looking at viewer|simple background|white background)$/.test(n)) continue;
      if (CopyTags.isCloth(n)) g.cloth.push(n);
      else if (CopyTags.isPose(n)) g.pose.push(n);
      else if (this.has(n, this.FACE)) g.face.push(n);
      else if (this.has(n, this.BG)) g.bg.push(n);
      else if (this.has(n, this.LOOK)) g.look.push(n);
    }
    const tidy = (a, max) => { const o = a.slice(0, max * 2); return o.filter((x) => !o.some((y) => x !== y && y.includes(x))).slice(0, max); };
    return { subject: g.subject, chars: g.chars.slice(0, 2), look: tidy(g.look, 10), cloth: tidy(g.cloth, 16), pose: tidy(g.pose, 6), bg: tidy(g.bg, 6), face: tidy(g.face, 4) };
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

  /** Cambiar de personaje (Qwen / Mage): de la foto solo la composición; del personaje nuevo, todo su aspecto. */
  forSwap(sw, a, b) {
    const who = a?.subject || "character";
    const name = (x) => (x && x === x.toLowerCase() ? x.replace(/\p{L}/gu, (c) => c.toUpperCase()) : x);
    const generic = /^(chica|chico|mujer|hombre|ni[ñn]a|ni[ñn]o|personaje|persona|girl|boy|woman|man|character|person|her|him)$/i;
    const from = !sw.from || generic.test(sw.from) ? (a?.chars[0] ? name(a.chars[0]) : `the ${who}`) : name(sw.from);
    const to = name(sw.to);
    const out = [];
    let line = `Replace ${from} in the picture with ${to}`;
    if (b && (b.chars.length || b.look.length || b.cloth.length)) {
      const look = [...b.chars, ...b.look];
      line += `, who must look exactly like the character in the reference${look.length ? ` (${this.list(look)})` : ""}${b.cloth.length ? `, wearing ${this.list(b.cloth)}` : ""}`;
    } else {
      line += `, with ${to}'s own characteristic face, hairstyle, hair color, eye color, outfit and accessories`;
    }
    out.push(line + ".");
    const keep = [
      a?.pose.length ? `the same pose, body position and gesture (${this.list(a.pose)})` : "the same pose, body position and gesture",
      "the same framing, camera angle and position in the picture",
      a?.bg.length ? `the same background (${this.list(a.bg)})` : "the same background",
      "the same lighting, scene colors and art style",
    ];
    out.push(`Keep exactly from the original picture: ${keep.join("; ")}.`);
    // lo que no debe quedar de la persona original; nunca un rasgo que el personaje nuevo también tiene
    // (Zelda y Peach son rubias: «no blonde hair» la arruinaría). Sin imagen 2 no se sabe cómo es: pelo y ojos fuera.
    const shared = new Set(b ? [...b.look, ...b.cloth] : []);
    const old = a ? [...a.chars, ...a.look.filter((x) => b ? !shared.has(x) : !/hair|eyes|bangs|braid|ponytail|twintails|drill|sidelocks|ahoge|skin/.test(x)), ...a.cloth.filter((x) => !shared.has(x))].slice(0, 12) : [];
    out.push(`Do not keep anything of the original person's appearance${old.length ? ` (no ${this.list(old)})` : ""}: only ${to} should be in the picture.`);
    out.push("Natural anatomy and hands, clean details, high quality.");
    return out.join(" ");
  },

  /** Cambiar de personaje con etiquetas (SDXL / Illustrious / Anima): el personaje nuevo con la pose y el fondo de la foto. */
  forSwapTags(sw, a, b) {
    const t = [];
    if (a?.subject || b?.subject) t.push({ girl: "1girl", boy: "1boy" }[b?.subject || a?.subject] || "solo");
    t.push(sw.to.toLowerCase());
    if (b) t.push(...b.chars, ...b.look, ...b.cloth);
    if (a) t.push(...a.pose, ...a.bg);
    return [...new Set(t)].join(", ");
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
    if (!raw) { $("prompt").focus(); return toast(UiLanguage.text("Escribe primero qué quieres (por ejemplo «cambia la ropa de la imagen 1 por la de la imagen 2») y pulsa ✨ Detallar."), 6000); }
    const opt = currentOption(), edit = REF_FAMILIES.includes(opt?.family);
    const it = this.intents(raw);
    const img1 = state.editImage?.src || null, img2 = MageRefs.extra[0]?.src || null;
    if ((img1 || img2) && !(await downloadAssets(["tagger", "tagger_tags"], "✨ Detallar", UiLanguage.text("WD Tagger lee las imágenes para escribir los detalles (SmilingWolf, Apache-2.0).")))) return;
    setStatus(UiLanguage.text("✨ Detallando: leyendo las imágenes…"));
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
      // 3) el prompt: cambiar de personaje («cambia a X por Y») o cambiar algo del mismo personaje
      let sw = this.swap(instr) || this.swap(raw);
      if (sw && EsEn.isSpanish(sw.to) && !this.swap(instr)) sw.to = (await invoke("translate_text", { texts: [sw.to] }))[0] || sw.to;
      const text = sw ? (edit ? this.forSwap(sw, a, b) : this.forSwapTags(sw, a, b)) : edit ? this.forEdit(instr, it, a, b) : this.forTags(instr, it, a, b);
      const used = [];
      if (sw) used.push(UiLanguage.template`cambio de personaje: ${sw.from || UiLanguage.text("el de la foto")} → ${sw.to}`);
      if (!sw && b && (it.outfit || it.pose || it.background || it.hair || it.face)) used.push(UiLanguage.text("de la imagen 2: ") + [it.outfit && `${b.cloth.length} prendas`, it.pose && `${b.pose.length} rasgos de pose`, it.background && UiLanguage.text("el fondo"), it.hair && UiLanguage.text("el peinado"), it.face && UiLanguage.text("la expresión")].filter(Boolean).join(", "));
      if (a) used.push(UiLanguage.template`de la imagen 1: ${a.look.length} rasgos que se conservan`);
      if (instr !== raw) used.push(UiLanguage.text("tu pedido traducido al inglés"));
      setStatus("");
      this.show(text, used.join(" · "), edit && !!b);
      return text;
    } catch (e) { setStatus(""); toast(UiLanguage.text("No se pudo detallar: ") + (e.message || e), 7000); }
  },

  show(text, info, dropRefs) {
    $("detailOut").value = text;
    $("detailInfo").textContent = (info ? UiLanguage.text("Usé ") + info + ". " : "") + (dropRefs ? UiLanguage.text("Al usarlo se edita solo la imagen 1 (con dos referencias Qwen tiende a copiar la imagen 2): todo lo de la imagen 2 ya va escrito.") : UiLanguage.text("Revísalo y edítalo si quieres."));
    this.dropRefs = dropRefs;
    openModal("detailDlg");
    $("detailOut").focus();
  },

  use() {
    $("prompt").value = $("detailOut").value.trim();
    $("prompt").dispatchEvent(new Event("input"));
    if (this.dropRefs) { MageRefs.extra = []; MageRefs.render(); }
    closeModal("detailDlg");
    toast(UiLanguage.text("✨ Prompt detallado listo: genera cuando quieras"));
  },
};

$("detailBtn").onclick = () => Detail.open();
$("detailUse").onclick = () => Detail.use();
