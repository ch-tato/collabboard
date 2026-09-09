# =============================================================================
# CollabBoard — Pydantic Models
# =============================================================================
# Owner : M3 (Data/Sync) + M1 (Server & DevOps)
# Sprint: Day 2 — Hello handshake models
#
# This module defines Pydantic v2 models for WebSocket message validation.
# Day 2 covers the hello/hello_ack handshake and generic error messages.
# Additional models will be added in future sprints as features are built.
#
# Reference:
#   - API_CONTRACT.md §1 (hello / hello_ack)
#   - API_CONTRACT.md §Error Message Contract
#   - IMPLEMENTATION_PLAN.md §Appendix A (Frozen Contracts)
# =============================================================================
"""
Pydantic models for request validation.

Day 2 (implemented):
    - HelloMessage, HelloAckMessage, ErrorMessage

TODO (Day 3+):
    - CreateRoom, RoomCreated
    - JoinRoom, JoinAck, JoinRejected
    - LeaveRoom, LeaveAck
    - OpMessage (add/modify/delete), OpAck, OpBroadcast, OpRejected
    - CursorMove, CursorUpdate
    - CursorChat, CursorChatBroadcast
    - CanvasSnapshot
    - ImageRequest, ImageResponse
"""

from __future__ import annotations

import re
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Client → Server: hello
# ---------------------------------------------------------------------------
class HelloMessage(BaseModel):
    """
    Validates the incoming ``hello`` message from a client.

    Reference: API_CONTRACT.md §1

    Fields:
        type: Must be the literal string ``"hello"``.
        username: Non-empty, max 32 chars, printable characters only.
    """

    type: Literal["hello"]
    username: str = Field(..., min_length=1, max_length=32)

    @field_validator("username")
    @classmethod
    def username_must_be_printable(cls, v: str) -> str:
        """Reject non-printable characters and whitespace-only usernames."""
        stripped = v.strip()
        if not stripped:
            raise ValueError("Username cannot be empty or whitespace-only")
        if not stripped.isprintable():
            raise ValueError("Username must contain only printable characters")
        return stripped


# ---------------------------------------------------------------------------
# Server → Client: hello_ack
# ---------------------------------------------------------------------------
class HelloAckMessage(BaseModel):
    """
    The server's success response to a valid ``hello`` message.

    Reference: API_CONTRACT.md §1

    Fields:
        type: Always ``"hello_ack"``.
        user_id: UUID v4 string assigned by the server.
        server_version: Semantic version string (e.g. ``"2.0"``).
    """

    type: Literal["hello_ack"] = "hello_ack"
    user_id: str
    server_version: str


# ---------------------------------------------------------------------------
# Server → Client: error
# ---------------------------------------------------------------------------
class ErrorMessage(BaseModel):
    """
    Generic error message sent by the server.

    Reference: API_CONTRACT.md §Error Message Contract

    Error codes used during the hello phase:
        - ``INVALID_USERNAME``: Empty, too long, or non-printable username.
        - ``SERVER_FULL``: Max connections reached.

    Fields:
        type: Always ``"error"``.
        code: Machine-readable error code (e.g. ``"INVALID_USERNAME"``).
        message: Human-readable description.
    """

    type: Literal["error"] = "error"
    code: str
    message: str


# =========================================================================
# Op Validation Models (Day 4, M3)
# =========================================================================
# Per API_CONTRACT.md §9 — each obj_type has its own required properties.
# These models are used by sync.py to validate incoming add operations.
# =========================================================================

_HEX_COLOR_RE = re.compile(r"^#[0-9A-Fa-f]{6}$")

VALID_OBJ_TYPES = frozenset(
    {"pencil", "text", "rectangle", "circle", "line", "arrow", "heart", "image"}
)
"""Valid obj_type values (matching the PostgreSQL ``obj_type`` ENUM)."""


# ---------------------------------------------------------------------------
# Per-type property models
# ---------------------------------------------------------------------------

class PencilProperties(BaseModel):
    """Pencil: freehand polyline. Requires ≥ 2 ``[x, y]`` points."""

    points: list = Field(..., min_length=2)

    @field_validator("points")
    @classmethod
    def validate_points(cls, v: list) -> list:
        if not isinstance(v, list) or len(v) < 2:
            raise ValueError("points must have at least 2 elements")
        for i, pt in enumerate(v):
            if not isinstance(pt, (list, tuple)) or len(pt) != 2:
                raise ValueError(f"Point {i} must be [x, y]")
            if not all(isinstance(c, (int, float)) for c in pt):
                raise ValueError(f"Point {i} coordinates must be numbers")
        return v


class TextProperties(BaseModel):
    """Text label. Position + content + font size."""

    x: int
    y: int
    content: str = Field(..., min_length=1)
    font_size: int = Field(..., ge=8, le=144)


