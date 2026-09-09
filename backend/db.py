# =============================================================================
# CollabBoard — Database Layer
# =============================================================================
# Owner : M3 (Data/Sync)
# Sprint: Day 1–6 — Pool Setup + CRUD + Room Membership + Canvas Snapshot
#
# This module manages the asyncpg connection pool lifecycle and exposes
# CRUD operations for all database tables.
#
# Pool configuration values are from POSTGRESQL_MIGRATION.md §7:
#   min_size=5, max_size=20, max_inactive_connection_lifetime=60,
#   command_timeout=10
#
# Reference:
#   - IMPLEMENTATION_PLAN.md §B1
#   - DATABASE_SCHEMA.md (source of truth for DDL)
#   - POSTGRESQL_MIGRATION.md §6 (transaction strategy), §7 (pooling)
# =============================================================================
"""
Database: asyncpg pool setup, CRUD operations.

Exposes:
    pool              — Module-level asyncpg.Pool instance (None until init).
    init_db_pool()    — Create the connection pool (call from lifespan startup).
    close_db_pool()   — Close the connection pool (call from lifespan shutdown).
    upsert_user()     — Insert a new user row with a pre-assigned UUID.
    insert_room()     — Insert a new room row.
    next_seq()        — Atomically increment and return a room's seq_counter.
    insert_room_member() — Add a user to a room (with capacity check).
    remove_room_member() — Remove a user from a room.
    count_room_members() — Count current members in a room.
    get_room_members()   — List members with usernames (JOIN).
    RoomFullError        — Raised when a room is at max capacity (8).

Day 4 (M3):
    - insert_canvas_object — atomic seq + insert in one transaction

Day 5 (M3):
    - update_canvas_object  — atomic seq + JSONB merge in one transaction
    - soft_delete_canvas_object — atomic seq + soft-delete in one transaction

Day 6 (M3):
    - get_canvas_objects — fetch all active (non-deleted) objects for snapshot
"""

from __future__ import annotations

import json as _json
import os
import uuid as _uuid
from typing import List, Optional, Tuple

import asyncpg


# ---------------------------------------------------------------------------
# Custom Exceptions
# ---------------------------------------------------------------------------

MAX_ROOM_MEMBERS: int = 8
"""Maximum number of users allowed in a single room (spec A3)."""


class RoomFullError(Exception):
    """Raised when a room has reached its maximum capacity of 8 users.

    The M1 WebSocket handler should catch this and send a
    ``join_rejected`` message with reason ``room_full``.
    """

    def __init__(self, room_id: str, current_count: int) -> None:
        self.room_id = room_id
        self.current_count = current_count
        super().__init__(
            f"Room {room_id} is full ({current_count}/{MAX_ROOM_MEMBERS})"
        )

# ---------------------------------------------------------------------------
# Module-level pool reference
# ---------------------------------------------------------------------------
# Initialized by init_db_pool(), consumed by all CRUD functions.
# Other modules import this directly:  from backend.db import pool
pool: Optional[asyncpg.Pool] = None


async def init_db_pool() -> asyncpg.Pool:
    """
    Create and return the asyncpg connection pool.

    Reads the DSN from the ``DATABASE_URL`` environment variable, which is
    expected to be set either via ``.env`` (python-dotenv) for local dev
    or via Docker environment injection in production.

    Pool parameters per POSTGRESQL_MIGRATION.md §7:
        - min_size: 5    — keep 5 warm connections ready
        - max_size: 20   — ceiling for concurrent queries
        - max_inactive_connection_lifetime: 60s — recycle idle connections
        - command_timeout: 10s — abort queries exceeding 10 seconds

    Raises:
        RuntimeError: If ``DATABASE_URL`` is not set or empty.
        asyncpg.PostgresError: If the database is unreachable.
    """
    global pool

    dsn = os.getenv("DATABASE_URL", "")
    if not dsn:
        raise RuntimeError(
            "DATABASE_URL environment variable is not set. "
            "Ensure .env is configured or the variable is exported."
        )

    pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=5,
        max_size=20,
        max_inactive_connection_lifetime=60,
        command_timeout=10,
    )

    # Quick connectivity verification
    async with pool.acquire() as conn:
        version = await conn.fetchval("SELECT version()")
    print(f"[db] Connection pool created (min=5, max=20)")
    print(f"[db] PostgreSQL: {version}")

    return pool


