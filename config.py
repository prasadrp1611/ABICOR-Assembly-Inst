"""Central configuration for the ABICOR Assembly-Doc app."""
import os
from pathlib import Path
from dotenv import load_dotenv
from google import genai

APP_DIR  = Path(__file__).resolve().parent
JOBS_DIR = APP_DIR / "jobs"
JOBS_DIR.mkdir(exist_ok=True)

# Load .env from the app dir first, then the parent home dir as a fallback.
load_dotenv(APP_DIR / ".env")
load_dotenv(APP_DIR.parent / ".env")

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
if not GEMINI_API_KEY:
    raise RuntimeError("GEMINI_API_KEY not found in .env")

# Deterministic generation settings
MODEL       = "gemini-3.5-flash"
EMBED_MODEL = "gemini-embedding-2"
SEED        = 42
TEMPERATURE = 0.0

# Part-ID match confidence threshold (cosine similarity)
PART_MATCH_THRESHOLD = 0.62

# Upload limits
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB

def get_client() -> "genai.Client":
    return genai.Client(api_key=GEMINI_API_KEY)
