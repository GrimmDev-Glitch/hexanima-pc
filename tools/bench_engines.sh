#!/bin/bash
# HexAnima PC - compara motores (cuda / cuda-gtx / vulkan) con la misma imagen corta.
# Uso: bash tools/bench_engines.sh <checkpoint SDXL> [motor ...]
# Escribe cache/bench-engines.txt con el tiempo de muestreo y por paso de cada uno.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="$1"; shift
ENGINES="${*:-cuda vulkan}"
STEPS=6
OUT="$ROOT/cache/bench-engines.txt"
for e in $ENGINES; do
  exe="$ROOT/engine/$e/sd-cli.exe"
  [ -f "$exe" ] || { echo "== $e: falta $exe" | tee -a "$OUT"; continue; }
  # Con varias GPU (p.ej. Intel integrada + NVIDIA), elegir la NVIDIA/AMD dedicada.
  dev=$("$exe" --list-devices 2>/dev/null | awk -F'	' 'tolower($2) !~ /intel|microsoft|llvmpipe/ && $1 !~ /^CPU/ {print tolower($1); exit}')
  bk=(); [ -n "$dev" ] && bk=(--backend "$dev")
  start=$(date +%s)
  res=$(cd "$ROOT/engine/$e" && ./sd-cli.exe -m "$MODEL" -p "masterpiece, 3d, 1girl, silver hair, cherry blossoms" \
        -W 832 -H 1216 --steps $STEPS --cfg-scale 5.5 --sampling-method euler_a -s 42 \
        "${bk[@]}" --type q8_0 --offload-to-cpu --flash-attn on --vae-tiling \
        -o "$ROOT/cache/bench-$e.png" 2>&1 | tr '\r' '\n' | grep -E "sampling completed|decoded,|generate_image completed|\[E\]" | sed 's/ --- .*//')
  samp=$(echo "$res" | grep -oE "sampling completed, taking [0-9.]+" | grep -oE "[0-9.]+$")
  per=$(awk -v s="$samp" -v n=$STEPS 'BEGIN{ if (s) printf "%.1f", s/n; else print "?" }')
  { echo "== $e ($dev): $per s/paso (muestreo ${samp:-?} s, total $(( $(date +%s) - start )) s)"; echo "$res"; } | tee -a "$OUT"
done
