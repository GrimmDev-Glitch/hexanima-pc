// HexAnima PC
//  · Personaje de referencia: tic dentro de «Editar una foto». Con él, la foto no es el punto de partida
//    (no hay img2img): el IP-Adapter (noobIPA Mark1, NoobAI / Illustrious) copia el aspecto del personaje
//    y el prompt decide el estilo, la pose y el lugar. Solo motor PyTorch y modelos SDXL.
//  · Prompt desde una imagen: WD Tagger v3, mismo diálogo y misma lógica que el teléfono (Tagger.java):
//    Etiquetas / Frase, Corto / Medio / Largo, «Solo el personaje», Copiar / Añadir / Usar.
"use strict";

// ---------- descargas de modelos auxiliares (con confirmación, progreso y reanudación) ----------
async function downloadAssets(kinds, title, msg, onText) {
  const assets = await invoke("asset_status");
  const missing = kinds.map((k) => assets.find((a) => a.kind === k)).filter((a) => a && !a.installed);
  if (!missing.length) return true;
  const mb = missing.reduce((n, a) => n + a.mb, 0);
  const size = mb >= 1024 ? (mb / 1024).toFixed(1).replace(".", ",") + " GB" : mb + " MB";
  const go = await ask({ title, msg: `${msg}\n\nDescarga: ${size}, una sola vez (si se corta, sigue donde se quedó).`,
    buttons: [{ label: "Cancelar", value: false }, { label: `Descargar (${size})`, value: true, primary: true }] });
  if (!go) return false;
  let base = 0;
  const total = mb * 1048576;
  const off = await window.__TAURI__.event.listen("dl-progress", (ev) => {
    const p = ev.payload;
    if (!missing.some((a) => p.id === "asset-" + a.kind)) return;
    const txt = `Descargando… ${Math.min(100, Math.round((100 * (base + p.done)) / total))} % · ${((base + p.done) / 1e9).toFixed(2).replace(".", ",")} de ${(total / 1e9).toFixed(1).replace(".", ",")} GB`;
    onText ? onText(txt) : setStatus(txt);
  });
  try {
    for (const a of missing) { await invoke("asset_download", { kind: a.kind }); base += a.mb * 1048576; }
    toast("✓ Descargado", 2500);
    return true;
  } catch (e) {
    toast("No se pudo descargar: " + (e.message || e), 6000);
    return false;
  } finally { off(); }
}

// ---------- Personaje de referencia ----------
const Ref = {
  supported(opt) { return state.engine === "torch" && opt?.family === "sdxl"; },
  on() { return !!state.editImage && $("refUse").checked; },

  async toggle() {
    const box = $("refUse");
    if (box.checked) {
      box.checked = false;
      if (!state.editImage) { toast("Primero elige la imagen del personaje (Elegir o ↳ Última imagen)", 4000); return this.render(); }
      if (!this.supported(currentOption())) { toast("La referencia funciona con el motor rápido (NVIDIA) y modelos SDXL, Illustrious o Pony", 5000); return this.render(); }
      box.checked = await downloadAssets(["ipadapter", "clip_vision"], "Personaje de referencia",
        "Necesita el IP-Adapter para NoobAI / Illustrious (noobIPA Mark1) y el codificador de imágenes CLIP ViT-bigG. La primera imagen con cada personaje tarda unos segundos más (se prepara una vez y se guarda).",
        (t) => { $("refInfo").textContent = t; });
    }
    this.render();
  },

  /** Añade la referencia a la petición si está activa (la foto ya no se manda como img2img). */
  apply(body, opt) {
    if (!this.on() || !this.supported(opt)) return false;
    body.ip_adapter = { image: state.editImage.src, weight: Number($("refWeight").value) };
    return true;
  },

  render() {
    const on = this.on();
    $("refBox").classList.toggle("hidden", !on);
    $("refWeightTxt").textContent = Number($("refWeight").value).toFixed(2).replace(".", ",");
    if (on && !this.supported(currentOption())) $("refInfo").textContent = "Este modelo o motor no admite referencia: se usará como imagen a imagen.";
    else if (on) $("refInfo").textContent = "Toma pelo, ojos, ropa y colores del personaje, no la pose ni el fondo. Escribe en el prompt el estilo, la pose o el lugar (por ejemplo: singing, holding sword).";
    setMode("edit");
    if (typeof Acc !== "undefined") Acc.summaries();
  },
};
$("refUse").onchange = () => Ref.toggle();
$("refWeight").oninput = () => { $("refWeightTxt").textContent = Number($("refWeight").value).toFixed(2).replace(".", ","); Acc?.summaries?.(); };

