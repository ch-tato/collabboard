# =============================================================================
# CollabBoard — Room Manager
# =============================================================================
# Owner : M1 (Server & DevOps)
# Sprint: Day 7 — WebSocket disconnect edge-case fixes
#
# This module implements the three room lifecycle handlers:
#   - handle_create_room: generate room, insert to PG, auto-join creator
#   - handle_join_room:   validate, insert member, send ack + snapshot,
#                         broadcast user_joined (local + Redis pub/sub)
#   - handle_leave_room:  remove member, send ack, broadcast user_left
#   - handle_disconnect_cleanup: cleanup for abrupt disconnects
#
# Each handler orchestrates 3 tiers of state per DISTRIBUTED_SYSTEM_DESIGN.md:
#   Tier 1 (PostgreSQL): rooms, room_members tables
#   Tier 2 (Redis):      session:{user_id} hash, room:{id}:members set,
#                         room:{id} pub/sub channel
#   Tier 3 (Memory):     ConnectionManager.clients + room_connections
#
# Day 7 changes:
#   - Reordered state mutations in handle_create_room and handle_join_room:
#     manager.add_to_room() now runs IMMEDIATELY after PG writes, before
#     Redis writes and WebSocket sends.  This guarantees client.room_id is
#     set early, so the main.py finally block always triggers
#     handle_disconnect_cleanup — even on mid-handshake disconnects (A1).
#   - Wrapped WebSocket sends in join/create with try/except so a dead
#     connection during the handshake re-raises cleanly to main.py.
#
# Reference:
#   - WEBSOCKET_PROTOCOL_EXTENSION.md §2 (Join), §3 (Leave), §9 (Disconnect)
#   - API_CONTRACT.md §4 (create_room), §5 (join_room), §6 (leave_room)
#   - DISTRIBUTED_SYSTEM_DESIGN.md §7 (Session Lifecycle), §8 (Sync)
# =============================================================================
"""
RoomManager: room create/join/leave handlers.

Exposes:
    MAX_ROOMS              — Maximum number of active rooms (10).
    handle_create_room()   — Create a room and auto-join the creator.
    handle_join_room()     — Join an existing room.
    handle_leave_room()    — Leave the current room.
    handle_disconnect_cleanup() — Clean up room state on abrupt disconnect.
"""

from __future__ import annotations

import json
import secrets
import string

import asyncio
from fastapi import WebSocket

from backend.connection import ConnectionManager, ClientState, SessionState
from backend import db
from backend import redis_client

_eviction_timers: dict[str, asyncio.Task] = {}

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_ROOMS: int = 10
"""Maximum number of active rooms on the server (spec A3)."""

ROOM_ID_LENGTH: int = 6
"""Length of the generated alphanumeric room code."""

ROOM_ID_CHARS: str = string.ascii_uppercase + string.digits
"""Character set for room code generation (uppercase + digits)."""


# ---------------------------------------------------------------------------
# Room Code Generator
# ---------------------------------------------------------------------------

def _generate_room_id() -> str:
    """Generate a 6-character uppercase alphanumeric room code."""
    return "".join(secrets.choice(ROOM_ID_CHARS) for _ in range(ROOM_ID_LENGTH))


# ---------------------------------------------------------------------------
# Handler: create_room
# ---------------------------------------------------------------------------

