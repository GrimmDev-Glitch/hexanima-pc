"""Exercise the exact Windows release engines in limited CPU mode.

Requires the three Anima model files in the supplied models directory.
The extracted executable and smoke-test logs are kept in --output.
"""

import argparse
import base64
import ctypes
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import time
from urllib.request import Request, urlopen
from zipfile import ZipFile


def resource_budget(process):
    """Apply the Windows CPU cap and reserve RAM before loading models."""
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
    ]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    class BasicLimits(ctypes.Structure):
        _fields_ = [
            ("process_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
            ("flags", wintypes.DWORD), ("min_working_set", ctypes.c_size_t),
            ("max_working_set", ctypes.c_size_t), ("max_processes", wintypes.DWORD),
            ("affinity", ctypes.c_size_t), ("priority", wintypes.DWORD), ("scheduling", wintypes.DWORD),
        ]

    class ExtendedLimits(ctypes.Structure):
        _fields_ = [
            ("basic", BasicLimits), ("io", ctypes.c_uint64 * 6),
            ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
            ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t),
        ]

    total, free = physical_ram_gib()
    limit = min(free - 2.5, total * .70)
    if limit < .5:
        kernel.CloseHandle(handle)
        raise RuntimeError("RAM insuficiente para iniciar la prueba")
    info = ExtendedLimits()
    info.basic.flags = 0x2200  # JOB_MEMORY | KILL_ON_JOB_CLOSE
    info.job_memory = int(limit * 2**30)
    if not kernel.SetInformationJobObject(handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    rate = (wintypes.DWORD * 2)(5, 2500)  # enable + hard cap
    if not kernel.SetInformationJobObject(handle, 15, ctypes.byref(rate), ctypes.sizeof(rate)):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    if not kernel.AssignProcessToJobObject(handle, process._handle):
        error = ctypes.get_last_error()
        kernel.CloseHandle(handle)
        raise ctypes.WinError(error)
    return kernel, handle


def call(port, route, data=None, timeout=10):
    headers = {"Content-Type": "application/json"}
    body = None if data is None else json.dumps(data).encode()
    with urlopen(Request(f"http://127.0.0.1:{port}/sdcpp/v1/{route}", body, headers), timeout=timeout) as response:
        return json.load(response)

def physical_ram_gib():
    class MemoryStatus(ctypes.Structure):
        _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
            (name, ctypes.c_uint64) for name in (
                "physical_total", "physical_free", "page_total", "page_free",
                "virtual_total", "virtual_free", "virtual_extended",
            )
        ]

    memory = MemoryStatus()
    memory.length = ctypes.sizeof(memory)
    if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(memory)):
        raise RuntimeError("No se pudo consultar la RAM disponible")
    return memory.physical_total / 2**30, memory.physical_free / 2**30


def available_ram_gib():
    return physical_ram_gib()[1]


def wait_ready(process, port):
    until = time.monotonic() + 30
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError(f"El motor terminó con código {process.returncode}")
        try:
            return call(port, "models/status", timeout=1)
        except OSError:
            time.sleep(.25)
    raise TimeoutError("El motor extraído no respondió")


def run_job(port, case, output_png):
    body = {
        "prompt": "a small red house on a hill",
        "width": 256, "height": 256, "seed": 7, "batch_count": 1,
        "sample_params": {
            "sample_steps": 3 if case == "sampling" else 1,
            "sample_method": "euler", "scheduler": "simple",
            "guidance": {"txt_cfg": 1},
        },
        "output_format": "png",
        "preview": "proj",
        "vae_tiling_params": {"enabled": True},
    }
    job = call(port, "img_gen", body)["id"]
    stages = []
    requested = False
    until = time.monotonic() + 720
    while time.monotonic() < until:
        if available_ram_gib() < 2.5:
            raise RuntimeError("Prueba detenida para reservar 2,5 GiB de RAM a Windows")
        result = call(port, f"jobs/{job}")
        status = result["status"]
        stage = result.get("progress", {}).get("stage")
        if stage and (not stages or stage != stages[-1]):
            stages.append(stage)
        if status in ("completed", "cancelled", "failed"):
            if not case and status == "completed":
                png = base64.b64decode(result["result"]["images"][0]["b64_json"])
                assert png.startswith(b"\x89PNG\r\n\x1a\n"), "Formato de salida incorrecto"
                output_png.write_bytes(png)
                return "PASS PNG válido"
            if case and requested and status == "cancelled":
                return f"PASS cancelación confirmada durante {case}"
            return f"FAIL {case or 'generación'}: estado={status}, cancelación={requested}, etapas={stages}, error={result.get('error')}"
        if case and not requested and stage == case:
            call(port, f"jobs/{job}/cancel", {})
            requested = True
        time.sleep(.2)
    return f"FAIL {case or 'generación'}: tiempo agotado, etapas={stages}"


