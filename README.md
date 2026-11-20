# HexAnima PC

**[🇪🇸 Leer en español](README.es.md)**

Generate images locally on Windows with your GPU, without a cloud account. HexAnima supports NVIDIA, AMD, and Intel graphics, with a CPU fallback for supported workloads.

> **Hardware note:** Performance and model compatibility depend on available RAM and VRAM. Low-memory profiles can take much longer, and some models or resolutions may not fit. Read the release notes for the hardware tested in each version.

## Download and install

1. Download **`HexAnima-PC-<version>.zip`** from [Releases](https://github.com/GrimmDev-Glitch/hexanima-pc/releases/latest).
2. Extract the folder anywhere. No installer or administrator permissions are required.
3. Open **`HexAnima.exe`** and follow the setup prompts. The app can offer the PyTorch engine for NVIDIA GPUs and a starter model.

Requirements: 64-bit Windows 10/11, at least 8 GB of RAM (16 GB recommended), and an NVIDIA, AMD, or Intel GPU. CPU-only operation is available for compatible jobs and is substantially slower.

## Features

- Generate with SDXL, Illustrious, Pony, and Anima, including LoRAs, Hires fix, face and hand correction, inpainting, upscaling, and image corrections.
- Browse and download models and LoRAs from Civitai; organize LoRAs into collections.
- Keep a local image history with saved generation settings and ZIP export.
- Read tags from an image to create a prompt. The tagger uses CPU on PC to avoid taking VRAM from image generation.
- Switch the app interface between Spanish and English in **Settings → Language**.
- Portable storage: models, LoRAs, generated images, and settings live beside `HexAnima.exe`. Copy the whole folder to move the installation.

## Hardware profiles and engines

HexAnima detects the available GPU, memory, and supported backend. Its profile adjusts safety thresholds and memory checks. On Windows, the protected CPU fallback limits engine CPU time and reserves memory for the system. These safeguards cannot guarantee that every model or resolution will run on every PC.

| Hardware / model family | Engine |
|---|---|
| NVIDIA with SDXL / Illustrious / Pony | PyTorch can be selected in Settings; CUDA is also available |
| NVIDIA with Anima | CUDA |
| AMD / Intel | Vulkan |
| No compatible GPU | Limited CPU mode, where supported |

The PyTorch engine is downloaded separately from the app. Some models need substantially more memory than others; start with smaller dimensions on low-memory PCs.

## Folder layout

```text
HexAnima.exe
engine/      Vulkan and CUDA engines; the PyTorch engine is downloaded separately
models/      checkpoints, diffusion models, text encoders, VAEs, and upscalers
loras/       LoRAs
outputs/     generated images
config/      local settings
```

To add a model manually, copy it into the matching `models/` folder and refresh the model list in the app.

## Development

The interface uses Tauri v2 (Rust + HTML/JavaScript in `app/`). Build the app with `cargo build --release` from `app/src-tauri`.

- `tools/package_release.py --version X.Y.Z` builds the portable release ZIP.
- `tools/build_torch_engine.py` and `tools/package_torch_engine.py` build the separately distributed PyTorch engine.
- `app/dev/preview_server.py` runs a browser preview of the interface.

## Licenses

- The app (`app/`, `tools/`) is **MIT**; see [LICENSE](LICENSE).
- The PyTorch engine (`torch_engine/`, downloaded into `engine/torch`) is **AGPL-3.0** because it uses code from Stable Diffusion WebUI Forge. It runs as a separate process.
- Engine, model, and other component licenses are listed in [THIRD_PARTY.md](THIRD_PARTY.md). Each model retains its own license.

## Credits

HexAnima was created by [ayanoby](https://github.com/ayanoby). Engines: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) by leejet and the [Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge) backend by lllyasviel.