async def close_db_pool() -> None:
    """
    Gracefully close the asyncpg connection pool.

    Waits for all acquired connections to be released, then closes them.
    Safe to call even if the pool was never initialized (no-op).
    """
    global pool

    if pool is not None:
        await pool.close()
        print("[db] Connection pool closed")
        pool = None


# =========================================================================
# CRUD — users (Day 2, M3)
# =========================================================================

async def upsert_user(
    user_id: str,
    username: str,
    color_hex: str = "#FFFFFF",
) -> asyncpg.Record:
    """
    Insert a new user row with a pre-assigned UUID.

    Called during the hello handshake after M1's ``ConnectionManager`` has
    generated the ``user_id``.  Since the spec enforces "No Authentication"
    (NG1), every new WebSocket connection creates a fresh user row —
    there is no conflict resolution on ``username``.

    Args:
        user_id:   UUID v4 string generated by ConnectionManager.
        username:  Display name (max 32 chars, validated by Pydantic).
        color_hex: RGB hex color string (default ``'#FFFFFF'``).

    Returns:
        The inserted ``asyncpg.Record`` with columns:
        ``user_id``, ``username``, ``color_hex``, ``created_at``.

    Raises:
        RuntimeError: If the connection pool is not initialized.
        asyncpg.UniqueViolationError: If ``user_id`` already exists
            (should never happen with UUID v4).
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO users (user_id, username, color_hex)
            VALUES ($1, $2, $3)
            RETURNING user_id, username, color_hex, created_at
            """,
            _uuid.UUID(user_id),
            username,
            color_hex,
        )
    return row


# =========================================================================
# CRUD — rooms (Day 2, M3)
# =========================================================================

async def insert_room(room_id: str) -> asyncpg.Record:
    """
    Insert a new room with the given 6-character alphanumeric code.

    All other columns use their schema defaults (``status='active'``,
    ``seq_counter=0``, ``is_dirty=FALSE``, etc.).  The ``room_id`` is
    generated by the caller (``RoomManager``, Day 3) using
    ``secrets.choice``.

    Args:
        room_id: 6-character alphanumeric room code.

    Returns:
        The inserted ``asyncpg.Record`` with columns:
        ``room_id``, ``created_at``, ``last_activity``,
        ``status``, ``seq_counter``.

    Raises:
        RuntimeError: If the connection pool is not initialized.
        asyncpg.UniqueViolationError: If the ``room_id`` already exists.
        asyncpg.CheckViolationError: If ``room_id`` fails the
            ``^[A-Za-z0-9]{6}$`` regex check.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO rooms (room_id)
            VALUES ($1)
            RETURNING room_id, created_at, last_activity, status, seq_counter
            """,
            room_id,
        )
    return row


# =========================================================================
# CRUD — atomic sequence counter (Day 2, M3)
# =========================================================================

async def next_seq(room_id: str) -> Optional[int]:
    """
    Atomically increment and return the room's sequence counter.

    Also updates ``last_activity`` to ``now()`` and sets
    ``is_dirty = TRUE`` in the same statement, as specified in
    POSTGRESQL_MIGRATION.md §6.

    This is the critical path for every canvas operation — the
    ``RETURNING`` clause eliminates the read-modify-write race that
    would otherwise require advisory locking.

    Reference:
        - DATABASE_SCHEMA.md §6 (Performance Notes — Critical Query Paths)
        - POSTGRESQL_MIGRATION.md §6 (Seq Counter Atomicity)

    Args:
        room_id: 6-character room code.

    Returns:
        The new (incremented) sequence counter value, or ``None`` if
        the ``room_id`` does not exist (UPDATE matched 0 rows).

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE rooms
            SET seq_counter   = seq_counter + 1,
                last_activity = now(),
                is_dirty      = TRUE
            WHERE room_id = $1
            RETURNING seq_counter
            """,
            room_id,
        )
    if row is None:
        return None
    return row["seq_counter"]


