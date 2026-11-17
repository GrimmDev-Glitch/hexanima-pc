// HexAnima PC: interfaz. Habla con el motor local (sd-server.exe en 127.0.0.1); no usa internet.
"use strict";

const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const state = {
  api: null,          // "http://127.0.0.1:<puerto>"
  hw: null,
  options: [],        // modelos que se pueden cargar
  loaded: null,       // id de la opcion cargada
  aspect: "p",
  loras: [],          // disponibles: [{name, path}]
  active: [],         // activas: [{name, path, mult}]
  job: null,
  stop: false,
  busy: false,
  batchTarget: 0,
  outputFiles: [],
  activeHistory: null,
  currentImage: null,
  editImage: null,    // {src, w, h}
  mode: "gen",        // gen | edit
  upscaler: null,
};

// ---------- utilidades ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem("hx." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("hx." + k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
function savedList(key) { const v = store.get(key, []); return Array.isArray(v) ? v : []; }
function fillPromptLists() {
  const templates = savedList("templates");
  const pick = $("templatePick");
  pick.innerHTML = '<option value="">Plantillas</option>';
  templates.forEach((t, i) => pick.add(new Option(t.name, String(i))));
  $("deleteTemplate").disabled = true;
  const recent = $("recentPick");
  recent.innerHTML = '<option value="">Recientes</option>';
  savedList("recentPrompts").forEach((p, i) => recent.add(new Option(p.prompt.slice(0, 64) || "Prompt vacío", String(i))));
}
function rememberPrompt(prompt, negative) {
  const items = savedList("recentPrompts").filter((p) => p.prompt !== prompt);
  items.unshift({ prompt, negative });
  store.set("recentPrompts", items.slice(0, 20));
  fillPromptLists();
}
function updatePromptMeta() {
  const p = $("prompt").value;
  const tags = p.split(",").filter((x) => x.trim()).length;
  const wildcards = [...p.matchAll(/\{[^{}]+\|[^{}]+\}/g)].length;
  $("promptMeta").textContent = p.length ? `${tags} etiquetas${wildcards ? ` · ${wildcards} comodín${wildcards > 1 ? "es" : ""}` : ""}` : "";
}
function expandWildcards(prompt) {
  return prompt.replace(/\{([^{}]+)\}/g, (full, choices) => {
    const options = choices.split("|").map((x) => x.trim()).filter(Boolean);
    return options.length > 1 ? options[Math.floor(Math.random() * options.length)] : full;
  });
}
function adjustPromptWeight(delta) {
  const p = $("prompt"), start = p.selectionStart, end = p.selectionEnd;
  if (start === end) { p.focus(); return; }
  const selected = p.value.slice(start, end);
  const match = selected.match(/^\((.*?):([\d.]+)\)$/);
  const text = match ? match[1] : selected;
  const weight = Math.max(0.1, Math.min(2, (match ? +match[2] : 1) + delta));
  const replacement = `(${text}:${weight.toFixed(1)})`;
  p.setRangeText(replacement, start, end, "select");
  p.focus(); updatePromptMeta();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtS = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
const gb = (x) => (x == null ? "—" : x.toFixed(1).replace(".", ","));

async function api(path, opts = {}) {
  const r = await fetch(state.api + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const e = new Error(body.error || body.message || `HTTP ${r.status}`);
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

function setStatus(text, kind = "") {
  const el = $("modelStatus");
  el.textContent = text;
  el.className = "status " + kind;
}

// ---------- perfiles y tamaños ----------
const FAMILY = {
  anima: { steps: 8, cfg: 1, sampler: "euler", scheduler: "discrete", neg: "", chips: ["masterpiece", "best quality", "highres", "detailed eyes"] },
  anima_base: { steps: 20, cfg: 4, sampler: "dpm++2m", scheduler: "sgm_uniform", neg: "worst quality, low quality, blurry", chips: ["masterpiece", "best quality", "highres"] },
  sdxl: {
    steps: 28, cfg: 5.5, sampler: "euler_a", scheduler: "discrete",
    neg: "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digits, blurry, jpeg artifacts, watermark, signature",
    chips: ["masterpiece", "best quality", "amazing quality", "very aesthetic", "absurdres"],
  },
};
const ASPECT = { p: [832, 1216], s: [1024, 1024], l: [1216, 832] };

function maxSide(family) {
  const p = state.hw?.profile || "medio";
  if (p === "bajo") return 768;
  if (p === "alto") return 1536;
  return family === "sdxl" ? 1216 : 1024; // medio
}

const align64 = (n) => Math.min(2048, Math.max(256, Math.round((+n || 0) / 64) * 64));

function currentSize() {
  // Personalizado: se respeta lo que elige la persona (múltiplos de 64, 256–2048), sin recortar al perfil.
  if (state.aspect === "c") return [align64($("customW").value), align64($("customH").value)];
  const opt = currentOption();
  const fam = opt?.family || "sdxl";
  let [w, h] = ASPECT[state.aspect];
  const ms = maxSide(fam);
  if (Math.max(w, h) > ms) { const k = ms / Math.max(w, h); w *= k; h *= k; }
  return [Math.max(256, Math.floor(w / 64) * 64), Math.max(256, Math.floor(h / 64) * 64)];
}

function updateSizeTxt() {
  const [w, h] = currentSize();
  const ms = maxSide(currentOption()?.family);
  const over = state.aspect === "c" && Math.max(w, h) > ms;
  $("customSize").classList.toggle("hidden", state.aspect !== "c");
  $("sizeTxt").className = "lbl" + (over ? " warn" : "");
  $("sizeTxt").textContent = over
    ? `${w} × ${h} · supera el máximo recomendado (${ms} px): tardará más y puede quedarse sin memoria`
    : `${w} × ${h}${state.aspect === "c" ? " · múltiplos de 64" : ""} · máximo del perfil ${ms} px`;
}

function onCustomSize(commit) {
  if (commit) {
    $("customW").value = align64($("customW").value);
    $("customH").value = align64($("customH").value);
  }
  store.set("customSize", [align64($("customW").value), align64($("customH").value)]);
  updateSizeTxt(); showEstimate();
}
$("customW").oninput = () => onCustomSize(false);
$("customH").oninput = () => onCustomSize(false);
$("customW").onchange = () => onCustomSize(true);
$("customH").onchange = () => onCustomSize(true);
$("swapSize").onclick = () => {
  const w = $("customW").value;
  $("customW").value = $("customH").value; $("customH").value = w;
  onCustomSize(true);
};

// ---------- hardware ----------
function renderHw(hw) {
  const g = hw.gpu;
  $("hwName").textContent = g ? `${g.name.replace("NVIDIA GeForce ", "")}${g.vram_gb ? " · " + gb(g.vram_gb) + " GB" : ""}` : "Sin GPU compatible";
  const prof = { bajo: "Bajo", medio: "Medio", alto: "Alto" }[hw.profile] || hw.profile;
  $("hwProfile").textContent = `Perfil: ${prof} · ${hw.engine.toUpperCase()}${hw.backend_device ? " (" + hw.backend_device + ")" : ""}`;
  $("setInfo").textContent = `Gráfica: ${g ? g.name : "ninguna"} · RAM ${gb(hw.ram_gb)} GB · motor ${hw.engine} · dispositivo ${hw.backend_device || "auto"} · perfil ${hw.profile}`;
}

async function refreshMemory() {
  try {
    const m = await invoke("memory");
    if (m.vram_total_gb) {
      const used = m.vram_total_gb - (m.vram_free_gb ?? 0);
      $("vramTxt").textContent = `${gb(used)} / ${gb(m.vram_total_gb)} GB`;
      $("vramBar").style.width = `${Math.min(100, (used / m.vram_total_gb) * 100)}%`;
    }
    const ru = m.ram_total_gb - m.ram_free_gb;
    $("ramTxt").textContent = `${gb(ru)} / ${gb(m.ram_total_gb)} GB`;
    $("ramBar").style.width = `${Math.min(100, (ru / m.ram_total_gb) * 100)}%`;
    $("tempTxt").textContent = m.gpu_temp_c != null ? `GPU ${m.gpu_temp_c} °C` : "";
    return m;
  } catch { return null; }
}

// ---------- motor ----------
async function startEngine() {
  setStatus("Iniciando motor…");
  const opts = { offload_to_cpu: store.get("offload", true), extra_args: store.get("extra", "") || null };
  const port = await invoke("start_server", { opts });
  state.api = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    try { await api("/sdcpp/v1/models/status"); return true; } catch { /* aun arrancando */ }
    const s = await invoke("server_status");
    if (!s.running) {
      $("serverLog").textContent = s.log || "";
      setStatus("El motor se cerró al iniciar. Revisa Ajustes → Registro del motor.", "err");
      return false;
    }
    await sleep(400);
  }
  setStatus("El motor no responde.", "err");
  return false;
}

// ---------- modelos ----------
function currentOption() {
  return state.options.find((o) => o.id === $("model").value);
}

async function scanModels() {
  const { files } = await api("/sdcpp/v1/model-files");
  const by = (cat, re) => files.filter((f) => f.category === cat && (!re || re.test(f.name)));
  const opts = [];
  for (const f of by("checkpoints")) {
    opts.push({ id: "ckpt:" + f.id, label: f.name.replace(/\.(safetensors|gguf|ckpt)$/i, "") + " · SDXL", family: "sdxl", recipe: "sdxl-checkpoint", models: { model: f.id } });
  }
  const llm = by("text_encoders", /qwen[_-]?3/i)[0];
  const vae = by("vae", /qwen[_-]?image/i)[0];
  for (const f of by("diffusion_models", /anima/i)) {
    if (!llm || !vae) continue;
    const turbo = /turbo/i.test(f.name);
    opts.push({
      id: "anima:" + f.id, label: f.name.replace(/\.(safetensors|gguf)$/i, "") + " · Anima",
      family: "anima", preset: turbo ? "anima" : "anima_base", recipe: "anima",
      models: { diffusion_model: f.id, llm: llm.id, vae: vae.id },
    });
  }
  state.options = opts;
  const sel = $("model");
  sel.innerHTML = "";
  for (const o of opts) sel.add(new Option(o.label, o.id));
  if (!opts.length) {
    sel.add(new Option("No hay modelos", ""));
    setStatus("Copia un checkpoint SDXL a models\\checkpoints o descarga Anima.", "warn");
    return;
  }
  const last = store.get("model", null);
  if (last && opts.some((o) => o.id === last)) sel.value = last;
}

function applyPreset(opt) {
  const p = FAMILY[opt.preset || opt.family];
  const saved = store.get("params:" + opt.id, null);
  const v = saved || p;
  $("steps").value = v.steps; $("cfg").value = v.cfg;
  $("sampler").value = v.sampler; $("scheduler").value = v.scheduler;
  if (!$("sampler").value && $("sampler").options.length) $("sampler").selectedIndex = 0;
  if (!$("scheduler").value && $("scheduler").options.length) $("scheduler").selectedIndex = 0;
  if (!$("neg").value || !saved) $("neg").value = saved?.neg ?? p.neg;
  $("chips").innerHTML = "";
  for (const c of p.chips) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = c;
    b.onclick = () => { const t = $("prompt"); t.value = t.value.trim() ? t.value.replace(/[,\s]*$/, "") + ", " + c : c; t.focus(); };
    $("chips").appendChild(b);
  }
  syncLabels(); updateSizeTxt(); showEstimate();
}

async function loadModel() {
  const opt = currentOption();
  if (!opt || state.busy) return;
  state.busy = true;
  $("genBtn").disabled = true; $("loadBtn").disabled = true;
  store.set("model", opt.id);
  applyPreset(opt);
  const t0 = Date.now();
  const tick = setInterval(() => setStatus(`Cargando ${opt.label}… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
  try {
    await api("/sdcpp/v1/models/load", { method: "POST", body: JSON.stringify({ recipe: opt.recipe, models: opt.models }) });
    state.loaded = opt.id;
    setStatus(`Listo · ${opt.label} (${Math.round((Date.now() - t0) / 1000)} s)`, "ok");
  } catch (e) {
    state.loaded = null;
    const s = await invoke("server_status");
    $("serverLog").textContent = s.log || "";
    setStatus(`No se pudo cargar: ${e.message}`, "err");
  } finally {
    clearInterval(tick);
    state.busy = false;
    $("loadBtn").disabled = false;
    $("genBtn").disabled = state.loaded !== opt.id;
  }
}

// ---------- LoRAs ----------
async function scanLoras() {
  try { state.loras = await api("/sdapi/v1/loras"); } catch { state.loras = []; }
  const lib = $("loraLib");
  lib.innerHTML = state.loras.length ? "" : '<div class="lbl">No hay LoRAs en la carpeta loras.</div>';
  for (const l of state.loras) {
    const d = document.createElement("div");
    d.className = "lora";
    d.innerHTML = `<div class="row"><span class="name"></span><button class="link">Usar</button></div>`;
    d.querySelector(".name").textContent = l.name;
    d.querySelector("button").onclick = () => { addLora(l); document.querySelector('.nav[data-page="gen"]').click(); };
    lib.appendChild(d);
  }
  filterLoraLibrary();
  state.active = state.active.filter((a) => state.loras.some((l) => l.path === a.path));
  renderActive();
}

function filterLoraLibrary() {
  const q = ($("loraSearch")?.value || "").trim().toLocaleLowerCase();
  for (const item of $("loraLib").children) {
    item.hidden = !!q && !item.textContent.toLocaleLowerCase().includes(q);
  }
}

// Nombres legibles (el valor que se envía al motor no cambia).
const SAMPLER_NAMES = {
  euler: "Euler", euler_a: "Euler a", heun: "Heun", dpm2: "DPM2", "dpm++2s_a": "DPM++ 2S a", "dpm++2m": "DPM++ 2M",
  "dpm++2mv2": "DPM++ 2M v2", ipndm: "iPNDM", ipndm_v: "iPNDM v", lcm: "LCM", ddim_trailing: "DDIM trailing", tcd: "TCD",
  res_multistep: "RES multistep", res_2s: "RES 2S", er_sde: "ER-SDE", euler_cfg_pp: "Euler CFG++", euler_a_cfg_pp: "Euler a CFG++",
  euler_ge: "Euler GE", "dpm++2m_sde": "DPM++ 2M SDE", "dpm++2m_sde_bt": "DPM++ 2M SDE BT", lms: "LMS",
};
const SCHEDULER_NAMES = {
  discrete: "Discreto", normal: "Normal", karras: "Karras", exponential: "Exponencial", ays: "AYS", gits: "GITS",
  sgm_uniform: "SGM Uniform", simple: "Simple", smoothstep: "Smoothstep", kl_optimal: "KL óptimo", lcm: "LCM",
  bong_tangent: "Bong tangent", beta: "Beta", logit_normal: "Logit normal",
};
function prettyName(n, map) { return map[n] || n.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()); }

async function refreshEngineMenus() {
  const [samplers, schedulers, upscalers] = await Promise.all([
    api("/sdapi/v1/samplers").catch(() => null),
    api("/sdapi/v1/schedulers").catch(() => null),
    api("/sdapi/v1/upscalers").catch(() => null),
  ]);
  // "Ampliar" necesita un modelo ESRGAN en models\upscalers; sin él el botón no aparece.
  state.upscaler = Array.isArray(upscalers) ? upscalers.find((u) => u.model_path)?.name || null : null;
  $("upscaleBtn").classList.toggle("hidden", !state.upscaler);
  if (state.upscaler) $("upscaleBtn").textContent = `Ampliar ×${upscalers.find((u) => u.name === state.upscaler).scale || 4}`;
  if (Array.isArray(samplers) && samplers.length) {
    const select = $("sampler"), selected = select.value;
    select.innerHTML = "";
    for (const s of samplers) if (s.name !== "default") select.add(new Option(prettyName(s.name, SAMPLER_NAMES), s.name));
    if (samplers.some((s) => s.name === selected)) select.value = selected;
  }
  if (Array.isArray(schedulers) && schedulers.length) {
    const select = $("scheduler"), selected = select.value;
    select.innerHTML = "";
    for (const s of schedulers) {
      const n = s.name || s.label;
      if (n !== "default") select.add(new Option(prettyName(n, SCHEDULER_NAMES), n));
    }
    if (schedulers.some((s) => (s.name || s.label) === selected)) select.value = selected;
  }
}

function addLora(l) {
  if (!state.active.some((a) => a.path === l.path)) state.active.push({ name: l.name, path: l.path, mult: 0.8 });
  renderActive();
}

function renderActive() {
  const list = $("loraList");
  list.innerHTML = "";
  for (const a of state.active) {
    const d = document.createElement("div");
    d.className = "lora";
    d.innerHTML = `<div class="row"><span class="name"></span><span><span class="lbl v"></span><button class="x" aria-label="Quitar">×</button></span></div>
      <input type="range" min="0" max="2" step="0.05">`;
    d.querySelector(".name").textContent = a.name;
    const r = d.querySelector("input"); r.value = a.mult; r.setAttribute("aria-label", "Fuerza de " + a.name);
    const v = d.querySelector(".v"); v.textContent = a.mult.toFixed(2);
    r.oninput = () => { a.mult = +r.value; v.textContent = a.mult.toFixed(2); store.set("active", state.active); };
    d.querySelector(".x").onclick = () => { state.active = state.active.filter((x) => x !== a); renderActive(); };
    list.appendChild(d);
  }
  store.set("active", state.active);
}

$("addLora").onclick = () => {
  const pick = $("loraPick");
  const avail = state.loras.filter((l) => !state.active.some((a) => a.path === l.path));
  pick.innerHTML = "";
  pick.add(new Option(avail.length ? "Elige un LoRA…" : "No hay más LoRAs", ""));
  for (const l of avail) pick.add(new Option(l.name, l.path));
  pick.classList.toggle("hidden");
  pick.onchange = () => {
    const l = state.loras.find((x) => x.path === pick.value);
    if (l) addLora(l);
    pick.classList.add("hidden");
  };
};

// ---------- generar ----------
const STAGE = {
  queued: "En cola", waiting: "Esperando", preparing: "Preparando", conditioning: "Leyendo el prompt",
  sampling: "Generando", vae_decode: "Decodificando imagen", vae_encode: "Codificando imagen",
  upscaling: "Ampliando", adetailer: "Corrigiendo detalles", encoding: "Guardando",
};

function showEstimate() {
  const opt = currentOption();
  const b = opt && store.get("bench:" + opt.id + ":" + currentSize().join("x"), null);
  $("estimate").textContent = b ? `~${fmtS(b.fixed + b.step * +$("steps").value)} estimados con tu equipo` : "";
}

async function waitIfHot() {
  let m = await refreshMemory();
  if (!m || m.gpu_temp_c == null || m.gpu_temp_c < 83) return;
  const t0 = Date.now();
  while (!state.stop && Date.now() - t0 < 600000) {
    $("progStage").textContent = `GPU a ${m.gpu_temp_c} °C: pausa para enfriar…`;
    await sleep(5000);
    m = await refreshMemory();
    if (!m || m.gpu_temp_c == null || m.gpu_temp_c <= 72) break;
  }
}

async function runOne(opt, seed) {
  const editing = state.mode === "edit" && state.editImage;
  // Al editar, el tamaño es el de la foto (ya ajustado a múltiplos de 64 al elegirla).
  const [w, h] = editing ? [state.editImage.w, state.editImage.h] : currentSize();
  const steps = +$("steps").value;
  const body = {
    ...(editing ? { init_image: state.editImage.src, strength: +$("editStrength").value } : {}),
    prompt: expandWildcards($("prompt").value.trim()),
    negative_prompt: $("neg").value.trim(),
    clip_skip: +$("clipskip").value,
    width: w, height: h, seed, batch_count: 1,
    sample_params: {
      scheduler: $("scheduler").value, sample_method: $("sampler").value, sample_steps: steps,
      guidance: { txt_cfg: +$("cfg").value },
    },
    lora: state.active.map((a) => ({ path: a.path, multiplier: a.mult, is_high_noise: false })),
    // Vulkan y el perfil bajo: VAE por mosaicos (sin ellos el primer intento puede fallar por memoria)
    vae_tiling_params: { enabled: state.hw.engine !== "cuda" || state.hw.profile === "bajo" },
    preview: "proj", preview_interval: 1,
    output_format: "png", embed_image_metadata: true,
  };
  const sub = await api("/sdcpp/v1/img_gen", { method: "POST", body: JSON.stringify(body) });
  state.job = sub.id;
  let sampStart = null, sampMs = 0;
  for (;;) {
    await sleep(400);
    const j = await api("/sdcpp/v1/jobs/" + sub.id);
    const p = j.progress || {};
    const st = STAGE[p.stage] || p.stage || "Trabajando";
    const cnt = p.unit === "steps" && p.total ? ` ${p.completed}/${p.total}` : "";
    $("progStage").textContent = st + cnt;
    $("progTime").textContent = fmtS((p.elapsed_ms || 0) / 1000);
    $("progBar").style.width = p.total ? `${(100 * (p.completed || 0)) / p.total}%` : "0%";
    if (p.stage === "sampling" && sampStart == null) sampStart = p.elapsed_ms;
    if (p.stage !== "sampling" && sampStart != null && !sampMs) sampMs = p.elapsed_ms - sampStart;
    if (j.preview?.b64_json && p.stage === "sampling") showImage("data:image/png;base64," + j.preview.b64_json, false);
    if (j.status === "completed") {
      const img = j.result.images[0].b64_json;
      showImage("data:image/png;base64," + img);
      const total = (j.completed - j.started) / 1000;
      if (sampMs) store.set("bench:" + opt.id + ":" + w + "x" + h, { step: sampMs / 1000 / steps, fixed: total - sampMs / 1000 });
      const path = await invoke("save_image", { b64: img, prefix: editing ? "edit" : opt.family });
      return { total, path };
    }
    if (j.status === "failed") throw new Error(j.error?.message || "falló la generación");
    if (j.status === "cancelled") return null;
  }
}

function showImage(src, final = true) {
  $("result").src = src;
  if (final) { state.currentImage = src; $("useLast").disabled = false; }
  $("canvas").classList.add("has");
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
    reader.readAsDataURL(file);
  });
}

// Ajusta la foto al máximo del perfil y a múltiplos de 64 (lo que pide el motor).
async function prepareEditImage(src) {
  const image = await new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error("formato no válido")); img.src = src;
  });
  const limit = maxSide(currentOption()?.family || "sdxl");
  const scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
  const align = (n) => Math.max(256, Math.floor(n / 64) * 64);
  const canvas = document.createElement("canvas");
  canvas.width = align(image.naturalWidth * scale); canvas.height = align(image.naturalHeight * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return { src: canvas.toDataURL("image/png"), w: canvas.width, h: canvas.height };
}

async function setEditImage(src) {
  try {
    state.editImage = await prepareEditImage(src);
    $("editPreview").src = state.editImage.src;
    $("editPreview").classList.add("on"); $("editEmpty").classList.add("off");
    $("editPreview").title = `${state.editImage.w} × ${state.editImage.h}`;
    updateGenLabel();
  } catch (e) { setStatus("No se pudo abrir la foto: " + e.message, "err"); }
}

function setMode(mode) {
  state.mode = mode;
  $("modeGen").classList.toggle("on", mode === "gen"); $("modeGen").setAttribute("aria-selected", mode === "gen");
  $("modeEdit").classList.toggle("on", mode === "edit"); $("modeEdit").setAttribute("aria-selected", mode === "edit");
  $("editStrip").classList.toggle("hidden", mode !== "edit");
  updateGenLabel();
}

function updateGenLabel() {
  $("genBtn").textContent = state.mode === "edit" ? "Aplicar a la foto" : "Generar";
  const [w, h] = state.mode === "edit" && state.editImage ? [state.editImage.w, state.editImage.h] : currentSize();
  if (state.mode === "edit" && state.editImage) $("sizeTxt").textContent = `Editando a ${w} × ${h}: el tamaño de la foto`;
  else updateSizeTxt();
}

async function upscaleCurrent() {
  if (!state.currentImage || state.busy) return;
  state.busy = true; $("upscaleBtn").disabled = true;
  setStatus("Ampliando imagen…");
  try {
    const result = await api("/sdcpp/v1/upscale", { method: "POST", body: JSON.stringify({ image: state.currentImage, upscaler: state.upscaler, repeats: 1, output_format: "png" }) });
    const image = result.images?.[0]?.b64_json;
    if (!image) throw new Error("El motor no devolvió una imagen ampliada");
    showImage("data:image/png;base64," + image);
    await invoke("save_image", { b64: image, prefix: "upscale" });
    setStatus(`Ampliación lista · ${result.width} × ${result.height} · ${result.upscaler || "ESRGAN"}`, "ok");
  } catch (e) {
    setStatus("No se pudo ampliar: " + e.message, "err");
  } finally {
    state.busy = false; $("upscaleBtn").disabled = false;
    $("genBtn").disabled = state.loaded !== currentOption()?.id;
  }
}

$("editFile").onchange = async () => {
  const file = $("editFile").files?.[0];
  if (file) await setEditImage(await readFileDataUrl(file));
  $("editFile").value = "";
};
$("useLast").onclick = () => { if (state.currentImage) setEditImage(state.currentImage); };
$("modeGen").onclick = () => setMode("gen");
$("modeEdit").onclick = () => setMode("edit");
$("editStrength").oninput = () => { $("editStrengthTxt").textContent = (+$("editStrength").value).toFixed(2).replace(".", ","); };
$("upscaleBtn").onclick = upscaleCurrent;

async function scanHistory() {
  try {
    state.outputFiles = await invoke("output_files");
    renderHistory();
  } catch (e) {
    $("historyList").textContent = `No se pudo leer outputs: ${e.message || e}`;
  }
}

function historyFavorites() { return new Set(store.get("favorites", [])); }
function renderHistory() {
  const list = $("historyList"), q = $("historySearch").value.trim().toLocaleLowerCase();
  const favorites = historyFavorites();
  list.innerHTML = "";
  const files = state.outputFiles.filter((f) => !q || f.name.toLocaleLowerCase().includes(q));
  files.sort((a, b) => Number(favorites.has(b.name)) - Number(favorites.has(a.name)) || b.name.localeCompare(a.name));
  if (!files.length) {
    const empty = document.createElement("div"); empty.className = "lbl";
    empty.textContent = state.outputFiles.length ? "No hay resultados para este filtro." : "Todavía no hay PNG en outputs.";
    list.appendChild(empty); return;
  }
  for (const file of files) {
    const button = document.createElement("button");
    button.className = "history-item" + (state.activeHistory === file.name ? " on" : "");
    const name = document.createElement("span"); name.className = "file-name"; name.textContent = file.name;
    const size = document.createElement("span"); size.className = "lbl"; size.textContent = `${(file.bytes / 1048576).toFixed(1)} MB`;
    const star = document.createElement("span"); star.setAttribute("aria-hidden", "true"); star.textContent = favorites.has(file.name) ? "★" : "☆";
    button.append(name, size, star); button.onclick = () => openHistoryImage(file.name);
    list.appendChild(button);
  }
}

async function openHistoryImage(name) {
  try {
    const b64 = await invoke("read_output", { name });
    const src = "data:image/png;base64," + b64;
    $("historyImage").src = src; state.currentImage = src; $("useLast").disabled = false;
    $("historyPreview").classList.add("has");
    $("historyName").textContent = name;
    state.activeHistory = name;
    $("historyFavorite").classList.remove("hidden");
    const favorite = historyFavorites().has(name);
    $("historyFavorite").textContent = favorite ? "★ Favorita" : "☆ Favorita";
    renderHistory();
  } catch (e) {
    $("historyEmpty").textContent = `No se pudo abrir la imagen: ${e.message || e}`;
  }
}

$("refreshHistory").onclick = scanHistory;
$("historySearch").oninput = renderHistory;
$("historyFavorite").onclick = () => {
  const name = state.activeHistory;
  if (!name) return;
  const favorites = historyFavorites();
  if (favorites.has(name)) favorites.delete(name); else favorites.add(name);
  store.set("favorites", [...favorites]);
  $("historyFavorite").textContent = favorites.has(name) ? "★ Favorita" : "☆ Favorita";
  renderHistory();
};

async function generate() {
  const opt = currentOption();
  if (!opt || state.loaded !== opt.id || state.busy) return;
  if (!$("prompt").value.trim()) { $("prompt").focus(); return; }
  if (state.mode === "edit" && !state.editImage) { setStatus("Elige una foto o usa la última imagen para editar.", "warn"); return; }
  state.busy = true; state.stop = false;
  $("genBtn").disabled = true; $("loadBtn").disabled = true; $("stopBtn").disabled = false;
  $("progress").classList.add("on");
  store.set("params:" + opt.id, { steps: +$("steps").value, cfg: +$("cfg").value, sampler: $("sampler").value, scheduler: $("scheduler").value, neg: $("neg").value });
  store.set("prompt", $("prompt").value);
  rememberPrompt($("prompt").value.trim(), $("neg").value.trim());
  state.batchTarget = Math.min(999, Math.max(1, parseInt($("count").value, 10) || 1));
  let seed = parseInt($("seed").value, 10);
  if (!(seed >= 0)) seed = Math.floor(Math.random() * 2 ** 31);
  $("extendBatch").disabled = false;
  try {
    for (let i = 0; i < state.batchTarget && !state.stop; i++) {
      if (i > 0) await waitIfHot();
      setStatus(state.batchTarget > 1 ? `Imagen ${i + 1} de ${state.batchTarget} · seed ${seed + i}` : `Generando · seed ${seed}`);
      const r = await runOne(opt, seed + i);
      if (!r) { setStatus("Detenido.", "warn"); break; }
      setStatus(`Lista en ${fmtS(r.total)} · seed ${seed + i} · guardada en outputs`, "ok");
    }
  } catch (e) {
    const s = await invoke("server_status");
    $("serverLog").textContent = s.log || "";
    setStatus("Error: " + e.message, "err");
  } finally {
    state.busy = false; state.job = null;
    $("progress").classList.remove("on");
    $("extendBatch").disabled = true;
    $("genBtn").disabled = state.loaded !== opt.id; $("loadBtn").disabled = false; $("stopBtn").disabled = true;
    showEstimate();
  }
}

$("extendBatch").onclick = () => {
  if (!state.busy) return;
  const add = Math.max(1, parseInt($("count").value, 10) || 1);
  const previous = state.batchTarget;
  state.batchTarget = Math.min(999, previous + add);
  $("count").value = String(state.batchTarget - previous);
  setStatus(`Cola ampliada: ${state.batchTarget} imágenes · se añadirán con la seed siguiente.`, "ok");
};

$("stopBtn").onclick = async () => {
  state.stop = true;
  if (state.job) { try { await api(`/sdcpp/v1/jobs/${state.job}/cancel`, { method: "POST" }); } catch { /* ya terminó */ } }
};

// ---------- controles ----------
function syncLabels() {
  $("stepsTxt").textContent = $("steps").value;
  $("cfgTxt").textContent = (+$("cfg").value).toFixed(1).replace(".", ",");
}
$("steps").oninput = () => { syncLabels(); showEstimate(); };
$("cfg").oninput = syncLabels;
$("prompt").addEventListener("input", updatePromptMeta);
$("weightDown").onclick = () => adjustPromptWeight(-0.1);
$("weightUp").onclick = () => adjustPromptWeight(0.1);
$("saveTemplate").onclick = () => {
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("prompt").focus(); return; }
  const name = window.prompt("Nombre de la plantilla:", prompt.slice(0, 32));
  if (!name?.trim()) return;
  const items = savedList("templates");
  items.push({ name: name.trim(), prompt, negative: $("neg").value, steps: +$("steps").value, cfg: +$("cfg").value, sampler: $("sampler").value, scheduler: $("scheduler").value });
  store.set("templates", items); fillPromptLists(); $("templatePick").value = String(items.length - 1);
};
$("templatePick").onchange = () => {
  const selected = $("templatePick").value;
  $("deleteTemplate").disabled = selected === "";
  if (selected === "") return;
  const item = savedList("templates")[+selected];
  if (!item) return;
  $("prompt").value = item.prompt; $("neg").value = item.negative || "";
  if (item.steps) $("steps").value = item.steps;
  if (item.cfg != null) $("cfg").value = item.cfg;
  if (item.sampler) $("sampler").value = item.sampler;
  if (item.scheduler) $("scheduler").value = item.scheduler;
  syncLabels(); updatePromptMeta(); showEstimate();
};
$("deleteTemplate").onclick = () => {
  const selected = $("templatePick").value;
  if (selected === "") return;
  const i = +selected;
  const items = savedList("templates");
  if (!Number.isInteger(i) || i < 0 || i >= items.length) return;
  items.splice(i, 1); store.set("templates", items); fillPromptLists();
};
$("recentPick").onchange = () => {
  const selected = $("recentPick").value;
  if (selected === "") return;
  const item = savedList("recentPrompts")[+selected];
  if (!item) return;
  $("prompt").value = item.prompt; $("neg").value = item.negative || ""; updatePromptMeta();
};
$("loraSearch").oninput = filterLoraLibrary;
$("randomSeed").onclick = () => { $("seed").value = "-1"; $("seed").focus(); };
for (const b of document.querySelectorAll("#aspect button")) {
  b.onclick = () => {
    state.aspect = b.dataset.a; store.set("aspect", state.aspect);
    document.querySelectorAll("#aspect button").forEach((x) => x.classList.toggle("on", x === b));
    updateSizeTxt(); showEstimate();
  };
}
$("model").onchange = () => {
  const opt = currentOption();
  if (!opt) return;
  applyPreset(opt);
  $("genBtn").disabled = state.loaded !== opt.id;
  if (state.loaded !== opt.id) setStatus("Pulsa Cargar para usar este modelo.");
};
$("loadBtn").onclick = loadModel;
$("genBtn").onclick = generate;
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) generate(); });
$("openOut").onclick = () => invoke("open_folder", { which: "outputs" });
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => invoke("open_folder", { which: b.dataset.open });
$("refreshLoras").onclick = async () => { await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {}); scanLoras(); };

for (const n of document.querySelectorAll(".nav")) {
  n.onclick = () => {
    document.querySelectorAll(".nav").forEach((x) => x.classList.toggle("on", x === n));
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === "page-" + n.dataset.page));
    if (n.dataset.page === "settings") invoke("server_status").then((s) => { $("serverLog").textContent = s.log || ""; });
    if (n.dataset.page === "history") scanHistory();
  };
}

$("optOffload").checked = store.get("offload", true);
$("optExtra").value = store.get("extra", "");
$("optHideConsole").checked = store.get("hideConsole", true);
$("optHideConsole").onchange = async () => {
  const hide = $("optHideConsole").checked;
  store.set("hideConsole", hide);
  try { await invoke("set_console_visible", { visible: !hide }); }
  catch (e) { setStatus(`No se pudo cambiar la ventana CMD: ${e.message || e}`, "warn"); }
};
$("restartBtn").onclick = async () => {
  if (state.busy) return;
  store.set("offload", $("optOffload").checked);
  store.set("extra", $("optExtra").value.trim());
  state.loaded = null; $("genBtn").disabled = true;
  if (await startEngine()) { await refreshEngineMenus(); await scanModels(); await scanLoras(); await loadModel(); }
};

// ---------- arranque: abrir el exe y que cargue todo solo ----------
(async function boot() {
  $("prompt").value = store.get("prompt", "");
  fillPromptLists(); updatePromptMeta();
  state.active = store.get("active", []);
  state.aspect = store.get("aspect", "p");
  const cs = store.get("customSize", null);
  if (Array.isArray(cs) && cs.length === 2) { $("customW").value = align64(cs[0]); $("customH").value = align64(cs[1]); }
  document.querySelectorAll("#aspect button").forEach((x) => x.classList.toggle("on", x.dataset.a === state.aspect));
  syncLabels(); updateSizeTxt();
  try {
    const info = await invoke("app_info");
    state.hw = info.hardware;
    // La consola solo existe en compilaciones de desarrollo; en el .exe final no hay opción.
    if (info.debug) {
      $("optConsoleRow").classList.remove("hidden");
      invoke("set_console_visible", { visible: !store.get("hideConsole", true) }).catch(() => {});
    }
    renderHw(state.hw);
    refreshMemory();
    setInterval(refreshMemory, 3000);
    if (!(await startEngine())) return;
    await refreshEngineMenus();
    await scanModels();
    await scanLoras();
    const opt = currentOption();
    if (opt) { applyPreset(opt); await loadModel(); }
  } catch (e) {
    setStatus("Error al iniciar: " + (e.message || e), "err");
  }
})();
