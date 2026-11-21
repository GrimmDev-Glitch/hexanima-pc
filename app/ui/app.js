// HexAnima PC: interfaz. Habla con el motor local (sd-server.exe en 127.0.0.1); no usa internet.
"use strict";

const { invoke: invokeNative } = window.__TAURI__.core;
const invoke = (command, args) => invokeNative(command, args).catch((error) => { throw UiLanguage.error(error); });
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
  cancelPromise: null,
  stop: false,
  safetyStop: false,
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
  pick.innerHTML = UiLanguage.text('<option value="">Plantillas</option>');
  templates.forEach((t, i) => pick.add(new Option(t.name, String(i))));
  $("deleteTemplate").disabled = true;
  const recent = $("recentPick");
  recent.innerHTML = UiLanguage.text('<option value="">Recientes</option>');
  savedList("recentPrompts").forEach((p, i) => recent.add(new Option(p.prompt.slice(0, 64) || UiLanguage.text("Prompt vacío"), String(i))));
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
  const pluralWildcard = UiLanguage.selected === "en" ? "s" : "es";
  const wildcards = [...p.matchAll(/\{[^{}]+\|[^{}]+\}/g)].length;
  $("promptMeta").textContent = p.length ? UiLanguage.template`${tags} etiquetas${wildcards ? UiLanguage.template` · ${wildcards} comodín${wildcards > 1 ? pluralWildcard : ""}` : ""}` : "";
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
const gb = (x) => x == null ? "—" : x.toLocaleString(UiLanguage.selected, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });

async function api(path, opts = {}) {
  const r = await fetch(state.api + path, { headers: { "Content-Type": "application/json" }, ...opts });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const e = new Error(UiLanguage.error(body.error || body.message) || `HTTP ${r.status}`);
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

async function engineRequest(path, opts = {}, timeout = 15000) {
  try {
    const deadline = AbortSignal.timeout(timeout);
    return await api(path, { ...opts, signal: opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline });
  } catch (error) {
    if (!error.status || error.status === 404 && path.includes("/jobs/")) {
      await invoke("stop_server");
      state.loaded = null;
      state.engine = null;
      state.job = null;
      if (opts.signal?.aborted) throw new Error(UiLanguage.text("Detenido. El motor se reiniciará al volver a generar."));
      throw new Error(UiLanguage.text("El motor dejó de responder o perdió el trabajo. Se detuvo y se reiniciará al volver a generar."));
    }
    throw error;
  }
}

async function requireResources(body = {}, modelBytes = 0) {
  const memory = await refreshMemory();
  if (!(memory?.ram_total_gb > 0)) throw new Error(UiLanguage.text("No se pudo verificar la RAM disponible."));
  const pixels = Math.max(0, Number(body.width || 0) * Number(body.height || 0));
  const hiresPixels = Number(body.hires?.target_width || 0) * Number(body.hires?.target_height || 0);
  const workingGb = (pixels * (1 + Number(!!body.adetailer || !!body.extra_ad_args || !!body.control_image)) + hiresPixels) / 1048576 * 0.75;
  const required = 2.5 + workingGb + modelBytes / 1073741824;
  if (memory.ram_free_gb < required) {
    throw new Error(UiLanguage.template`RAM insuficiente: ${memory.ram_free_gb.toFixed(1)} GB libres. Se estiman ${required.toFixed(1)} GB necesarios con la reserva del sistema. Reduce el tamaño, desactiva Hires o libera RAM.`);
  }
  if (memory.commit_free_gb == null) throw new Error(UiLanguage.text("Windows no pudo medir el margen de memoria comprometida; por seguridad no se iniciará esta carga."));
  if (memory.commit_free_gb < required) {
    throw new Error(UiLanguage.template`Margen de memoria comprometida insuficiente: ${memory.commit_free_gb.toFixed(1)} GB disponibles y ${required.toFixed(1)} GB estimados incluyendo la reserva de Windows.`);
  }
  if (body.width && state.device !== "cpu") {
    if (memory.gpu_temp_c == null || memory.gpu_temp_c >= thermalThreshold() || memory.vram_free_gb == null) {
      throw new Error(UiLanguage.text("No hay margen térmico o una lectura fiable de la GPU. Vuelve a Generar para que HexAnima evalúe el modo CPU."));
    }
    if (memory.vram_free_gb < 0.5 + workingGb) {
      throw new Error(UiLanguage.text("VRAM libre insuficiente para esta resolución o sus etapas adicionales. Reduce el tamaño o desactiva Hires."));
    }
  }
}

async function submitImage(body) {
  await requireResources(body);
  const sub = await engineRequest("/sdcpp/v1/img_gen", { method: "POST", body: JSON.stringify(body) });
  state.job = sub.id;
  return sub;
}

function upscaleTiles(length, size = 128, overlap = 24) {
  const starts = [0];
  while (starts.at(-1) + size < length) starts.push(Math.min(starts.at(-1) + size - overlap, length - size));
  return starts.map((start, i) => ({
    start,
    from: i ? Math.floor((start + starts[i - 1] + size) / 2) : 0,
    to: i + 1 < starts.length ? Math.floor((start + starts[i + 1] + size) / 2) : length,
  }));
}

async function submitUpscale(body, stopping = () => false, factor = 4, progress = () => {}) {
  const image = new Image();
  image.src = body.image;
  await image.decode();
  const w = image.naturalWidth, h = image.naturalHeight;
  const width = w * factor, height = h * factor;
  if (width * height > 24000000 || width > 8192 || height > 8192) {
    throw new Error(UiLanguage.text("La imagen supera el límite de Ampliar. Usa ×2 o recorta la foto."));
  }
  const required = 2.5 + 0.75 + (w * h * 4 + width * height * 16) / 1073741824;
  const ensureMemory = async () => {
    const memory = await refreshMemory();
    if (memory?.ram_free_gb == null || memory.ram_free_gb < required) {
      throw new Error(UiLanguage.template`Ampliar necesita unos ${required.toFixed(1)} GB de RAM libre con la reserva de Windows.`);
    }
    if (memory.commit_free_gb == null || memory.commit_free_gb < required) {
      throw new Error(UiLanguage.template`Ampliar necesita unos ${required.toFixed(1)} GB de margen de memoria comprometida de Windows.`);
    }
  };
  if (stopping()) throw new Error("Detenido.");
  // El escalador tiene su propio modelo. Reiniciar libera los pesos de difusión
  // y evita que la ampliación dependa de la gráfica o de su temperatura.
  if (!state.cpuRecovery || state.loaded || state.device !== "cpu") {
    const engine = (state.engines || []).find((name) => ["cpu", "cuda", "vulkan"].includes(name));
    if (!engine) throw new Error(UiLanguage.text("Hace falta un motor local compatible con CPU para ampliar."));
    state.loaded = null;
    if (!(await startEngine(engine, true))) throw new Error(UiLanguage.text("No se pudo iniciar el motor de ampliación en CPU."));
  }
  await ensureMemory();
  const out = document.createElement("canvas"), tile = document.createElement("canvas");
  out.width = width; out.height = height;
  const output = out.getContext("2d");
  output.imageSmoothingQuality = "high";
  const xs = upscaleTiles(w), ys = upscaleTiles(h);
  const controller = new AbortController();
  const check = setInterval(() => { if (stopping()) controller.abort(); }, 250);
  try {
    let done = 0;
    for (const y of ys) for (const x of xs) {
      if (stopping()) throw new Error("Detenido.");
      const tw = Math.min(128, w - x.start), th = Math.min(128, h - y.start);
      tile.width = tw; tile.height = th;
      tile.getContext("2d").drawImage(image, x.start, y.start, tw, th, 0, 0, tw, th);
      await ensureMemory();
      if (stopping()) throw new Error("Detenido.");
      const result = await engineRequest("/sdcpp/v1/upscale", {
        method: "POST", signal: controller.signal,
        body: JSON.stringify({ ...body, image: tile.toDataURL("image/png"), repeats: 1 }),
      }, 600000);
      const b64 = result.images?.[0]?.b64_json;
      if (!b64) throw new Error(UiLanguage.text("El motor no devolvió el mosaico ampliado."));
      const enlarged = new Image();
      enlarged.src = "data:image/png;base64," + b64;
      await enlarged.decode();
      if (enlarged.naturalWidth !== tw * 4 || enlarged.naturalHeight !== th * 4) {
        throw new Error(UiLanguage.text("El motor devolvió un mosaico con un tamaño inesperado."));
      }
      const keepW = x.to - x.from, keepH = y.to - y.from;
      output.drawImage(enlarged, (x.from - x.start) * 4, (y.from - y.start) * 4, keepW * 4, keepH * 4,
        x.from * factor, y.from * factor, keepW * factor, keepH * factor);
      progress(++done, xs.length * ys.length);
    }
    if (stopping()) throw new Error("Detenido.");
    return { width, height, images: [{ b64_json: out.toDataURL("image/png").split(",")[1] }] };
  } finally {
    clearInterval(check);
    tile.width = 0; out.width = 0;
  }
}

async function waitForImage(id, stopping, onProgress) {
  const path = "/sdcpp/v1/jobs/" + id;
  let cancelAt;
  for (;;) {
    if (stopping() && cancelAt == null) {
      cancelAt = Date.now();
      state.cancelPromise ||= fetch(state.api + path + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(2500) }).catch(() => null);
    }
    await sleep(400);
    let job;
    try { job = await engineRequest(path, {}, stopping() ? 3000 : 15000); }
    catch (error) {
      if (!stopping()) throw error;
      await invoke("stop_server").catch(() => {});
      state.loaded = null; state.engine = null; state.device = null; state.job = null;
      throw new Error(UiLanguage.text("El motor no respondió al detenerlo; se cerró para liberar sus recursos y se reiniciará en el siguiente intento."));
    }
    if (["completed", "cancelled", "failed"].includes(job.status)) {
      state.job = null;
      return job;
    }
    if (cancelAt != null && Date.now() - cancelAt > 10000) {
      await invoke("stop_server");
      state.loaded = null;
      state.engine = null;
      state.job = null;
      throw new Error(UiLanguage.text("El motor no confirmó la cancelación. Se detuvo y se reiniciará al volver a generar."));
    }
    onProgress(job);
  }
}