async def handle_create_room(
    websocket: WebSocket,
    client: ClientState,
    manager: ConnectionManager,
    server_id: str,
) -> None:
    """
    Handle the ``create_room`` message.

    Flow:
        1. Verify user is in Identified state (not already in a room)
        2. Check MAX_ROOMS limit (10 active rooms)
        3. Generate 6-char room code, insert into PostgreSQL ``rooms`` table
        4. Auto-join the creator into the room (same as join_room minus
           the room validation — we just created it)
        5. Send ``room_created`` response to the client

    After room creation, the user's state transitions to InRoom.
    No ``user_joined`` broadcast is needed since the creator is the
    only member.

    Reference:
        - API_CONTRACT.md §4 (CREATE_ROOM)
        - WEBSOCKET_PROTOCOL_EXTENSION.md §2.1

    Args:
        websocket: The client's WebSocket connection.
        client: The client's state object.
        manager: The ConnectionManager instance.
        server_id: This backend's SERVER_ID.
    """
    # Guard: must be Identified (not InRoom)
    if client.state == SessionState.IN_ROOM:
        await websocket.send_text(json.dumps({
            "type": "error",
            "code": "ALREADY_IN_ROOM",
            "message": "Leave current room first",
        }))
        return

    # Check MAX_ROOMS limit
    try:
        active_count = await db.count_active_rooms()
        if active_count >= MAX_ROOMS:
            await websocket.send_text(json.dumps({
                "type": "error",
                "code": "MAX_ROOMS",
                "message": "Server room limit reached",
            }))
            return
    except Exception as exc:
        print(f"[rooms] ERROR: Failed to count rooms: {exc}")
        await websocket.send_text(json.dumps({
            "type": "error",
            "code": "MAX_ROOMS",
            "message": "Failed to check room availability",
        }))
        return

    # Generate unique room code (retry on collision)
    room_id = _generate_room_id()
    try:
        await db.insert_room(room_id)
    except Exception:
        # Collision or DB error — try once more with a new code
        room_id = _generate_room_id()
        try:
            await db.insert_room(room_id)
        except Exception as exc:
            print(f"[rooms] ERROR: Failed to insert room: {exc}")
            await websocket.send_text(json.dumps({
                "type": "error",
                "code": "MAX_ROOMS",
                "message": "Failed to create room",
            }))
            return

    # Insert user into room (PG)
    try:
        await db.insert_room_member(client.user_id, room_id)
    except Exception as exc:
        print(f"[rooms] ERROR: Failed to add creator to room: {exc}")
        await websocket.send_text(json.dumps({
            "type": "error",
            "code": "MAX_ROOMS",
            "message": "Failed to join created room",
        }))
        return

    # Update local in-memory state FIRST (Day 7, A1)
    # Set client.room_id early so main.py's finally block will trigger
    # handle_disconnect_cleanup if the connection dies during sends below.
    manager.add_to_room(room_id, client.user_id)

    # Update Redis session and room membership
    await redis_client.update_session_room(client.user_id, room_id)
    await redis_client.add_room_member(room_id, client.user_id)

    # Send room_created response (may throw if WS is dead — cleanup in finally)
    try:
        await websocket.send_text(json.dumps({
            "type": "room_created",
            "room_id": room_id,
        }))
    except Exception as exc:
        # Connection died during send. client.room_id is set, so
        # main.py's finally block will clean up PG + Redis + memory.
        print(
            f"[rooms] WARNING: room_created send failed for "
            f"{client.user_id} in {room_id}: {exc}"
        )
        raise  # Re-raise so main.py's disconnect handler runs

    print(
        f"[rooms] Room created: {room_id} by "
        f"{client.username} ({client.user_id})"
    )


# ---------------------------------------------------------------------------
# Handler: join_room
# ---------------------------------------------------------------------------

