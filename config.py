"""Central configuration + runtime API-key management."""
import os
from pathlib import Path
from dotenv import load_dotenv
from google import genai

APP_DIR  = Path(__file__).resolve().parent
JOBS_DIR = APP_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)
ENV_PATH = APP_DIR / ".env"

# Load .env from the app dir first, then the parent home dir as a fallback.
load_dotenv(ENV_PATH)
load_dotenv(APP_DIR.parent / ".env")

# Generation settings (deterministic)
MODEL       = "gemini-3.5-flash"
EMBED_MODEL = "gemini-embedding-2"
SEED        = 42
TEMPERATURE = 0.0

PART_MATCH_THRESHOLD = 0.62
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

# Runtime key store (may be set via the in-app Settings dialog)
_API_KEY = (os.getenv("GEMINI_API_KEY") or "").strip() or None


def has_key() -> bool:
    return bool(_API_KEY)


def get_api_key() -> str:
    return _API_KEY or ""


def set_api_key(key: str, persist: bool = True) -> str:
    global _API_KEY
    _API_KEY = (key or "").strip() or None
    if _API_KEY:
        os.environ["GEMINI_API_KEY"] = _API_KEY
        if persist:
            _persist_key(_API_KEY)
    return _API_KEY or ""


def _persist_key(key: str):
    """Write/replace GEMINI_API_KEY in the app's .env so it survives restarts."""
    lines = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    found = False
    for i, ln in enumerate(lines):
        if ln.strip().startswith("GEMINI_API_KEY"):
            lines[i] = f"GEMINI_API_KEY={key}"
            found = True
    if not found:
        lines.append(f"GEMINI_API_KEY={key}")
    ENV_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate_key(key: str) -> bool:
    """Cheap check that a key actually works."""
    try:
        c = genai.Client(api_key=(key or "").strip())
        next(iter(c.models.list()), None)
        return True
    except Exception:
        return False


def get_client() -> "genai.Client":
    if not _API_KEY:
        raise RuntimeError("No API key configured — add it in Settings.")
    return genai.Client(api_key=_API_KEY)