# =========================================================================
# CRUD — room_members (Day 3, M3)
# =========================================================================

async def insert_room_member(
    user_id: str,
    room_id: str,
) -> asyncpg.Record:
    """
    Add a user to a room, enforcing the 8-user capacity limit.

    Uses a **SERIALIZABLE** transaction to atomically:
        1. ``SELECT COUNT(*) FROM room_members WHERE room_id = $1``
        2. If count >= 8 → raise ``RoomFullError``
        3. ``INSERT INTO room_members (user_id, room_id)``
        4. ``UPDATE rooms SET last_activity = now() WHERE room_id = $1``

    The SERIALIZABLE isolation level prevents the race condition where
    two users join simultaneously and both see count=7, pushing the
    room to 9 users (per POSTGRESQL_MIGRATION.md §6).

    If a serialization conflict occurs (``asyncpg.SerializationError``),
    the caller should retry the operation once.

    Args:
        user_id: UUID v4 string of the joining user.
        room_id: 6-character room code.

    Returns:
        The inserted ``asyncpg.Record`` with columns:
        ``user_id``, ``room_id``, ``joined_at``.

    Raises:
        RoomFullError: If the room already has 8 members.
        RuntimeError: If the connection pool is not initialized.
        asyncpg.SerializationError: On serialization conflict (caller
            should retry).
        asyncpg.ForeignKeyViolationError: If user_id or room_id
            does not exist.
        asyncpg.UniqueViolationError: If the user is already in the room.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        async with conn.transaction(isolation='serializable'):
            # Step 1: Check current member count
            count = await conn.fetchval(
                "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
                room_id,
            )

            # Step 2: Enforce capacity
            if count >= MAX_ROOM_MEMBERS:
                raise RoomFullError(room_id, count)

            # Step 3: Insert member row
            row = await conn.fetchrow(
                """
                INSERT INTO room_members (user_id, room_id)
                VALUES ($1, $2)
                RETURNING user_id, room_id, joined_at
                """,
                _uuid.UUID(user_id),
                room_id,
            )

            # Step 4: Touch room last_activity
            await conn.execute(
                "UPDATE rooms SET last_activity = now() WHERE room_id = $1",
                room_id,
            )

    return row


async def remove_room_member(
    user_id: str,
    room_id: str,
) -> bool:
    """
    Remove a user from a room.

    Idempotent — returns ``False`` if the membership row did not exist.
    Also updates ``rooms.last_activity`` to ``now()``.

    The schema's ``ON DELETE CASCADE`` on ``room_members`` handles
    automatic cleanup when a user or room is deleted from the parent
    table. This function handles the *explicit* leave/disconnect case.

    Args:
        user_id: UUID v4 string of the leaving user.
        room_id: 6-character room code.

    Returns:
        ``True`` if a row was deleted, ``False`` if the user was not
        a member of the room.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        async with conn.transaction():
            result = await conn.execute(
                "DELETE FROM room_members WHERE user_id = $1 AND room_id = $2",
                _uuid.UUID(user_id),
                room_id,
            )

            # result is a status string like 'DELETE 1' or 'DELETE 0'
            deleted = result == "DELETE 1"

            if deleted:
                await conn.execute(
                    "UPDATE rooms SET last_activity = now() WHERE room_id = $1",
                    room_id,
                )

    return deleted