async def handle_join_room(
    websocket: WebSocket,
    client: ClientState,
    data: dict,
    manager: ConnectionManager,
    server_id: str,
) -> None:
    """
    Handle the ``join_room`` message.

    Flow per WEBSOCKET_PROTOCOL_EXTENSION.md §2.2:
        1. Verify user is in Identified state (not already in a room)
        2. Extract ``room_id`` from message, validate format
        3. Verify room exists in PostgreSQL
        4. Insert into ``room_members`` (capacity check via SERIALIZABLE txn)
        5. Update Redis: session room_id, SADD to room members set
        6. Update local ConnectionManager state
        7. Send ``join_ack`` with current member list
        8. Send ``canvas_snapshot`` (empty for Day 4 — M3 wires snapshot query Day 7)
        9. Broadcast ``user_joined`` to other local room members
       10. Publish ``user_joined`` to Redis pub/sub for cross-server relay

    Args:
        websocket: The client's WebSocket connection.
        client: The client's state object.
        data: The parsed ``join_room`` message dict.
        manager: The ConnectionManager instance.
        server_id: This backend's SERVER_ID.
    """
    # Guard: must be Identified (not InRoom)
    if client.state == SessionState.IN_ROOM:
        await websocket.send_text(json.dumps({
            "type": "error",
            "code": "ALREADY_IN_ROOM",
            "message": "Leave current room first",
        }))
        return

    # Extract and validate room_id
    room_id = data.get("room_id", "")
    if not isinstance(room_id, str) or len(room_id) != 6 or not room_id.isalnum():
        await websocket.send_text(json.dumps({
            "type": "join_rejected",
            "reason": "room_not_found",
        }))
        return

    # --- Tier 1 (PostgreSQL) -------------------------------------------------

    # Check room exists
    try:
        exists = await db.room_exists(room_id)
        if not exists:
            await websocket.send_text(json.dumps({
                "type": "join_rejected",
                "reason": "room_not_found",
            }))
            return
    except Exception as exc:
        print(f"[rooms] ERROR: Failed to check room existence: {exc}")
        await websocket.send_text(json.dumps({
            "type": "join_rejected",
            "reason": "room_not_found",
        }))
        return

    # Insert room member (with capacity check)
    try:
        await db.insert_room_member(client.user_id, room_id)
    except db.RoomFullError:
        await websocket.send_text(json.dumps({
            "type": "join_rejected",
            "reason": "room_full",
        }))
        return
    except Exception as exc:
        # asyncpg.SerializationError → retry once
        import asyncpg
        if isinstance(exc, asyncpg.SerializationError):
            try:
                await db.insert_room_member(client.user_id, room_id)
            except db.RoomFullError:
                await websocket.send_text(json.dumps({
                    "type": "join_rejected",
                    "reason": "room_full",
                }))
                return
            except Exception as retry_exc:
                print(f"[rooms] ERROR: Retry insert_room_member failed: {retry_exc}")
                await websocket.send_text(json.dumps({
                    "type": "join_rejected",
                    "reason": "room_not_found",
                }))
                return
        else:
            print(f"[rooms] ERROR: insert_room_member failed: {exc}")
            await websocket.send_text(json.dumps({
                "type": "join_rejected",
                "reason": "room_not_found",
            }))
            return

    # --- Tier 2 (Redis) ------------------------------------------------------

    await redis_client.update_session_room(client.user_id, room_id)
    await redis_client.add_room_member(room_id, client.user_id)

    # --- Tier 3 (In-memory) --- BEFORE sends (Day 7, A1) ---------------------
    # Set client.room_id early so main.py's finally block will trigger
    # handle_disconnect_cleanup if the connection dies during sends below.
    manager.add_to_room(room_id, client.user_id)

    # Cancel eviction timer if it exists (Day 10, M3)
    if room_id in _eviction_timers:
        _eviction_timers[room_id].cancel()
        del _eviction_timers[room_id]
        print(f"[rooms] Cancelled eviction timer for {room_id} (user joined)")
        # Make sure room status is active
        try:
            await db.update_room_status(room_id, "active")
        except Exception:
            pass

    # --- Responses -----------------------------------------------------------

    # Build member list for join_ack
    try:
        member_rows = await db.get_room_members(room_id)
        members = [
            {"user_id": str(row["user_id"]), "username": row["username"]}
            for row in member_rows
        ]
    except Exception as exc:
        print(f"[rooms] WARNING: Failed to fetch member list: {exc}")
        # Fallback: at least include the joiner
        members = [{"user_id": client.user_id, "username": client.username}]

    # Send join_ack + canvas_snapshot (may throw if WS is dead)
    try:
        await websocket.send_text(json.dumps({
            "type": "join_ack",
            "room_id": room_id,
            "members": members,
        }))

        # Send canvas_snapshot to the joiner (Day 6, M3: live query)
        try:
            seq = await db.get_room_seq(room_id)
            if seq is None:
                seq = 0
        except Exception:
            seq = 0

        try:
            obj_rows = await db.get_canvas_objects(room_id)
            objects = [
                {
                    "obj_id": str(row["obj_id"]),
                    "obj_type": row["obj_type"],
                    "created_by": str(row["created_by"]),
                    "created_at": row["created_at"].isoformat(),
                    "z_index": row["z_index"],
                    "color": row["color"],
                    "stroke_width": row["stroke_width"],
                    "properties": json.loads(row["properties"]) if isinstance(row["properties"], str) else row["properties"],
                }
                for row in obj_rows
            ]
        except Exception as exc:
            print(f"[rooms] WARNING: Failed to fetch canvas objects: {exc}")
            objects = []

        await websocket.send_text(json.dumps({
            "type": "canvas_snapshot",
            "seq": seq,
            "objects": objects,
        }))
    except Exception as exc:
        # Connection died during join handshake sends.  client.room_id is
        # already set, so main.py's finally block handles full cleanup.
        print(
            f"[rooms] WARNING: Join sends failed for "
            f"{client.user_id} in {room_id}: {exc}"
        )
        raise  # Re-raise so main.py's disconnect handler runs

    # --- Broadcast user_joined -----------------------------------------------

    user_joined_msg = {
        "type": "user_joined",
        "user_id": client.user_id,
        "username": client.username,
    }

    # Local broadcast (to other local clients in the room)
    await manager.broadcast_to_room(
        room_id,
        user_joined_msg,
        exclude_user_id=client.user_id,
    )

    # Cross-server broadcast via Redis pub/sub
    await redis_client.publish_to_room(
        room_id=room_id,
        server_id=server_id,
        msg_type="user_joined",
        payload=user_joined_msg,
    )

    print(
        f"[rooms] User joined: {client.username} ({client.user_id}) "
        f"→ room {room_id} [{len(members)} members]"
    )


