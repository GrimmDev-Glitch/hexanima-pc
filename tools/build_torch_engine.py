"""Arma engine/torch (motor PyTorch portátil de HexAnima PC) a partir de un Python 3.10 y un entorno
que ya tenga PyTorch con CUDA (por ejemplo el venv de Forge), copiando solo lo que el motor usa.

    python tools/build_torch_engine.py --python C:/.../Python310 --site C:/.../venv/Lib/site-packages --forge C:/.../stable-diffusion-webui-forge

Resultado:
    engine/torch/python/        Python 3.10 mínimo + Lib/site-packages con los paquetes del motor
    engine/torch/forge/         backend de Forge (AGPL-3.0) que usa el motor
    engine/torch/hexanima/      torch_engine/*.py (servidor de HexAnima)
"""
import argparse
import fnmatch
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Paquetes que el motor importa al generar (medido con una generación real) + spandrel para ampliar.
PACKAGES = """_distutils_hack accelerate bitsandbytes certifi cffi charset_normalizer colorama cython diffusers einops
filelock fsspec ftfy google huggingface_hub idna jinja2 markupsafe mpmath numpy onnx packaging peft PIL psutil
pynvml regex requests safetensors scipy sentencepiece socks sympy tokenizers torch torchdiffeq torchgen torchsde
torchvision tqdm trampoline transformers typing_extensions urllib3 wcwidth yaml spandrel _cffi_backend""".split()
SKIP = ["__pycache__", "*.pyc", "tests", "test", ".git"]


def ignore(dirpath, names):
    out = set()
    for n in names:
        if any(fnmatch.fnmatch(n, p) for p in SKIP):
            out.add(n)
    return out


def copy(src, dst):
    if os.path.isdir(src):
        shutil.copytree(src, dst, ignore=ignore, dirs_exist_ok=True)
    else:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)


def size(p):
    t = 0
    for d, _, fs in os.walk(p):
        for f in fs:
            try: t += os.path.getsize(os.path.join(d, f))
            except OSError: pass
    return t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", required=True, help="carpeta de un Python 3.10 instalado")
    ap.add_argument("--site", required=True, help="site-packages con torch+CUDA (p. ej. venv de Forge)")
    ap.add_argument("--forge", required=True, help="carpeta de stable-diffusion-webui-forge")
    ap.add_argument("--out", default=os.path.join(ROOT, "engine", "torch"))
    a = ap.parse_args()
    out = a.out
    py = os.path.join(out, "python")
    sp = os.path.join(py, "Lib", "site-packages")

    # 1) Python mínimo (sin documentación, tests, tkinter, idle ni site-packages del sistema)
    print("Python…", flush=True)
    for n in os.listdir(a.python):
        if n in ("Doc", "Tools", "tcl", "include", "libs", "Scripts", "Lib", "NEWS.txt"):
            continue
        copy(os.path.join(a.python, n), os.path.join(py, n))
    lib_skip = {"site-packages", "test", "idlelib", "tkinter", "turtledemo", "ensurepip", "lib2to3", "__pycache__"}
    for n in os.listdir(os.path.join(a.python, "Lib")):
        if n in lib_skip:
            continue
        copy(os.path.join(a.python, "Lib", n), os.path.join(py, "Lib", n))

    # 2) Paquetes del motor + sus .dist-info / .libs (transformers y diffusers leen versiones de dist-info)
    print("Paquetes…", flush=True)
    names = os.listdir(a.site)
    low = {n.lower(): n for n in names}
    missing = []
    for p in PACKAGES:
        hits = [n for n in names if n.lower() == p.lower() or n.lower() == p.lower() + ".py" or
                (n.lower().startswith(p.lower() + ".") and n.lower().endswith((".pyd",)))]
        norm = p.lower().replace("-", "_")
        hits += [n for n in names if n.lower().endswith((".dist-info", ".libs")) and
                 n.lower().replace("-", "_").split("-")[0] in (norm, norm + ".libs") ]
        hits += [n for n in names if n.lower() == norm + ".libs"]
        if p == "PIL":
            hits += [n for n in names if n.lower().startswith("pillow")]
        if p == "yaml":
            hits += [n for n in names if n.lower().startswith(("pyyaml", "_yaml"))]
        if p == "google":
            hits += [n for n in names if n.lower().startswith("protobuf")]
        if p == "socks":
            hits += [n for n in names if n.lower().startswith(("pysocks", "sockshandler"))]
        if p == "pynvml":
            hits += [n for n in names if n.lower().startswith(("pynvml", "nvidia_ml_py"))]
        if p == "_distutils_hack":
            hits += [n for n in names if n.lower() == "distutils-precedence.pth"]
        if not hits:
            missing.append(p)
        for n in sorted(set(hits)):
            copy(os.path.join(a.site, n), os.path.join(sp, n))
    if missing:
        print("No encontrados (se omiten):", missing)
    # Metadatos de todos los paquetes (.dist-info, pocos MB): transformers/diffusers comprueban versiones
    for n in names:
        if n.endswith(".dist-info"):
            copy(os.path.join(a.site, n), os.path.join(sp, n))
    # MKL / OpenMP / TBB de Intel: torch los busca en <prefijo>/Library/bin
    lib = os.path.normpath(os.path.join(a.site, "..", "..", "Library", "bin"))
    if os.path.isdir(lib):
        copy(lib, os.path.join(py, "Library", "bin"))
    for n in names:
        if n.lower().startswith(("mkl-", "intel_openmp-", "tbb-")) and n.endswith(".dist-info"):
            copy(os.path.join(a.site, n), os.path.join(sp, n))

    # 3) Código: backend de Forge (AGPL-3.0) y el servidor de HexAnima
    print("Código…", flush=True)
    # + IP-Adapter de Forge (GPL-3.0, de cubiq/ComfyUI_IPAdapter_plus) para «Personaje de referencia»
    for rel in ("backend", "k_diffusion", "packages_3rdparty", os.path.join("repositories", "huggingface_guess"), "LICENSE.txt",
                os.path.join("extensions-builtin", "sd_forge_ipadapter", "lib_ipadapter"),
                os.path.join("extensions-builtin", "sd_forge_ipadapter", "LICENSE")):
        src = os.path.join(a.forge, rel)
        if os.path.exists(src):
            copy(src, os.path.join(out, "forge", rel))
    for n in os.listdir(os.path.join(ROOT, "torch_engine")):
        if n.endswith((".py", ".md", ".pt")):
            copy(os.path.join(ROOT, "torch_engine", n), os.path.join(out, "hexanima", n))
    print(f"Listo: {out} · {size(out) / 2**30:.2f} GB")


if __name__ == "__main__":
    sys.exit(main())