function setStatus(text, kind = "") {
  const el = $("modelStatus");
  el.textContent = text;
  el.className = "status " + kind;
}

// ---------- perfiles y tamaños ----------
const FAMILY = {
  // Mage Edit Turbo: 4 pasos y CFG 1 (el negativo no se usa); el prompt es una orden en frase
  mage: { steps: 4, cfg: 1, sampler: "euler", scheduler: "discrete", neg: "", chips: ["the character from image 1", "keep the same face and outfit", "in a new pose", "high quality anime illustration"] },
  anima: { steps: 8, cfg: 1, sampler: "euler", scheduler: "discrete", neg: "", chips: ["masterpiece", "best quality", "highres", "detailed eyes"] },
  anima_base: { steps: 20, cfg: 4, sampler: "dpm++2m", scheduler: "sgm_uniform", neg: "worst quality, low quality, blurry", chips: ["masterpiece", "best quality", "highres"] },
  // Qwen-Image 2.1 Turbo: 8 pasos, CFG 1, Euler y los sigmas del Turbo (los pone runOne); frases, no etiquetas
  qwen: { steps: 8, cfg: 1, sampler: "euler", scheduler: "discrete", neg: "", chips: ["high quality", "detailed", "soft natural light", "a clear sign that says"] },
  qwen_base: { steps: 20, cfg: 4, sampler: "euler", scheduler: "discrete", neg: "blurry, low quality, distorted text", chips: ["high quality", "detailed", "soft natural light"] },
  // MOSS-Image: sin el adaptador de 4 pasos del teléfono (necesita su propio muestreador): 20 pasos, CFG 3
  moss: { steps: 20, cfg: 3, sampler: "euler", scheduler: "discrete", neg: "lowres, blurry, bad anatomy, bad hands", chips: ["realistic photo", "detailed skin", "soft light", "high quality"] },
  sdxl: {
    steps: 28, cfg: 5.5, sampler: "euler_a", scheduler: "discrete",
    neg: "worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digits, blurry, jpeg artifacts, watermark, signature",
    chips: ["masterpiece", "best quality", "amazing quality", "very aesthetic", "absurdres"],
  },
};
const ASPECT = { p: [832, 1216], s: [1024, 1024], l: [1216, 832] };
const ASPECT_ANIMA = { p: [512, 768], s: [640, 640], l: [768, 512] };
// Mage está entrenado a ~1024 px: a 512×768 sale tosco (caras y manos); 768×1152 a 4 pasos queda bien
// (GTX 1650: 117 s frente a 58 s). 8 pasos apenas mejora y tarda el doble.
const ASPECT_MAGE = { p: [768, 1152], s: [960, 960], l: [1152, 768] };
// Qwen-Image (múltiplos de 32) y MOSS (de 16): cerca de 1 megapíxel, como Mage
const BIG_FAMILIES = ["mage", "qwen", "moss"];
/** Familias que editan con imágenes de referencia (ref_images) en vez de imagen a imagen. */
const REF_FAMILIES = ["mage", "qwen"];
/** Sigmas fijos de Qwen-Image 2.1 Turbo (preset qwen-image-2.1-turbo del motor): 8 pasos. */
const QWEN_TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0];

function maxSide(family) {
  const p = state.hw?.profile || "medio";
  if (p === "bajo") return 768;
  if (p === "alto") return 1536;
  return family === "sdxl" || BIG_FAMILIES.includes(family) ? 1216 : 1024; // medio
}

const align64 = (n) => Math.min(2048, Math.max(256, Math.round((+n || 0) / 64) * 64));

function currentSize() {
  // Personalizado: se respeta lo que elige la persona (múltiplos de 64, 256–2048), sin recortar al perfil.
  if (state.aspect === "c") return [align64($("customW").value), align64($("customH").value)];
  const opt = currentOption();
  const fam = opt?.family || "sdxl";
  let [w, h] = (BIG_FAMILIES.includes(fam) ? ASPECT_MAGE : fam === "anima" ? ASPECT_ANIMA : ASPECT)[state.aspect];
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
    ? UiLanguage.template`${w} × ${h} · supera el máximo recomendado (${ms} px): tardará más y puede quedarse sin memoria`
    : UiLanguage.template`${w} × ${h}${state.aspect === "c" ? UiLanguage.text(" · múltiplos de 64") : ""} · máximo del perfil ${ms} px`;
  if (typeof Hires !== "undefined") Hires.refresh();
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
  $("hwName").textContent = g ? `${g.name.replace("NVIDIA GeForce ", "")}${g.vram_gb ? " · " + gb(g.vram_gb) + " GB" : ""}` : UiLanguage.text("Sin GPU compatible");
  const prof = profileLabel(hw.profile);
  $("hwProfile").textContent = UiLanguage.template`Perfil: ${prof} · ${hw.engine.toUpperCase()}${hw.backend_device ? " (" + hw.backend_device + ")" : ""}`;
  $("setInfo").textContent = UiLanguage.template`Gráfica: ${g ? g.name : UiLanguage.text("ninguna")} · RAM ${gb(hw.ram_gb)} GB · motor ${hw.engine} · dispositivo ${hw.backend_device || "auto"} · perfil ${prof}`;
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
    $("tempTxt").title = UiLanguage.template`Umbral de HexAnima antes de generar: ${thermalThreshold()} °C`;
    // portátil desenchufado: la gráfica va limitada (GTX 1650 a 20 W, ~3 veces más lento)
    $("battTxt").classList.toggle("hidden", !m.on_battery);
    const reserve = Math.max(2.5, (m.ram_total_gb || 0) * 0.15);
    const critical = (m.ram_total_gb > 0 && m.ram_free_gb < reserve) || (m.commit_free_gb != null && m.commit_free_gb < reserve);
    if (state.busy && critical && !state.safetyStop) {
      state.safetyStop = true;
      state.stop = true;
      setStatus(UiLanguage.text("Presión crítica de memoria: deteniendo el trabajo para proteger Windows…"), "warn");
      if (state.job && state.api) {
        const path = "/sdcpp/v1/jobs/" + state.job + "/cancel";
        state.cancelPromise ||= fetch(state.api + path, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(2500) }).catch(() => null);
      } else {
        state.loaded = null; state.engine = null; state.device = null;
        invoke("stop_server").catch(() => {});
      }
    }
    return m;
  } catch { return null; }
}

