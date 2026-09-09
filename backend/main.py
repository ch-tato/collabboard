# =============================================================================
# CollabBoard — FastAPI Application Entry Point
# =============================================================================
# Owner : M1 (Server & DevOps)
# Sprint: Day 7 — WebSocket disconnect edge-case fixes
#
# This module creates the FastAPI application, registers the health-check HTTP
# endpoint, implements the WebSocket route with hello/hello_ack handshake,
# and configures application lifespan events (startup / shutdown).
#
# Day 7 changes:
#   - Added asyncio.CancelledError handling for server-shutdown-during-
#     active-connection scenarios (CancelledError is BaseException in 3.9+)
#   - Added receive timeouts: 10s for hello handshake, 120s for message loop
#     as defense-in-depth dead-connection detection
#   - Improved disconnect logging: distinguishes graceful, abrupt, timeout,
#     and server-shutdown disconnect types
#
# Day 6 changes:
#   - Hardened disconnect cleanup: each tier (PG, Redis, memory) is
#     independently try/except'd so a failure in one doesn't block others
#   - Added structured logging for graceful vs abrupt disconnect
#   - Defense-in-depth: delete_session wrapped in try/except
#   - Subscriber starts on lifespan startup, cancelled on shutdown
#   - Uses dedicated Redis connection with PSUBSCRIBE room:*
#   - Cross-server messages relayed to local clients via ConnectionManager
#   - Anti-echo: messages with _server_id == MY_SERVER_ID are filtered out
#
# Reference:
#   - IMPLEMENTATION_PLAN.md §1, §2
#   - API_CONTRACT.md §1 (hello), §3 (ping/pong), §4-6 (rooms), §GET /health
#   - WEBSOCKET_PROTOCOL_EXTENSION.md §1 (lifecycle), §2-3 (rooms), §8-9
#   - DISTRIBUTED_SYSTEM_DESIGN.md §7 (Session Lifecycle), §8.1 (Redis Schema)
#   - DOCKER_DEPLOYMENT.md §8 (backend responsibilities)
# =============================================================================

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

try:
    from dotenv import load_dotenv  # Optional: only needed for local dev
except ModuleNotFoundError:
    def load_dotenv() -> None:  # type: ignore[misc]
        """No-op fallback when python-dotenv is not installed."""

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from backend.connection import ConnectionManager, SessionState
from backend.models import ErrorMessage, HelloAckMessage, HelloMessage
from backend import redis_client
from backend.redis_client import (
    init_redis,
    close_redis,
    create_session,
    delete_session,
    refresh_session_ttl,
)
from backend.rooms import (
    handle_create_room,
    handle_join_room,
    handle_leave_room,
    handle_disconnect_cleanup,
)
from backend.sync import handle_op
from backend.pubsub import start_subscriber
from backend.cursor import handle_cursor_move, handle_cursor_chat, remove_user_throttle

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
load_dotenv()  # Load .env for local dev; Docker uses env injection

SERVER_ID: str = os.getenv("SERVER_ID", "local-dev")
SERVER_VERSION: str = "2.0"
DATABASE_URL: str = os.getenv("DATABASE_URL", "")
REDIS_URL: str = os.getenv("REDIS_URL", "")

# ---------------------------------------------------------------------------
# Application start time (for /health uptime calculation)
# ---------------------------------------------------------------------------
_start_time: float = time.time()

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
PROJECT_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = PROJECT_ROOT / "frontend"

# ---------------------------------------------------------------------------
# Connection Manager (singleton for this backend instance)
# ---------------------------------------------------------------------------
manager = ConnectionManager()


