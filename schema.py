"""
Canonical assembly-document schema + system prompt (deterministic contract).
The Pydantic models are used as the engine's `response_schema`, forcing identical
structure on every run. Schema version: 1.0
"""
from __future__ import annotations
from enum import Enum
from typing import List
from pydantic import BaseModel, Field

SCHEMA_VERSION = "1.0"


class ActionType(str, Enum):
    pick_up  = "pick_up"
    position = "position"
    align    = "align"
    route    = "route"
    connect  = "connect"
    insert   = "insert"
    screw    = "screw"
    tighten  = "tighten"
    press    = "press"
    remove   = "remove"
    verify   = "verify"
    other    = "other"


class InstructionPoint(BaseModel):
    point: int = Field(..., description="1-based order within the step")
    text: str = Field(..., description="Short actionable instruction a newcomer can follow")
    action_type: ActionType = Field(..., description="Controlled action category")


class Component(BaseModel):
    name: str = Field(..., description="Plain-language part name identified in the video")
    part_id: str = Field(..., description="Official part number if provided, else empty string")
    role: str = Field(..., description="What the part does / why it is used in this step")


class Deictic(BaseModel):
    utterance: str = Field(..., description="Exact word/phrase the worker said")
    refers_to: str = Field(..., description="Concrete physical object it points to")


class Narration(BaseModel):
    original_language: str = Field(..., description="BCP-47 code, e.g. 'de' or 'en'")
    original_text: str = Field(..., description="Verbatim transcript in the spoken language")
    english_text: str = Field(..., description="Faithful English translation")


class Step(BaseModel):
    step_number: int = Field(..., description="1-based, strictly time-ordered")
    timestamp_start: str = Field(..., description="MM:SS where the step begins")
    timestamp_end: str = Field(..., description="MM:SS where the next step begins or video end")
    title: str = Field(..., description="Concise English title of the task")
    goal: str = Field(..., description="One sentence: what this step achieves")
    instructions: List[InstructionPoint] = Field(..., description="Ordered point-wise breakdown")
    components: List[Component] = Field(..., description="Parts handled in this step")
    tools: List[str] = Field(..., description="Tools used in this step")
    deictic_references: List[Deictic] = Field(..., description="Resolved vague references")
    narration: Narration = Field(..., description="Worker's spoken explanation")
    tips: List[str] = Field(..., description="Helpful technique notes the worker gives")
    warnings: List[str] = Field(..., description="Safety / damage-risk notes (only if present)")
    frame_image: str = Field(..., description="'step_NN.jpg' (zero-padded step_number)")


class Station(BaseModel):
    station_number: int
    station_title: str
    steps: List[Step]


class Product(BaseModel):
    name: str = Field(..., description="Product family / name")
    model: str = Field(..., description="Model designation, e.g. 'EX-TRAFIRE 30H'")
    id_number: str = Field(..., description="ID-Number if known, else empty string")


class Source(BaseModel):
    video_file: str
    language: str = Field(..., description="Primary spoken language BCP-47 code")
    duration: str = Field(..., description="MM:SS total duration")


class AssemblyDocument(BaseModel):
    schema_version: str = Field(..., description="Must equal '1.0'")
    product: Product
    source: Source
    summary: str = Field(..., description="2-3 sentence overview of the procedure")
    stations: List[Station]


SYSTEM_PROMPT = """\
You are an industrial assembly-documentation engine for ABICOR BINZEL welding \
products. You watch ONE assembly tutorial video in which an experienced worker \
narrates and demonstrates how to assemble a product, and you convert it into a \
STRICT structured JSON assembly document that a new employee can follow.

You MUST return only a single JSON object that conforms exactly to the provided \
response schema (AssemblyDocument). No prose, no markdown, no comments outside the JSON.

CORE PRINCIPLES
1. Faithfulness — Describe only what is actually shown or said. Never invent parts, \
tools, quantities, measurements, or steps. If unsure, describe generically; do not guess.
2. Determinism — Be consistent and repeatable. Segment at natural, stable boundaries \
(each distinct physical task = one step). Order steps strictly by time. Use MM:SS \
timestamps. Produce the same segmentation and ordering on every run.
3. Point-wise illustrative instructions — THE MOST IMPORTANT REQUIREMENT. For each \
step, break the worker's actions into an ordered list of short, concrete instruction \
points: ONE discrete physical action per point, written as a clear instruction a \
newcomer can follow (e.g. "Slide the orange protective cap onto the thin electrical \
wire"). Preserve the worker's explanatory intent and small tips, but phrase every point \
as an actionable instruction. Prefer several small points over one long sentence.

SEGMENTATION
- step = one coherent assembly task. station = a phase grouping related steps. If the \
video is one continuous procedure, use a single station "Station 1: Final Assembly".
- timestamp_start = when the worker begins the step; timestamp_end = when the next step \
begins (or the video end for the final step).

NARRATION & LANGUAGE
- narration.original_text: verbatim transcript of the worker's words for THIS step.
- narration.english_text: faithful English translation.
- narration.original_language: BCP-47 code ("de", "en").
- Keep technical terms accurate (Gasdüse = gas nozzle, Stromdüse = contact tip, \
Gasdiffusor = gas diffuser, Maulschlüssel = open-end wrench).

DEICTIC RESOLUTION
- For every vague reference ("this","that","here","das","hier","dieses") add a \
deictic_references entry mapping the exact utterance to the concrete physical object \
it points to, grounded by what is visible on screen.

COMPONENTS, TOOLS, PART IDs
- components: parts handled in the step, each with a short role. Set part_id to "" \
unless an official part number is explicitly supplied; NEVER fabricate part numbers.
- tools: tools used (wrenches, screwdrivers, etc.).

TIPS & WARNINGS
- tips: helpful technique notes ("after the first screw it goes faster").
- warnings: safety/damage-critical notes ("counter-hold with the second wrench so the \
hose does not twist"). Include only if genuinely present.

FRAME IMAGE
- frame_image: "step_NN.jpg" using the zero-padded step_number (e.g. "step_03.jpg").

OUTPUT RULES
- Fill EVERY required field. Use empty arrays/strings where nothing applies — never \
null, never omit a key. schema_version must be "1.0". Return exactly one JSON object.
"""

USER_INSTRUCTION = (
    "Analyse this assembly tutorial video and produce the AssemblyDocument JSON "
    "exactly as specified by the system instructions and the response schema."
)
