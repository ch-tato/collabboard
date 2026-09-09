# =============================================================================
# CollabBoard — Sync Engine
# =============================================================================
# Owner : M3 (Data/Sync)
# Sprint: Day 4–5 — handle_op for add, modify, delete operations
#
# This module implements operation dispatch: validates incoming op messages
# against the API contract, writes to PostgreSQL via db.py, and constructs
# the op_ack / op_broadcast / op_rejected response dicts.
#
# The module does NOT perform WebSocket I/O — it returns plain dicts.
# M1's main.py handler is responsible for sending the results over WebSocket
# and broadcasting to the room.
#
# Day 4 scope:
#   - handle_op: dispatches add/modify/delete
#   - _handle_add: validates AddObjectPayload, writes to PG, returns ack/broadcast
#
# Day 5 scope:
#   - _handle_modify: validates ModifyChangesPayload, partial JSONB merge
#   - _handle_delete: soft-delete (is_deleted = TRUE), seq increment
#
# Reference:
#   - API_CONTRACT.md §9 (add), §10 (modify), §11 (delete)
#   - POSTGRESQL_MIGRATION.md §6 (transaction strategy, seq atomicity)
#   - DATABASE_SCHEMA.md §3.4 (canvas_objects table)
# =============================================================================
"""
SyncEngine: op dispatch, PostgreSQL write, response construction.

Exposes:
    handle_op(user_id, username, room_id, data) → dict
        Returns one of:
            {"status": "ok", "op_ack": {...}, "op_broadcast": {...}}
            {"status": "rejected", "op_rejected": {...}}
"""

from __future__ import annotations

from pydantic import ValidationError
import base64
import os
import uuid
from pathlib import Path

from backend import db
from backend.models import AddObjectPayload, ModifyChangesPayload


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def handle_op(
    user_id: str,
    username: str,
    room_id: str,
    data: dict,
) -> dict:
    """
    Dispatch an incoming ``op`` message to the correct handler.

    Supported ``op`` values:
        - ``"add"``    — Day 4 (implemented)
        - ``"modify"`` — Day 5 (implemented)
        - ``"delete"`` — Day 5 (implemented)

    Args:
        user_id: UUID v4 string of the sending user.
        username: Display name of the sending user.
        room_id: 6-character room code the user is in.
        data: The full parsed JSON message dict.

    Returns:
        A dict with ``"status"`` key set to ``"ok"`` or ``"rejected"``.
        On success, includes ``"op_ack"`` and ``"op_broadcast"`` dicts.
        On rejection, includes ``"op_rejected"`` dict.
    """
    op_type = data.get("op")

    if op_type == "add":
        return await _handle_add(user_id, username, room_id, data)

    if op_type == "modify":
        return await _handle_modify(user_id, username, room_id, data)

    if op_type == "delete":
        return await _handle_delete(user_id, username, room_id, data)

    # Unknown or missing op type
    return _rejected("invalid_object_type")


# ---------------------------------------------------------------------------
# Internal: rejection helper
# ---------------------------------------------------------------------------

def _rejected(reason: str) -> dict:
    """
    Build an ``op_rejected`` response.

    Reference: API_CONTRACT.md §Error Message Contract

    Args:
        reason: One of ``invalid_object_type``, ``invalid_properties``,
                ``image_too_large``, ``object_not_found``.

    Returns:
        ``{"status": "rejected", "op_rejected": {"type": "op_rejected", "seq": null, "reason": ...}}``
    """
    return {
        "status": "rejected",
        "op_rejected": {
            "type": "op_rejected",
            "seq": None,
            "reason": reason,
        },
    }


# ---------------------------------------------------------------------------
# Internal: handle add
# ---------------------------------------------------------------------------

