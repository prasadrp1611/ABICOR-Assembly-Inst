"""Session state — a JSON document store (one JSON document per session).

This is the queryable source of truth for the session list / sidebar; the jobs/<id>/
folders remain the blob store (video, frames, docs). It's intentionally document-shaped
so it swaps to a NoSQL DB (Mongo, etc.) later with zero reshaping — each record is
already a self-contained JSON document.
"""
import json
import threading

import config

DB_PATH = config.DATA_DIR / "sessions.json"   # gitignored runtime state
_lock = threading.Lock()


def _load() -> dict:
    if not DB_PATH.exists():
        return {}
    try:
        return json.loads(DB_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save(d: dict):
    DB_PATH.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")


def upsert(record: dict):
    """Merge a session document (must carry 'id') into the store."""
    sid = record.get("id")
    if not sid:
        return
    with _lock:
        d = _load()
        cur = d.get(sid, {})
        cur.update(record)
        d[sid] = cur
        _save(d)


def all_sessions() -> list:
    with _lock:
        return list(_load().values())


def get(sid: str):
    with _lock:
        return _load().get(sid)


def backfill_from_disk():
    """One-time seed from existing jobs/*/status.json so nothing is lost on first run
    after the store is introduced."""
    with _lock:
        d = _load()
        changed = False
        for jd in config.JOBS_DIR.iterdir():
            sf = jd / "status.json"
            if not sf.exists():
                continue
            try:
                st = json.loads(sf.read_text(encoding="utf-8"))
            except Exception:
                continue
            sid = st.get("id") or jd.name
            if sid not in d:
                d[sid] = st
                changed = True
        if changed:
            _save(d)
