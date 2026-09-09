# =============================================================================
# CollabBoard — Connection Manager
# =============================================================================
# Owner : M1 (Server & DevOps)
# Sprint: Day 7 — WebSocket disconnect edge-case fixes
#
# This module manages active WebSocket connections, tracks client session
# state, and provides broadcast utilities for room-level messaging.
#
# Day 2 scope:
#   - In-memory client registry (dict[user_id, ClientState])
#   - hello / hello_ack handshake with UUID assignment
#   - Session state machine: Connected → Identified
#   - SERVER_FULL enforcement
#   - Graceful disconnect cleanup
#
# Day 3 scope:
#   - Added room_connections reverse index (dict[room_id, set[user_id]])
#   - Helper methods: add_to_room(), remove_from_room(), get_room_connections()
#   - These enable fast local broadcast without scanning all clients
#
# Day 6 notes:
#   - disconnect() and remove_from_room() are verified idempotent — safe
#     to call even if the user was already removed (e.g. during error recovery)
#   - remove_from_room() auto-cleans the room_connections entry when the
#     last local member leaves
#
# Reference:
#   - IMPLEMENTATION_PLAN.md §B2
#   - WEBSOCKET_PROTOCOL_EXTENSION.md §1 (lifecycle), §10 (broadcast)
#   - DISTRIBUTED_SYSTEM_DESIGN.md §4 (Per-Backend WebSocket Handling)
#   - API_CONTRACT.md §1 (hello / hello_ack)
# =============================================================================
"""
ConnectionManager: manages active WebSocket connections.

Provides:
    - Client registration / deregistration with UUID assignment
    - hello / hello_ack handshake orchestration
    - Session state tracking (Connected → Identified → InRoom)
    - Room-level connection index for fast local broadcast
    - Broadcast to room members (exclude-sender pattern)
    - SERVER_FULL capacity enforcement
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

from fastapi import WebSocket


# ---------------------------------------------------------------------------
# Session State Machine
# ---------------------------------------------------------------------------
class SessionState(str, Enum):
    """
    WebSocket session states per WEBSOCKET_PROTOCOL_EXTENSION.md §1.

    Connected  → Only ``hello`` is accepted.
    Identified → ``create_room``, ``join_room``, ``ping`` allowed.
    InRoom     → Full message set (ops, cursors, save/load, etc.)
    """

    CONNECTED = "connected"
    IDENTIFIED = "identified"
    IN_ROOM = "in_room"


# ---------------------------------------------------------------------------
# Client State
# ---------------------------------------------------------------------------
@dataclass
class ClientState:
    """
    Represents a single connected client's server-side state.

    Attributes:
        websocket: The active FastAPI WebSocket instance.
        user_id: UUID v4 assigned during hello handshake.
        username: Display name provided by the client.
        room_id: Current room (None if not in a room).
        state: Current session state in the lifecycle.
    """

    websocket: WebSocket
    user_id: str
    username: str
    room_id: Optional[str] = None
    state: SessionState = field(default=SessionState.IDENTIFIED)


# ---------------------------------------------------------------------------
# Connection Manager
# ---------------------------------------------------------------------------
class ConnectionManager:
    """
    Manages all active WebSocket connections for this backend instance.

    Thread-safety note: FastAPI runs in a single asyncio event loop, so
    no locks are needed for the ``clients`` dict. All access is
    sequential within the event loop.

    Attributes:
        MAX_CONNECTIONS: Upper limit on simultaneous connections.
        clients: Mapping of user_id → ClientState for all identified users.
    """

    MAX_CONNECTIONS: int = 100

    def __init__(self) -> None:
        self.clients: dict[str, ClientState] = {}
        # Reverse index: room_id → set of user_ids with local WebSocket
        # connections in that room. Enables O(1) room membership lookup
        # and fast local broadcast without scanning all clients.
        # (DISTRIBUTED_SYSTEM_DESIGN.md §4: "Local room → [websocket] mapping")
        self.room_connections: dict[str, set[str]] = {}

    # -- Properties -----------------------------------------------------------

    @property
    def active_count(self) -> int:
        """Number of currently connected and identified clients."""
        return len(self.clients)

    @property
    def is_full(self) -> bool:
        """Whether the server has reached its connection capacity."""
        return self.active_count >= self.MAX_CONNECTIONS

    # -- Registration ---------------------------------------------------------

    def register(self, websocket: WebSocket, username: str) -> ClientState:
        """
        Register a new client after a successful hello handshake.

        Generates a UUID v4 ``user_id``, creates a ``ClientState``, and adds
        it to the ``clients`` registry.

        Args:
            websocket: The WebSocket connection for this client.
            username: Validated display name from the hello message.

        Returns:
            The newly created ``ClientState``.
        """
        user_id = str(uuid.uuid4())
        client = ClientState(
            websocket=websocket,
            user_id=user_id,
            username=username,
        )
        self.clients[user_id] = client
        return client

    def disconnect(self, user_id: str) -> Optional[ClientState]:
        """
        Remove a client from the registry.

        Called on WebSocket disconnect (graceful or abrupt). Returns the
        removed ``ClientState`` so callers can perform additional cleanup
        (e.g., broadcasting ``user_left`` to the room).

        Args:
            user_id: The UUID of the disconnecting client.

        Returns:
            The removed ``ClientState``, or ``None`` if not found.
        """
        return self.clients.pop(user_id, None)

    def get_client(self, user_id: str) -> Optional[ClientState]:
        """Look up a client by user_id. Returns None if not found."""
        return self.clients.get(user_id)

    # -- Broadcast ------------------------------------------------------------

    async def broadcast_to_room(
        self,
        room_id: str,
        message: dict,
        exclude_user_id: Optional[str] = None,
    ) -> None:
        """
        Send a JSON message to all clients in a room.

        Implements the sender-exclusion pattern from
        WEBSOCKET_PROTOCOL_EXTENSION.md §10.

        Args:
            room_id: Target room identifier.
            message: Dict payload to JSON-serialize and send.
            exclude_user_id: Optional user_id to skip (e.g., the sender).
        """
        msg_str = json.dumps(message)
        for client in self.clients.values():
            if client.room_id == room_id and client.user_id != exclude_user_id:
                try:
                    await client.websocket.send_text(msg_str)
                except Exception:
                    # Connection may have died; disconnect handler will clean up
                    pass

    async def send_to_client(self, user_id: str, message: dict) -> None:
        """
        Send a JSON message to a specific client by user_id.

        Args:
            user_id: Target client's UUID.
            message: Dict payload to JSON-serialize and send.
        """
        client = self.clients.get(user_id)
        if client is not None:
            try:
                await client.websocket.send_text(json.dumps(message))
            except Exception:
                pass

    # -- Room Index -----------------------------------------------------------

    def add_to_room(self, room_id: str, user_id: str) -> None:
        """
        Track a user's WebSocket in the local room index.

        Called when a user joins a room. Updates both the ClientState
        and the room_connections reverse index.

        Args:
            room_id: The room being joined.
            user_id: The user joining the room.
        """
        client = self.clients.get(user_id)
        if client is not None:
            client.room_id = room_id
            client.state = SessionState.IN_ROOM
        if room_id not in self.room_connections:
            self.room_connections[room_id] = set()
        self.room_connections[room_id].add(user_id)

    def remove_from_room(self, room_id: str, user_id: str) -> None:
        """
        Remove a user's WebSocket from the local room index.

        Called when a user leaves a room or disconnects. Cleans up
        both the ClientState and the room_connections reverse index.
        Removes the room entry entirely when the last local member leaves.

        Args:
            room_id: The room being left.
            user_id: The user leaving the room.
        """
        client = self.clients.get(user_id)
        if client is not None:
            client.room_id = None
            client.state = SessionState.IDENTIFIED
        if room_id in self.room_connections:
            self.room_connections[room_id].discard(user_id)
            if not self.room_connections[room_id]:
                del self.room_connections[room_id]

    def get_room_connections(self, room_id: str) -> list[ClientState]:
        """
        Get all locally-connected clients in a specific room.

        Returns a list of ClientState objects for all users with an
        active WebSocket on *this* backend instance that are in the
        given room. Used for local-first broadcast
        (DISTRIBUTED_SYSTEM_DESIGN.md §4).

        Args:
            room_id: The room to query.

        Returns:
            List of ClientState objects (may be empty).
        """
        user_ids = self.room_connections.get(room_id, set())
        return [
            self.clients[uid]
            for uid in user_ids
            if uid in self.clients
        ]

    @property
    def active_room_count(self) -> int:
        """Number of rooms with at least one local WebSocket connection."""
        return len(self.room_connections)