async def _handle_add(
    user_id: str,
    username: str,
    room_id: str,
    data: dict,
) -> dict:
    """
    Handle an ``op: "add"`` message.

    Flow:
        1. Extract ``object`` from the message.
        2. Validate via ``AddObjectPayload`` (Pydantic).
        3. Write to PostgreSQL via ``db.insert_canvas_object`` (atomic
           seq_counter + INSERT in one transaction).
        4. Construct ``op_ack`` (to sender) and ``op_broadcast``
           (to other room members).

    Reference: API_CONTRACT.md §9

    Args:
        user_id: Creator's UUID.
        username: Creator's display name.
        room_id: Room the object belongs to.
        data: Full parsed message dict.

    Returns:
        Success or rejection dict (see ``handle_op`` docstring).
    """
    # --- Step 1: Extract object payload --------------------------------------
    obj_data = data.get("object")
    if not isinstance(obj_data, dict):
        return _rejected("invalid_properties")

    # --- Step 2: Validate via Pydantic ---------------------------------------
    try:
        payload = AddObjectPayload.model_validate(obj_data)
    except ValidationError as exc:
        # Determine the most specific rejection reason
        for err in exc.errors():
            loc = err.get("loc", ())
            if "obj_type" in loc:
                return _rejected("invalid_object_type")
        return _rejected("invalid_properties")

    # --- Step 2.5: Image validation and storage (Day 10) ---------------------
    image_meta = None
    if payload.obj_type == "image":
        image_data_b64 = payload.properties.get("image_data", "")
        original_filename = payload.properties.get("original_filename", "image.png")
        
        try:
            if "," in image_data_b64:
                image_data_b64 = image_data_b64.split(",", 1)[1]
            decoded_bytes = base64.b64decode(image_data_b64)
        except Exception as exc:
            print(f"[sync] ERROR: base64 decode failed: {exc}")
            return _rejected("invalid_properties")
            
        file_size = len(decoded_bytes)
        if file_size > 2097152:
            return _rejected("image_too_large")
            
        image_id = str(uuid.uuid4())
        ext = ".png" if original_filename.lower().endswith(".png") else ".jpg"
        mime_type = "image/png" if ext == ".png" else "image/jpeg"
        filename = f"{image_id}{ext}"
        
        project_root = Path(__file__).resolve().parent.parent
        images_dir = project_root / "data" / "canvases" / room_id / "images"
        os.makedirs(images_dir, exist_ok=True)
        
        image_path = images_dir / filename
        try:
            with open(image_path, "wb") as f:
                f.write(decoded_bytes)
        except Exception as exc:
            print(f"[sync] ERROR: Failed to write image to disk: {exc}")
            return _rejected("invalid_properties")

        # Strip base64 data from properties before saving to DB
        payload.properties.pop("image_data", None)
        payload.properties["image_id"] = image_id
        
        image_meta = {
            "image_id": image_id,
            "filename": filename,
            "mime_type": mime_type,
            "file_size": file_size,
        }

    # --- Step 3: Write to PostgreSQL -----------------------------------------
    try:
        seq, obj_id, created_at = await db.insert_canvas_object(
            room_id=room_id,
            user_id=user_id,
            obj_type=payload.obj_type,
            z_index=payload.z_index,
            color=payload.color,
            stroke_width=payload.stroke_width,
            properties=payload.properties,
        )
    except Exception as exc:
        print(f"[sync] ERROR: insert_canvas_object failed: {exc}")
        return _rejected("invalid_properties")

    # Day 10 M3: Insert image metadata
    if image_meta:
        try:
            await db.insert_image(
                image_id=str(image_meta["image_id"]),
                room_id=room_id,
                obj_id=obj_id,
                filename=str(image_meta["filename"]),
                mime_type=str(image_meta["mime_type"]),
                file_size=int(image_meta["file_size"]),
            )
        except Exception as exc:
            print(f"[sync] ERROR: insert_image failed: {exc}")

    # --- Step 4: Build response dicts ----------------------------------------
    op_ack = {
        "type": "op_ack",
        "seq": seq,
        "obj_id": obj_id,
    }

    broadcast_object = {
        "obj_id": obj_id,
        "obj_type": payload.obj_type,
        "created_by": user_id,
        "created_at": created_at,
        "z_index": payload.z_index,
        "color": payload.color,
        "stroke_width": payload.stroke_width,
        "properties": payload.properties,
    }

    op_broadcast = {
        "type": "op_broadcast",
        "op": "add",
        "seq": seq,
        "object": broadcast_object,
    }

    print(
        f"[sync] add: {payload.obj_type} by {username} "
        f"in room {room_id} → seq={seq}, obj_id={obj_id}"
    )

    return {
        "status": "ok",
        "op_ack": op_ack,
        "op_broadcast": op_broadcast,
    }


# ---------------------------------------------------------------------------
# Internal: handle modify (Day 5, M3)
# ---------------------------------------------------------------------------