# ---------------------------------------------------------------------------
# Lifespan — startup / shutdown hooks
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.

    Startup:
        - Initialize asyncpg connection pool (M3, Day 1) [DONE]
        - Initialize async Redis connection (M1, Day 3) [DONE]
        - Start Redis pub/sub subscriber task (M1, Day 5) [DONE]
        - Start autosave background task (M3, Day 9) [DONE]
        - TODO (Day 10): Start cleanup scheduler (M3)

    Shutdown:
        - Cancel autosave background task (M3, Day 9) [DONE]
        - Cancel pub/sub subscriber task (M1, Day 5) [DONE]
        - Close asyncpg pool (M3, Day 1) [DONE]
        - Close Redis connection (M1, Day 3) [DONE]
    """
    # asyncio is imported at module level (Day 7)

    pubsub_task: asyncio.Task | None = None
    autosave_task: asyncio.Task | None = None
    cleanup_task: asyncio.Task | None = None

    # -- Startup --------------------------------------------------------------
    print(f"[{SERVER_ID}] CollabBoard backend starting...")
    print(f"[{SERVER_ID}] DATABASE_URL = {DATABASE_URL}")
    print(f"[{SERVER_ID}] REDIS_URL    = {REDIS_URL}")
    print(f"[{SERVER_ID}] Serving frontend from: {FRONTEND_DIR}")

    # Initialize asyncpg connection pool (M3)
    try:
        from backend.db import init_db_pool
        await init_db_pool()
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Failed to initialize DB pool: {exc}")
        print(f"[{SERVER_ID}] Server will start without database connectivity.")

    # Initialize async Redis connection (M1, Day 3)
    try:
        await init_redis()
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Failed to initialize Redis: {exc}")
        print(f"[{SERVER_ID}] Server will start without Redis connectivity.")

    # Start Redis pub/sub subscriber task (M1, Day 5)
    # Uses a SEPARATE Redis connection dedicated to PSUBSCRIBE room:*.
    # The subscriber relays cross-server messages to local WebSocket clients
    # and filters out self-published messages via _server_id anti-echo check.
    if REDIS_URL:
        try:
            pubsub_task = start_subscriber(
                manager=manager,
                server_id=SERVER_ID,
                redis_url=REDIS_URL,
            )
            print(f"[{SERVER_ID}] Redis pub/sub subscriber task started")
        except Exception as exc:
            print(f"[{SERVER_ID}] WARNING: Failed to start pub/sub subscriber: {exc}")
    else:
        print(f"[{SERVER_ID}] WARNING: REDIS_URL not set — pub/sub subscriber skipped")

    # Start autosave background task (M3, Day 9)
    # Runs every 60s, protected by the Redis lock:autosave distributed lock.
    # Only one backend instance will execute the autosave per cycle.
    try:
        from backend.tasks import start_autosave_loop
        autosave_task = start_autosave_loop(server_id=SERVER_ID)
        print(f"[{SERVER_ID}] Autosave background task started (60s interval)")
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Failed to start autosave task: {exc}")

    # Start cleanup background task (M3, Day 10)
    try:
        from backend.tasks import start_cleanup_loop
        cleanup_task = start_cleanup_loop(server_id=SERVER_ID)
        print(f"[{SERVER_ID}] Cleanup background task started (6h interval)")
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Failed to start cleanup task: {exc}")

    yield  # Application is running

    # -- Shutdown -------------------------------------------------------------
    print(f"[{SERVER_ID}] CollabBoard backend shutting down...")

    # Cancel autosave background task (M3, Day 9)
    if autosave_task is not None and not autosave_task.done():
        autosave_task.cancel()
        try:
            await autosave_task
        except asyncio.CancelledError:
            pass
        print(f"[{SERVER_ID}] Autosave background task stopped")

    if cleanup_task is not None and not cleanup_task.done():
        cleanup_task.cancel()
        try:
            await cleanup_task
        except asyncio.CancelledError:
            pass
        print(f"[{SERVER_ID}] Cleanup background task stopped")

    # Cancel pub/sub subscriber task (M1, Day 5)
    if pubsub_task is not None and not pubsub_task.done():
        pubsub_task.cancel()
        try:
            await pubsub_task
        except asyncio.CancelledError:
            pass
        print(f"[{SERVER_ID}] Redis pub/sub subscriber task stopped")

    # Close Redis connection (M1, Day 3)
    try:
        await close_redis()
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Error closing Redis: {exc}")

    # Close asyncpg connection pool (M3)
    try:
        from backend.db import close_db_pool
        await close_db_pool()
    except Exception as exc:
        print(f"[{SERVER_ID}] WARNING: Error closing DB pool: {exc}")


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------
app = FastAPI(
    title="CollabBoard",
    version=SERVER_VERSION,
    docs_url=None,       # Disable Swagger UI in production
    redoc_url=None,      # Disable ReDoc in production
    lifespan=lifespan,
)


# ---------------------------------------------------------------------------
# HTTP — Health Check
# ---------------------------------------------------------------------------
@app.get("/health")
async def health_check():
    """
    Health endpoint for Docker HEALTHCHECK and Nginx upstream monitoring.

    Returns 200 with status info when server is up.
    Includes Redis connectivity check (Day 3) and DB pool status.

    Reference: API_CONTRACT.md §GET /health
    """
    uptime = int(time.time() - _start_time)

    # Check Redis connectivity
    redis_status = "disconnected"
    if redis_client.redis_conn is not None:
        try:
            await asyncio.wait_for(redis_client.redis_conn.ping(), timeout=1.0)
            redis_status = "connected"
        except Exception:
            redis_status = "unreachable"

    # Check PostgreSQL connectivity
    from backend.db import pool as db_pool
    pg_status = "disconnected"
    if db_pool is not None:
        try:
            await asyncio.wait_for(db_pool.fetchval("SELECT 1"), timeout=1.0)
            pg_status = "connected"
        except Exception:
            pg_status = "unreachable"

    status_code = 200
    overall_status = "ok"

    if redis_status == "unreachable" or pg_status == "unreachable":
        status_code = 503
        overall_status = "degraded"

    return JSONResponse(
        status_code=status_code,
        content={
            "status": overall_status,
            "server_id": SERVER_ID,
            "server_version": SERVER_VERSION,
            "uptime_seconds": uptime,
            "active_connections": manager.active_count,
            "active_rooms": manager.active_room_count,
            "postgres": pg_status,
            "redis": redis_status,
        },
    )


# ---------------------------------------------------------------------------
# Helper — send error and close WebSocket
# ---------------------------------------------------------------------------
async def _send_error_and_close(
    websocket: WebSocket,
    code: str,
    message: str,
    ws_close_code: int = 1008,
) -> None:
    """
    Send an error JSON message and then close the WebSocket.

    Used during the hello phase where errors are terminal
    (per WEBSOCKET_PROTOCOL_EXTENSION.md §1).

    Args:
        websocket: The active WebSocket connection.
        code: Machine-readable error code (e.g. ``"INVALID_USERNAME"``).
        message: Human-readable description.
        ws_close_code: WebSocket close status code (default 1008 Policy Violation).
    """
    error = ErrorMessage(code=code, message=message)
    try:
        await websocket.send_text(error.model_dump_json())
        await websocket.close(code=ws_close_code)
    except Exception:
        pass  # Connection may already be gone


# ---------------------------------------------------------------------------
# WebSocket — Main Endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """
    Primary WebSocket endpoint for all client communication.

    Implements the full WebSocket connection lifecycle:
        1. Accept WebSocket connection (state: Connected)
        2. Wait for ``hello`` message, validate username
        3. On success: assign UUID, register in ConnectionManager,
           send ``hello_ack`` (state: Identified)
        4. Enter message loop for post-handshake messages
        5. On disconnect: clean up ConnectionManager

    Error handling during hello phase:
        - Invalid JSON → error + close
        - Missing/wrong ``type`` → error + close
        - Invalid ``username`` → INVALID_USERNAME + close
        - Server at capacity → SERVER_FULL + close

    Reference:
        - WEBSOCKET_PROTOCOL_EXTENSION.md §1 (lifecycle)
        - API_CONTRACT.md §1 (hello / hello_ack)
        - API_CONTRACT.md §3 (ping / pong)
    """
    await websocket.accept()

    user_id: str | None = None

    try:
        # ==================================================================
        # PHASE 1: Hello Handshake (state: Connected)
        # ==================================================================
        # The first message MUST be a valid ``hello``. Anything else is a
        # protocol violation and the connection is closed.
        # ------------------------------------------------------------------

        # Check server capacity before processing the handshake
        if manager.is_full:
            await _send_error_and_close(
                websocket,
                code="SERVER_FULL",
                message="Server is full",
            )
            return

        # Wait for the hello message (10s timeout — Day 7)
        try:
            raw = await asyncio.wait_for(
                websocket.receive_text(), timeout=10.0,
            )
        except asyncio.TimeoutError:
            await _send_error_and_close(
                websocket,
                code="TIMEOUT",
                message="Hello handshake timed out (10s)",
            )
            return
        except WebSocketDisconnect:
            return  # Client disconnected before sending hello

        # Parse JSON
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            await _send_error_and_close(
                websocket,
                code="INVALID_USERNAME",
                message="Invalid JSON payload",
            )
            return

        # Verify message type is "hello"
        if not isinstance(data, dict) or data.get("type") != "hello":
            await _send_error_and_close(
                websocket,
                code="INVALID_USERNAME",
                message="First message must be of type 'hello'",
            )
            return

        # Validate via Pydantic model
        try:
            hello = HelloMessage.model_validate(data)
        except ValidationError as exc:
            # Extract the first human-readable error
            errors = exc.errors()
            detail = errors[0].get("msg", "Invalid username") if errors else "Invalid username"
            await _send_error_and_close(
                websocket,
                code="INVALID_USERNAME",
                message=f"Username validation failed: {detail}",
            )
            return

        # -- Handshake successful: register client ----------------------------
        client = manager.register(websocket, hello.username)
        user_id = client.user_id

        # Insert user into PostgreSQL (Day 2/4 integration)
        try:
            from backend import db
            await db.upsert_user(client.user_id, client.username)
        except Exception as exc:
            print(f"[{SERVER_ID}] WARNING: Failed to upsert user {client.user_id}: {exc}")

        # Create Redis session state (Day 3, M1)
        # HSET session:{user_id} server_id <id> username <name> room_id ""
        # EXPIRE session:{user_id} 300
        session_ok = await create_session(
            user_id=client.user_id,
            server_id=SERVER_ID,
            username=client.username,
        )

        # Build and send hello_ack
        ack = HelloAckMessage(
            user_id=client.user_id,
            server_version=SERVER_VERSION,
        )
        await websocket.send_text(ack.model_dump_json())

        print(
            f"[{SERVER_ID}] Client connected: "
            f"{client.username} ({client.user_id}) "
            f"[{manager.active_count} active] "
            f"(redis_session={'ok' if session_ok else 'skipped'})"
        )

        # ==================================================================
        # PHASE 2: Message Loop (state: Identified / InRoom)
        # ==================================================================
        # After the hello handshake, the client is Identified. Messages are
        # routed based on the ``type`` field. Day 2 implements ping/pong.
        # Room and op handling will be added in Day 3–4.
        # ------------------------------------------------------------------

        while True:
            # 120s receive timeout — defense-in-depth for silent dead
            # connections that bypass WebSocket-level ping/pong (Day 7).
            # Uvicorn's default ws-ping-interval (20s) + ws-ping-timeout
            # (20s) handles most cases; this is a fallback safety net.
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=120.0,
                )
            except asyncio.TimeoutError:
                print(
                    f"[{SERVER_ID}] Receive timeout (120s) for "
                    f"user {user_id} — closing connection"
                )
                break

            # Parse JSON — malformed messages close the connection
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await _send_error_and_close(
                    websocket,
                    code="INVALID_USERNAME",
                    message="Invalid JSON payload",
                )
                return

            if not isinstance(data, dict):
                await _send_error_and_close(
                    websocket,
                    code="INVALID_USERNAME",
                    message="Message must be a JSON object",
                )
                return

            msg_type = data.get("type")

            # -- ping / pong (app-level heartbeat) ----------------------------
            if msg_type == "ping":
                # Refresh Redis session TTL (Day 9, ISSUE-01)
                if client.user_id:
                    await refresh_session_ttl(client.user_id)
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            # -- State-gated messages (Day 3+ implementations) ----------------
            # These are recognized message types that are not yet implemented.
            # Respond with a placeholder so the client knows the server is
            # alive but the feature is pending.

            if client.state == SessionState.IDENTIFIED:
                if msg_type == "create_room":
                    await handle_create_room(
                        websocket, client, manager, SERVER_ID,
                    )
                    continue

                if msg_type == "join_room":
                    await handle_join_room(
                        websocket, client, data, manager, SERVER_ID,
                    )
                    continue

                if msg_type in (
                    "op", "cursor_move", "cursor_chat",
                    "save_canvas", "load_canvas", "image_request",
                    "leave_room",
                ):
                    # These require InRoom state
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "code": "NOT_IN_ROOM",
                        "message": "You must join a room first.",
                    }))
                    continue

            elif client.state == SessionState.IN_ROOM:
                # Room management while InRoom
                if msg_type == "leave_room":
                    await handle_leave_room(
                        websocket, client, manager, SERVER_ID,
                    )
                    continue

                if msg_type in ("create_room", "join_room"):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "code": "ALREADY_IN_ROOM",
                        "message": "Leave current room first",
                    }))
                    continue

                # Canvas operations — op routing (Day 4, M3)
                if msg_type == "op":
                    if not client.room_id:
                        continue

                    result = await handle_op(
                        user_id=client.user_id,
                        username=client.username,
                        room_id=client.room_id,
                        data=data,
                    )
                    if result["status"] == "ok":
                        # Send op_ack to sender
                        await websocket.send_text(
                            json.dumps(result["op_ack"])
                        )
                        # Broadcast op_broadcast to other local clients
                        await manager.broadcast_to_room(
                            client.room_id,
                            result["op_broadcast"],
                            exclude_user_id=client.user_id,
                        )
                        # Cross-server relay via Redis pub/sub
                        await redis_client.publish_to_room(
                            room_id=client.room_id,
                            server_id=SERVER_ID,
                            msg_type="op_broadcast",
                            payload=result["op_broadcast"],
                        )
                    else:
                        # Send op_rejected to sender
                        await websocket.send_text(
                            json.dumps(result["op_rejected"])
                        )
                    continue

                # Day 6 (M3) — cursor relay with 50ms throttle
                if msg_type == "cursor_move":
                    if not client.room_id:
                        continue

                    broadcast = handle_cursor_move(
                        user_id=client.user_id,
                        username=client.username,
                        data=data,
                    )
                    if broadcast is not None:
                        # Local broadcast (exclude sender)
                        await manager.broadcast_to_room(
                            client.room_id,
                            broadcast,
                            exclude_user_id=client.user_id,
                        )
                        # Cross-server relay via Redis pub/sub
                        await redis_client.publish_to_room(
                            room_id=client.room_id,
                            server_id=SERVER_ID,
                            msg_type="cursor_update",
                            payload=broadcast,
                        )
                    # No ack sent — fire-and-forget (API_CONTRACT §7)
                    continue

                # Day 8 (M1/M2) — cursor chat relay
                if msg_type == "cursor_chat":
                    if not client.room_id:
                        continue
                    
                    broadcast = handle_cursor_chat(
                        user_id=client.user_id,
                        username=client.username,
                        data=data,
                    )
                    if broadcast is not None:
                        # Local broadcast (exclude sender)
                        await manager.broadcast_to_room(
                            client.room_id,
                            broadcast,
                            exclude_user_id=client.user_id,
                        )
                        # Cross-server relay via Redis pub/sub
                        await redis_client.publish_to_room(
                            room_id=client.room_id,
                            server_id=SERVER_ID,
                            msg_type="cursor_chat_broadcast",
                            payload=broadcast,
                        )
                    continue

                # Sprint 4.5 (M1/M2) — remote selection presence relay
                if msg_type == "selection_update":
                    if not client.room_id:
                        continue
                    
                    broadcast = {
                        "type": "selection_update",
                        "user_id": client.user_id,
                        "username": client.username,
                        "obj_id": data.get("obj_id")
                    }
                    
                    # Local broadcast (exclude sender)
                    await manager.broadcast_to_room(
                        client.room_id,
                        broadcast,
                        exclude_user_id=client.user_id,
                    )
                    # Cross-server relay via Redis pub/sub
                    await redis_client.publish_to_room(
                        room_id=client.room_id,
                        server_id=SERVER_ID,
                        msg_type="selection_update",
                        payload=broadcast,
                    )
                    continue

                # Phase 2, Sprint 5 (M1/M2) — real-time stroke streaming
                if msg_type == "stream_points":
                    if not client.room_id:
                        continue

                    # Ephemeral relay — NO database write, NO seq increment
                    broadcast = {
                        "type": "stream_points",
                        "user_id": client.user_id,
                        "username": client.username,
                        "obj_type": data.get("obj_type", "pencil"),
                        "color": data.get("color", "#000000"),
                        "stroke_width": data.get("stroke_width", 4),
                        "points": data.get("points", [])
                    }

                    await manager.broadcast_to_room(
                        client.room_id,
                        broadcast,
                        exclude_user_id=client.user_id,
                    )
                    await redis_client.publish_to_room(
                        room_id=client.room_id,
                        server_id=SERVER_ID,
                        msg_type="stream_points",
                        payload=broadcast,
                    )
                    continue

                if msg_type == "stream_end":
                    if not client.room_id:
                        continue

                    broadcast = {
                        "type": "stream_end",
                        "user_id": client.user_id
                    }

                    await manager.broadcast_to_room(
                        client.room_id,
                        broadcast,
                        exclude_user_id=client.user_id,
                    )
                    await redis_client.publish_to_room(
                        room_id=client.room_id,
                        server_id=SERVER_ID,
                        msg_type="stream_end",
                        payload=broadcast,
                    )
                    continue

                # Day 6+ — save/load, etc.
                if msg_type in (
                    "save_canvas", "load_canvas", "image_request",
                ):
                    await websocket.send_text(json.dumps({
                        "type": "error",
                        "code": "NOT_IMPLEMENTED",
                        "message": f"'{msg_type}' will be implemented in a future sprint.",
                    }))
                    continue

            # -- Unknown message type -----------------------------------------
            await websocket.send_text(json.dumps({
                "type": "error",
                "code": "INVALID_USERNAME",
                "message": f"Unknown message type: '{msg_type}'",
            }))

    except WebSocketDisconnect:
        # Graceful disconnect: client sent a close frame or browser tab
        # was closed normally.  Falls through to the finally block.
        pass
    except asyncio.CancelledError:
        # Server shutdown while this connection was active (Day 7, A4).
        # CancelledError is a BaseException in Python 3.9+, so the
        # generic 'except Exception' below would NOT catch it.  We must
        # handle it explicitly to ensure the finally cleanup runs.
        print(
            f"[{SERVER_ID}] WebSocket cancelled (server shutdown) "
            f"for user {user_id}"
        )
    except Exception as exc:
        # Abrupt disconnect: network drop, kill -9, or unexpected error.
        # Log the exception for debugging, then fall through to cleanup.
        print(
            f"[{SERVER_ID}] WebSocket error (abrupt) for "
            f"user {user_id}: {type(exc).__name__}: {exc}"
        )
    finally:
        # ==================================================================
        # PHASE 3: Cleanup  (Day 6 — hardened)
        # ==================================================================
        # Each cleanup tier is independently try/except'd so a failure in
        # one tier (e.g. Redis is down) does not prevent the remaining
        # tiers from cleaning up.  This follows the confirmed Assumption 7:
        # "cleanup should be best-effort across all three tiers."
        # ------------------------------------------------------------------
        if user_id is not None:
            # Get client state BEFORE removing from manager (need room_id)
            client_state = manager.get_client(user_id)

            # ----- Tier 1+2+3: Room cleanup (PG + Redis + memory) --------
            # If the user was in a room, remove from all three tiers and
            # broadcast user_left to remaining members (local + pub/sub).
            if client_state is not None and client_state.room_id is not None:
                try:
                    await handle_disconnect_cleanup(
                        client_state, manager, SERVER_ID,
                    )
                except Exception as exc:
                    print(
                        f"[{SERVER_ID}] WARNING: Disconnect room cleanup "
                        f"failed for {user_id}: {exc}"
                    )

            # ----- Tier 3: Remove from in-memory connection map -----------
            # This MUST happen after handle_disconnect_cleanup because the
            # cleanup function needs the client's WebSocket reference for
            # the broadcast_to_room exclusion logic.
            removed = manager.disconnect(user_id)
            if removed:
                print(
                    f"[{SERVER_ID}] Client disconnected: "
                    f"{removed.username} ({removed.user_id}) "
                    f"[{manager.active_count} active]"
                )

            # ----- Tier 2: Delete Redis session hash ----------------------
            # Defense-in-depth: delete_session() has its own internal
            # try/except, but we wrap again so a truly unexpected error
            # (e.g. event loop issue) never propagates out of cleanup.
            try:
                await delete_session(user_id)
            except Exception as exc:
                print(
                    f"[{SERVER_ID}] WARNING: Failed to delete Redis "
                    f"session for {user_id}: {exc}"
                )

            # ----- Cursor throttle cleanup (Day 6, M3) ----------------
            # Remove per-user timestamp from the cursor throttle tracker
            # to prevent memory leaks in the _last_cursor_ts dict.
            remove_user_throttle(user_id)


# ---------------------------------------------------------------------------
# Static Files — Frontend
# ---------------------------------------------------------------------------
# Mount the frontend directory so the backend serves HTML/CSS/JS directly.
# In production, Nginx can serve static files, but for dev this is convenient.
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
