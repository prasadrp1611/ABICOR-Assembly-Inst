# Knowledge Platform — Plan

_From "video → PDF" to a stateful "company assembly brain."_

## Why (the real product)
ABICOR's workforce is ageing; the client asked for PDFs to capture retiring experts'
knowledge. A PDF is a dead snapshot. We turn each tutorial video into a node in a
**living, queryable knowledge graph** of the company's whole assembly expertise —
connected across products, searchable, persistent. The PDF becomes just *one printout*
of the graph. This is knowledge **preservation**, not documentation.

## What we're adding
1. **State / multiple sessions** — every processed video is a persistent session; a
   sidebar lists all (active · done · archived) and reopens any.
2. **Cross-video knowledge graph** — all sessions' ontologies merge into one graph,
   glued by part number.
3. **Graph + semantic search** — "ask across everything" (GraphRAG over the whole base).

## Storage decision
Requirements: **maintained** (not archived), **fast as it grows**, **graph + vectors in
one place**, low-maintenance, runs locally.

### Recommendation: **FalkorDB**
- Purpose-built for **GraphRAG / knowledge-graphs-for-LLMs** — our exact use case.
- **Graph + vector + full-text in ONE store** → the ontology and the part/step/frame
  embeddings live together; no cross-DB joins.
- **OpenCypher**. **Sub-millisecond traversals** (GraphBLAS sparse matrices) — the
  fastest option, which directly answers the "must stay fast as we re-upload" worry.
- Self-host with **one Docker container** (ships a browser UI). Low-ops; runs on the box.
- Actively maintained; ships a **GraphRAG SDK + MCP server**.

### Alternatives (and why not, for us)
- **Postgres + Apache AGE + pgvector** — "one DB does all," Postgres-native; but AGE is a
  compile-it extension with real performance degradation on large edge counts. Fine at
  small scale — pick it only if the team already lives in Postgres. FalkorDB is faster
  and purpose-built.
- **Kùzu (LadybugDB / RyuGraph forks)** — embedded, no server, Cypher + vector; but the
  original was **archived Oct 2025** and forks are young → production risk. (Your instinct
  was right: archived = don't bet prod on it.)
- **ArangoDB / ArcadeDB** — multi-model (graph + vector + doc) but non-Cypher (AQL).
- **SQLite + sqlite-vec** — zero-ops embedded; graph via recursive CTEs (no Cypher). The
  ultra-simple fallback if we don't want to run any service at all.

**Blobs stay on disk.** Videos, frames and generated `.docx` remain in the existing
`jobs/<id>/` folders. The DB stores the graph + vectors + *references* (paths), never the
big files.

## Data model
- **Nodes:** Session · Product · Step · Part · Tool · Action · (optional) Frame.
- **Edges:** Session-`PRODUCES`->Document · Step-`PART_OF`->Session · Part-`USED_IN`->Step ·
  Part-`CONNECTS_TO` / `SCREWS_INTO`->Part · Step-`DEMONSTRATED_IN`->Session · Product-`HAS`->Part …
- **Vectors (indices in FalkorDB):** part name/desc, step text, frame image-embedding,
  video-segment text → semantic retrieval.
- **Merge key:** canonical **part number** (from the BoM) + normalised entity name → the
  same part across videos becomes ONE node, so the graphs self-assemble.

## Multi-session / state (the sidebar)
- Sidebar lists sessions: **Active** (processing) · **Done** · **Archived** — each with
  product/model, date, thumbnail, status.
- Click → reopen that session (its doc + its place in the graph). **Archived** = hidden
  from the main list but fully viewable ("watch the archived parts").
- Persistence: sessions already survive restarts (`jobs/` on disk + `status.json`). Add a
  session index (FalkorDB Session nodes, or a small `sessions.json`) + an `archived` flag.
- New **"Knowledge Graph"** view: the merged graph + a search bar across all sessions.
- This is where we **give the app real state** — a persistent workspace with history,
  not a one-shot tool.

## Performance / scale (accumulate forever)
- Graph stays fast: FalkorDB sub-ms traversals even as nodes grow.
- Vectors live **with** the graph (FalkorDB vector index) — no separate vector DB, no
  cross-store joins.
- Big files on disk, not in the DB.
- **Incremental ingest** per job (UPSERT parts/edges, merge by part number) — cheap,
  O(parts in that one video).
- **Dedup re-uploads by content hash** so we never recompute embeddings for the same video.

## Build sequence (phased, de-risked)
- **Phase 0 — Sessions + sidebar (NO new infra).** Persist a session index + a sidebar to
  list/reopen past & archived jobs (reuses `jobs/` + `/api/jobs`). Delivers "state +
  multiple sessions" immediately, zero DB risk. **← start here.**
- **Phase 1 — Knowledge graph (FalkorDB).** Stand up FalkorDB (Docker). On each job
  complete, ingest its ontology, merging by part number. Global-graph endpoint + view.
- **Phase 2 — Semantic search.** Store part/step/frame embeddings in FalkorDB vector
  indices. Search bar → hybrid graph + vector (GraphRAG) retrieval.
- **Phase 3 — Ask the brain.** Query/chat over the whole base ("how do I assemble X" →
  the exact demonstrated steps + linked parts). FalkorDB's GraphRAG SDK does the lifting.
  **← the winning demo.**

## Risk / fallback
Each phase ships on its own. Don't want Docker for the demo? Phase 0 needs no DB; the
graph can start in SQLite and migrate to FalkorDB later. Nothing here changes how the app
generates each document today — it's an accumulating layer on top.
