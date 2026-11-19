// Sustituto de window.__TAURI__ para la vista previa en navegador (solo desarrollo).
// Hardware simulado como la PC de pruebas; motor = sd-server real en SD_PORT; Civitai = API real.
(function () {
  const SD_PORT = +(new URLSearchParams(location.search).get("sd") || 18780);
  const fakeOutputs = [
    { name: "20261117-152520-sdxl.png", bytes: 1612000 },
    { name: "20261117-151124-anima.png", bytes: 985000 },
  ];
  const loras = [
    { file: "FrierenK112.safetensors", stem: "FrierenK112", folder: "", name: null, alias: null, cat: "character", words: ["frieren", "elf", "pointy ears"], base: "SDXL", bytes: 228646924, fav: true, preview: "https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/2b51113d-1a94-4635-9651-fe5778760f54/width=320/118378407.jpeg" },
    { file: "watercolor_v2.safetensors", stem: "watercolor_v2", folder: "Estilos", name: "Watercolor Style", alias: null, cat: "style", words: ["watercolor"], base: "Illustrious", bytes: 145000000 },
    { file: "anima_turbo_lora.safetensors", stem: "anima_turbo_lora", folder: "", name: "Anima Turbo LoRA", alias: null, cat: null, words: [], base: "Anima", bytes: 98000000 },
  ];
  const title = (l) => l.alias || l.name || l.stem;
  const listeners = {};
  const civ = async (path) => (await fetch("https://civitai.red/api/v1" + path)).json();
  const handlers = {
    app_info: () => ({
      root: "C:\\HexAnima", version: "0.1.0-preview", engines: new URLSearchParams(location.search).has("notorch") ? ["vulkan", "cuda"] : ["torch", "vulkan", "cuda"], debug: false,
      hardware: {
        gpu: { name: "NVIDIA GeForce GTX 1650", vendor: "nvidia", vram_gb: 4, driver: "616.56" },
        ram_gb: 15.6, engine: "vulkan", engine_candidates: ["vulkan", "cuda", "cpu"], backend_device: "vulkan1", profile: "medio",
      },
    }),
    memory: () => ({ ram_total_gb: 15.6, ram_free_gb: 7.2, vram_total_gb: 4, vram_free_gb: 2.9, gpu_temp_c: 51, on_battery: true }),
    start_server: ({ engine }) => ({ port: SD_PORT, engine: engine || "vulkan", device: "vulkan1" }),
    server_status: () => ({ running: true, port: SD_PORT, log: "[I] vista previa: motor externo en " + SD_PORT }),
    save_image: () => "outputs\\preview.png",
    storage_info: () => ({ free: 379e9, groups: [
      { title: "MODELOS", items: [{ id: "models/checkpoints", title: "Checkpoints", sub: "Modelos SDXL / Illustrious / Pony completos", bytes: 13.9e9, action: "open" }, { id: "loras", title: "LoRAs", sub: "Se gestionan en LoRAs", bytes: 2.1e9, action: "open" }] },
      { title: "MOTORES", items: [{ id: "engine/torch", title: "Motor rápido (PyTorch)", sub: "Se puede volver a descargar en Ajustes", bytes: 4.7e9, action: "" }, { id: "engine-leftovers", title: "Restos del motor rápido", sub: "Descarga a medias o copia del motor anterior", bytes: 1.2e9, action: "clear" }] },
      { title: "CACHÉS", items: [{ id: "cache", title: "Caché", sub: "Archivos temporales", bytes: 0, action: "clear" }, { id: "logs", title: "Registros", sub: "Lo que escribe el motor", bytes: 3.4e6, action: "clear" }] },
      { title: "IMÁGENES", items: [{ id: "outputs", title: "Imágenes", sub: "Tus imágenes", bytes: 2.6e9, action: "open" }] } ] }),
    storage_clear: () => 1.2e9,
    logs_export: () => "C:/Users/demo/hexanima-registros.zip",
    output_files: () => fakeOutputs,
    read_output: async ({ name }) => { const b = await (await fetch("/__outputs/" + name)).arrayBuffer(); let s = ""; const u = new Uint8Array(b); for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); },
    open_folder: () => null,
    reveal_file: () => null,
    set_console_visible: () => null,
    open_url: ({ url }) => { window.open(url, "_blank"); },
    lora_list: () => loras.map((l) => ({ ...l, title: title(l) })),
    lora_set_meta: ({ file, patch }) => {
      const l = loras.find((x) => x.file === file);
      if (patch.alias != null) l.alias = patch.alias || null;
      if (patch.cat != null) l.cat = patch.cat === "none" ? null : patch.cat;
      if (patch.words) l.words = patch.words.map((w) => w.trim()).filter(Boolean);
    },
    lora_trash: ({ file }) => { loras.splice(loras.findIndex((x) => x.file === file), 1); },
    lora_import: () => ({ imported: [], failed: [] }),
    downloaded_index: () => ({ ids: [], names: loras.map((l) => l.stem.toLowerCase()) }),
    civitai_search: async ({ params: p }) => {
      const q = new URLSearchParams({ limit: "20" });
      if (p.query) q.append("query", p.query); else if (p.sort) q.append("sort", p.sort);
      if (p.tag) q.append("tag", p.tag);
      for (const t of p.types) q.append("types", t);
      for (const b of p.base_models) q.append("baseModels", b);
      q.append("nsfw", p.nsfw ? "true" : "false");
      if (p.cursor) q.append("cursor", p.cursor);
      if (p.favorites) throw new Error("vista previa: favoritos requiere la app");
      return civ("/models?" + q);
    },
    civitai_model: ({ id }) => civ("/models/" + id),
    civitai_download: async ({ req }) => {
      for (let i = 1; i <= 10; i++) {
        await new Promise((r) => setTimeout(r, 150));
        (listeners["dl-progress"] || []).forEach((f) => f({ payload: { id: req.id, done: i * 2e7, total: 2e8, state: i < 10 ? "downloading" : "done" } }));
      }
      return req.file_name;
    },
    civitai_cancel: () => null,
    gallery_list: async () => (await fetch("/__gallery")).json(),
    gallery_fav: () => null,
    gallery_trash: () => null,
    gallery_zip: ({ names }) => "C:\Users\demo\Downloads\HexAnima-" + names.length + ".zip",
    gallery_reveal: () => null,
    lora_folders: () => ["Personajes", "Estilos"],
    lora_make_folder: ({ name }) => name,
    lora_move: ({ file, folder }) => { const l = loras.find((x) => x.file === file); l.folder = folder; return file; },
    lora_presets_get: () => presets,
    lora_presets_set: ({ presets: p }) => { presets.splice(0, presets.length, ...p); },
    lora_fetch_info: async () => ({ found: true }),
    upscaler_status: () => [{ kind: 'fast', stem: 'RealESRGAN_x4plus_anime_6B', installed: true }, { kind: 'detail', stem: '4x-UltraSharp', installed: false }],
    upscaler_download: async () => 'ok',
    vae_import: async () => null,
    engine_dl_info: () => ({ installed: null, free_bytes: 120e9, partial_bytes: 0,
      remote: { version: 1, file: "hexanima-motor-pytorch-1.zip", bytes: 2.6e9, sha256: "x", unpacked_bytes: 4.6e9, files: 22000 } }),
    engine_download: () => new Promise((ok) => {
      let i = 0; const st = ["download", "download", "download", "download", "verify", "extract", "extract"];
      const t = setInterval(() => {
        const s = st[Math.min(i, st.length - 1)];
        (listeners["dl-progress"] || []).forEach((f) => f({ payload: { id: "engine-torch", stage: s, done: (i % 4 + 1) * 6.5e8, total: 2.6e9 } }));
        if (++i > st.length) { clearInterval(t); ok({ version: 1 }); }
      }, 700);
    }),
    pack_status: () => ({ anima: { bytes: 5628171998, have: 0, installed: false } }),
    pack_download: () => new Promise((ok) => {
      let i = 0;
      const t = setInterval(() => {
        (listeners["dl-progress"] || []).forEach((f) => f({ payload: { id: "pack-anima", stage: "download", done: i * 7e8, total: 5628171998 } }));
        if (++i > 8) { clearInterval(t); ok(null); }
      }, 600);
    }),
    engine_dl_cancel: () => null,
    asset_status: () => [{ kind: 'sdxl_vae', file: 'vae/sdxl_vae_fp16_fix.safetensors', mb: 335, installed: false }, { kind: 'taesdxl', file: 'vae_approx/taesdxl_decoder.pth', mb: 5, installed: false }, { kind: 'dmd2', file: '@loras/dmd2_sdxl_4step_lora_fp16.safetensors', mb: 394, installed: true }, { kind: 'tagger', file: 'tagger/wd-vit-tagger-v3.safetensors', mb: 378, installed: true }, { kind: 'tagger_tags', file: 'tagger/wd-vit-tagger-v3.csv', mb: 1, installed: true }, { kind: 'ipadapter', file: 'ipadapter/noobIPAMARK1_mark1.safetensors', mb: 1405, installed: true }, { kind: 'clip_vision', file: 'clip_vision/clip_vision_g.safetensors', mb: 3690, installed: true }],
    asset_download: async ({ kind }) => kind,
    detector_status: () => [{ kind: 'face', installed: true }, { kind: 'hand', installed: false }],
    detector_install: async () => 'ok',
    ad_detections: () => ({ seq: 0, items: [] }),
    store_get: ({ key }) => { try { return JSON.parse(localStorage.getItem("stub:" + key)); } catch { return null; } },
    store_set: ({ key, value }) => { localStorage.setItem("stub:" + key, JSON.stringify(value)); },
  };
  const presets = [{ name: "Frieren 3D", loras: [{ stem: "FrierenK112", w: 0.8 }, { stem: "watercolor_v2", w: 0.4 }] }];
  window.__TAURI__ = {
    core: {
      // Equivale a convertFileSrc de Tauri: outputs/ y loras/ los sirve el servidor de vista previa.
      convertFileSrc: (p) => {
        const s = String(p).replace(/\\/g, "/");
        const i = s.search(/\/(outputs|loras)\//);
        return i < 0 ? s : (s.slice(i).startsWith("/outputs/") ? "/__outputs/" + s.slice(i + 9) : "/__loras/" + s.slice(i + 7));
      },
      invoke: async (cmd, args) => {
        if (!(cmd in handlers)) throw new Error("stub: comando desconocido " + cmd);
        return handlers[cmd](args || {});
      },
    },
    event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
  };
})();
