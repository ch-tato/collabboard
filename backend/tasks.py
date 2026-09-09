# =============================================================================
# CollabBoard — Background Tasks
# =============================================================================
# Owner : M3 (Data/Sync)
# Sprint: Day 9 — Autosave loop with Redis distributed lock
#
# This module implements periodic background tasks using asyncio:
#   - autosave_loop (every 60s) with Redis distributed lock (lock:autosave)
#   - cleanup_loop placeholder (Day 10, every 6h) with lock:cleanup
#
# The autosave_loop:
#   1. Attempts to acquire the Redis distributed lock:
#      SET lock:autosave <server_id> NX EX 55
#   2. If acquired (OK), queries all rooms where is_dirty = TRUE
#   3. For each dirty room, serializes the current canvas state and
#      inserts a snapshot into saved_canvases
#   4. Resets is_dirty = FALSE and updates last_saved on the room
#   5. If lock not acquired (nil), logs and skips this cycle
#
# Exception handling:
#   - Each room's save is wrapped in its own try/except to prevent
#     one failed room from aborting the entire cycle
#   - The outer loop is wrapped in a catch-all to prevent the
#     background task from crashing the FastAPI server
#
# Reference:
#   - IMPLEMENTATION_PLAN.md §B4
#   - DISTRIBUTED_SYSTEM_DESIGN.md §8.1 (lock:autosave key schema)
#   - DISTRIBUTED_SYSTEM_DESIGN.md §8.2 (Autosave Lock details)
#   - DATABASE_SCHEMA.md §3.7 (saved_canvases table)
# =============================================================================
"""
Background Tasks: autosave via Redis distributed lock.

Exposes:
    start_autosave_loop()  — Launch the autosave asyncio.Task.
                             Returns the Task handle for cancellation.

Day 10 TODO:
    - cleanup_loop: every 6h, SET lock:cleanup NX EX 21600,
      delete 24-hour stale rooms
"""

from __future__ import annotations

import asyncio
import json
from typing import Optional

from backend import db
from backend import redis_client

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
AUTOSAVE_INTERVAL_SECONDS: int = 60
"""How often the autosave loop runs (per DISTRIBUTED_SYSTEM_DESIGN.md §8.2)."""

AUTOSAVE_LOCK_KEY: str = "lock:autosave"
"""Redis key for the distributed autosave lock."""

AUTOSAVE_LOCK_TTL_SECONDS: int = 55
"""Lock TTL — slightly less than the 60s interval so it auto-expires
before the next cycle.  Per DISTRIBUTED_SYSTEM_DESIGN.md §8.2."""


# ---------------------------------------------------------------------------
# Autosave Loop
# ---------------------------------------------------------------------------

async def autosave_loop(server_id: str) -> None:
    """
    Background coroutine that runs the autosave cycle every 60 seconds.

    Lifecycle:
        1. Sleep for ``AUTOSAVE_INTERVAL_SECONDS`` (60s).
        2. Attempt to acquire the Redis distributed lock:
           ``SET lock:autosave <server_id> NX EX 55``
        3. If acquired → process all dirty rooms:
           a. Query ``rooms WHERE is_dirty = TRUE``
           b. For each dirty room:
              - Fetch all active canvas objects via ``get_canvas_objects()``
              - Serialize into snapshot JSON
              - INSERT into ``saved_canvases``
              - UPDATE room: ``is_dirty = FALSE``, ``last_saved = now()``
        4. If NOT acquired → log and skip (another backend holds the lock).
        5. Repeat from step 1.

    The loop runs indefinitely until cancelled (via ``task.cancel()``
    during FastAPI shutdown).

    Exception handling:
        - Per-room errors are caught and logged; the loop continues
          to the next dirty room.
        - Cycle-level errors (e.g., Redis or PG completely down) are
          caught and logged; the loop sleeps and retries next cycle.
        - ``asyncio.CancelledError`` propagates normally (graceful shutdown).

    Args:
        server_id: This backend's SERVER_ID (used as the lock value
                   and for log prefixing).
    """
    print(f"[{server_id}] [autosave] Background task started "
          f"(interval={AUTOSAVE_INTERVAL_SECONDS}s, "
          f"lock_ttl={AUTOSAVE_LOCK_TTL_SECONDS}s)")

    while True:
        # Step 1: Sleep first — give the server time to fully start up
        # on the first iteration, and space out subsequent cycles.
        await asyncio.sleep(AUTOSAVE_INTERVAL_SECONDS)

        # Step 2: Attempt to run the autosave cycle
        try:
            await _run_autosave_cycle(server_id)
        except asyncio.CancelledError:
            # Graceful shutdown — re-raise so the task exits cleanly
            print(f"[{server_id}] [autosave] Background task cancelled")
            raise
        except Exception as exc:
            # Catch-all: prevent the background task from crashing.
            # Log the error and continue to the next cycle.
            print(
                f"[{server_id}] [autosave] ERROR: Cycle failed — "
                f"{type(exc).__name__}: {exc}"
            )