async def _handle_modify(
    user_id: str,
    username: str,
    room_id: str,
    data: dict,
) -> dict:
    """
    Handle an ``op: "modify"`` message.

    Flow:
        1. Extract ``obj_id`` and ``changes`` from the message.
        2. Validate ``changes`` via ``ModifyChangesPayload`` (Pydantic).
        3. Write to PostgreSQL via ``db.update_canvas_object`` (atomic
           seq_counter + JSONB merge in one transaction).
        4. If the object was not found (already deleted or invalid ID),
           return ``op_rejected("object_not_found")``.
        5. Construct ``op_ack`` (to sender) and ``op_broadcast``
           (to other room members).

    Any user in the room may modify any object — no ownership check is
    performed (collaborative editing model).

    Reference: API_CONTRACT.md §10

    Args:
        user_id: Modifier's UUID.
        username: Modifier's display name.
        room_id: Room the object belongs to.
        data: Full parsed message dict.

    Returns:
        Success or rejection dict (see ``handle_op`` docstring).
    """
    # --- Step 1: Extract obj_id and changes ----------------------------------
    obj_id = data.get("obj_id")
    if not isinstance(obj_id, str) or not obj_id.strip():
        return _rejected("object_not_found")

    changes_data = data.get("changes")
    if not isinstance(changes_data, dict):
        return _rejected("invalid_properties")

    # --- Step 2: Validate changes via Pydantic -------------------------------
    try:
        payload = ModifyChangesPayload.model_validate(changes_data)
    except ValidationError:
        return _rejected("invalid_properties")

    # Build a clean changes dict with only non-None validated fields
    clean_changes: dict = {}
    if payload.color is not None:
        clean_changes["color"] = payload.color
    if payload.stroke_width is not None:
        clean_changes["stroke_width"] = payload.stroke_width
    if payload.z_index is not None:
        clean_changes["z_index"] = payload.z_index
    if payload.properties is not None:
        clean_changes["properties"] = payload.properties

    # --- Step 3: Write to PostgreSQL -----------------------------------------
    try:
        result = await db.update_canvas_object(
            room_id=room_id,
            user_id=user_id,
            obj_id=obj_id,
            changes=clean_changes,
        )
    except Exception as exc:
        print(f"[sync] ERROR: update_canvas_object failed: {exc}")
        return _rejected("invalid_properties")

    # --- Step 4: Check if object was found -----------------------------------
    if result is None:
        return _rejected("object_not_found")

    seq, returned_obj_id = result

    # --- Step 5: Build response dicts ----------------------------------------
    op_ack = {
        "type": "op_ack",
        "seq": seq,
        "obj_id": returned_obj_id,
    }

    op_broadcast = {
        "type": "op_broadcast",
        "op": "modify",
        "seq": seq,
        "obj_id": returned_obj_id,
        "changes": clean_changes,
    }

    print(
        f"[sync] modify: obj {returned_obj_id} by {username} "
        f"in room {room_id} → seq={seq}, changes={list(clean_changes.keys())}"
    )

    return {
        "status": "ok",
        "op_ack": op_ack,
        "op_broadcast": op_broadcast,
    }


# ---------------------------------------------------------------------------
# Internal: handle delete (Day 5, M3)
# ---------------------------------------------------------------------------

async def _handle_delete(
    user_id: str,
    username: str,
    room_id: str,
    data: dict,
) -> dict:
    """
    Handle an ``op: "delete"`` message.

    Flow:
        1. Extract ``obj_id`` from the message.
        2. Write to PostgreSQL via ``db.soft_delete_canvas_object`` (atomic
           seq_counter + SET is_deleted = TRUE in one transaction).
        3. If the object was not found (already deleted or invalid ID),
           return ``op_rejected("object_not_found")``.
        4. Construct ``op_ack`` (to sender) and ``op_broadcast``
           (to other room members).

    Any user in the room may delete any object — no ownership check is
    performed (collaborative editing model).

    Soft-delete is used (``is_deleted = TRUE``) rather than ``DELETE FROM``
    to preserve the object record for undo/redo support (Day 8).

    Reference: API_CONTRACT.md §11

    Args:
        user_id: Deleter's UUID.
        username: Deleter's display name.
        room_id: Room the object belongs to.
        data: Full parsed message dict.

    Returns:
        Success or rejection dict (see ``handle_op`` docstring).
    """
    # --- Step 1: Extract obj_id ----------------------------------------------
    obj_id = data.get("obj_id")
    if not isinstance(obj_id, str) or not obj_id.strip():
        return _rejected("object_not_found")

    # --- Step 2: Write to PostgreSQL -----------------------------------------
    try:
        result = await db.soft_delete_canvas_object(
            room_id=room_id,
            user_id=user_id,
            obj_id=obj_id,
        )
    except Exception as exc:
        print(f"[sync] ERROR: soft_delete_canvas_object failed: {exc}")
        return _rejected("object_not_found")

    # --- Step 3: Check if object was found -----------------------------------
    if result is None:
        return _rejected("object_not_found")

    seq, returned_obj_id = result

    # --- Step 4: Build response dicts ----------------------------------------
    op_ack = {
        "type": "op_ack",
        "seq": seq,
        "obj_id": returned_obj_id,
    }

    op_broadcast = {
        "type": "op_broadcast",
        "op": "delete",
        "seq": seq,
        "obj_id": returned_obj_id,
    }

    print(
        f"[sync] delete: obj {returned_obj_id} by {username} "
        f"in room {room_id} → seq={seq}"
    )

    return {
        "status": "ok",
        "op_ack": op_ack,
        "op_broadcast": op_broadcast,
    }
