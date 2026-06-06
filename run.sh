#!/usr/bin/env bash
# ===== ABICOR Assembly-Doc Generator - start the app (macOS / Linux) =====
cd "$(dirname "$0")"

if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
else
  echo "[warning] .venv not found - run ./setup.sh first. Trying system Python..."
fi

echo "Starting ABICOR Assembly-Doc Generator at http://127.0.0.1:8000  (Ctrl+C to stop)"
python server.py