// ---------- motor ----------
/** Motor para una familia: Anima va mejor con CUDA en NVIDIA (su VAE tarda ~16 s en vez de
 *  ~67 s con Vulkan por mosaicos, medido en GTX 1650); SDXL va mejor con Vulkan en GTX. */
/** Motor para el modelo. Automático: CUDA en cualquier NVIDIA si está instalado. En la GTX 1650 Vulkan
 *  es algo más rápido por paso (~14 s frente a ~24 s en SDXL 832×1216) pero hace fallar la gráfica cada
 *  2-3 imágenes (ErrorDeviceLost) y a ratos baja a 29 s/paso; CUDA hizo 3 de 3 sin fallos.
 *  En Ajustes se puede forzar CUDA o Vulkan. */
/** Motor PyTorch: el de siempre trae PyTorch 2.3.1 + CUDA 12.1 (kernels hasta sm_90) y las RTX serie 50
 *  (Blackwell, capacidad 10.x/12.x) dan «no kernel image is available»; para ellas está el motor
 *  PyTorch 2.7.1 + CUDA 12.8 (motor-cu128.json). Sin él, esas gráficas usan CUDA de sd.cpp (runtime 12.8). */
function needsCu128() {
  const g = state.hw?.gpu;
  if (g?.vendor !== "nvidia") return false;
  if (g.compute_cap != null) return g.compute_cap >= 10;
  return /RTX\s*(PRO\s*)?50\d\d|blackwell/i.test(g.name || "");
}

/** ¿El motor PyTorch instalado sirve para esta gráfica? */
function torchSupportsGpu() {
  if (state.hw?.gpu?.vendor !== "nvidia") return false;
  return !needsCu128() || Number(state.torchCuda || 0) >= 128;
}

function engineFor(opt) {
  const engines = state.engines || [];
  const nvidia = state.hw?.gpu?.vendor === "nvidia";
  // El motor PyTorch trae su propio ADetailer y detector (YOLOv8): SDXL siempre puede usarlo
  const torchOk = opt?.family === "sdxl" && engines.includes("torch") && torchSupportsGpu();
  const pref = store.get("enginePref", "auto");
  // A manual preference is authoritative. Compatibility checks must explain failure instead
  // of quietly turning a PyTorch choice into Vulkan, CUDA, or CPU.
  if (pref !== "auto") return pref;
  // Automático: PyTorch (backend de Forge) para SDXL/Illustrious/Pony en NVIDIA: ~8,5 s/paso frente a
  // ~24 s/paso de sd.cpp CUDA en la GTX 1650. Anima y el resto: CUDA (estable) o el de la gráfica.
  if (nvidia && torchOk) return "torch";
  if (nvidia && engines.includes("cuda")) return "cuda";
  return state.hw?.engine;
}

function thermalThreshold() {
  return { bajo: 75, medio: 78, alto: 80 }[state.hw?.profile] ?? 75;
}

function profileLabel(profile) {
  if (profile === "alto") return UiLanguage.selected === "en" ? "High" : "Alto";
  return { bajo: UiLanguage.text("Bajo"), medio: UiLanguage.text("Medio") }[profile] || profile;
}

function generationEngine(opt, memory) {
  const preferred = engineFor(opt);
  const manual = store.get("enginePref", "auto") !== "auto";
  const engines = state.engines || [];
  if (!preferred || !engines.includes(preferred)) {
    throw new Error(UiLanguage.template`El motor elegido (${preferred || "—"}) no está instalado. Instálalo o cambia la preferencia a Automático.`);
  }
  if (preferred === "torch" && (opt?.family !== "sdxl" || !torchSupportsGpu())) {
    throw new Error(UiLanguage.text("PyTorch seleccionado: este motor requiere una GPU NVIDIA compatible y admite modelos SDXL, Illustrious y Pony. Elige otro motor o Automático para este modelo."));
  }
  if (preferred === "cpu") return { engine: preferred, limitedCpu: true };
  const threshold = thermalThreshold();
  const target = state.hw?.gpu_target_temp_c;
  // nvidia-smi mide la primera NVIDIA. Vulkan tiene su propia enumeración.
  const knownDevice = preferred === "torch" || preferred === "cuda" && !/--backend\b/.test(store.get("extra", ""));
  if (knownDevice && target != null && target <= threshold &&
      memory?.gpu_temp_c != null && memory.gpu_temp_c < threshold) {
    return { engine: preferred, limitedCpu: false };
  }
  if (manual && preferred === "torch") {
    throw new Error(UiLanguage.text("PyTorch está seleccionado, pero no se pudo confirmar un margen térmico seguro para la GPU. Espera a que se enfríe o cambia el motor a Automático."));
  }
  const native = (state.engines || []).find((engine) => ["cpu", "cuda", "vulkan"].includes(engine));
  return { engine: preferred === "torch" ? native : preferred, limitedCpu: true };
}

