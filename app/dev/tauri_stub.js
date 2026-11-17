// Sustituto de window.__TAURI__ para la vista previa en navegador (solo desarrollo).
// Los datos de hardware imitan la PC de pruebas; el motor es el sd-server real en SD_PORT.
(function () {
  const SD_PORT = +(new URLSearchParams(location.search).get("sd") || 18780);
  const fakeOutputs = [
    { name: "20261117-152520-sdxl.png", bytes: 1612000 },
    { name: "20261117-151124-anima.png", bytes: 985000 },
    { name: "20261117-130129-anima.png", bytes: 973000 },
  ];
  const handlers = {
    app_info: () => ({
      root: "C:\\HexAnima",
      version: "0.1.0-preview",
      hardware: {
        gpu: { name: "NVIDIA GeForce GTX 1650", vendor: "nvidia", vram_gb: 4, driver: "616.56" },
        ram_gb: 15.6, engine: "vulkan", engine_candidates: ["vulkan", "cuda", "cpu"],
        backend_device: "vulkan1", profile: "medio",
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
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (!(cmd in handlers)) throw new Error("stub: comando desconocido " + cmd);
        return handlers[cmd](args || {});
      },
    },
  };
})();
