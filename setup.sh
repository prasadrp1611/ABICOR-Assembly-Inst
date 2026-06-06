#!/usr/bin/env bash
# ===== ABICOR Assembly-Doc Generator - one-time setup (macOS / Linux) =====
set -e
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "[ERROR] python3 not found. Install Python 3.10+ and re-run."
  exit 1
fi

echo "Creating virtual environment (.venv) ..."
python3 -m venv .venv
# shellcheck disable=SC1091
source .venv/bin/activate

echo "Upgrading pip and installing dependencies (this can take a few minutes) ..."
python -m pip install --upgrade pip
pip install -r requirements.txt

[ -f .env ] || cp .env.example .env

cat <<'DONE'

============================================================
 Setup complete!

 1) Edit .env and paste your GEMINI_API_KEY
    (free at https://aistudio.google.com/apikey)
    -- or skip and paste it in the app's Settings (gear icon).

 2) ./run.sh        (opens http://127.0.0.1:8000)

 Optional - precise SAM segmentation:
    source .venv/bin/activate && pip install -r requirements-sam.txt
============================================================
DONE