class RectangleProperties(BaseModel):
    """Rectangle. Position + dimensions + optional fill."""

    x: int
    y: int
    width: int = Field(..., gt=0)
    height: int = Field(..., gt=0)
    fill_color: Optional[str] = None

    @field_validator("fill_color")
    @classmethod
    def validate_fill(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _HEX_COLOR_RE.match(v):
            raise ValueError("fill_color must be a valid hex color")
        return v


class CircleProperties(BaseModel):
    """Circle. Centre + radius + optional fill."""

    cx: int
    cy: int
    radius: int = Field(..., gt=0)
    fill_color: Optional[str] = None

    @field_validator("fill_color")
    @classmethod
    def validate_fill(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _HEX_COLOR_RE.match(v):
            raise ValueError("fill_color must be a valid hex color")
        return v


class LineProperties(BaseModel):
    """Straight line between two points."""

    x1: int
    y1: int
    x2: int
    y2: int


class ArrowProperties(BaseModel):
    """Arrow (line with head) between two points."""

    x1: int
    y1: int
    x2: int
    y2: int


class HeartProperties(BaseModel):
    """Heart shape. Centre + size."""

    cx: int
    cy: int
    size: int = Field(..., gt=0)


class ImageProperties(BaseModel):
    """Embedded image. Position + dimensions + base64 payload."""

    x: int
    y: int
    width: int
    height: int
    image_data: str = Field(..., min_length=1)
    original_filename: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Property dispatcher
# ---------------------------------------------------------------------------

PROPERTY_VALIDATORS: dict[str, type[BaseModel]] = {
    "pencil": PencilProperties,
    "text": TextProperties,
    "rectangle": RectangleProperties,
    "circle": CircleProperties,
    "line": LineProperties,
    "arrow": ArrowProperties,
    "heart": HeartProperties,
    "image": ImageProperties,
}
"""Maps ``obj_type`` → Pydantic model for property validation."""


# ---------------------------------------------------------------------------
# Add-operation payload model
# ---------------------------------------------------------------------------

class AddObjectPayload(BaseModel):
    """
    Validates the ``object`` dict inside an ``op: "add"`` message.

    Reference: API_CONTRACT.md §9

    Validation steps:
        1. ``obj_type`` must be one of the 8 valid types.
        2. ``color`` must be a valid ``#RRGGBB`` hex string.
        3. ``properties`` must satisfy the type-specific property model.
    """

    obj_type: str
    z_index: int = Field(..., ge=0)
    color: str
    stroke_width: int = Field(..., ge=0)
    properties: dict

    @field_validator("obj_type")
    @classmethod
    def validate_obj_type(cls, v: str) -> str:
        if v not in VALID_OBJ_TYPES:
            raise ValueError(f"Invalid obj_type: '{v}'")
        return v

    @field_validator("color")
    @classmethod
    def validate_color(cls, v: str) -> str:
        if not _HEX_COLOR_RE.match(v):
            raise ValueError("color must be a valid #RRGGBB hex string")
        return v

    @model_validator(mode="after")
    def validate_properties_for_type(self) -> "AddObjectPayload":
        """Dispatch ``properties`` to the correct per-type validator."""
        validator_cls = PROPERTY_VALIDATORS.get(self.obj_type)
        if validator_cls is None:
            raise ValueError(f"No property validator for obj_type: {self.obj_type}")
        validator_cls.model_validate(self.properties)
        return self


# ---------------------------------------------------------------------------
# Modify-operation changes model (Day 5, M3)
# ---------------------------------------------------------------------------

class ModifyChangesPayload(BaseModel):
    """
    Validates the ``changes`` dict inside an ``op: "modify"`` message.

    Reference: API_CONTRACT.md §10

    Allowed keys (all optional — at least one must be present):
        - ``color``: ``#RRGGBB`` hex string.
        - ``stroke_width``: Integer ≥ 0.
        - ``z_index``: Integer ≥ 0.
        - ``properties``: Partial dict merged into existing JSONB via ``||``.

    Unknown keys are silently ignored (``extra = "ignore"``).
    """

    model_config = {"extra": "ignore"}

    color: Optional[str] = None
    stroke_width: Optional[int] = Field(default=None, ge=0)
    z_index: Optional[int] = Field(default=None, ge=0)
    properties: Optional[dict] = None

    @field_validator("color")
    @classmethod
    def validate_color(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and not _HEX_COLOR_RE.match(v):
            raise ValueError("color must be a valid #RRGGBB hex string")
        return v

    @model_validator(mode="after")
    def at_least_one_change(self) -> "ModifyChangesPayload":
        """Ensure the changes dict is not completely empty after filtering."""
        if all(
            v is None
            for v in (self.color, self.stroke_width, self.z_index, self.properties)
        ):
            raise ValueError("changes must contain at least one valid key")
        return self