# ---------------------------------------------------------------------------
# Handler: leave_room
# ---------------------------------------------------------------------------

async def handle_leave_room(
    websocket: WebSocket,
    client: ClientState,
    manager: ConnectionManager,
    server_id: str,
) -> None:
    """
    Handle the ``leave_room`` message.

    Flow per WEBSOCKET_PROTOCOL_EXTENSION.md §3:
        1. Verify user is InRoom
        2. Capture room_id before clearing state
        3. Remove from PostgreSQL ``room_members``
        4. Update Redis: session room_id → "", SREM from room members set
        5. Update local ConnectionManager state
        6. Send ``leave_ack`` to the leaver
        7. Broadcast ``user_left`` to other local room members
        8. Publish ``user_left`` to Redis pub/sub for cross-server relay

    After leaving, the user's state transitions back to Identified.

    Args:
        websocket: The client's WebSocket connection.
        client: The client's state object.
        manager: The ConnectionManager instance.
        server_id: This backend's SERVER_ID.
    """
    # Guard: must be InRoom
    if client.state != SessionState.IN_ROOM or client.room_id is None:
        await websocket.send_text(json.dumps({
            "type": "error",
            "code": "NOT_IN_ROOM",
            "message": "Not currently in a room",
        }))
        return

    room_id = client.room_id

    # --- Tier 1 (PostgreSQL) -------------------------------------------------
    try:
        await db.remove_room_member(client.user_id, room_id)
    except Exception as exc:
        print(f"[rooms] WARNING: Failed to remove room member from PG: {exc}")
        # Continue anyway — we still want to clean up Redis and memory

    # --- Tier 2 (Redis) ------------------------------------------------------
    await redis_client.update_session_room(client.user_id, "")
    await redis_client.remove_room_member(room_id, client.user_id)

    # --- Tier 3 (In-memory) --------------------------------------------------
    manager.remove_from_room(room_id, client.user_id)

    # --- Response ------------------------------------------------------------
    await websocket.send_text(json.dumps({"type": "leave_ack"}))

    # --- Broadcast user_left -------------------------------------------------
    user_left_msg = {
        "type": "user_left",
        "user_id": client.user_id,
        "username": client.username,
    }

    # Local broadcast
    await manager.broadcast_to_room(room_id, user_left_msg)

    # Cross-server broadcast via Redis pub/sub
    await redis_client.publish_to_room(
        room_id=room_id,
        server_id=server_id,
        msg_type="user_left",
        payload=user_left_msg,
    )

    print(
        f"[rooms] User left: {client.username} ({client.user_id}) "
        f"← room {room_id}"
    )

    # Day 10, M3: Start 5-min eviction timer if room is empty globally
    try:
        members = await db.get_room_members(room_id)
        if len(members) == 0:
            if room_id not in _eviction_timers:
                _eviction_timers[room_id] = asyncio.create_task(_evict_room_after_delay(room_id))
                print(f"[rooms] Started 5-minute eviction timer for {room_id}")
    except Exception as exc:
        print(f"[rooms] WARNING: Failed to check room members for eviction: {exc}")


# ---------------------------------------------------------------------------
# Disconnect Cleanup
# ---------------------------------------------------------------------------

