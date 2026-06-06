"""
Ontology / knowledge-graph extraction for an assembly video, plus a
server-side graph renderer (PNG). Supplementary to the assembly document.
"""
from enum import Enum
from typing import List, Dict
from pathlib import Path

from pydantic import BaseModel, Field
from google.genai import types

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch
import networkx as nx

import config


# ---- schema (also enforces deterministic structure) ----
class Entity(BaseModel):
    id: str
    label: str
    cls: str = Field(..., description="One of: Tool, Component, Material, Action, Property, SafetyMeasure")


class Relationship(BaseModel):
    subject: str
    predicate: str = Field(..., description="PART_OF, CONNECTS_TO, USES_TOOL, ACTS_ON, REQUIRES, PRECEDES, HAS_PROPERTY, SCREWS_INTO")
    object: str


class Ontology(BaseModel):
    entities: List[Entity]
    relationships: List[Relationship]


CLASS_COLORS = {
    "Tool": "#e74c3c", "Component": "#3498db", "Material": "#2ecc71",
    "Action": "#f39c12", "Property": "#9b59b6", "SafetyMeasure": "#e91e63",
}

ONTOLOGY_PROMPT = """\
Build a formal ONTOLOGY (knowledge graph) of the assembly procedure in this video.

Entities — every physical part, tool, material, action, property or safety measure.
Each: {"id":"snake_case","label":"Human Readable","cls":"<class>"} where class is one of:
Tool, Component, Material, Action, Property, SafetyMeasure.

Relationships — RDF triples {"subject":"<id>","predicate":"<REL>","object":"<id>"} using
predicates: PART_OF, CONNECTS_TO, USES_TOOL, ACTS_ON, REQUIRES, PRECEDES, HAS_PROPERTY,
SCREWS_INTO. Every subject/object MUST be a defined entity id. Capture the real assembly
hierarchy and the step order (PRECEDES). Return only the structured object.
"""


def extract_ontology(client, vfile) -> dict:
    resp = client.models.generate_content(
        model=config.MODEL,
        contents=[vfile, ONTOLOGY_PROMPT],
        config=types.GenerateContentConfig(
            temperature=config.TEMPERATURE, seed=config.SEED,
            response_mime_type="application/json", response_schema=Ontology,
        ),
    )
    onto: Ontology = resp.parsed
    if onto is None:
        return {"entities": [], "relationships": []}
    data = onto.model_dump()
    # keep only relationships whose endpoints exist
    ids = {e["id"] for e in data["entities"]}
    data["relationships"] = [r for r in data["relationships"]
                             if r["subject"] in ids and r["object"] in ids]
    return data


def render_graph(onto: dict, out_path: Path, title: str = "Assembly Ontology"):
    G = nx.DiGraph()
    by_id = {e["id"]: e for e in onto["entities"]}
    for e in onto["entities"]:
        G.add_node(e["id"], label=e["label"], cls=e.get("cls", "Component"))
    for r in onto["relationships"]:
        if r["subject"] in by_id and r["object"] in by_id:
            G.add_edge(r["subject"], r["object"], predicate=r["predicate"])
    if G.number_of_nodes() == 0:
        return None

    colors = [CLASS_COLORS.get(G.nodes[n].get("cls"), "#95a5a6") for n in G.nodes]
    plt.figure(figsize=(16, 11))
    pos = nx.spring_layout(G, k=1.7, iterations=80, seed=config.SEED)
    nx.draw_networkx_nodes(G, pos, node_color=colors, node_size=1900,
                           alpha=0.92, edgecolors="black")
    nx.draw_networkx_edges(G, pos, edge_color="#666", arrows=True, arrowsize=16,
                           width=1.3, alpha=0.55, connectionstyle="arc3,rad=0.08")
    nx.draw_networkx_labels(G, pos, labels={n: G.nodes[n]["label"] for n in G.nodes},
                            font_size=8.5, font_weight="bold")
    nx.draw_networkx_edge_labels(
        G, pos, edge_labels={(u, v): d["predicate"] for u, v, d in G.edges(data=True)},
        font_size=6.5, font_color="#8e0052",
        bbox=dict(boxstyle="round,pad=0.2", facecolor="white", alpha=0.7))
    plt.legend(handles=[Patch(facecolor=c, edgecolor="black", label=k)
                        for k, c in CLASS_COLORS.items()],
               loc="upper left", fontsize=10, title="Classes")
    plt.title(title, fontsize=16, fontweight="bold")
    plt.axis("off"); plt.tight_layout()
    plt.savefig(str(out_path), dpi=160, bbox_inches="tight")
    plt.close()
    return out_path


def summarize(onto: dict) -> dict:
    from collections import Counter
    cls = Counter(e.get("cls", "?") for e in onto["entities"])
    pred = Counter(r["predicate"] for r in onto["relationships"])
    return {"n_entities": len(onto["entities"]),
            "n_relationships": len(onto["relationships"]),
            "classes": dict(cls), "predicates": dict(pred)}