async def _run_autosave_cycle(server_id: str) -> None:
    """
    Execute a single autosave cycle: acquire lock, save dirty rooms.

    Separated from the loop for clarity and testability.

    Args:
        server_id: This backend's SERVER_ID.
    """
    # -- Step 1: Acquire the distributed lock ---------------------------------
    lock_acquired = await _try_acquire_autosave_lock(server_id)

    if not lock_acquired:
        print(
            f"[{server_id}] [autosave] Lock held by another instance "
            f"— skipping this cycle"
        )
        return

    print(f"[{server_id}] [autosave] Lock acquired — scanning for dirty rooms")

    # -- Step 2: Query all dirty rooms ----------------------------------------
    try:
        dirty_rooms = await db.get_dirty_rooms()
    except Exception as exc:
        print(
            f"[{server_id}] [autosave] ERROR: Failed to query dirty rooms — "
            f"{type(exc).__name__}: {exc}"
        )
        return

    if not dirty_rooms:
        print(f"[{server_id}] [autosave] No dirty rooms found — cycle complete")
        return

    print(
        f"[{server_id}] [autosave] Found {len(dirty_rooms)} dirty room(s): "
        f"{[r['room_id'] for r in dirty_rooms]}"
    )

    # -- Step 3: Save each dirty room -----------------------------------------
    saved_count = 0
    error_count = 0

    for room_row in dirty_rooms:
        room_id = room_row["room_id"]
        seq_at_save = room_row["seq_counter"]

        try:
            await _save_room_snapshot(server_id, room_id, seq_at_save)
            saved_count += 1
        except Exception as exc:
            error_count += 1
            print(
                f"[{server_id}] [autosave] ERROR: Failed to save room "
                f"{room_id} — {type(exc).__name__}: {exc}"
            )

    print(
        f"[{server_id}] [autosave] Cycle complete — "
        f"saved={saved_count}, errors={error_count}"
    )


async def _try_acquire_autosave_lock(server_id: str) -> bool:
    """
    Attempt to acquire the Redis distributed autosave lock.

    Uses ``SET lock:autosave <server_id> NX EX 55``:
        - ``NX``: Only set if the key does not already exist.
        - ``EX 55``: Auto-expire after 55 seconds.

    Per DISTRIBUTED_SYSTEM_DESIGN.md §8.2:
        - If returns ``OK``: this backend runs the autosave cycle.
        - If returns ``nil``: another backend holds the lock; skip.
        - Lock is NOT explicitly released — TTL handles expiry.

    Args:
        server_id: This backend's SERVER_ID (stored as the lock value).

    Returns:
        ``True`` if the lock was acquired, ``False`` otherwise
        (including Redis unavailability).
    """
    if redis_client.redis_conn is None:
        # Redis is not available — cannot coordinate. Skip this cycle.
        print(
            f"[{server_id}] [autosave] Redis unavailable — "
            f"cannot acquire lock, skipping"
        )
        return False

    try:
        result = await redis_client.redis_conn.set(
            AUTOSAVE_LOCK_KEY,
            server_id,
            nx=True,
            ex=AUTOSAVE_LOCK_TTL_SECONDS,
        )
        # redis.set with NX returns True if set, None if not set
        return result is True
    except Exception as exc:
        print(
            f"[{server_id}] [autosave] ERROR: Failed to acquire lock — "
            f"{type(exc).__name__}: {exc}"
        )
        return False


