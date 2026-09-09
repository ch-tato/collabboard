# =============================================================================
# CollabBoard — Redis Pub/Sub Subscriber
# =============================================================================
# Owner : M1 (Server & DevOps)
# Sprint: Day 5 — Cross-server message relay via Redis pub/sub
#
# This module runs a dedicated asyncio task that subscribes to Redis
# room channels using PSUBSCRIBE room:* and relays cross-server messages
# to local WebSocket clients via the ConnectionManager.
#
# Architecture:
#   - Uses a SEPARATE Redis connection (dedicated for pub/sub; the main
#     redis_conn in redis_client.py is used for commands like HSET/SADD/PUBLISH).
#   - Uses PSUBSCRIBE room:* to capture all room events with a single
#     subscription. With ≤10 rooms this is simpler than dynamic per-room
#     subscribe/unsubscribe management.
#   - Implements anti-echo: messages with _server_id == MY_SERVER_ID are
#     skipped because the originating backend already broadcast locally.
#   - Auto-reconnects on Redis disconnection with a 2-second backoff.
#
# Envelope format (DISTRIBUTED_SYSTEM_DESIGN.md §8):
#   {
#     "_server_id": "backend-1",
#     "_type": "op_broadcast",
#     "payload": { ... }
#   }
#
# Subscriber logic (DISTRIBUTED_SYSTEM_DESIGN.md §8):
#   on_redis_message(channel, message):
#       if message._server_id == MY_SERVER_ID:
#           return  # skip own messages (already broadcast locally)
#       room_id = extract_room_id(channel)
#       for ws in local_room_connections[room_id]:
#           ws.send(message.payload)
#
# Relayed message types (_type field):
#   - op_broadcast
#   - user_joined
#   - user_left
#   - canvas_snapshot
#   - cursor_update
#   - cursor_chat_broadcast
#
# Reference:
#   - IMPLEMENTATION_PLAN.md §B3 (pubsub.py as dedicated asyncio task)
#   - DISTRIBUTED_SYSTEM_DESIGN.md §4 (Local-First Broadcast), §8 (Sync)
#   - DISTRIBUTED_SYSTEM_DESIGN.md §8.1 (Redis Key/Channel Schema)
#   - DEVOPS_ARCHITECTURE.md §11 (Cross-Server Communication)
# =============================================================================
"""
Redis Subscriber: listens to room channels, relays to local WebSockets.

Exposes:
    start_subscriber(manager, server_id, redis_url) → asyncio.Task
        Creates and returns a long-running asyncio task that:
        1. Opens a dedicated Redis connection for pub/sub
        2. PSUBSCRIBE room:*
        3. Listens for messages in an infinite loop
        4. Filters out self-published messages (anti-echo)
        5. Relays payloads to local WebSocket clients via ConnectionManager
        6. Auto-reconnects on Redis failure with 2s backoff
"""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

import redis.asyncio as aioredis

if TYPE_CHECKING:
    from backend.connection import ConnectionManager

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
ROOM_CHANNEL_PATTERN: str = "room:*"
"""Redis PSUBSCRIBE pattern to match all room channels (room:{room_id})."""

ROOM_CHANNEL_PREFIX: str = "room:"
"""Prefix to strip from channel names to extract the room_id."""

RECONNECT_DELAY_SECONDS: float = 2.0
"""Delay before attempting to reconnect after a Redis failure."""

# Message types that the subscriber should relay to local clients.
# These match the _type values published by rooms.py, main.py, and sync.py.
RELAYABLE_TYPES: frozenset[str] = frozenset({
    "op_broadcast",
    "user_joined",
    "user_left",
    "canvas_snapshot",
    "cursor_update",
    "cursor_chat_broadcast",
    "selection_update",
    "stream_points",
    "stream_end",
})


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def start_subscriber(
    manager: ConnectionManager,
    server_id: str,
    redis_url: str,
) -> asyncio.Task:
    """
    Create and return a long-running asyncio task for the Redis pub/sub
    subscriber.

    The task subscribes to ``room:*`` using PSUBSCRIBE and relays incoming
    messages to local WebSocket clients. It runs indefinitely until
    cancelled.

    This function should be called during the FastAPI lifespan startup
    phase. The returned task should be stored and cancelled during shutdown.

    Args:
        manager: The ConnectionManager singleton that holds the local
            WebSocket connection registry (``room_connections`` and
            ``broadcast_to_room``).
        server_id: This backend instance's SERVER_ID (e.g. ``"backend-1"``).
            Used for anti-echo filtering.
        redis_url: The REDIS_URL for creating a dedicated subscriber
            connection (separate from the command connection).

    Returns:
        An ``asyncio.Task`` that can be awaited or cancelled.
    """
    task = asyncio.create_task(
        _subscriber_loop(manager, server_id, redis_url),
        name=f"pubsub-subscriber-{server_id}",
    )
    return task


# ---------------------------------------------------------------------------
# Internal: subscriber loop (runs forever)
# ---------------------------------------------------------------------------

