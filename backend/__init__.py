# CollabBoard — Backend Package
"""
CollabBoard async Python backend.

Modules:
    main        – FastAPI app entry point, WebSocket route, health endpoint
    connection  – ConnectionManager: manages active WebSocket connections
    rooms       – RoomManager: join/leave logic, Redis session state
    sync        – SyncEngine: op dispatch, PostgreSQL write, Redis publish
    pubsub      – Redis Subscriber: listens to room channels, relays to local WS
    db          – Database: asyncpg pool setup, CRUD operations
    tasks       – Background Tasks: autosave, 24-hour cleanup via Redis locks
    models      – Pydantic models for request/message validation
"""
