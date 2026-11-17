// Sustituto de window.__TAURI__ para la vista previa en navegador (solo desarrollo).
// Hardware simulado como la PC de pruebas; motor = sd-server real en SD_PORT; Civitai = API real.
(function () {
  const SD_PORT = +(new URLSearchParams(location.search).get("sd") || 18780);
  const fakeOutputs = [
    { name: "20261117-152520-sdxl.png", bytes: 1612000 },
    { name: "20261117-151124-anima.png", bytes: 985000 },
  ];
  const loras = [
    { file: "FrierenK112.safetensors", stem: "FrierenK112", name: null, alias: null, cat: "character", words: ["frieren", "elf", "pointy ears"], base: "SDXL", bytes: 228646924 },
    { file: "watercolor_v2.safetensors", stem: "watercolor_v2", name: "Watercolor Style", alias: null, cat: "style", words: ["watercolor"], base: "Illustrious", bytes: 145000000 },
    { file: "anima_turbo_lora.safetensors", stem: "anima_turbo_lora", name: "Anima Turbo LoRA", alias: null, cat: null, words: [], base: "Anima", bytes: 98000000 },
  ];
  const title = (l) => l.alias || l.name || l.stem;
  const listeners = {};
  const civ = async (path) => (await fetch("https://civitai.com/api/v1" + path)).json();
  const handlers = {
    app_info: () => ({
      root: "C:\\HexAnima", version: "0.1.0-preview", debug: false,
      hardware: {
        gpu: { name: "NVIDIA GeForce GTX 1650", vendor: "nvidia", vram_gb: 4, driver: "616.56" },
        ram_gb: 15.6, engine: "vulkan", engine_candidates: ["vulkan", "cuda", "cpu"], backend_device: "vulkan1", profile: "medio",
      },
    }),
    memory: () => ({ ram_total_gb: 15.6, ram_free_gb: 7.2, vram_total_gb: 4, vram_free_gb: 2.9, gpu_temp_c: 51 }),
    start_server: () => SD_PORT,
    server_status: () => ({ running: true, port: SD_PORT, log: "[I] vista previa: motor externo en " + SD_PORT }),
    save_image: () => "outputs\\preview.png",
    output_files: () => fakeOutputs,
    read_output: () => "",
    open_folder: () => null,
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
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (!(cmd in handlers)) throw new Error("stub: comando desconocido " + cmd);
        return handlers[cmd](args || {});
      },
    },
    event: { listen: async (name, fn) => { (listeners[name] ||= []).push(fn); return () => {}; } },
  };
})();