async def count_room_members(room_id: str) -> int:
    """
    Count the current number of members in a room.

    Args:
        room_id: 6-character room code.

    Returns:
        Integer count of members (0 if room has no members or
        does not exist).

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM room_members WHERE room_id = $1",
            room_id,
        )
    return count


async def get_room_members(room_id: str) -> List[asyncpg.Record]:
    """
    List all members of a room with their usernames.

    Performs a JOIN with the ``users`` table to retrieve display names.
    Used by M1 to populate the ``members`` array in ``join_ack``.

    Args:
        room_id: 6-character room code.

    Returns:
        List of ``asyncpg.Record``, each with columns:
        ``user_id`` (UUID), ``username`` (str), ``joined_at`` (datetime).

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT rm.user_id, u.username, rm.joined_at
            FROM room_members rm
            JOIN users u ON u.user_id = rm.user_id
            WHERE rm.room_id = $1
            ORDER BY rm.joined_at
            """,
            room_id,
        )
    return rows


# =========================================================================
# CRUD — room queries (Day 4, M1)
# =========================================================================

async def room_exists(room_id: str) -> bool:
    """
    Check whether a room with the given ID exists in the ``rooms`` table.

    Used by M1's ``join_room`` handler to validate the room_id before
    attempting to insert a room member.

    Args:
        room_id: 6-character room code.

    Returns:
        ``True`` if the room exists, ``False`` otherwise.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        row = await conn.fetchval(
            "SELECT 1 FROM rooms WHERE room_id = $1",
            room_id,
        )
    return row is not None


async def count_active_rooms() -> int:
    """
    Count rooms with ``status = 'active'``.

    Used by M1's ``create_room`` handler to enforce the MAX_ROOMS (10) limit.

    Returns:
        Integer count of active rooms.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM rooms WHERE status = 'active'",
        )
    return count


async def get_room_seq(room_id: str) -> Optional[int]:
    """
    Get the current sequence counter for a room.

    Used by M1 to populate the ``seq`` field in ``canvas_snapshot``
    when a user joins a room.

    Args:
        room_id: 6-character room code.

    Returns:
        The current ``seq_counter`` value, or ``None`` if the room
        does not exist.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        row = await conn.fetchval(
            "SELECT seq_counter FROM rooms WHERE room_id = $1",
            room_id,
        )
    return row


async def _record_action_history(
    conn: asyncpg.Connection,
    room_id: str,
    user_id: str,
    seq_num: int,
    op_type: str,
    obj_id: str,
    forward_data: dict,
    inverse_data: dict,
) -> None:
    """
    Record an action into the action_history table and enforce the 50-action limit.
    """
    await conn.execute(
        """
        INSERT INTO action_history
            (room_id, user_id, seq_num, op_type, obj_id, forward_data, inverse_data)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        """,
        room_id,
        _uuid.UUID(user_id),
        seq_num,
        op_type,
        _uuid.UUID(obj_id),
        _json.dumps(forward_data),
        _json.dumps(inverse_data),
    )

    await conn.execute(
        """
        DELETE FROM action_history
        WHERE action_id IN (
            SELECT action_id
            FROM action_history
            WHERE room_id = $1 AND user_id = $2
            ORDER BY seq_num DESC
            OFFSET 50
        )
        """,
        room_id,
        _uuid.UUID(user_id),
    )


# =========================================================================
# CRUD — canvas_objects (Day 4, M3)
# =========================================================================