// ---------- Prompt desde una imagen (lógica de Tagger.java del teléfono) ----------
const TagText = {
  LOOK: ["hair", "eyes", "ears", "tail", "wings", "horns", "halo", "skin", "freckles", "mole", "fang", "pupils", "eyelashes", "eyebrows", "bangs", "ponytail", "twintails", "braid", "bun", "ahoge", "sidelocks",
    "dress", "shirt", "uniform", "skirt", "jacket", "coat", "kimono", "hoodie", "sweater", "pants", "jeans", "shorts", "swimsuit", "bikini", "armor", "suit", "bowtie", "bow", "ribbon", "hat", "gloves", "boots", "sneakers", "shoes",
    "thighhighs", "socks", "pantyhose", "scarf", "apron", "cape", "glasses", "necktie", "vest", "leotard", "sleeves", "collar", "earrings", "necklace", "choker", "hairband", "headband", "hairclip", "hair ornament", "crown", "mask",
    "belt", "robe", "cloak", "raincoat", "serafuku", "sailor", "headwear", "jewelry", "bracelet", "nail polish", "tattoo", "makeup", "lipstick", "elf", "animal", "cat", "fox", "wolf", "rabbit",
    "nude", "naked", "topless", "bottomless", "breasts", "nipples", "areolae", "pussy", "penis", "testicles", "pubic hair", "navel", "abs", "muscular", "thighs", "ass", "cleavage", "lingerie", "panties", "bra", "underwear",
    "curvy", "plump", "petite", "skinny", "toned", "tan", "tanlines", "piercing", "body", "chest", "capelet", "backpack", "bag", "hood"],
  NOT_LOOK: ["background", "looking", "smile", "open mouth", "closed mouth", "blush", "standing", "sitting", "lying", "walking", "full body", "upper body", "cowboy shot", "portrait", "close-up", "solo", "realistic", "shadow", "lips", "holding", "arms", "hand", "from ", "outdoors", "indoors"],
  SUBJECTS: ["1girl", "2girls", "3girls", "multiple girls", "1boy", "2boys", "multiple boys", "1other", "no humans"],
  FILLER: ["solo", "general", "sensitive", "questionable", "explicit", "simple background", "looking at viewer"],
  PLURAL: ["jeans", "pants", "shorts", "sneakers", "boots", "gloves", "thighhighs", "glasses", "shoes", "socks", "pantyhose"],

  clean(n) { return n.length <= 3 ? n : n.replace(/_/g, " "); },
  isLook(t) {
    if (t.category === 4) return true;
    const n = this.clean(t.name);
    if (this.SUBJECTS.includes(n)) return true;
    if (this.NOT_LOOK.some((x) => n.includes(x))) return false;
    return this.LOOK.some((x) => n === x || n.endsWith(" " + x) || n.startsWith(x + " ") || n.includes(" " + x + " "));
  },
  characterOnly(tags) { return tags.filter((t) => this.isLook(t)); },

  /** Etiquetas: corto = sujeto y las más fuertes (6), medio = hasta 14, largo = todas (hasta 40). Personajes primero. */
  tags(t, len) {
    const max = len === 0 ? 6 : len === 1 ? 14 : 40, out = [];
    for (const x of t) if (x.category === 4) out.push(this.clean(x.name));
    const all = t.filter((x) => x.category === 0).map((x) => this.clean(x.name));
    const drop = new Set();
    for (const a of all) for (const b of all) if (a !== b && b.endsWith(" " + a)) drop.add(a);   // «shirt» si está «white shirt»
    if (len !== 2) ["solo", "general", "simple background"].forEach((x) => drop.add(x));
    for (const n of all) { if (drop.has(n)) continue; if (out.length >= max) break; out.push(n); }
    return out.map((x) => x.replace(/([()])/g, "\\$1")).join(", ");
  },

  /** Frase sencilla: corto «A girl with long silver hair», medio añade ojos, ropa, expresión, pose y lugar; largo, el resto. */
  sentence(t, len) {
    const n = new Set(t.filter((x) => x.category === 0).map((x) => this.clean(x.name)));
    const chars = t.filter((x) => x.category === 4).map((x) => this.clean(x.name));
    let subj = n.has("no humans") ? "a scene" : n.has("2girls") ? "two girls" : n.has("3girls") ? "three girls" : n.has("multiple girls") ? "a group of girls"
      : n.has("2boys") ? "two boys" : n.has("multiple boys") ? "a group of boys" : n.has("1boy") && n.has("1girl") ? "a boy and a girl" : n.has("1boy") ? "a boy" : n.has("1girl") ? "a girl" : "a person";
    if (chars.length) subj = `${chars[0]} (${subj})`;
    const used = new Set([...this.SUBJECTS, ...this.FILLER]);
    let hairLen = null, hairCol = null;
    for (const x of n) if (["very long hair", "long hair", "medium hair", "short hair"].includes(x)) { if (!hairLen) hairLen = x; used.add(x); }
    for (const x of n) if (x.endsWith(" hair") && !/long|short|medium/.test(x) && !used.has(x)) { hairCol = x.slice(0, -5); used.add(x); break; }
    const hair = hairLen || hairCol ? `${hairLen ? hairLen.replace(" hair", "") + " " : ""}${hairCol ? hairCol + " " : ""}hair`.trim() : null;
    let s = subj[0].toUpperCase() + subj.slice(1);
    if (hair) s += " with " + hair;
    if (len === 0) return s + ".";
    let eyes = null;
    for (const x of n) if (x.endsWith(" eyes") && !used.has(x) && !x.startsWith("closed")) { eyes = x; used.add(x); break; }
    if (eyes) s += (hair ? " and " : " with ") + eyes;
    const cloth = ["dress", "shirt", "t-shirt", "uniform", "skirt", "jacket", "coat", "kimono", "hoodie", "sweater", "pants", "jeans", "shorts", "swimsuit", "bikini", "armor", "suit", "bowtie", "bow", "ribbon", "hat", "gloves", "boots", "sneakers", "thighhighs", "scarf", "apron", "cape", "capelet", "glasses", "necktie", "vest", "leotard", "choker"];
    let wear = [];
    for (const x of n) { if (used.has(x)) continue; if (cloth.some((c) => x === c || x.endsWith(" " + c))) { wear.push(x); used.add(x); } }
    wear = wear.filter((a) => !wear.some((b) => a !== b && b.endsWith(" " + a)));
    const wa = wear.slice(0, len === 1 ? 3 : wear.length).map((x) => this.article(x));
    if (wa.length) s += ", wearing " + this.list(wa);
    const nud = ["completely nude", "nude", "naked", "topless", "bottomless"].find((o) => n.has(o));
    if (nud) { used.add(nud); s += (wa.length ? " and " : ", ") + nud; }
    const body = ["huge breasts", "large breasts", "medium breasts", "small breasts", "flat chest", "nipples", "pussy", "penis", "pubic hair", "abs", "muscular", "curvy", "thick thighs", "wide hips", "cleavage", "navel"].filter((a) => n.has(a));
    body.forEach((a) => used.add(a));
    if (body.length) s += ", " + this.list(body.slice(0, len === 1 ? 4 : body.length));
    const acts = ["smile", "open mouth", "blush", "standing", "sitting", "lying", "walking", "running", "holding", "arms at sides", "hand up", "looking back", "from side", "full body", "upper body", "cowboy shot", "portrait", "close-up"].filter((a) => n.has(a));
    acts.forEach((a) => used.add(a));
    if (acts.length) s += ", " + this.list(acts.slice(0, len === 1 ? 2 : acts.length).map((a) => (a === "smile" ? "smiling" : a)));
    const places = ["outdoors", "indoors", "cherry blossoms", "sky", "night", "city", "beach", "forest", "classroom", "bedroom", "street", "water", "snow", "flower", "grey background", "white background", "black background", "gradient background"].filter((a) => n.has(a));
    places.forEach((a) => used.add(a));
    if (places.length) s += ", " + this.list(places.slice(0, len === 1 ? 2 : places.length));
    if (len === 2) { const rest = [...n].filter((x) => !used.has(x)).slice(0, 20); if (rest.length) s += ". Details: " + rest.join(", "); }
    return s + ".";
  },
  article(x) { return this.PLURAL.some((p) => x === p || x.endsWith(" " + p)) ? x : ("aeiou".includes(x[0]) ? "an " : "a ") + x; },
  list(l) { return l.length <= 1 ? (l[0] || "") : l.slice(0, -1).join(", ") + " and " + l[l.length - 1]; },
};

