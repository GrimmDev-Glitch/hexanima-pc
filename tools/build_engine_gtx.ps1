# HexAnima PC - compila stable-diffusion.cpp optimizado para GTX (series 9, 10 y 16).
#
# RESULTADO (17 nov 2026, GTX 1650, SDXL 832x1216 q8): este build fue MAS LENTO que el
# oficial (24,9 vs 20,9 s/paso; VAE 110 vs 49 s) y que Vulkan (16,9 s/paso). Descartado:
# para GTX se usa el motor Vulkan oficial. Se conserva el script como referencia.
#
# Por que: el motor oficial (CUDA 12) usa cuBLAS para pesos cuantizados y, en las
# GTX 16xx (arquitectura 7.5 sin tensor cores), cae en un camino pensado para RTX.
# Este build fuerza los kernels MMQ y compila solo codigo Pascal (sm_61): la 1050
# lo usa directo y la 1650/1660 lo traducen del PTX compute_61 en el primer arranque.
# Las RTX siguen con el motor oficial en engine\cuda.
#
# Requisitos: VS 2022 Build Tools (C++ y CMake), CUDA Toolkit 12.x (13 ya no
# compila para Pascal), git.
#
# Uso:  powershell -ExecutionPolicy Bypass -File tools\build_engine_gtx.ps1 [-Src <ruta>] [-Commit 532d2c1]
param(
    [string]$Src = "$PSScriptRoot\..\..\sd-build\src",
    [string]$Commit = "532d2c1",
    [string]$Archs = "52;61"
)
$ErrorActionPreference = "Stop"
$Root = Resolve-Path "$PSScriptRoot\.."
$Out = Join-Path $Root "engine\cuda-gtx"

if (-not (Test-Path $Src)) {
    git clone --recursive https://github.com/leejet/stable-diffusion.cpp.git $Src
}
git -C $Src fetch -q --all
git -C $Src checkout -q $Commit
git -C $Src submodule update -q --init --recursive

# Entorno de compilacion de Visual Studio (cl.exe, cmake, ninja)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "No se encontro VS Build Tools con C++." }
$envLines = cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && set"
foreach ($l in $envLines) { if ($l -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] } }

$cuda = Get-ChildItem "C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA" -Directory | Where-Object Name -like "v12.*" | Sort-Object Name -Descending | Select-Object -First 1
if (-not $cuda) { throw "No se encontro CUDA Toolkit 12.x." }
$env:CUDA_PATH = $cuda.FullName
$env:PATH = "$($cuda.FullName)\bin;$env:PATH"
Write-Host "CUDA: $($cuda.Name) · VS: $vs · arquitecturas: $Archs"

$Build = Join-Path $Src "build-gtx"
cmake -S $Src -B $Build -G Ninja -DCMAKE_BUILD_TYPE=Release `
    -DSD_CUDA=ON -DGGML_CUDA_FORCE_MMQ=ON "-DCMAKE_CUDA_ARCHITECTURES=$Archs" `
    -DSD_BUILD_SHARED_LIBS=ON -DSD_BUILD_SHARED_GGML_LIB=ON -DGGML_BACKEND_DL=ON `
    -DGGML_NATIVE=OFF -DGGML_CPU_ALL_VARIANTS=ON `
    "-DCMAKE_CUDA_FLAGS=-Xcudafe --diag_suppress=177 -Xcudafe --diag_suppress=550"
if ($LASTEXITCODE) { throw "cmake (configuracion) fallo" }
cmake --build $Build --config Release -j $env:NUMBER_OF_PROCESSORS
if ($LASTEXITCODE) { throw "cmake (compilacion) fallo" }

New-Item -ItemType Directory -Force $Out | Out-Null
Get-ChildItem "$Build\bin" -File -Include *.exe, *.dll -Recurse | Copy-Item -Destination $Out -Force
# Librerias de CUDA (cudart, cublas) del toolkit, para que funcione sin instalar CUDA
foreach ($d in "cudart64_12.dll", "cublas64_12.dll", "cublasLt64_12.dll") {
    Copy-Item "$($cuda.FullName)\bin\$d" $Out -Force
}
Write-Host "Motor GTX listo en $Out"
& "$Out\sd-cli.exe" --list-devices
