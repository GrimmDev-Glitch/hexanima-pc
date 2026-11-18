# Motor PyTorch de HexAnima PC

Motor opcional para NVIDIA (SDXL / Illustrious / Pony) basado en el backend de
[Stable Diffusion WebUI Forge](https://github.com/lllyasviel/stable-diffusion-webui-forge)
(carga de modelos, gestión de memoria para poca VRAM, LoRAs, atención SDP).

**Licencia:** este motor incluye y modifica código de Forge, que es AGPL-3.0; por eso todo
lo que hay en `torch_engine/` se distribuye bajo **AGPL-3.0**. Corre como un programa aparte
(la app le habla por HTTP en 127.0.0.1), y el resto de HexAnima PC sigue bajo su licencia MIT.

Medido en una GTX 1650 4 GB / 16 GB RAM (hassaku SDXL, 4 LoRAs, 832×1216, Euler a, CFG 5, 25 pasos):

| Motor | s/paso | Total |
|---|---|---|
| stable-diffusion.cpp CUDA (q8) | 24 | ~12 min |
| Forge (`--precision full --no-half`) | ~15 | 6 min 47 s |
| **Este motor** | **8,5** | **4 min 50 s** (incluye 1 min de mover el modelo la 1.ª vez) |


## Personaje de referencia

- `tagger.py`: WD Tagger v3 (SmilingWolf, Apache-2.0) reescrito en PyTorch.
- IP-Adapter: `lib_ipadapter` de Forge (GPL-3.0, basado en cubiq/ComfyUI_IPAdapter_plus), en `forge/extensions-builtin/sd_forge_ipadapter`. Modelo noobIPA Mark1 (FAIPL-1.0-SD) y codificador CLIP ViT-bigG.