const PicPrompt = {
  tags: [], img: null,
  kind() { return store.get("tagSentence", false) ? "sentence" : "tags"; },
  len() { return store.get("tagLen", 1); },

  async open(src) {
    if (state.engine !== "torch") return toast("«Prompt desde una imagen» necesita el motor rápido (PyTorch, NVIDIA)", 5000);
    if (!(await downloadAssets(["tagger", "tagger_tags"], "Prompt desde una imagen",
      "Lee una imagen y escribe su prompt: etiquetas (1girl, silver hair…) o una frase. Usa WD ViT Tagger v3 de SmilingWolf (Apache-2.0), el mismo que el teléfono."))) return;
    src = src || (await pickImage());
    if (!src) return;
    this.img = src;
    setStatus("Leyendo la imagen…");
    try {
      const r = await api("/hexanima/v1/tag", { method: "POST", body: JSON.stringify({ image: src }) });
      this.tags = r.tags.filter((t) => t.category !== 9);
      $("picCount").textContent = `${this.tags.length} etiquetas en ${String(r.seconds).replace(".", ",")} s`;
      setStatus("");
    } catch (e) { return toast("No se pudo leer la imagen: " + (e.message || e), 6000); }
    $("picImg").src = src;
    $("picOnly").checked = store.get("tagCharOnly", false);
    this.paint();
    openModal("picDlg");
  },

  fill() {
    const use = $("picOnly").checked ? TagText.characterOnly(this.tags) : this.tags;
    $("picOut").value = this.kind() === "sentence" ? TagText.sentence(use, this.len()) : TagText.tags(use, this.len());
  },

  paint() {
    for (const b of $("picKind").children) b.classList.toggle("on", b.dataset.v === this.kind());
    for (const b of $("picLen").children) b.classList.toggle("on", Number(b.dataset.v) === this.len());
    this.fill();
  },
};
for (const b of $("picKind").children) b.onclick = () => { store.set("tagSentence", b.dataset.v === "sentence"); PicPrompt.paint(); };
for (const b of $("picLen").children) b.onclick = () => { store.set("tagLen", Number(b.dataset.v)); PicPrompt.paint(); };
$("picOnly").onchange = () => { store.set("tagCharOnly", $("picOnly").checked); PicPrompt.fill(); };
$("picOther").onclick = () => { closeModal("picDlg"); PicPrompt.open(); };
$("picCopy").onclick = async () => { try { await navigator.clipboard.writeText($("picOut").value); toast("Copiado", 1500); } catch { toast("No se pudo copiar", 2500); } };
$("picAdd").onclick = () => {
  const t = $("prompt"), add = $("picOut").value.trim();
  if (add) t.value = t.value.trim() ? t.value.replace(/[,\s]*$/, "") + ", " + add : add;
  t.dispatchEvent(new Event("input")); closeModal("picDlg");
};
$("picUse").onclick = () => { $("prompt").value = $("picOut").value.trim(); $("prompt").dispatchEvent(new Event("input")); closeModal("picDlg"); };
$("picPromptBtn").onclick = () => PicPrompt.open();