async def insert_canvas_object(
    room_id: str,
    user_id: str,
    obj_type: str,
    z_index: int,
    color: str,
    stroke_width: int,
    properties: dict,
) -> Tuple[int, str, str]:
    """
    Atomically insert a canvas object and increment the room's seq_counter.

    Both operations execute inside a **single transaction** so the
    ``seq_counter`` is rolled back if the ``INSERT`` fails (no sequence
    gaps).  This is the critical write path for every ``op: "add"``
    operation.

    Transaction flow (per POSTGRESQL_MIGRATION.md §6):
        1. ``UPDATE rooms SET seq_counter = seq_counter + 1 ... RETURNING``
        2. ``INSERT INTO canvas_objects (...) RETURNING obj_id, created_at``

    Args:
        room_id: 6-character room code.
        user_id: UUID v4 string of the creating user.
        obj_type: One of the 8 ``obj_type`` enum values.
        z_index: Draw order (≥ 0).
        color: ``#RRGGBB`` hex string.
        stroke_width: Stroke width in pixels (≥ 0).
        properties: Type-specific JSONB properties dict.

    Returns:
        A 3-tuple ``(seq, obj_id, created_at)``:
            - seq (int):  The new monotonic sequence number.
            - obj_id (str):  UUID v4 string of the created object.
            - created_at (str):  ISO 8601 timestamp string.

    Raises:
        RuntimeError: If the connection pool is not initialized or
            the room does not exist (UPDATE matched 0 rows).
        asyncpg.ForeignKeyViolationError: If ``user_id`` does not exist.
        asyncpg.DataError: If ``obj_type`` is not in the PG enum.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    obj_id = _uuid.uuid4()

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Step 1: Atomically increment seq_counter
            seq_row = await conn.fetchrow(
                """
                UPDATE rooms
                SET seq_counter   = seq_counter + 1,
                    last_activity = now(),
                    is_dirty      = TRUE
                WHERE room_id = $1
                RETURNING seq_counter
                """,
                room_id,
            )
            if seq_row is None:
                raise RuntimeError(f"Room {room_id} not found")

            seq = seq_row["seq_counter"]

            # Step 2: Insert the canvas object
            obj_row = await conn.fetchrow(
                """
                INSERT INTO canvas_objects
                    (obj_id, room_id, created_by, obj_type,
                     z_index, color, stroke_width, properties)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
                RETURNING obj_id, created_at
                """,
                obj_id,
                room_id,
                _uuid.UUID(user_id),
                obj_type,
                z_index,
                color,
                stroke_width,
                _json.dumps(properties),
            )

            # Record in action_history (Day 8)
            forward_data = {
                "op": "add",
                "object": {
                    "obj_id": str(obj_id),
                    "obj_type": obj_type,
                    "z_index": z_index,
                    "color": color,
                    "stroke_width": stroke_width,
                    "properties": properties,
                }
            }
            inverse_data = {
                "op": "delete",
                "obj_id": str(obj_id),
            }
            await _record_action_history(
                conn, room_id, user_id, seq, "add", str(obj_id), forward_data, inverse_data
            )

    return (
        seq,
        str(obj_row["obj_id"]),
        obj_row["created_at"].isoformat(),
    )


async def update_canvas_object(
    room_id: str,
    user_id: str,
    obj_id: str,
    changes: dict,
) -> Optional[Tuple[int, str]]:
    """
    Atomically modify a canvas object and increment the room's seq_counter.

    Both operations execute inside a **single transaction** so the
    ``seq_counter`` is rolled back if the ``UPDATE`` fails (no sequence
    gaps).

    The ``changes`` dict may contain any combination of:
        - ``color`` (str): New ``#RRGGBB`` hex color.
        - ``stroke_width`` (int): New stroke width in pixels.
        - ``z_index`` (int): New draw order.
        - ``properties`` (dict): Partial JSONB merge — only provided
          keys are overwritten, existing keys are preserved via
          PostgreSQL ``||`` operator.

    Only objects where ``is_deleted = FALSE`` are eligible for update.
    If the object does not exist or has been soft-deleted, returns
    ``None`` (caller should send ``op_rejected("object_not_found")``).

    Transaction strategy (per POSTGRESQL_MIGRATION.md §6):
        - Isolation: READ COMMITTED (default)
        - ``UPDATE canvas_objects SET ... WHERE obj_id = $1 AND is_deleted = FALSE``
        - Check rowcount; if 0 → return None (no seq consumed)

    Args:
        room_id: 6-character room code (for seq_counter increment).
        user_id: UUID v4 string of the modifying user.
        obj_id: UUID v4 string of the target object.
        changes: Validated changes dict (from ``ModifyChangesPayload``).

    Returns:
        A 2-tuple ``(seq, obj_id)`` on success, or ``None`` if the
        object was not found / already deleted.

    Raises:
        RuntimeError: If the connection pool is not initialized or
            the room does not exist.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    # --- Build dynamic SET clause for canvas_objects -------------------------
    set_parts: list[str] = []
    params: list = []
    param_idx = 1  # asyncpg uses $1, $2, ...

    # Column-level changes
    for col in ("color", "stroke_width", "z_index"):
        if col in changes and changes[col] is not None:
            set_parts.append(f"{col} = ${param_idx}")
            params.append(changes[col])
            param_idx += 1

    # JSONB merge for properties (partial update via || operator)
    if "properties" in changes and changes["properties"] is not None:
        set_parts.append(f"properties = properties || ${param_idx}::jsonb")
        params.append(_json.dumps(changes["properties"]))
        param_idx += 1

    if not set_parts:
        # Nothing to update (should not happen if ModifyChangesPayload validated)
        return None

    # Add obj_id and is_deleted guard to WHERE clause
    obj_id_param = f"${param_idx}"
    params.append(_uuid.UUID(obj_id))
    param_idx += 1

    update_sql = (
        f"UPDATE canvas_objects SET {', '.join(set_parts)} "
        f"WHERE obj_id = {obj_id_param} AND is_deleted = FALSE "
        f"RETURNING obj_id"
    )

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Step 1: Read existing row for undo tracking (Day 8)
            old_row = await conn.fetchrow(
                """
                SELECT color, stroke_width, z_index, properties
                FROM canvas_objects
                WHERE obj_id = $1 AND is_deleted = FALSE
                """,
                _uuid.UUID(obj_id)
            )
            if old_row is None:
                # Object not found or already deleted — no seq consumed
                return None

            # Calculate inverse data
            old_changes = {}
            if "color" in changes: old_changes["color"] = old_row["color"]
            if "stroke_width" in changes: old_changes["stroke_width"] = old_row["stroke_width"]
            if "z_index" in changes: old_changes["z_index"] = old_row["z_index"]
            if "properties" in changes and changes["properties"] is not None:
                old_props = _json.loads(old_row["properties"])
                prop_changes = {}
                for k in changes["properties"].keys():
                    prop_changes[k] = old_props.get(k)
                old_changes["properties"] = prop_changes

            # Step 2: Attempt the canvas object update
            obj_row = await conn.fetchrow(update_sql, *params)

            if obj_row is None:
                # Object not found or already deleted — no seq consumed
                return None

            # Step 2: Atomically increment seq_counter (only if update succeeded)
            seq_row = await conn.fetchrow(
                """
                UPDATE rooms
                SET seq_counter   = seq_counter + 1,
                    last_activity = now(),
                    is_dirty      = TRUE
                WHERE room_id = $1
                RETURNING seq_counter
                """,
                room_id,
            )
            if seq_row is None:
                raise RuntimeError(f"Room {room_id} not found")

            seq = seq_row["seq_counter"]

            # Record in action_history
            forward_data = {"op": "modify", "obj_id": obj_id, "changes": changes}
            inverse_data = {"op": "modify", "obj_id": obj_id, "changes": old_changes}
            await _record_action_history(
                conn, room_id, user_id, seq, "modify", obj_id, forward_data, inverse_data
            )

    return (seq, str(obj_row["obj_id"]))