async function startEngine(engine, cpuRecovery = false) {
  setStatus(UiLanguage.text("Iniciando motor…"));
  // ADetailer: el detector elegido se carga al arrancar el motor (uno a la vez).
  const ad = typeof Ad !== "undefined" ? Ad.wanted() : null;
  const opts = { offload_to_cpu: store.get("offload", true), extra_args: store.get("extra", "") || null, ad_model: ad, cpu_recovery: cpuRecovery };
  const r = await invoke("start_server", { opts, engine: engine || null });
  state.cpuRecovery = cpuRecovery;
  state.adLoaded = ad;
  state.api = `http://127.0.0.1:${r.port}`;
  state.engine = r.engine; state.device = r.device;
  if (state.hw) $("hwProfile").textContent = UiLanguage.template`Perfil: ${profileLabel(state.hw.profile)} · ${r.engine === "torch" ? "PYTORCH" : r.engine.toUpperCase()}${r.device ? " (" + r.device + ")" : ""}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    try {
      await api("/sdcpp/v1/models/status");
      if (r.engine === "torch") {
        const runtime = await api("/hexanima/v1/runtime").catch(() => null);
        state.device = runtime?.device || "unknown";
        state.backendDeviceName = runtime?.gpu || null;
        const label = "PYTORCH (" + (runtime?.device || UiLanguage.text("dispositivo sin verificar")) + (runtime?.gpu ? ": " + runtime.gpu : "") + ")";
        $("hwProfile").textContent = UiLanguage.template`Perfil: ${profileLabel(state.hw?.profile)} · ${label}`;
      }
      return true;
    } catch { /* aun arrancando */ }
    const s = await invoke("server_status");
    if (!s.running) {
      $("serverLog").textContent = s.log || "";
      setStatus(UiLanguage.text("El motor se cerró al iniciar. Revisa Ajustes → Registro del motor."), "err");
      return false;
    }
    await sleep(400);
  }
  setStatus(UiLanguage.text("El motor no responde."), "err");
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
  // Anima: Qwen3 0.6B (no Qwen3.5 de MOSS ni Qwen3-VL) y el VAE de Qwen Image (no el de la 2.1)
  const llm = files.filter((f) => f.category === "text_encoders" && /qwen[_-]?3(?![.\d])/i.test(f.name) && !/vl|mmproj/i.test(f.name))[0];
  const vae = by("vae", /qwen[_-]?image/i).filter((f) => !/2[._]1/.test(f.name))[0];
  for (const f of by("diffusion_models", /anima/i)) {
    if (!llm || !vae) continue;
    const turbo = /turbo/i.test(f.name);
    opts.push({
      id: "anima:" + f.id, label: f.name.replace(/\.(safetensors|gguf)$/i, "") + " · Anima",
      family: "anima", preset: turbo ? "anima" : "anima_base", recipe: "anima",
      models: { diffusion_model: f.id, llm: llm.id, vae: vae.id },
    });
  }
  // Mage-Flow Edit Turbo (Microsoft, MIT): edita con una orden y hasta 3 imágenes de referencia, 4 pasos
  const mllm = files.find((f) => f.category === "text_encoders" && /qwen[_-]?3[_-]?vl[_-]?4b/i.test(f.name) && !/mmproj/i.test(f.name));
  const mvis = files.find((f) => /mmproj/i.test(f.name) && /qwen[_-]?3[_-]?vl[_-]?4b/i.test(f.name));
  // «mage» a secas también está dentro de «image» (qwen-image, moss-image): se busca Mage-Flow o mage- al principio
  const isMage = (n) => /mage[-_ ]?flow|^mage[-_]/i.test(n);
  const mvae = files.filter((f) => f.category === "vae" && isMage(f.name))[0];
  for (const f of files.filter((x) => x.category === "diffusion_models" && isMage(x.name))) {
    if (!mllm || !mvae) continue;
    opts.push({
      id: "mage:" + f.id, label: (/edit/i.test(f.name) ? "Mage Edit" : "Mage") + (/turbo/i.test(f.name) ? " Turbo" : "") + " · Mage",
      family: "mage", recipe: "mage-flow-edit",
      models: { diffusion_model: f.id, llm: mllm.id, vae: mvae.id, ...(mvis ? { llm_vision: mvis.id } : {}) },
    });
  }
  // Qwen-Image 2.1 (Qwen): Qwen3-VL-8B + su proyector de visión (editar con referencias) y el VAE de la 2.1.
  // Turbo: 8 pasos con sus sigmas fijos; la normal, 20 pasos con CFG 4.
  const qllm = files.find((f) => f.category === "text_encoders" && /qwen[_-]?3[_-]?vl[_-]?8b/i.test(f.name) && !/mmproj/i.test(f.name));
  const qvis = files.find((f) => /mmproj/i.test(f.name) && /qwen[_-]?3[_-]?vl[_-]?8b/i.test(f.name));
  const qvae = by("vae", /qwen[_-]?image[_-]?2[._]1/i)[0];
  for (const f of by("diffusion_models", /qwen[_-]?image/i)) {
    if (!qllm || !qvae) continue;
    const turbo = /turbo|lightning/i.test(f.name);
    opts.push({
      id: "qwen:" + f.id, label: f.name.replace(/\.(safetensors|gguf)$/i, "") + " · Qwen-Image",
      family: "qwen", preset: turbo ? "qwen" : "qwen_base", recipe: turbo ? "qwen-image-21-turbo" : "qwen-image-21",
      models: { diffusion_model: f.id, llm: qllm.id, vae: qvae.id, ...(qvis ? { llm_vision: qvis.id } : {}) },
    });
  }
  // MOSS-Image (OpenMOSS): Qwen3.5-9B, su tokenizer.json y el VAE de FLUX.2. Base o SFT según el nombre
  // (MiaoMiao Harem MOSS es de la Base; RealSkin MOSS, del SFT).
  const sllm = files.find((f) => f.category === "text_encoders" && /qwen[_-]?3\.5/i.test(f.name) && !/mmproj/i.test(f.name));
  const stok = files.find((f) => f.category === "tokenizers");
  const svae = by("vae", /flux[_-]?2/i).filter((f) => !/small/i.test(f.name))[0] || by("vae", /flux[_-]?2/i)[0];
  for (const f of by("diffusion_models", /moss/i)) {
    if (!sllm || !stok || !svae) continue;
    const base = /base|harem/i.test(f.name);
    opts.push({
      id: "moss:" + f.id, label: f.name.replace(/\.(safetensors|gguf)$/i, "") + " · MOSS",
      family: "moss", preset: "moss", recipe: base ? "moss-image-base" : "moss-image-sft",
      models: { diffusion_model: f.id, llm: sllm.id, tokenizer: stok.id, vae: svae.id },
    });
  }
  state.options = opts;
  const sel = $("model");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const o of opts) sel.add(new Option(o.label, o.id));
  if (!opts.length) {
    sel.add(new Option(UiLanguage.text("No hay modelos"), ""));
    setStatus(UiLanguage.text("Copia un checkpoint SDXL a models\\checkpoints o descarga Anima."), "warn");
    return;
  }
  const last = opts.some((o) => o.id === prev) ? prev : store.get("model", null);
  if (last && opts.some((o) => o.id === last)) sel.value = last;
  // el selector de VAE depende del modelo elegido y de los archivos del motor
  if (typeof Vae !== "undefined") Vae.refresh();
  if (typeof Gpt !== "undefined") Gpt.sync();
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

/** TAE de la familia para la vista previa con stable-diffusion.cpp (el motor rápido usa su propio TAESD).
 *  Se descarga solo la primera vez (10-30 MB); si falla, se sigue con la vista previa simple. */
const TAE = { qwen: "tae_qwen21", anima: "tae_wan21", sdxl: "tae_sdxl" };
async function taeFor(opt) {
  const kind = TAE[opt.family];
  if (!kind || state.engine === "torch" || state.cpuRecovery || (state.hw?.gpu?.vram_gb > 0 && state.hw.gpu.vram_gb <= 2)) return null;
  try {
    let a = (await invoke("asset_status")).find((x) => x.kind === kind);
    if (a && !a.installed) {
      setStatus(UiLanguage.text("Descargando la vista previa nítida (una sola vez)…"));
      await invoke("asset_download", { kind });
      await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
      a = { ...a, installed: true };
    }
    return a?.installed ? a.file : null;
  } catch { return null; }
}

async function loadModel(plan, reserved = false) {
  const opt = currentOption();
  if (!opt || state.busy && !reserved) return;
  state.busy = true;
  $("genBtn").disabled = true; $("loadBtn").disabled = true;
  store.set("model", opt.id);
  if (state.loaded !== opt.id) applyPreset(opt);
  const t0 = Date.now();
  let tick;
  try {
    const { engine, limitedCpu } = plan ?? generationEngine(opt, await refreshMemory());
    if (!engine) throw new Error(UiLanguage.text("hace falta un motor compatible con CPU para aplicar el perfil térmico"));
    if (engine !== state.engine || limitedCpu !== !!state.cpuRecovery) {
      state.loaded = null;
      if (!(await startEngine(engine, limitedCpu))) return;
      await refreshEngineMenus();
    }
    tick = setInterval(() => setStatus(UiLanguage.template`Cargando ${opt.label}… ${Math.round((Date.now() - t0) / 1000)} s`), 500);
    const models = typeof Vae !== "undefined" ? Vae.modelsFor(opt) : opt.models;
    // Vista previa nítida: el autoencoder diminuto de la familia (solo para ver la imagen mientras se genera)
    const tae = await taeFor(opt);
    if (tae) models.tae = tae;
    state.previewMode = tae ? "tae" : "proj";
    const modelRequest = { recipe: opt.recipe, models };
    await requireResources({}, await invoke("model_bytes", { files: Object.values(models) }));
    await engineRequest("/sdcpp/v1/models/load", { method: "POST", body: JSON.stringify(modelRequest) }, 180000);
    state.modelRequest = modelRequest;
    state.loaded = opt.id;
    setStatus(UiLanguage.template`Listo · ${opt.label} (${Math.round((Date.now() - t0) / 1000)} s)`, "ok");
  } catch (e) {
    state.loaded = null;
    const s = await invoke("server_status");
    $("serverLog").textContent = s.log || "";
    setStatus(UiLanguage.template`No se pudo cargar: ${e.message}`, "err");
  } finally {
    clearInterval(tick);
    if (!reserved) {
      state.busy = false;
      $("loadBtn").disabled = false;
      $("genBtn").disabled = !opt;
    }
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
  sgm_uniform: "SGM Uniform", simple: "Simple", smoothstep: "Smoothstep", kl_optimal: UiLanguage.text("KL óptimo"), lcm: "LCM",
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
  // Ampliadores instalados (modelos ESRGAN en models\\upscalers). El botón Ampliar siempre está:
  // si falta el modelo, su diálogo ofrece descargarlo (como el teléfono).
  state.upscalers = Array.isArray(upscalers) ? upscalers.filter((u) => u.model_path).map((u) => u.name) : [];
  state.upscaler = state.upscalers[0] || null;
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


// ---------- generar ----------
const STAGE = { loading_control: UiLanguage.text("Cargando el ControlNet de pose"),
  queued: UiLanguage.text("En cola"), waiting: UiLanguage.text("Esperando"), preparing: UiLanguage.text("Preparando"), conditioning: UiLanguage.text("Leyendo el prompt"),
  sampling: UiLanguage.text("Generando"), vae_decode: UiLanguage.text("Decodificando imagen"), vae_encode: UiLanguage.text("Codificando imagen"),
  upscaling: UiLanguage.text("Ampliando"), adetailer: "Corrigiendo detalles", encoding: UiLanguage.text("Guardando"), reference: UiLanguage.text("Preparando el personaje de referencia"),
};

function showEstimate() {
  const opt = currentOption();
  const b = opt && store.get("bench:" + opt.id + ":" + currentSize().join("x"), null);
  $("estimate").textContent = b ? UiLanguage.template`~${fmtS(b.fixed + b.step * +$("steps").value)} estimados con tu equipo` : "";
}

async function waitIfHot() {
  if (state.device === "cpu") return;
  const threshold = thermalThreshold();
  let m = await refreshMemory();
  if (!m || m.gpu_temp_c == null || m.gpu_temp_c < threshold) return;
  while (!state.stop && m?.gpu_temp_c != null && m.gpu_temp_c > threshold - 8) {
    $("progStage").textContent = UiLanguage.template`GPU a ${m.gpu_temp_c} °C: pausa para enfriar…`;
    await sleep(5000);
    m = await refreshMemory();
  }
}

async function runOne(opt, seed, ov = {}) {
  const editing = state.mode === "edit" && state.editImage && !REF_FAMILIES.includes(opt.family);
  // Al editar, el tamaño es el de la foto (ya ajustado a múltiplos de 64 al elegirla).
  const [w, h] = editing ? [state.editImage.w, state.editImage.h] : currentSize();
  const steps = clampNum($("steps"), 20);
  const cfg = clampNum($("cfg"), 5);
  // Las etiquetas <lora:nombre:fuerza> del prompt se convierten en la lista que pide el motor
  // (el servidor no lee etiquetas dentro del texto) y se quitan del prompt enviado.
  // 🌐 ES→EN: se genera con la versión en inglés (los comodines {a|b} se eligen antes de traducir)
  const promptWithTags = await EsEn.apply(expandWildcards($("prompt").value.trim()));
  const negative = await EsEn.apply($("neg").value.trim());
  const loraSpec = Loras.fromPrompt(promptWithTags);
  if (loraSpec.missing.length) setStatus(UiLanguage.template`LoRA no encontrado: ${loraSpec.missing.join(", ")} (se ignora)`, "warn");
  const body = {
    ...(editing ? { init_image: state.editImage.src, strength: clampNum($("editStrength"), 45) / 100 } : {}),
    // «✎ Zona a cambiar»: blanco = se vuelve a generar, negro = se conserva.
    ...(editing && state.editMask ? { mask_image: state.editMask.src } : {}),
    ...(Hires.body(w, h) ? { hires: Hires.body(w, h) } : {}),
    // Con un detector cargado, ADetailer corre siempre: si está en "No" se le pide una confianza imposible.
    ...(state.adLoaded && state.engine !== "torch" ? { extra_ad_args: Ad.args() } : {}),
    // Motor PyTorch: ADetailer propio (detector YOLOv8 en PyTorch + redibujado por recorte)
    ...(state.engine === "torch" && Ad.mode !== "off" ? { adetailer: { model: Ad.mode, strength: Ad.den() / 100, confidence: 0.3 } } : {}),
    prompt: loraSpec.prompt,
    negative_prompt: negative,
    clip_skip: +$("clipskip").value,
    width: w, height: h, seed, batch_count: 1,
    sample_params: {
      scheduler: $("scheduler").value, sample_method: $("sampler").value, sample_steps: steps,
      guidance: { txt_cfg: cfg },
    },
    lora: loraSpec.lora,
    // Vulkan y el perfil bajo: VAE por mosaicos (sin ellos el primer intento puede fallar por memoria)
    vae_tiling_params: { enabled: vaeTiling() },
    preview: state.previewMode || "proj", preview_interval: 1,
    output_format: "png", embed_image_metadata: true,
  };
  const fast = typeof Fast !== "undefined" && Fast.apply(body, opt);
  const mageRefs = typeof MageRefs !== "undefined" ? MageRefs.apply(body, opt) : 0;
  const usedRef = typeof Ref !== "undefined" && Ref.apply(body, opt);
  const usedPose = typeof Pose !== "undefined" ? Pose.apply(body, opt) : null;
  // Qwen-Image 2.1 Turbo: sus 8 sigmas fijos (con otros pasos, el planificador normal)
  if (opt.preset === "qwen" && body.sample_params.sample_steps === 8 && ov.steps == null) body.sample_params.custom_sigmas = QWEN_TURBO_SIGMAS;
  // ⊞ Comparar 2×2: la imagen i cambia el CFG o los pasos (después del Modo rápido, que también los fija)
  if (ov.cfg != null) body.sample_params.guidance.txt_cfg = ov.cfg;
  if (ov.steps != null) body.sample_params.sample_steps = ov.steps;
  const usedSteps = body.sample_params.sample_steps, usedCfg = body.sample_params.guidance.txt_cfg;
  const canRecover = ["cuda", "vulkan"].includes(state.engine) && !state.cpuRecovery;
  const previousLog = canRecover ? await invoke("server_status").then((s) => s.log).catch(() => null) : null;
  if (state.stop) return null;
  let sub = await submitImage(body);
  let sampStart = null, sampMs = 0;
  for (;;) {
    const j = await waitForImage(sub.id, () => state.stop, (j) => {
      const p = j.progress || {};
      const st = STAGE[p.stage] || p.stage || UiLanguage.text("Trabajando");
      const cnt = p.unit === "steps" && p.total ? ` ${p.completed}/${p.total}` : "";
      $("progStage").textContent = st + cnt;
      $("progTime").textContent = fmtS((p.elapsed_ms || 0) / 1000);
      $("progBar").style.width = p.total ? `${(100 * (p.completed || 0)) / p.total}%` : "0%";
      if (p.stage === "sampling" && sampStart == null) sampStart = p.elapsed_ms;
      if (p.stage !== "sampling" && sampStart != null && !sampMs) sampMs = p.elapsed_ms - sampStart;
      if (j.preview?.b64_json && p.stage === "sampling") showImage("data:image/png;base64," + j.preview.b64_json, false);
    });
    if (state.stop) return null;
    if (j.status === "completed") {
      const img = j.result.images[0].b64_json;
      showImage("data:image/png;base64," + img);
      const total = (j.completed - j.started) / 1000;
      if (sampMs) store.set("bench:" + opt.id + ":" + w + "x" + h + (fast ? ":fast" : ""), { step: sampMs / 1000 / usedSteps, fixed: total - sampMs / 1000 });
      // .json con los ajustes completos junto al PNG (como la galería del teléfono).
      const meta = {
        prompt: promptWithTags, negative: body.negative_prompt, prompt_es: EsEn.on() ? $("prompt").value.trim() : null, model: opt.id, model_label: opt.label, family: opt.family,
        steps: usedSteps, cfg: usedCfg, fast: fast || null, reference: usedRef ? { weight: body.ip_adapter.weight } : null, pose: usedPose, references: mageRefs || null, sampler: body.sample_params.sample_method, scheduler: body.sample_params.scheduler,
        seed, width: w, height: h, clip_skip: body.clip_skip, mode: editing ? (body.mask_image ? "inpaint" : "edit") : "gen", hires: body.hires || null, adetailer: (state.engine === "torch" ? Ad.mode !== "off" : Ad.active()) ? { mode: Ad.mode, strength: Ad.den() } : null,
        strength: editing ? body.strength : null, loras: loraSpec.lora.filter((l) => typeof Fast === "undefined" || !Fast.isOwn(l.path)).map((l) => ({ file: l.path, w: l.multiplier })),
        seconds: Math.round(total), created: new Date().toISOString(),
      };
      const path = await invoke("save_image", { b64: img, prefix: editing ? "edit" : opt.family, meta });
      state.lastSaved = path;
      Session.add({ name: path, src: "data:image/png;base64," + img, meta, before: editing ? state.editImage.src : null });
      return { total, path, src: "data:image/png;base64," + img, meta };
    }
    if (j.status === "failed") {
      state.job = null;
      if (state.stop) return null;
      const error = UiLanguage.error(j.error?.message) || UiLanguage.text("falló la generación");
      if (!canRecover || state.cpuRecovery) throw new Error(error);
      const log = await invoke("server_status").then((s) => s.log).catch(() => null);
      const memoryFailure = /out of (?:device )?memory|cannot make enough memory available/i;
      const previousLine = previousLog?.split("\n").at(-1);
      const previousEnd = previousLine ? log?.lastIndexOf(previousLine) ?? -1 : -1;
      const newLog = previousEnd < 0 ? log : log.slice(previousEnd + previousLine.length);
      if (!memoryFailure.test(error) && !memoryFailure.test(newLog || "")) throw new Error(error);
      if (state.stop) return null;
      $("progStage").textContent = UiLanguage.text("VRAM insuficiente. Preparando reintento en CPU…");
      $("progBar").style.width = "0%";
      state.loaded = null;
      if (!(await startEngine(state.engine, true))) throw new Error(UiLanguage.text("no se pudo iniciar el reintento en CPU"));
      if (state.stop) return null;
      const { tae, ...models } = state.modelRequest.models;
      await requireResources({}, await invoke("model_bytes", { files: Object.values(models) }));
      await engineRequest("/sdcpp/v1/models/load", { method: "POST", body: JSON.stringify({ ...state.modelRequest, models }) }, 180000);
      if (state.stop) return null;
      state.previewMode = "proj";
      body.preview = "proj";
      $("progStage").textContent = UiLanguage.text("Reintentando en CPU con pesos mapeados desde disco…");
      setStatus(UiLanguage.text("VRAM insuficiente · continuando en CPU"), "warn");
      sub = await submitImage(body);
      sampStart = null;
      sampMs = 0;
    }
    if (j.status === "cancelled") return null;
  }
}

/** VAE por mosaicos: en Vulkan hace fallar la gráfica (ErrorDeviceLost en la GTX 1650), así que
 *  solo se usa con CUDA en el perfil bajo. Sin mosaicos, Vulkan decodifica 832×1216 en ~23 s. */
function vaeTiling() { return state.cpuRecovery || (state.engine || state.hw.engine) === "cuda" && state.hw.profile === "bajo"; }

function showImage(src, final = true) {
  $("result").src = src;
  $("canvas").classList.toggle("previewing", !final);
  if (final) { state.currentImage = src; $("useLast").disabled = false; }
  $("canvas").classList.add("has");
}

function readFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(UiLanguage.text("No se pudo leer la imagen")));
    reader.readAsDataURL(file);
  });
}

// Ajusta la foto al máximo del perfil y a múltiplos de 64 (lo que pide el motor).
async function prepareEditImage(src) {
  const image = await new Promise((resolve, reject) => {
    const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(UiLanguage.text("formato no válido"))); img.src = src;
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
    usePreparedEditImage(await prepareEditImage(src));
  } catch (e) { setStatus(UiLanguage.text("No se pudo abrir la foto: ") + e.message, "err"); }
}

function usePreparedEditImage(image) {
  state.editImage = image;
  if (typeof Mask !== "undefined") Mask.paint = null;
  state.editMask = null;
  $("editPreview").src = image.src;
  $("editPreview").classList.add("on"); $("editEmpty").classList.add("off");
  $("editPreview").title = `${image.w} × ${image.h}`;
  setMode("edit");
}

/** Editar una foto está dentro de Crear (como el teléfono): con foto se genera a partir de ella. */
function setMode(mode) {
  // con «Usar la imagen como referencia del personaje» la foto no es el punto de partida (no hay img2img)
  const ref = typeof Ref !== "undefined" && Ref.on();
  const mage = REF_FAMILIES.includes(currentOption()?.family);
  state.mode = mode === "edit" && state.editImage && !ref && !mage ? "edit" : "gen";
  $("editBox").classList.toggle("mage-on", mage);
  const has = !!state.editImage;
  $("editBox").classList.toggle("ref-on", ref);
  $("editClear").classList.toggle("hidden", !has);
  $("editBox").classList.toggle("on", has);
  if (has && typeof Acc !== "undefined") Acc.open("edit");
  $("editHint").textContent = !has ? UiLanguage.text("Elige una foto para generar a partir de ella (imagen a imagen), o márcala como referencia del personaje para copiar su aspecto.")
    : ref ? UiLanguage.text("Personaje de referencia: se copia su aspecto, no la foto. El tamaño es el de «Tamaño».")
    : UiLanguage.template`Se genera a partir de esta foto (${state.editImage.w} × ${state.editImage.h}).`;
  if (!has) state.editMask = null;
  if (typeof Mask !== "undefined") { if (!has) Mask.paint = null; Mask.refresh(); }
  updateGenLabel();
}

function updateGenLabel() {
  $("genBtn").textContent = state.mode === "edit" ? UiLanguage.text("Generar desde la foto") : UiLanguage.text("Generar");
  const [w, h] = state.mode === "edit" && state.editImage ? [state.editImage.w, state.editImage.h] : currentSize();
  if (state.mode === "edit" && state.editImage) { $("sizeTxt").textContent = UiLanguage.template`Editando a ${w} × ${h}: el tamaño de la foto`; if (typeof Hires !== "undefined") Hires.refresh(); }
  else updateSizeTxt();
}

async function upscaleCurrent() {
  if (!state.currentImage || state.busy) return;
  state.busy = true; $("upscaleBtn").disabled = true;
  setStatus(UiLanguage.text("Ampliando imagen…"));
  try {
    const result = await submitUpscale({ image: state.currentImage, upscaler: state.upscaler, repeats: 1, output_format: "png" });
    const image = result.images?.[0]?.b64_json;
    if (!image) throw new Error(UiLanguage.text("El motor no devolvió una imagen ampliada"));
    const base = Session.cur()?.meta || {};
    const meta = { ...base, width: result.width, height: result.height, upscaled: result.upscaler || "ESRGAN", created: new Date().toISOString() };
    const name = await invoke("save_image", { b64: image, prefix: "upscale", meta });
    Session.add({ name, src: "data:image/png;base64," + image, meta, before: state.currentImage });
    setStatus(UiLanguage.template`Ampliación lista · ${result.width} × ${result.height} · ${result.upscaler || "ESRGAN"}`, "ok");
  } catch (e) {
    setStatus(UiLanguage.text("No se pudo ampliar: ") + e.message, "err");
  } finally {
    state.busy = false; $("upscaleBtn").disabled = false;
    $("genBtn").disabled = !currentOption();
  }
}

$("editFile").onchange = async () => {
  const file = $("editFile").files?.[0];
  if (file) await setEditImage(await readFileDataUrl(file));
  $("editFile").value = "";
};
$("useLast").onclick = () => { if (state.currentImage) setEditImage(state.currentImage); };
$("editClear").onclick = () => {
  state.editImage = null;
  if (typeof Ref !== "undefined") { $("refUse").checked = false; Ref.render(); }
  $("editPreview").classList.remove("on"); $("editPreview").removeAttribute("src"); $("editEmpty").classList.remove("off");
  setMode("gen");
};
$("upscaleBtn").onclick = () => Upscale.open();


/** opts (para ↻ Otra vez y Variaciones): {count, newSeed, init: {src,w,h}, strength}.
 *  init = "Parecidas a esta imagen": img2img desde esa imagen sin tocar la pestaña Editar foto. */
async function generate(opts = {}) {
  const opt = currentOption();
  if (!opt || state.busy) return;
  if (!$("prompt").value.trim()) { $("prompt").focus(); return; }
  state.busy = true; state.stop = false; state.safetyStop = false;
  $("genBtn").disabled = true; $("loadBtn").disabled = true; $("stopBtn").disabled = false;
  let saved;
  try {
    if (!(await Ad.ensure(true)) || state.stop) return;
    if (typeof Pose !== "undefined" && !(await Pose.ensure())) return;
    // Con la RAM casi llena el motor tiene que esperar al disco y cada paso tarda el doble o más.
    const memory = await refreshMemory();
    if (memory?.ram_free_gb != null && memory.ram_free_gb < 2.5) toast(UiLanguage.template`Queda poca RAM libre (${memory.ram_free_gb.toFixed(1)} GB): cierra programas como el navegador o Discord para que no vaya más lento.`, 7000);
    if (state.stop) return;
    const plan = generationEngine(opt, memory);
    if (state.loaded !== opt.id || plan.engine !== state.engine || plan.limitedCpu !== !!state.cpuRecovery) {
      await loadModel(plan, true);
      if (state.loaded !== opt.id) return;
    }

    if (state.stop) return;
    saved = opts.init ? { mode: state.mode, img: state.editImage, str: $("editStrength").value, mask: state.editMask } : null;
    if (opts.init) { state.mode = "edit"; state.editImage = opts.init; state.editMask = opts.mask || null; $("editStrength").value = String(Math.round((opts.strength ?? 0.45) * 100)); }
    $("progress").classList.add("on");
    store.set("params:" + opt.id, { steps: +$("steps").value, cfg: +$("cfg").value, sampler: $("sampler").value, scheduler: $("scheduler").value, neg: $("neg").value });
    store.set("prompt", $("prompt").value);
    rememberPrompt($("prompt").value.trim(), $("neg").value.trim());
    // ⊞ Comparar 2×2: siempre 4 imágenes y el lote no se puede ampliar
    const grid = opts.grid || 0;
    state.batchTarget = grid ? 4 : Math.min(999, Math.max(1, opts.count || parseInt($("count").value, 10) || 1));
    let seed = opts.newSeed ? -1 : parseInt($("seed").value, 10);
    if (!(seed >= 0)) seed = Math.floor(Math.random() * 2 ** 31);
    $("extendBatch").disabled = !!grid;
    const made = [], labels = [];
    for (let i = 0; i < state.batchTarget && !state.stop; i++) {
      await waitIfHot();
      if (state.stop) break;
      const g = grid ? Grids.plan(grid, i, seed) : { seed: seed + i };
      const status = state.batchTarget > 1 ? UiLanguage.template`Imagen ${i + 1} de ${state.batchTarget} · ${g.label || "seed " + g.seed}` : UiLanguage.template`Generando · seed ${seed}`;
      setStatus(state.cpuRecovery ? UiLanguage.template`${status} · CPU limitada por perfil térmico` : status);
      const r = await runOne(opt, g.seed, g);
      if (!r) { setStatus(UiLanguage.text("Detenido."), "warn"); break; }
      made.push(r); if (grid) labels.push(g.label);
      setStatus(UiLanguage.template`Lista en ${fmtS(r.total)} · seed ${g.seed} · guardada en outputs`, "ok");
    }
    // Lote de 2 o más: hojas de contacto; comparación: la cuadrícula 2×2 (no si se detuvo)
    if (!state.stop && typeof Grids !== "undefined") await Grids.finish(grid, made, labels);
  } catch (e) {
    const s = await invoke("server_status");
    $("serverLog").textContent = s.log || "";
    setStatus("Error: " + e.message, "err");
  } finally {
    if (saved) { state.mode = saved.mode; state.editImage = saved.img; state.editMask = saved.mask; $("editStrength").value = saved.str; }
    // Detenido o fallido: no dejar en pantalla la vista previa a medio hacer.
    if ($("canvas").classList.contains("previewing")) { const c = Session.cur(); if (c) showImage(c.src); else Session.clear(); }
    state.busy = false; state.job = null; state.cancelPromise = null; state.safetyStop = false;
    $("progress").classList.remove("on");
    $("extendBatch").disabled = true;
    $("genBtn").disabled = !opt; $("loadBtn").disabled = false; $("stopBtn").disabled = true;
    showEstimate();
  }
}

$("extendBatch").onclick = () => {
  if (!state.busy) return;
  const add = Math.max(1, parseInt($("count").value, 10) || 1);
  const previous = state.batchTarget;
  state.batchTarget = Math.min(999, previous + add);
  $("count").value = String(state.batchTarget - previous);
  setStatus(UiLanguage.template`Cola ampliada: ${state.batchTarget} imágenes · se añadirán con la seed siguiente.`, "ok");
};

$("stopBtn").onclick = () => {
  state.stop = true;
  // A job id enables cooperative cancellation. Before one exists (for example while
  // loading weights), stop only the backend process tree owned by this app.
  if (state.job && state.api) {
    const path = "/sdcpp/v1/jobs/" + state.job + "/cancel";
    state.cancelPromise ||= fetch(state.api + path, { method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(2500) }).catch(() => null);
  } else {
    state.loaded = null;
    state.engine = null;
    state.device = null;
    invoke("stop_server").catch(() => {});
  }
};

// ---------- controles ----------
// Campos numéricos escritos a mano: acepta coma decimal y, al salir del campo,
// ajusta el valor a su mínimo, máximo y paso.
function readNum(el) { return parseFloat(String(el.value).replace(",", ".")); }
function clampNum(el, fallback) {
  const min = +el.min, max = +el.max, step = +el.step || 1;
  let v = readNum(el);
  if (!Number.isFinite(v)) v = fallback ?? min;
  v = Math.min(max, Math.max(min, Math.round(v / step) * step));
  el.value = String(+v.toFixed(2));
  return v;
}
function syncLabels() { /* los campos muestran su propio valor */ }
$("steps").oninput = showEstimate;
$("steps").onchange = () => { clampNum($("steps"), 20); showEstimate(); };
$("cfg").onchange = () => clampNum($("cfg"), 5);
$("editStrength").onchange = () => clampNum($("editStrength"), 45);
for (const id of ["steps", "cfg", "editStrength", "count", "customW", "customH"]) {
  $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });
}
$("prompt").addEventListener("input", updatePromptMeta);
$("weightDown").onclick = () => adjustPromptWeight(-0.1);
$("weightUp").onclick = () => adjustPromptWeight(0.1);
$("saveTemplate").onclick = async () => {
  const prompt = $("prompt").value.trim();
  if (!prompt) { $("prompt").focus(); return; }
  const r = await ask({
    title: UiLanguage.text("Guardar plantilla"), input: { value: prompt.slice(0, 32), placeholder: UiLanguage.text("Nombre de la plantilla") },
    buttons: [{ label: UiLanguage.text("Cancelar"), value: null }, { label: UiLanguage.text("Guardar"), value: "@input", primary: true }],
  });
  const name = r?.input;
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
  $("genBtn").disabled = false;
  if (state.loaded !== opt.id) setStatus(UiLanguage.text("No está en memoria · se carga al generar"));
};
$("loadBtn").onclick = () => loadModel();
$("genBtn").onclick = () => generate();
$("prompt").addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) generate(); });
// (la barra de la imagen la maneja session.js)
for (const b of document.querySelectorAll("[data-open]")) b.onclick = () => invoke("open_folder", { which: b.dataset.open });

for (const n of document.querySelectorAll(".nav")) {
  n.onclick = () => {
    document.querySelectorAll(".nav").forEach((x) => x.classList.toggle("on", x === n));
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("on", p.id === "page-" + n.dataset.page));
    if (n.dataset.page === "settings") invoke("server_status").then((s) => { $("serverLog").textContent = s.log || ""; });
  };
}

$("optOffload").checked = store.get("offload", true);
$("optLanguage").onchange = () => {
  if (state.busy) {
    $("optLanguage").value = UiLanguage.selected;
    return toast(UiLanguage.text("Espera a que termine la generación para cambiar el idioma."));
  }
  try {
    UiLanguage.set($("optLanguage").value);
    store.set("prompt", $("prompt").value);
    location.reload();
  } catch {
    $("optLanguage").value = UiLanguage.selected;
    toast(UiLanguage.text("No se pudo guardar el idioma."));
  }
};
$("optEngine").value = store.get("enginePref", "auto");
$("optEngine").onchange = () => { store.set("enginePref", $("optEngine").value); toast(UiLanguage.text("Se aplica al pulsar Reiniciar motor (o al cargar otro modelo)"), 4000); };
$("optExtra").value = store.get("extra", "");
$("optHideConsole").checked = store.get("hideConsole", true);
$("optHideConsole").onchange = async () => {
  const hide = $("optHideConsole").checked;
  store.set("hideConsole", hide);
  try { await invoke("set_console_visible", { visible: !hide }); }
  catch (e) { setStatus(UiLanguage.template`No se pudo cambiar la ventana CMD: ${e.message || e}`, "warn"); }
};
$("restartBtn").onclick = async () => {
  if (state.busy) return;
  store.set("offload", $("optOffload").checked);
  store.set("extra", $("optExtra").value.trim());
  state.loaded = null; $("genBtn").disabled = true;
  try {
    if (await startEngine(engineFor(currentOption()))) { await refreshEngineMenus(); await scanModels(); await Loras.refresh(); $("genBtn").disabled = !currentOption(); }
  } catch (error) { setStatus(UiLanguage.text("No se pudo iniciar el motor seleccionado: ") + error.message, "err"); }
};

// ---------- arranque: abrir el exe y que cargue todo solo ----------
(async function boot() {
  $("prompt").value = store.get("prompt", "");
  fillPromptLists(); updatePromptMeta();
  state.aspect = store.get("aspect", "p");
  const cs = store.get("customSize", null);
  if (Array.isArray(cs) && cs.length === 2) { $("customW").value = align64(cs[0]); $("customH").value = align64(cs[1]); }
  document.querySelectorAll("#aspect button").forEach((x) => x.classList.toggle("on", x.dataset.a === state.aspect));
  syncLabels(); updateSizeTxt();
  try {
    const info = await invoke("app_info");
    state.hw = info.hardware;
    state.engines = info.engines || [];
    state.torchCuda = info.torch_cuda;
    state.version = info.version;
    // La consola solo existe en compilaciones de desarrollo; en el .exe final no hay opción.
    if (info.debug) {
      $("optConsoleRow").classList.remove("hidden");
      invoke("set_console_visible", { visible: !store.get("hideConsole", true) }).catch(() => {});
    }
    renderHw(state.hw);
    if (typeof EngineDl !== "undefined") EngineDl.maybeWelcome();  // NVIDIA sin motor rápido: ofrecerlo
    refreshMemory();
    setInterval(refreshMemory, 3000);
    // el motor del último modelo usado (Anima → CUDA) para no arrancarlo dos veces
    const lastFamily = String(store.get("model", "")).startsWith("anima:") ? "anima" : "sdxl";
    const bootEngine = engineFor({ family: lastFamily });
    if (state.engines.includes(bootEngine)) {
      try {
        if (!(await startEngine(bootEngine))) return;
      } catch (error) {
        setStatus(UiLanguage.text("No se pudo iniciar el motor seleccionado: ") + error.message, "warn");
      }
    } else {
      setStatus(UiLanguage.text("El motor seleccionado no está instalado. Instálalo en Ajustes o selecciona Automático."), "warn");
    }
    await refreshEngineMenus();
    await scanModels();
    // sin modelos: la bienvenida ofrece descargar uno (después del paso del motor rápido)
    if (typeof Packs !== "undefined") { Packs.modelsKnown = true; Packs.next(); }
    await Loras.refresh();
    const opt = currentOption();
    // no se carga al abrir (llenaba la RAM sin generar): se carga al pulsar Generar o «Cargar modelo»
    if (opt) { applyPreset(opt); $("genBtn").disabled = false; setStatus(UiLanguage.text("No está en memoria · se carga al generar")); }
  } catch (e) {
    setStatus(UiLanguage.text("Error al iniciar: ") + (e.message || e), "err");
  }
})();

// ---------- ↻ Actualizar: modelos / LoRAs / ampliadores / detectores copiados a mano ----------
async function refreshAll() {
  if (state.busy) return toast(UiLanguage.text("Espera a que termine la generación"));
  const btns = [$("refreshBtn"), $("lpRefresh")];
  for (const b of btns) b?.classList.add("spinning");
  try {
    const before = { models: state.options.length, loras: Loras.lib.length };
    await api("/sdcpp/v1/models/refresh", { method: "POST" }).catch(() => {});
    await scanModels();
    await Loras.refresh();
    await refreshEngineMenus().catch(() => {});
    if (typeof Ad !== "undefined") await Ad.load();
    if (LoraPage.visible()) await LoraPage.show();
    if ($("page-history").classList.contains("on")) await History.show();
    // El motor solo lee la carpeta de ampliadores al arrancar.
    let upNote = "";
    try {
      const st = await invoke("upscaler_status");
      if (st.some((u) => u.installed && !state.upscalers.includes(u.stem))) upNote = UiLanguage.text("\nAmpliador nuevo: aparecerá al reiniciar el motor (Ajustes → Reiniciar motor).");
    } catch { /* vista previa */ }
    const dm = state.options.length - before.models, dl = Loras.lib.length - before.loras;
    const diff = (n, a, b) => (n > 0 ? ` (+${n} ${n === 1 ? a : b})` : n < 0 ? ` (${n})` : "");
    toast(UiLanguage.template`Actualizado · ${state.options.length} modelos${diff(dm, UiLanguage.text("nuevo"), UiLanguage.text("nuevos"))} · ${Loras.lib.length} LoRAs${diff(dl, UiLanguage.text("nuevo"), UiLanguage.text("nuevos"))}${upNote}`, 4500);
  } catch (e) { toast(UiLanguage.text("No se pudo actualizar: ") + (e.message || e), 5000); }
  finally { for (const b of btns) b?.classList.remove("spinning"); }
}
$("refreshBtn").onclick = refreshAll;
$("lpRefresh").onclick = refreshAll;


/** Libera el modelo. El motor rápido suelta también ControlNet, IP-Adapter, ampliadores… y dice cuánta RAM le
 *  queda; si sigue por encima de lo que ocupa PyTorch solo (~2-3 GB), se reinicia el proceso: así la RAM
 *  vuelve entera a Windows. La próxima generación arranca unos segundos más tarde. */
const ENGINE_IDLE_MB = 4500;
async function unloadModel() {
  const r = await api("/sdcpp/v1/models/unload", { method: "POST" });
  state.loaded = null;
  invoke("translate_stop").catch(() => {}); // el traductor ES→EN (~1 GB) también se cierra; se abre al traducir
  // PyTorch en Windows se guarda la memoria liberada para reusarla y no se la devuelve al sistema: medido con el
  // ControlNet, el objeto se libera pero el proceso sigue en 5,4 GB. Un motor anterior a la 0.2.1 no dice
  // cuánto ocupa (sin rss_mb): también se reinicia.
  if (state.engine === "torch" && !(r?.rss_mb <= ENGINE_IDLE_MB)) {
    setStatus(r?.rss_mb ? UiLanguage.template`El motor seguía ocupando ${(r.rss_mb / 1024).toFixed(1)} GB: reiniciándolo para devolver la RAM…` : UiLanguage.text("Reiniciando el motor para devolver la RAM…"));
    await startEngine("torch");
  }
  refreshMemory();
  return r;
}

// ---------- Liberar el modelo tras unos minutos sin generar ----------
// Cargado, el motor ocupa 7-8 GB de RAM aunque no se use: con la app abierta en segundo plano el
// resto del PC se queda sin memoria. Se libera solo y se vuelve a cargar al pulsar Generar.
const Idle = {
  last: Date.now(),
  touch() { this.last = Date.now(); },
  async check() {
    const mins = Number(store.get("idleUnload", 10));
    if (!mins || !state.loaded || state.busy || Date.now() - this.last < mins * 60000) return;
    try {
      await unloadModel();
      setStatus(UiLanguage.template`Modelo liberado tras ${mins} min sin generar · se carga al generar`, "");
    } catch { /* motor ocupado o reiniciándose: se intenta en el siguiente minuto */ }
    this.touch();
  },
};
// Tema: oscuro (por defecto), claro o el de Windows
const Theme = {
  mq: window.matchMedia("(prefers-color-scheme: light)"),
  apply() {
    const t = store.get("theme", "dark");
    document.documentElement.dataset.theme = t === "system" ? (this.mq.matches ? "light" : "dark") : t;
  },
};
Theme.apply();
Theme.mq.addEventListener("change", () => Theme.apply());
$("optTheme").value = store.get("theme", "dark");
$("optTheme").onchange = () => { store.set("theme", $("optTheme").value); Theme.apply(); };
$("optIdle").value = String(store.get("idleUnload", 10));
$("optIdle").onchange = () => { store.set("idleUnload", Number($("optIdle").value)); Idle.touch(); };
$("genBtn").addEventListener("click", () => Idle.touch());
$("loadBtn").addEventListener("click", () => Idle.touch());
setInterval(() => { if (state.busy) Idle.touch(); else Idle.check(); }, 30000);
