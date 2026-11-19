// HexAnima PC: 🌐 ES→EN (encendido / apagado). Con él encendido se escribe el prompt y el negativo en español
// y se genera con su versión en inglés, que se ve en vivo debajo de cada cuadro. Solo se traducen los trozos
// en español: las etiquetas en inglés (1girl, masterpiece…), las LoRAs <lora:…>, los pesos (…:1.2), BREAK y
// los comodines {a|b} se dejan tal cual. Traduce sin internet (OPUS-MT, en el Python del motor rápido).
"use strict";

const EsEn = {
  KINDS: ["tr_config", "tr_generation_config", "tr_pytorch_model", "tr_source", "tr_target", "tr_tokenizer_config", "tr_vocab"],
  cache: new Map(),
  timer: null,

  on() { return store.get("esen", false); },

  // Etiquetas habituales que el traductor general dice de otra forma («mejor calidad» → «better quality»)
  GLOSS: {
    "mejor calidad": "best quality", "la mejor calidad": "best quality", "obra maestra": "masterpiece", "alta calidad": "high quality",
    "calidad alta": "high quality", "peor calidad": "worst quality", "la peor calidad": "worst quality", "baja calidad": "low quality",
    "calidad baja": "low quality", "muy estético": "very aesthetic", "muy estetico": "very aesthetic", "calidad increíble": "amazing quality",
    "manos mal dibujadas": "bad hands", "malas manos": "bad hands", "mala anatomía": "bad anatomy", "mala anatomia": "bad anatomy",
    "dedos de más": "extra digits", "dedos extra": "extra digits", "faltan dedos": "missing fingers", "borroso": "blurry",
    "marca de agua": "watermark", "firma": "signature", "texto": "text", "artefactos jpeg": "jpeg artifacts", "baja resolución": "lowres",
    "una chica": "1girl", "un chico": "1boy", "dos chicas": "2girls", "solo": "solo", "mirando al espectador": "looking at viewer",
    "sonriendo": "smile", "sonrisa": "smile", "boca abierta": "open mouth", "de pie": "standing", "sentada": "sitting", "sentado": "sitting",
  },
  // Palabras que delatan español en un trozo sin tildes
  WORDS: new Set(("de del la las el los un una unos unas y con sin en por para sobre bajo entre muy su sus al que es está esta este ese esa " +
    "chica chico mujer hombre niña niño pelo cabello ojos ojo cara boca mano manos brazo brazos pierna piernas vestido falda camisa " +
    "zapatos botas sombrero fondo ciudad noche día dia lluvia cielo mar playa bosque calle casa cuarto habitación sonriendo sonrisa " +
    "rojo roja azul verde amarillo amarilla negro negra blanco blanca rosa morado morada gris largo larga corto corta grande pequeño pequeña " +
    "mirando sentada sentado parada parado acostada caminando corriendo llorando enojada feliz triste gato perro flor flores luz sombra " +
    "calidad mejor peor alta baja estilo dibujo foto realista detallado detallada").split(" ")),

  isSpanish(seg) {
    const s = seg.toLowerCase().trim();
    if (!s) return false;
    if (this.GLOSS[s] && this.GLOSS[s] !== s) return true;
    if (/[áéíóúñü¿¡]/i.test(s)) return true;
    return s.split(/[^a-záéíóúñü]+/i).some((w) => this.WORDS.has(w));
  },

  /** Trozos del prompt: separados por comas y saltos de línea, conservando los separadores. */
  parts(text) { return text.split(/(,|\n)/); },

  /** Lo que hay que mandar al traductor de un trozo (sin LoRAs, pesos ni comodines), o null si no se traduce. */
  core(seg) {
    const t = seg.trim();
    if (!t || /^<lora:[^>]*>$/i.test(t) || /^BREAK$/.test(t) || /[{}|]/.test(t)) return null;
    const w = t.match(/^\((.+):\s*([\d.]+)\)$/);
    const inner = (w ? w[1] : t).replace(/<lora:[^>]*>/gi, "").trim();
    return inner && this.isSpanish(inner) ? inner.toLowerCase() : null;
  },

  fix(src, out) {
    let o = String(out || "").trim().replace(/[.。]+$/, "");
    if (src === src.toLowerCase()) o = o.toLowerCase();
    return o;
  },

  /** Vuelve a montar el texto con las traducciones en caché (lo que no está, queda en español). */
  build(text) {
    return this.parts(text).map((seg) => {
      const c = this.core(seg);
      if (!c) return seg;
      const tr = this.GLOSS[c] || this.cache.get(c);
      if (!tr) return seg;
      const lead = seg.match(/^\s*/)[0], tail = seg.match(/\s*$/)[0], t = seg.trim();
      const w = t.match(/^\((.+):\s*([\d.]+)\)$/);
      const loras = (w ? w[1] : t).match(/<lora:[^>]*>/gi) || [];
      const body = [tr, ...loras].join(" ");
      return lead + (w ? `(${body}:${w[2]})` : body) + tail;
    }).join("");
  },

  /** Traduce lo que falte en la caché. */
  async fill(texts) {
    const need = [...new Set(texts.flatMap((t) => this.parts(t).map((s) => this.core(s)).filter((c) => c && !this.GLOSS[c] && !this.cache.has(c))))];
    if (!need.length) return;
    const out = await invoke("translate_text", { texts: need });
    need.forEach((c, i) => this.cache.set(c, this.fix(c, out[i])));
  },

  /** Texto para generar: traducido si ES→EN está encendido. */
  async apply(text) {
    if (!this.on() || !text) return text;
    await this.fill([text]);
    return this.build(text);
  },

  async ensure() {
    return downloadAssets(this.KINDS, "🌐 ES→EN", "Traduce el prompt y el negativo de español a inglés sin internet, con OPUS-MT (Helsinki-NLP, Apache-2.0). Funciona con el Python del motor rápido (NVIDIA).");
  },

  async toggle() {
    if (!this.on()) {
      if (!(await this.ensure())) return;
      store.set("esen", true);
      setStatus("🌐 ES→EN encendido: abriendo el traductor (la primera vez tarda un poco)…");
    } else store.set("esen", false);
    this.render();
    this.preview(true);
  },

  /** Vista previa en inglés debajo de cada cuadro (al dejar de escribir). */
  preview(now) {
    clearTimeout(this.timer);
    if (!this.on()) { for (const id of ["promptEn", "negEn"]) $(id).classList.add("hidden"); return; }
    this.timer = setTimeout(async () => {
      const p = $("prompt").value, n = $("neg").value;
      try {
        await this.fill([p, n]);
        this.show("promptEn", p); this.show("negEn", n);
        if (/abriendo el traductor/.test($("modelStatus")?.textContent || "")) setStatus("🌐 ES→EN listo", "ok");
      } catch (e) {
        $("promptEn").textContent = "No se pudo traducir: " + (e.message || e);
        $("promptEn").classList.remove("hidden");
      }
    }, now ? 0 : 700);
  },

  show(id, text) {
    const en = this.build(text), changed = en !== text;
    $(id).classList.toggle("hidden", !changed);
    if (changed) $(id).textContent = "En inglés: " + en;
  },

  render() {
    const b = $("esenBtn"), on = this.on();
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? "ES→EN encendido: escribe en español y se genera en inglés (clic para apagar)" : "ES→EN apagado: el prompt se manda tal cual (clic para encender)";
  },
};

$("esenBtn").onclick = () => EsEn.toggle();
for (const id of ["prompt", "neg"]) $(id).addEventListener("input", () => EsEn.preview());
EsEn.render();
if (EsEn.on()) EsEn.preview(true);
