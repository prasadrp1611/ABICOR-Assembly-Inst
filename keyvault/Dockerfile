# ABICOR key-vault — handshake-token proxy in front of Gemini. Tiny image.
FROM python:3.12-slim
WORKDIR /vault
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV VAULT_HOST=0.0.0.0 \
    VAULT_PORT=8800 \
    VAULT_STATE_DIR=/state \
    PYTHONUNBUFFERED=1
RUN mkdir -p /state \
    && useradd -m -u 10002 vaultuser \
    && chown -R vaultuser /state /vault
USER vaultuser
VOLUME ["/state"]
EXPOSE 8800
# the real Gemini key comes in at runtime via env (GEMINI_API_KEY) — never baked in
CMD ["python", "vault.py"]
