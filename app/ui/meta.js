// HexAnima PC: ⋯ → Leer metadatos de una imagen. Arrastra o elige un PNG, JPG o WebP y muestra lo que
// guardó el programa que la hizo: prompt, negativo, pasos, CFG, sampler, seed, tamaño, modelo y LoRAs.
// Entiende A1111 / Forge / sd.cpp / HexAnima («parameters»), ComfyUI (grafo «prompt»), NovelAI
// («Comment») e InvokeAI («invokeai_metadata»); en JPG y WebP lee el comentario EXIF (UserComment).
// «Usar estos ajustes» los pasa a Generar como «Usar ajustes» del Historial.
"use strict";

const Meta = {
  cur: null, // { src, name, fields, extra, raw, source }

  open() { this.show(null); openModal("metaDlg"); },

  // ---------- lectura de los bloques de texto ----------
  async texts(buf) {
    const b = new Uint8Array(buf), out = {};
    const latin = (a) => String.fromCharCode(...a);
    const utf8 = (a) => new TextDecoder("utf-8").decode(a);
    const inflate = async (a) => utf8(new Uint8Array(await new Response(new Blob([a]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer()));
    // PNG: tEXt / iTXt / zTXt
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      const dv = new DataView(buf);
      for (let p = 8; p + 8 <= b.length;) {
        const len = dv.getUint32(p), type = latin(b.subarray(p + 4, p + 8)), d = b.subarray(p + 8, p + 8 + len);
        const z = d.indexOf(0);
        try {
          if (type === "tEXt" && z > 0) out[latin(d.subarray(0, z))] = utf8(d.subarray(z + 1));
          else if (type === "zTXt" && z > 0) out[latin(d.subarray(0, z))] = await inflate(d.subarray(z + 2));
          else if (type === "iTXt" && z > 0) {
            const key = latin(d.subarray(0, z)), comp = d[z + 1];
            let q = z + 3; q = d.indexOf(0, q) + 1; q = d.indexOf(0, q) + 1; // idioma y clave traducida
            out[key] = comp ? await inflate(d.subarray(q)) : utf8(d.subarray(q));
          }
        } catch { /* bloque dañado: se ignora */ }
        if (type === "IEND") break;
        p += 12 + len;
      }
      return out;
    }
    // JPEG: EXIF (APP1) y comentario (COM)
    if (b[0] === 0xff && b[1] === 0xd8) {
      for (let p = 2; p + 4 < b.length;) {
        if (b[p] !== 0xff) break;
        const m = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
        if (m === 0xda) break; // empiezan los datos de la imagen
        const seg = b.subarray(p + 4, p + 2 + len);
        if (m === 0xe1 && latin(seg.subarray(0, 4)) === "Exif") Object.assign(out, this.exif(seg.subarray(6)));
        if (m === 0xfe) out.Comment = utf8(seg);
        p += 2 + len;
      }
      return out;
    }
    // WebP: bloque EXIF dentro del RIFF
    if (latin(b.subarray(0, 4)) === "RIFF" && latin(b.subarray(8, 12)) === "WEBP") {
      const dv = new DataView(buf);
      for (let p = 12; p + 8 <= b.length;) {
        const type = latin(b.subarray(p, p + 4)), len = dv.getUint32(p + 4, true), d = b.subarray(p + 8, p + 8 + len);
        if (type === "EXIF") Object.assign(out, this.exif(latin(d.subarray(0, 4)) === "Exif" ? d.subarray(6) : d));
        p += 8 + len + (len & 1);
      }
    }
    return out;
  },

  /** TIFF/EXIF: ImageDescription (0x010E), y UserComment (0x9286) dentro del IFD de EXIF. */
  exif(t) {
    const out = {};
    if (t.length < 8) return out;
    const le = t[0] === 0x49, dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
    const u16 = (o) => dv.getUint16(o, le), u32 = (o) => dv.getUint32(o, le);
    const ifd = (off, cb) => { if (off + 2 > t.length) return; const n = u16(off); for (let i = 0; i < n; i++) { const e = off + 2 + i * 12; if (e + 12 <= t.length) cb(u16(e), u32(e + 4), e + 8); } };
    const bytes = (cnt, at) => { const o = cnt > 4 ? u32(at) : at; return t.subarray(o, o + cnt); };
    ifd(u32(4), (tag, cnt, at) => {
      if (tag === 0x010e) out.ImageDescription = new TextDecoder().decode(bytes(cnt, at)).replace(/\0+$/, "");
      if (tag === 0x8769) ifd(u32(at), (t2, c2, a2) => {
        if (t2 !== 0x9286) return;
        const raw = bytes(c2, a2), head = String.fromCharCode(...raw.subarray(0, 8)), body = raw.subarray(8);
        let s;
        if (head.startsWith("UNICODE")) {
          // A1111 (piexif) lo escribe en UTF-16 big endian; algunos programas en little endian
          const be = new TextDecoder("utf-16be").decode(body), lit = new TextDecoder("utf-16le").decode(body);
          s = (be.match(/[\x20-\x7e\n]/g) || []).length >= (lit.match(/[\x20-\x7e\n]/g) || []).length ? be : lit;
        } else s = new TextDecoder().decode(body);
        out.UserComment = s.replace(/\0+$/, "");
      });
    });
    return out;
  },

  // ---------- interpretación ----------
  parse(tx) {
    const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const a1111 = tx.parameters || [tx.UserComment, tx.Comment, tx.ImageDescription].find((s) => s && /(^|\n)Steps: ?\d+/.test(s));
    if (a1111) return { source: tx.parameters ? "A1111 / Forge / HexAnima" : "A1111 (EXIF)", ...this.a1111(a1111), raw: a1111 };
    const comfy = json(tx.prompt);
    if (comfy && typeof comfy === "object" && Object.values(comfy).some((n) => n?.class_type)) return { source: "ComfyUI", ...this.comfy(comfy), raw: tx.prompt };
    const nai = json(tx.Comment);
    if (nai && (nai.prompt != null || nai.uc != null)) return { source: "NovelAI", fields: { prompt: nai.prompt, negative: nai.uc, steps: nai.steps, cfg: nai.scale, seed: nai.seed, sampler_label: nai.sampler, width: nai.width, height: nai.height }, extra: [], raw: tx.Comment };
    const inv = json(tx.invokeai_metadata);
    if (inv) return { source: "InvokeAI", fields: { prompt: inv.positive_prompt, negative: inv.negative_prompt, steps: inv.steps, cfg: inv.cfg_scale, seed: inv.seed, scheduler_label: inv.scheduler, width: inv.width, height: inv.height, model_label: inv.model?.name }, extra: [], raw: tx.invokeai_metadata };
    return null;
  },

  /** Texto estilo A1111: prompt, «Negative prompt: …» y la línea «Steps: 20, Sampler: …, Seed: …». */
  a1111(text) {
    const lines = text.replace(/\r/g, "").split("\n");
    let li = lines.length - 1;
    while (li >= 0 && !/^\s*Steps: ?\d+/.test(lines[li])) li--;
    const paramLine = li >= 0 ? lines.slice(li).join(", ") : "";
    const head = (li >= 0 ? lines.slice(0, li) : lines).join("\n");
    const ni = head.search(/(^|\n)Negative prompt:/);
    const prompt = (ni >= 0 ? head.slice(0, ni) : head).trim();
    const negative = ni >= 0 ? head.slice(ni).replace(/^\n?Negative prompt:\s*/, "").trim() : "";
    const kv = {};
    for (const m of paramLine.matchAll(/\s*([A-Za-z][\w \-/().]*?):\s*("(?:\\.|[^"])*"|[^,]*)(?:,|$)/g)) kv[m[1].trim()] = m[2].trim().replace(/^"|"$/g, "");
    const size = (kv.Size || "").match(/(\d+)\s*x\s*(\d+)/);
    const used = new Set(["Steps", "Sampler", "Schedule type", "CFG scale", "Seed", "Size", "Model", "Clip skip"]);
    return {
      fields: {
        prompt, negative, steps: +kv.Steps || null, cfg: kv["CFG scale"] != null ? +kv["CFG scale"] : null, seed: kv.Seed != null ? +kv.Seed : null,
        sampler_label: kv.Sampler, scheduler_label: kv["Schedule type"], clip_skip: kv["Clip skip"] ? +kv["Clip skip"] : null,
        width: size ? +size[1] : null, height: size ? +size[2] : null, model_label: kv.Model,
      },
      extra: Object.entries(kv).filter(([k]) => !used.has(k)),
    };
  },

  /** Grafo de ComfyUI (formato API): el primer sampler, sus textos positivo/negativo, modelo, LoRAs y tamaño. */
  comfy(g) {
    const node = (l) => (Array.isArray(l) ? g[l[0]] : null);
    const text = (l, depth = 0) => {
      if (typeof l === "string") return l;
      const n = node(l); if (!n || depth > 8) return "";
      const i = n.inputs || {};
      for (const k of ["text", "text_g", "value", "string", "prompt"]) if (i[k] != null) return text(i[k], depth + 1);
      for (const k of ["conditioning", "conditioning_1", "conditioning_to", "positive"]) if (i[k]) return text(i[k], depth + 1);
      return "";
    };
    const loras = [];
    const model = (l, depth = 0) => {
      const n = node(l); if (!n || depth > 12) return "";
      const i = n.inputs || {};
      if (i.lora_name) loras.push(`${i.lora_name} (${i.strength_model ?? i.strength ?? 1})`);
      if (i.ckpt_name || i.unet_name) return i.ckpt_name || i.unet_name;
      return model(i.model, depth + 1);
    };
    const sampler = Object.values(g).find((n) => /KSampler|SamplerCustom/i.test(n?.class_type || ""));
    const i = sampler?.inputs || {};
    const lat = node(i.latent_image)?.inputs || {};
    const num = (v) => (typeof v === "number" ? v : null);
    return {
      fields: {
        prompt: text(i.positive), negative: text(i.negative), steps: num(i.steps), cfg: num(i.cfg), seed: num(i.seed ?? i.noise_seed),
        sampler_label: typeof i.sampler_name === "string" ? i.sampler_name : null, scheduler_label: typeof i.scheduler === "string" ? i.scheduler : null,
        width: num(lat.width), height: num(lat.height), model_label: model(i.model) || null,
      },
      extra: loras.length ? [["LoRAs", loras.join(", ")]] : [],
    };
  },

  // ---------- pantalla ----------
  async load(file) {
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const res = this.parse(await this.texts(buf));
      const src = URL.createObjectURL(new Blob([buf], { type: file.type || "image/png" }));
      this.show(res ? { ...res, src, name: file.name } : { src, name: file.name, none: true });
    } catch (e) { toast(UiLanguage.text("No se pudo leer la imagen: ") + (e.message || e), 5000); }
  },

  show(r) {
    if (this.cur?.src) URL.revokeObjectURL(this.cur.src);
    this.cur = r;
    $("metaDrop").classList.toggle("hidden", !!r);
    $("metaRes").classList.toggle("hidden", !r);
    $("metaUse").disabled = !r || r.none;
    $("metaCopyAll").disabled = !r || r.none;
    if (!r) return;
    $("metaImg").src = r.src;
    $("metaName").textContent = r.name + (r.source ? ` · ${r.source}` : "");
    const box = $("metaFields"); box.innerHTML = "";
    if (r.none) { box.innerHTML = UiLanguage.text('<div class="lbl">Esta imagen no tiene ajustes guardados (prompt, pasos, seed…). Las redes sociales y algunos programas los borran al guardar o comprimir.</div>'); $("metaRaw").textContent = ""; return; }
    const f = r.fields, rows = [
      [UiLanguage.text("Pasos"), f.steps], ["CFG", f.cfg], ["Sampler", f.sampler_label || f.sampler], ["Scheduler", f.scheduler_label || f.scheduler],
      ["Seed", f.seed], [UiLanguage.text("Tamaño"), f.width && f.height ? `${f.width} × ${f.height}` : null], ["Clip skip", f.clip_skip], [UiLanguage.text("Modelo"), f.model_label], ...r.extra,
    ].filter(([, v]) => v != null && v !== "");
    const add = (label, value, copy) => {
      const d = document.createElement("div"); d.className = copy ? "meta-block" : "meta-row";
      const k = document.createElement("span"); k.className = "lbl"; k.textContent = label;
      const v = document.createElement(copy ? "div" : "span"); v.className = copy ? "meta-text" : "meta-val"; v.textContent = value;
      d.append(k);
      if (copy) { const b = document.createElement("button"); b.className = "link"; b.textContent = UiLanguage.text("Copiar"); b.onclick = async () => { await copyText(value); toast(label + " copiado"); }; k.append(" ", b); }
      d.append(v); box.append(d);
    };
    if (f.prompt) add("Prompt", f.prompt, true);
    if (f.negative) add(UiLanguage.text("Negativo"), f.negative, true);
    for (const [k, v] of rows) add(k, String(v));
    $("metaRaw").textContent = r.raw || "";
  },

  /** A Generar, con los mismos nombres de campo que guarda HexAnima. */
  use() {
    const f = this.cur?.fields; if (!f) return;
    History.useSettings({ meta: { ...f, sampler: this.sampler(f.sampler_label), scheduler: this.scheduler(f.scheduler_label, f.sampler_label) } });
    closeModal("metaDlg");
  },

  /** Nombres de A1111 / ComfyUI -> los del motor («Euler a» / euler_ancestral -> euler_a). */
  sampler(l) {
    if (!l) return null;
    const s = String(l).toLowerCase().replace(/\s*(karras|exponential|sgm uniform)$/, "").replace(/^k_/, "").replace(/^dpmpp_2s_a$/, "dpmpp_2s_ancestral").trim();
    const map = {
      "euler a": "euler_a", euler_ancestral: "euler_a", euler: "euler", heun: "heun", dpm2: "dpm2",
      "dpm++ 2s a": "dpm++2s_a", dpmpp_2s_ancestral: "dpm++2s_a", "dpm++ 2m": "dpm++2m", dpmpp_2m: "dpm++2m",
      "dpm++ 2m sde": "dpm++2m", dpmpp_2m_sde: "dpm++2m", lcm: "lcm", ddim: "ddim_trailing", ipndm: "ipndm", tcd: "tcd",
    };
    return map[s] || s;
  },
  scheduler(l, sampler) {
    const s = String(l || (/karras/i.test(sampler || "") ? "karras" : "")).toLowerCase();
    if (!s) return null;
    return { karras: "karras", exponential: "exponential", "sgm uniform": "sgm_uniform", sgm_uniform: "sgm_uniform", normal: "discrete", simple: "simple", "align your steps": "ays", automatic: null }[s] ?? s;
  },
};

$("metaPick").onclick = () => $("metaFile").click();
$("metaOther").onclick = () => $("metaFile").click();
$("metaFile").onchange = (e) => { Meta.load(e.target.files[0]); e.target.value = ""; };
$("metaUse").onclick = () => Meta.use();
$("metaCopyAll").onclick = async () => { if (Meta.cur?.raw) { await copyText(Meta.cur.raw); toast(UiLanguage.text("Metadatos copiados")); } };
for (const ev of ["dragover", "dragenter"]) $("metaDlg").addEventListener(ev, (e) => { e.preventDefault(); $("metaDlg").classList.add("dragging"); });
$("metaDlg").addEventListener("dragleave", (e) => { if (e.target === $("metaDlg")) $("metaDlg").classList.remove("dragging"); });
$("metaDlg").addEventListener("drop", (e) => { e.preventDefault(); $("metaDlg").classList.remove("dragging"); Meta.load(e.dataTransfer.files[0]); });