async def handle_disconnect_cleanup(
    client: ClientState,
    manager: ConnectionManager,
    server_id: str,
) -> None:
    """
    Clean up room state when a user disconnects (graceful or abrupt).

    Called from the ``finally`` block in ``main.py`` after the WebSocket
    connection is closed. If the user was in a room, this performs the
    same cleanup as ``leave_room`` (minus sending ``leave_ack`` since
    the WebSocket is already closed).

    Day 6 hardening:
        Each cleanup tier is wrapped in its own try/except so a failure
        in one tier (e.g. Redis unreachable) does not block the remaining
        tiers from completing.  This follows the best-effort resilience
        principle agreed upon in the Day 6 sprint assumptions.

    Flow per WEBSOCKET_PROTOCOL_EXTENSION.md §9.2:
        1. If user is InRoom: remove from PG, Redis, local state
        2. Broadcast ``user_left`` to remaining room members
        3. Publish ``user_left`` to Redis pub/sub

    Args:
        client: The disconnected client's state object.
        manager: The ConnectionManager instance.
        server_id: This backend's SERVER_ID.
    """
    if client.room_id is None:
        return  # User was not in a room — nothing to clean up

    room_id = client.room_id

    # --- Tier 1 (PostgreSQL) -------------------------------------------------
    # Remove the user from the room_members table.
    # If PG is down, we log and continue — the Redis and memory tiers must
    # still be cleaned up to prevent ghost presence.
    try:
        await db.remove_room_member(client.user_id, room_id)
    except Exception as exc:
        print(
            f"[rooms] WARNING: Disconnect cleanup PG remove failed "
            f"for {client.user_id} in room {room_id}: {exc}"
        )

    # --- Tier 2 (Redis) ------------------------------------------------------
    # Remove user from the room:{room_id}:members SET.
    # If this fails, the session TTL (300s) will eventually expire the
    # stale entry.  We do NOT delete the SET key when it becomes empty
    # (confirmed assumption: leave empty sets in Redis).
    try:
        await redis_client.remove_room_member(room_id, client.user_id)
    except Exception as exc:
        print(
            f"[rooms] WARNING: Disconnect cleanup Redis SREM failed "
            f"for {client.user_id} in room {room_id}: {exc}"
        )
    # Session hash (session:{user_id}) is fully deleted by main.py's
    # delete_session call — no action needed here.

    # --- Tier 3 (In-memory) --------------------------------------------------
    # Remove from local ConnectionManager room index.
    try:
        manager.remove_from_room(room_id, client.user_id)
    except Exception as exc:
        print(
            f"[rooms] WARNING: Disconnect cleanup memory remove failed "
            f"for {client.user_id} in room {room_id}: {exc}"
        )

    # --- Broadcast user_left -------------------------------------------------
    # Notify remaining members (both local and cross-server) that this user
    # has left.  Each broadcast is independent: if the local broadcast
    # fails, the Redis pub/sub broadcast should still be attempted.
    user_left_msg = {
        "type": "user_left",
        "user_id": client.user_id,
        "username": client.username,
    }

    # Local broadcast (to other local clients still in the room)
    try:
        await manager.broadcast_to_room(room_id, user_left_msg)
    except Exception as exc:
        print(
            f"[rooms] WARNING: Disconnect cleanup local broadcast failed "
            f"for room {room_id}: {exc}"
        )

    # Cross-server broadcast via Redis pub/sub
    try:
        await redis_client.publish_to_room(
            room_id=room_id,
            server_id=server_id,
            msg_type="user_left",
            payload=user_left_msg,
        )
    except Exception as exc:
        print(
            f"[rooms] WARNING: Disconnect cleanup Redis pub/sub broadcast "
            f"failed for room {room_id}: {exc}"
        )

    print(
        f"[rooms] Disconnect cleanup: {client.username} ({client.user_id}) "
        f"← room {room_id}"
    )

    # Day 10, M3: Start 5-min eviction timer if room is empty globally
    try:
        members = await db.get_room_members(room_id)
        if len(members) == 0:
            if room_id not in _eviction_timers:
                _eviction_timers[room_id] = asyncio.create_task(_evict_room_after_delay(room_id))
                print(f"[rooms] Started 5-minute eviction timer for {room_id}")
    except Exception as exc:
        print(f"[rooms] WARNING: Failed to check room members for eviction: {exc}")

async def _evict_room_after_delay(room_id: str) -> None:
    """Evict room after 5 minutes if it remains empty."""
    try:
        await asyncio.sleep(300)
        # Verify it's still empty
        members = await db.get_room_members(room_id)
        if len(members) == 0:
            await db.update_room_status(room_id, "empty")
            print(f"[rooms] Room {room_id} has been idle for 5 mins. Status set to empty.")
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        print(f"[rooms] ERROR in eviction timer for {room_id}: {exc}")
    finally:
        _eviction_timers.pop(room_id, None)