async def soft_delete_canvas_object(
    room_id: str,
    user_id: str,
    obj_id: str,
) -> Optional[Tuple[int, str]]:
    """
    Atomically soft-delete a canvas object and increment the room's seq_counter.

    Sets ``is_deleted = TRUE`` on the target row. Only objects that are
    currently ``is_deleted = FALSE`` can be deleted. If the object does
    not exist or is already deleted, returns ``None`` (caller should
    send ``op_rejected("object_not_found")``).

    Also decrements ``rooms.total_objects`` by 1 to keep the count
    consistent with the number of live canvas objects.

    Both mutations execute inside a **single transaction** so the
    ``seq_counter`` is rolled back if the soft-delete fails.

    Transaction strategy (per POSTGRESQL_MIGRATION.md §6):
        - Isolation: READ COMMITTED (default)
        - ``UPDATE canvas_objects SET is_deleted = TRUE WHERE obj_id = $1 AND is_deleted = FALSE``
        - Check rowcount; if 0 → return None (no seq consumed)

    Args:
        room_id: 6-character room code (for seq_counter increment).
        user_id: UUID v4 string of the modifying user.
        obj_id: UUID v4 string of the target object.

    Returns:
        A 2-tuple ``(seq, obj_id)`` on success, or ``None`` if the
        object was not found / already deleted.

    Raises:
        RuntimeError: If the connection pool is not initialized or
            the room does not exist.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Step 1: Read existing row for undo tracking (Day 8)
            old_row = await conn.fetchrow(
                """
                SELECT obj_type, z_index, color, stroke_width, properties
                FROM canvas_objects
                WHERE obj_id = $1 AND is_deleted = FALSE
                """,
                _uuid.UUID(obj_id)
            )
            if old_row is None:
                # Object not found or already deleted — no seq consumed
                return None

            # Step 2: Soft-delete the canvas object
            obj_row = await conn.fetchrow(
                """
                UPDATE canvas_objects
                SET is_deleted = TRUE
                WHERE obj_id = $1 AND is_deleted = FALSE
                RETURNING obj_id
                """,
                _uuid.UUID(obj_id),
            )

            if obj_row is None:
                # Object not found or already deleted — no seq consumed
                return None

            # Step 2: Atomically increment seq_counter and decrement total_objects
            seq_row = await conn.fetchrow(
                """
                UPDATE rooms
                SET seq_counter   = seq_counter + 1,
                    last_activity = now(),
                    is_dirty      = TRUE,
                    total_objects = GREATEST(total_objects - 1, 0)
                WHERE room_id = $1
                RETURNING seq_counter
                """,
                room_id,
            )
            if seq_row is None:
                raise RuntimeError(f"Room {room_id} not found")

            seq = seq_row["seq_counter"]

            # Record in action_history
            forward_data = {"op": "delete", "obj_id": obj_id}
            inverse_data = {
                "op": "add",
                "object": {
                    "obj_id": obj_id,
                    "obj_type": old_row["obj_type"],
                    "z_index": old_row["z_index"],
                    "color": old_row["color"],
                    "stroke_width": old_row["stroke_width"],
                    "properties": _json.loads(old_row["properties"]),
                }
            }
            await _record_action_history(
                conn, room_id, user_id, seq, "delete", obj_id, forward_data, inverse_data
            )

    return (seq, str(obj_row["obj_id"]))


# =========================================================================
# CRUD — canvas snapshot query (Day 6, M3)
# =========================================================================

async def get_canvas_objects(room_id: str) -> List[asyncpg.Record]:
    """
    Fetch all active (non-deleted) canvas objects for a room.

    Used by M1's ``handle_join_room`` to populate the ``objects`` array
    in the ``canvas_snapshot`` message sent to newly joining clients.
    Also used by the ``load_canvas`` handler (Day 7).

    Query details:
        - Filters: ``room_id = $1 AND is_deleted = FALSE``
        - Sort: ``ORDER BY z_index ASC, created_at ASC``
          (visual layering first, chronological tie-breaking second)
        - Index: Hits ``idx_co_room_active`` partial B-tree index
          (DATABASE_SCHEMA.md §3.4)
        - No pagination: returns the full set in a single batch.
          Expected <5ms for 100 objects (DATABASE_SCHEMA.md §6).

    The caller is responsible for serializing the returned records
    into the ``canvas_snapshot`` payload shape (converting UUIDs to
    strings and datetimes to ISO 8601).

    Args:
        room_id: 6-character room code.

    Returns:
        List of ``asyncpg.Record``, each with columns:
        ``obj_id`` (UUID), ``obj_type`` (str), ``created_by`` (UUID),
        ``created_at`` (datetime), ``z_index`` (int), ``color`` (str),
        ``stroke_width`` (int), ``properties`` (dict/JSON).

        Returns an empty list if the room has no active objects
        or the room does not exist.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT obj_id, obj_type, created_by, created_at,
                   z_index, color, stroke_width, properties
            FROM   canvas_objects
            WHERE  room_id = $1 AND is_deleted = FALSE
            ORDER  BY z_index ASC, created_at ASC
            """,
            room_id,
        )
    return rows


# =========================================================================
# CRUD — autosave helpers (Day 9, M3)
# =========================================================================

async def get_dirty_rooms() -> List[asyncpg.Record]:
    """
    Fetch all rooms where ``is_dirty = TRUE``.

    Used by the ``autosave_loop`` background task (Day 9, M3) to
    determine which rooms need their canvas state saved.

    Returns:
        List of ``asyncpg.Record``, each with columns:
        ``room_id`` (str), ``seq_counter`` (int).

        Returns an empty list if no rooms are dirty.

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT room_id, seq_counter
            FROM   rooms
            WHERE  is_dirty = TRUE
            """,
        )
    return rows


async def save_canvas_snapshot(
    room_id: str,
    snapshot_json: dict,
    total_objects: int,
    seq_at_save: int,
    save_type: str = "auto",
) -> Optional[str]:
    """
    Insert a canvas snapshot into ``saved_canvases`` and reset the room's
    dirty flag.

    Executes atomically within a single transaction:
        1. ``INSERT INTO saved_canvases (...)`` with the serialized snapshot
        2. ``UPDATE rooms SET is_dirty = FALSE, last_saved = now()``

    Used by:
        - ``autosave_loop`` (Day 9, M3) with ``save_type='auto'``
        - Future manual save handler with ``save_type='manual'``

    Args:
        room_id: 6-character room code.
        snapshot_json: Full canvas object array as a dict (``{"objects": [...]}``)
            to be stored as JSONB.
        total_objects: Count of live canvas objects at save time.
        seq_at_save: The room's current ``seq_counter`` at save time.
        save_type: ``'auto'`` (default) or ``'manual'``.

    Returns:
        The UUID string of the newly created ``save_id``, or ``None``
        if the room does not exist (UPDATE matched 0 rows).

    Raises:
        RuntimeError: If the connection pool is not initialized.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        async with conn.transaction():
            # Step 1: Insert the snapshot record
            save_row = await conn.fetchrow(
                """
                INSERT INTO saved_canvases
                    (room_id, save_type, snapshot_json, total_objects, seq_at_save)
                VALUES ($1, $2, $3::jsonb, $4, $5)
                RETURNING save_id
                """,
                room_id,
                save_type,
                _json.dumps(snapshot_json),
                total_objects,
                seq_at_save,
            )

            # Step 2: Reset the dirty flag (only if no new ops occurred) and update last_saved
            result = await conn.execute(
                """
                UPDATE rooms
                SET is_dirty   = (seq_counter > $2),
                    last_saved = now()
                WHERE room_id = $1
                """,
                room_id,
                seq_at_save,
            )

            # Verify the room existed
    return str(save_row["save_id"])


# =========================================================================
# Image helpers (Day 10, M3)
# =========================================================================

async def insert_image(
    image_id: str,
    room_id: str,
    obj_id: str,
    filename: str,
    mime_type: str,
    file_size: int,
) -> None:
    """
    Insert an image metadata record into the `images` table.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO images
                (image_id, room_id, obj_id, filename, mime_type, file_size)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            _uuid.UUID(image_id),
            room_id,
            _uuid.UUID(obj_id),
            filename,
            mime_type,
            file_size,
        )

# =========================================================================
# Cleanup helpers (Day 10, M3)
# =========================================================================

async def delete_stale_rooms() -> List[str]:
    """
    Delete rooms inactive for > 24 hours and return their room_ids.
    Used by the cleanup_loop.
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            DELETE FROM rooms
            WHERE last_activity < now() - INTERVAL '24 hours'
            RETURNING room_id
            """
        )
    return [row["room_id"] for row in rows]

async def update_room_status(room_id: str, status: str) -> None:
    """
    Update the status of a room (e.g., 'active', 'empty').
    """
    if pool is None:
        raise RuntimeError("Database pool is not initialized")

    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE rooms
            SET status = $2
            WHERE room_id = $1
            """,
            room_id,
            status,
        )
