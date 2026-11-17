# engine/

Motor de generación: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) precompilado. No se sube a git por tamaño.

| Carpeta | Para | Archivos de la release oficial |
|---|---|---|
| `cuda/` | NVIDIA | `sd-master-<commit>-bin-win-cuda12-x64.zip` + `cudart-sd-bin-win-cu12-x64.zip` |
| `vulkan/` | AMD / Intel | `sd-master-<commit>-bin-win-vulkan-x64.zip` |
| `cpu/` | Sin GPU compatible | `sd-master-<commit>-bin-win-cpu-x64.zip` |

Versión probada: `master-1106-532d2c1` (16 nov 2026).

```bash
gh release download master-1106-532d2c1 -R leejet/stable-diffusion.cpp -p "*win-cuda12-x64.zip" -p "cudart-sd-bin-win-cu12-x64.zip"
```

Descomprime ambos zips dentro de `engine/cuda/`.
