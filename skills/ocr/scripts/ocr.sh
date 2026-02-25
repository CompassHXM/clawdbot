#!/usr/bin/env bash
# 用法: ocr.sh <image_path>
# 依赖: tesseract-ocr, tesseract-ocr-chi-sim, tesseract-ocr-eng
set -euo pipefail

IMAGE="$1"
if [[ ! -f "$IMAGE" ]]; then
  echo "Error: file not found: $IMAGE" >&2
  exit 1
fi

# 中文 + 英文混合识别
exec tesseract "$IMAGE" stdout -l chi_sim+eng --psm 6 2>/dev/null
