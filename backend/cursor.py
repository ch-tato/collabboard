# =============================================================================
# CollabBoard — Cursor Relay
# =============================================================================
# Owner : M3 (Data/Sync)
# Sprint: Day 6 — cursor_move relay with 50ms throttle
#
# This module handles cursor_move messages from clients:
#   - Validates x/y coordinates (0–1920, 0–1080)
#   - Enforces 50ms per-user server-side throttle (API_CONTRACT.md §7)
#   - Constructs cursor_update broadcast payload
#   - Fire-and-forget: no ack, no persistence, no sequencing
#
# The module does NOT perform WebSocket I/O — it returns plain dicts
# (or None if throttled/invalid). M1's main.py handler is responsible
# for sending broadcasts and relaying via Redis pub/sub.
#
# Reference:
#   - API_CONTRACT.md §7 (Cursor Update)
#   - DISTRIBUTED_SYSTEM_DESIGN.md (fire-and-forget relay)
#   - WEBSOCKET_PROTOCOL_EXTENSION.md §5 (cursor tracking)
# =============================================================================
"""
CursorRelay: cursor_move validation, throttle, and broadcast construction.

Exposes:
    handle_cursor_move(user_id, username, data) → dict | None
        Returns a broadcast dict on success, or None if throttled/invalid.
"""

from __future__ import annotations

import time
from typing import Dict, Optional


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

THROTTLE_INTERVAL_MS: float = 50.0
"""Minimum interval between cursor updates per user, in milliseconds."""

CANVAS_MAX_X: int = 1920
"""Maximum x coordinate (spec: fixed 1920×1080 canvas)."""

CANVAS_MAX_Y: int = 1080
"""Maximum y coordinate (spec: fixed 1920×1080 canvas)."""


# ---------------------------------------------------------------------------
# Per-user throttle tracker
# ---------------------------------------------------------------------------
# Maps user_id → last cursor_move timestamp (ms since epoch).
# Entries are automatically cleaned up when the user disconnects
# via remove_user_throttle().

_last_cursor_ts: Dict[str, float] = {}


def remove_user_throttle(user_id: str) -> None:
    """
    Remove a user's throttle state on disconnect.

    Called from the disconnect cleanup path to prevent memory leaks
    in the throttle tracker dict.

    Args:
        user_id: UUID v4 string of the disconnecting user.
    """
    _last_cursor_ts.pop(user_id, None)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def handle_cursor_move(
    user_id: str,
    username: str,
    data: dict,
) -> Optional[dict]:
    """
    Process an incoming ``cursor_move`` message.

    Validates coordinate bounds, enforces the 50ms per-user throttle,
    and constructs the ``cursor_update`` broadcast payload.

    This is a **synchronous** function — cursor relay is fire-and-forget
    with no database writes, no sequencing, and no ack. The caller
    (main.py) handles WebSocket broadcast and Redis pub/sub relay.

    Throttle strategy (per API_CONTRACT.md §7):
        - Track the last accepted cursor_move timestamp per user.
        - If less than 50ms has elapsed since the last accepted message,
          silently drop the current one (return None).
        - This prevents flooding the broadcast channel with high-frequency
          mouse events while still providing smooth visual tracking.

    Args:
        user_id: UUID v4 string of the sending user.
        username: Display name of the sending user.
        data: The full parsed JSON message dict. Expected keys:
              ``type`` (str), ``x`` (int), ``y`` (int).

    Returns:
        A ``cursor_update`` broadcast dict on success::

            {
                "type": "cursor_update",
                "user_id": "...",
                "username": "...",
                "x": 150,
                "y": 300
            }

        Or ``None`` if the message is throttled or has invalid coordinates.
    """
    # --- Step 1: Extract and validate coordinates ----------------------------
    x = data.get("x")
    y = data.get("y")

    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None  # Silently drop invalid messages (per spec)

    x = int(x)
    y = int(y)

    if not (0 <= x <= CANVAS_MAX_X) or not (0 <= y <= CANVAS_MAX_Y):
        return None  # Out of canvas bounds — silently drop

    # --- Step 2: Enforce 50ms per-user throttle ------------------------------
    now_ms = time.monotonic() * 1000.0
    last_ts = _last_cursor_ts.get(user_id, 0.0)

    if (now_ms - last_ts) < THROTTLE_INTERVAL_MS:
        return None  # Throttled — silently drop

    _last_cursor_ts[user_id] = now_ms

    # --- Step 3: Build cursor_update broadcast payload -----------------------
    return {
        "type": "cursor_update",
        "user_id": user_id,
        "username": username,
        "x": x,
        "y": y,
    }


def handle_cursor_chat(
    user_id: str,
    username: str,
    data: dict,
) -> Optional[dict]:
    """
    Process an incoming ``cursor_chat`` message.

    Validates coordinates and message string, and constructs the
    ``cursor_chat_broadcast`` payload. 
    """
    x = data.get("x")
    y = data.get("y")
    message = data.get("message")

    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None

    if not isinstance(message, str):
        return None

    x = int(x)
    y = int(y)

    if not (0 <= x <= CANVAS_MAX_X) or not (0 <= y <= CANVAS_MAX_Y):
        return None

    # Defense in depth: cap message length (frontend limits to 200)
    message = message.strip()[:200]

    return {
        "type": "cursor_chat_broadcast",
        "user_id": user_id,
        "username": username,
        "x": x,
        "y": y,
        "message": message,
    }