async def _subscriber_loop(
    manager: ConnectionManager,
    server_id: str,
    redis_url: str,
) -> None:
    """
    Core subscriber loop. Connects to Redis, subscribes, and listens.

    If the Redis connection drops, logs the error, waits for
    RECONNECT_DELAY_SECONDS, and retries. This loop only exits when
    the asyncio task is cancelled (during application shutdown).

    Args:
        manager: ConnectionManager for local WebSocket broadcast.
        server_id: This backend's SERVER_ID for anti-echo.
        redis_url: Redis connection URL.
    """
    print(f"[pubsub] Subscriber starting for {server_id}...")

    while True:
        conn: aioredis.Redis | None = None
        pubsub: aioredis.client.PubSub | None = None

        try:
            # Create a dedicated Redis connection for pub/sub.
            # CRITICAL: socket_timeout=None is required so that the
            # blocking listen() call can wait indefinitely for messages.
            # Without this, redis-py's default timeout causes the listener
            # to raise TimeoutError on idle connections.
            # health_check_interval=0 disables periodic PING checks that
            # interfere with the pub/sub blocking read.
            conn = aioredis.from_url(
                redis_url,
                decode_responses=True,
                socket_timeout=None,
                socket_connect_timeout=5,
                health_check_interval=0,
            )

            # Verify connectivity
            await conn.ping()
            print(f"[pubsub] Connected to Redis (dedicated subscriber connection)")

            # Subscribe to all room channels via pattern
            pubsub = conn.pubsub()
            await pubsub.psubscribe(ROOM_CHANNEL_PATTERN)
            print(f"[pubsub] PSUBSCRIBE {ROOM_CHANNEL_PATTERN} — listening...")

            # Listen for messages (blocking async iterator)
            async for raw_message in pubsub.listen():
                await _handle_message(raw_message, manager, server_id)

        except asyncio.CancelledError:
            # Graceful shutdown — break out of the retry loop
            print(f"[pubsub] Subscriber task cancelled, shutting down...")
            raise

        except Exception as exc:
            print(
                f"[pubsub] Subscriber error: {exc}. "
                f"Reconnecting in {RECONNECT_DELAY_SECONDS}s..."
            )

        finally:
            # Clean up the pub/sub and connection on any exit
            if pubsub is not None:
                try:
                    await pubsub.punsubscribe(ROOM_CHANNEL_PATTERN)
                    await pubsub.aclose()
                except Exception:
                    pass
            if conn is not None:
                try:
                    await conn.aclose()
                except Exception:
                    pass

        # Wait before retrying (only reached on error, not on cancel)
        await asyncio.sleep(RECONNECT_DELAY_SECONDS)


# ---------------------------------------------------------------------------
# Internal: handle a single incoming pub/sub message
# ---------------------------------------------------------------------------

async def _handle_message(
    raw_message: dict,
    manager: ConnectionManager,
    server_id: str,
) -> None:
    """
    Process a single Redis pub/sub message.

    Expected ``raw_message`` dict from redis-py:
        - ``type``: ``"pmessage"`` for pattern-matched messages
        - ``pattern``: The subscribed pattern (``"room:*"``)
        - ``channel``: The actual channel (``"room:X7K9M2"``)
        - ``data``: The published message string (JSON envelope)

    We only care about ``pmessage`` type (skip subscribe confirmations).

    Flow:
        1. Ignore non-pmessage types (subscribe acks, etc.)
        2. Parse the JSON envelope
        3. Anti-echo: skip if ``_server_id == MY_SERVER_ID``
        4. Extract room_id from channel name
        5. Skip if no local clients are in this room
        6. Broadcast payload to all local clients in the room

    Args:
        raw_message: The raw dict from ``pubsub.listen()``.
        manager: ConnectionManager for local broadcast.
        server_id: This backend's SERVER_ID.
    """
    # Step 1: Only process pattern-matched messages
    if raw_message.get("type") != "pmessage":
        return

    channel: str = raw_message.get("channel", "")
    data: str = raw_message.get("data", "")

    # Step 2: Parse JSON envelope
    try:
        envelope = json.loads(data)
    except (json.JSONDecodeError, TypeError):
        print(f"[pubsub] WARNING: Invalid JSON on channel {channel}: {data[:100]}")
        return

    if not isinstance(envelope, dict):
        return

    # Step 3: Anti-echo — skip messages we published ourselves
    # (DISTRIBUTED_SYSTEM_DESIGN.md §8: "filter by SERVER_ID in the Redis message")
    msg_server_id = envelope.get("_server_id", "")
    if msg_server_id == server_id:
        return  # We already broadcast this locally — do not double-deliver

    # Step 4: Extract room_id from channel name
    # Channel format: "room:{room_id}"
    if not channel.startswith(ROOM_CHANNEL_PREFIX):
        return
    room_id = channel[len(ROOM_CHANNEL_PREFIX):]

    if not room_id:
        return

    # Step 5: Check if we have any local clients in this room
    # (optimization: skip the broadcast if no local connections)
    if room_id not in manager.room_connections:
        return

    local_members = manager.room_connections.get(room_id, set())
    if not local_members:
        return

    # Step 6: Extract and relay the payload
    msg_type = envelope.get("_type", "unknown")
    payload = envelope.get("payload")

    if payload is None:
        print(f"[pubsub] WARNING: Missing payload in envelope from {msg_server_id}")
        return

    if not isinstance(payload, dict):
        print(f"[pubsub] WARNING: Payload is not a dict from {msg_server_id}")
        return

    # Optional: validate that the message type is one we should relay
    if msg_type not in RELAYABLE_TYPES:
        print(
            f"[pubsub] Ignoring unknown _type '{msg_type}' "
            f"from {msg_server_id} on {channel}"
        )
        return

    # Relay the payload to all local WebSocket connections in this room.
    # No user exclusion — all local clients should see cross-server events.
    await manager.broadcast_to_room(room_id, payload)

    # Debug logging (concise)
    local_count = len(local_members)
    print(
        f"[pubsub] Relayed {msg_type} from {msg_server_id} "
        f"→ room {room_id} ({local_count} local client{'s' if local_count != 1 else ''})"
    )
