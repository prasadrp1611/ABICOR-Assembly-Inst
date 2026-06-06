# ABICOR Assembly-Doc — app image. Serves the web UI + API on :8000.
# Lean by design: SAM/torch (requirements-sam.txt) is NOT installed, so "Precise
# highlight" falls back to box mode. Add it only if you need on-box segmentation.
FROM python:3.12-slim

# system libs opencv-headless / pymupdf need on slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libglib2.0-0 libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# runtime state (jobs, codes, incidents) goes to a writable volume — never the image
ENV ABICOR_DATA_DIR=/data \
    PYTHONUNBUFFERED=1
RUN mkdir -p /data \
    && useradd -m -u 10001 appuser \
    && chown -R appuser /data /app
USER appuser
VOLUME ["/data"]

EXPOSE 8000
# secrets come in at runtime via env (GEMINI_API_KEY, or GEMINI_PROXY_URL + hsk token)
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