def test_engine(root, models, output, name, full_matrix, startup_only):
    executable = root / "engine" / name / "sd-server.exe"
    version = subprocess.check_output([str(executable), "--version"], cwd=executable.parent, text=True).strip()
    print(f"{name}: {version}", flush=True)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    args = [
        str(executable), "--listen-ip", "127.0.0.1", "--listen-port", str(port),
        "--model-dir", str(models), "--backend", "cpu", "--threads", "2",
        "--mmap", "--batched-cfg", "off", "--type", "q8_0",
        "--flash-attn", "on", "--taesd-preview-only",
    ]
    ok = True
    for attempt in (1, 2):
        with (output / f"{name}-{attempt}.log").open("wb") as log:
            process = subprocess.Popen(args, cwd=executable.parent, stdout=log, stderr=subprocess.STDOUT)
            budget = None
            try:
                budget = resource_budget(process)
                wait_ready(process, port)
                print(f"{name}: PASS {'arranque' if attempt == 1 else 'reinicio'} con CPU limitada", flush=True)
                if attempt == 2 or startup_only:
                    continue
                files = call(port, "model-files")["files"]
                names = {item["name"]: item["id"] for item in files}
                model = {
                    "diffusion_model": names["anima-base-v1.0.safetensors"],
                    "llm": names["qwen_3_06b_base.safetensors"],
                    "vae": names["qwen_image_vae.safetensors"],
                }
                required = 2.5 + sum((models / file).stat().st_size for file in model.values()) / 2**30
                if available_ram_gib() < required:
                    raise RuntimeError(f"Prueba omitida: hacen falta {required:.1f} GiB libres para cargar Anima con reserva")
                call(port, "models/load", {"recipe": "anima", "models": model}, timeout=180)
                cases = (None, "sampling", "vae_decode") if full_matrix else (None,)
                for case in cases:
                    result = run_job(port, case, output / f"{name}-anima.png")
                    print(f"{name}: {result}", flush=True)
                    ok &= result.startswith("PASS")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=15)
                if budget:
                    budget[0].CloseHandle(budget[1])
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--models", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--startup-only", action="store_true", help="Check startup and restart without loading models")
    args = parser.parse_args()
    archive, models, output = args.archive.resolve(), args.models.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with archive.open("rb") as stream:
        print(f"SHA256 {hashlib.file_digest(stream, 'sha256').hexdigest()}", flush=True)
    with ZipFile(archive) as zip_file:
        bad = zip_file.testzip()
        if bad:
            raise RuntimeError(f"CRC incorrecto: {bad}")
        names = zip_file.namelist()
        packaged_exe = next(name for name in names if name.endswith("/HexAnima.exe"))
        top = packaged_exe.split("/")[0]
        zip_file.extractall(output)
    root = output / top
    print(f"PASS integridad del ZIP y extracción de {len(names)} entradas", flush=True)
    results = []
    for name in ("cuda", "vulkan"):
        try:
            results.append(test_engine(root, models, output, name, name == "cuda", args.startup_only))
        except (OSError, RuntimeError, KeyError, ValueError) as error:
            print(f"{name}: FAIL {error}", flush=True)
            results.append(False)
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
