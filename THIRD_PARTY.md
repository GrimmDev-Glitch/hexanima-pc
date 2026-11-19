# Componentes de terceros

## Incluidos en el zip de la app

| Componente | Dónde | Licencia |
|---|---|---|
| [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) (leejet) | `engine/vulkan`, `engine/cuda` | MIT (`engine/cuda/stable-diffusion.cpp.txt`) |
| [ggml](https://github.com/ggml-org/ggml) | `engine/*/ggml*.dll` | MIT (`engine/cuda/ggml.txt`) |
| CUTLASS (NVIDIA) | `engine/cuda` | BSD-3-Clause (`engine/cuda/cutlass.txt`) |
| CUDA Runtime, cuBLAS (NVIDIA) | `engine/cuda/cudart64_12.dll`, `cublas*.dll` | NVIDIA CUDA EULA (bibliotecas redistribuibles) |
| libwebp (Google) | `engine/*/libwebp*.dll` | BSD-3-Clause |
| Tauri, crates de Rust | `HexAnima.exe` | MIT / Apache-2.0 |
| Barlow Semi Condensed | `HexAnima.exe` (interfaz) | SIL OFL 1.1 |

## Se descargan desde la app

| Componente | Origen | Licencia |
|---|---|---|
| Motor PyTorch de HexAnima PC (Python 3.10, PyTorch, backend de Forge, IP-Adapter de Forge/cubiq) | [hexanima-packs/pc_torch](https://huggingface.co/GrimmDev-Glitch/hexanima-packs/tree/main/pc_torch) | AGPL-3.0 (Forge); IP-Adapter GPL-3.0; PyTorch BSD-3-Clause; cada paquete conserva la suya en su `*.dist-info` |
| Anima Turbo, Qwen3 0.6B, Qwen Image VAE | [circlestone-labs/Anima](https://huggingface.co/circlestone-labs/Anima) | ver `LICENSE.md` del repositorio |
| Detectores YOLOv8 de ADetailer | [Bingsu/adetailer](https://huggingface.co/Bingsu/adetailer) | AGPL-3.0 (Ultralytics) |
| Detector de pose OpenPose (cuerpo, `body_pose_model.pth`) para «🧍 Pose» | [lllyasviel/Annotators](https://huggingface.co/lllyasviel/Annotators) | pesos de CMU OpenPose: uso académico / no comercial; el código del motor (`torch_engine/pose.py`) se basa en el anotador de [lllyasviel/ControlNet](https://github.com/lllyasviel/ControlNet) (Apache-2.0) |
| ControlNet OpenPose SDXL para «🧍 Pose» | [xinsir/controlnet-openpose-sdxl-1.0](https://huggingface.co/xinsir/controlnet-openpose-sdxl-1.0) | Apache-2.0 |
| Qwen-Image 2.1 Turbo (GGUF de unsloth), Qwen3-VL-8B, VAE de Qwen-Image 2.1 | [unsloth](https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF), [Qwen](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF), [Comfy-Org](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) | Qwen Research License (no comercial) para Qwen-Image; Apache-2.0 para Qwen3-VL |
| MOSS-Image SFT (GGUF de leejet), Qwen3.5-9B (GGUF de unsloth), VAE de FLUX.2, tokenizer | [leejet](https://huggingface.co/leejet/MOSS-Image-SFT-GGUF), [unsloth](https://huggingface.co/unsloth/Qwen3.5-9B-GGUF), [Comfy-Org](https://huggingface.co/Comfy-Org/MOSS-Image), [OpenMOSS-Team](https://huggingface.co/OpenMOSS-Team/MOSS-Image-Base) | Apache-2.0 |
| LoRA «Style > gpt-image-2» (✦ Estilo ChatGPT) | [Civitai 2564225](https://civitai.red/models/2564225) (AgileNumbers) | ver la página del modelo (uso comercial y derivados permitidos) |
| OPUS-MT español → inglés (🌐 ES→EN) | [Helsinki-NLP/opus-mt-es-en](https://huggingface.co/Helsinki-NLP/opus-mt-es-en) | Apache-2.0 |
| Real-ESRGAN anime 6B | [xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | BSD-3-Clause |
| 4x-UltraSharp | [Kim2091/UltraSharp](https://huggingface.co/Kim2091/UltraSharp) | CC BY-NC-SA 4.0 |
| SDXL VAE fp16 fix | [madebyollin/sdxl-vae-fp16-fix](https://huggingface.co/madebyollin/sdxl-vae-fp16-fix) | MIT |
| DMD2 4-step LoRA (⚡ Modo rápido) | [tianweiy/DMD2](https://huggingface.co/tianweiy/DMD2) | CC BY-NC 4.0 (uso no comercial) |
| WD ViT Tagger v3 (Prompt desde una imagen) | [SmilingWolf/wd-vit-tagger-v3](https://huggingface.co/SmilingWolf/wd-vit-tagger-v3) | Apache-2.0 |
| noobIPA Mark1 (personaje de referencia) | [subby2006/noob-ipa](https://huggingface.co/subby2006/noob-ipa) | FAIPL-1.0-SD |
| CLIP ViT-bigG (codificador de imágenes) | [comfyanonymous/clip_vision_g](https://huggingface.co/comfyanonymous/clip_vision_g) (LAION) | MIT |
| Mage-Flow Edit Turbo (Microsoft), Q6_K de johnsor | [johnsor/Mage-Flow-Edit-Turbo-GGUF](https://huggingface.co/johnsor/Mage-Flow-Edit-Turbo-GGUF) · VAE de [Comfy-Org/Mage-Flow](https://huggingface.co/Comfy-Org/Mage-Flow) | MIT |
| Qwen3-VL-4B-Instruct (codificador de Mage) | [Qwen/Qwen3-VL-4B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF) | Apache-2.0 |
| Catálogo MiaoMiao (3D Harem, Harem, RealSkin) de MIAOKA | Civitai (modelos 431957, 934764, 2026594) | uso no comercial, ver cada página |
| Anima Turbo v1.1 LoRA (Modo rápido en Anima) | [Civitai 2924907](https://civitai.com/models/2924907) | ver la página del modelo |
| TAESD XL | [madebyollin/taesd](https://github.com/madebyollin/taesd) | MIT |
| Modelos y LoRAs de Civitai | civitai.com | la de cada autor |