async def _save_room_snapshot(
    server_id: str,
    room_id: str,
    seq_at_save: int,
) -> None:
    """
    Serialize and save a single room's canvas state.

    Steps:
        1. Fetch all active (non-deleted) canvas objects via
           ``db.get_canvas_objects(room_id)``
        2. Serialize each record into a JSON-friendly dict
           (UUID → str, datetime → ISO 8601)
        3. Build the ``snapshot_json`` payload: ``{"objects": [...]}``
        4. Call ``db.save_canvas_snapshot()`` which atomically:
           - INSERTs into ``saved_canvases``
           - UPDATEs the room's ``is_dirty = FALSE``, ``last_saved = now()``

    Args:
        server_id: For log prefixing.
        room_id: 6-character room code.
        seq_at_save: The room's current seq_counter.

    Raises:
        Any exception from asyncpg or db operations — caller handles.
    """
    # Step 1: Fetch all active canvas objects
    objects = await db.get_canvas_objects(room_id)

    # Step 2: Serialize each record into a JSON-friendly dict
    serialized_objects = []
    for obj in objects:
        serialized_objects.append({
            "obj_id": str(obj["obj_id"]),
            "obj_type": obj["obj_type"],
            "created_by": str(obj["created_by"]),
            "created_at": obj["created_at"].isoformat(),
            "z_index": obj["z_index"],
            "color": obj["color"],
            "stroke_width": obj["stroke_width"],
            "properties": (
                json.loads(obj["properties"])
                if isinstance(obj["properties"], str)
                else obj["properties"]
            ),
        })

    total_objects = len(serialized_objects)

    # Step 3: Build the snapshot payload
    snapshot_json = {"objects": serialized_objects}

    # Step 4: Persist to saved_canvases + reset dirty flag
    save_id = await db.save_canvas_snapshot(
        room_id=room_id,
        snapshot_json=snapshot_json,
        total_objects=total_objects,
        seq_at_save=seq_at_save,
        save_type="auto",
    )

    print(
        f"[{server_id}] [autosave] Saved room {room_id}: "
        f"save_id={save_id}, objects={total_objects}, seq={seq_at_save}"
    )


# ---------------------------------------------------------------------------
# Task Launcher
# ---------------------------------------------------------------------------

def start_autosave_loop(server_id: str) -> asyncio.Task:
    """
    Create and return the autosave background task.

    The returned ``asyncio.Task`` should be stored by the caller
    (FastAPI lifespan) and cancelled during shutdown.

    Args:
        server_id: This backend's SERVER_ID.

    Returns:
        The running ``asyncio.Task`` for the autosave loop.
    """
    task = asyncio.create_task(
        autosave_loop(server_id),
        name=f"autosave_loop_{server_id}",
    )
    return task

# ---------------------------------------------------------------------------
# Cleanup Loop (Day 10)
# ---------------------------------------------------------------------------

CLEANUP_INTERVAL_SECONDS: int = 21600
CLEANUP_LOCK_KEY: str = "lock:cleanup"
CLEANUP_LOCK_TTL_SECONDS: int = 21600

import shutil
from pathlib import Path

async def cleanup_loop(server_id: str) -> None:
    print(f"[{server_id}] [cleanup] Background task started (interval={CLEANUP_INTERVAL_SECONDS}s)")
    
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL_SECONDS)
        try:
            await _run_cleanup_cycle(server_id)
        except asyncio.CancelledError:
            print(f"[{server_id}] [cleanup] Background task cancelled")
            raise
        except Exception as exc:
            print(f"[{server_id}] [cleanup] ERROR: Cycle failed — {type(exc).__name__}: {exc}")

async def _run_cleanup_cycle(server_id: str) -> None:
    if redis_client.redis_conn is None:
        return
        
    try:
        lock_acquired = await redis_client.redis_conn.set(
            CLEANUP_LOCK_KEY,
            server_id,
            nx=True,
            ex=CLEANUP_LOCK_TTL_SECONDS,
        )
    except Exception as exc:
        print(f"[{server_id}] [cleanup] ERROR: Failed to acquire lock: {exc}")
        return
        
    if not lock_acquired:
        return
        
    print(f"[{server_id}] [cleanup] Lock acquired — deleting stale rooms")
    
    try:
        deleted_rooms = await db.delete_stale_rooms()
    except Exception as exc:
        print(f"[{server_id}] [cleanup] ERROR: Failed to delete stale rooms: {exc}")
        return
        
    if not deleted_rooms:
        return
        
    print(f"[{server_id}] [cleanup] Deleted {len(deleted_rooms)} stale room(s). Cleaning up disk...")
    
    project_root = Path(__file__).resolve().parent.parent
    for room_id in deleted_rooms:
        room_dir = project_root / "data" / "canvases" / room_id
        if room_dir.exists():
            try:
                shutil.rmtree(room_dir)
            except Exception as exc:
                print(f"[{server_id}] [cleanup] ERROR: Failed to rmtree {room_id}: {exc}")

def start_cleanup_loop(server_id: str) -> asyncio.Task:
    task = asyncio.create_task(
        cleanup_loop(server_id),
        name=f"cleanup_loop_{server_id}",
    )
    return task
