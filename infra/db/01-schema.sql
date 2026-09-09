-- =============================================================================
-- CollabBoard — PostgreSQL Schema
-- =============================================================================
-- Owner : M3 (Data/Sync)
-- Sprint: Day 1
--
-- Full DDL from DATABASE_SCHEMA.md §4 (PostgreSQL 16).
-- Auto-executed by PostgreSQL on first container start via
-- the docker-entrypoint-initdb.d mount in docker-compose.dev.yml.
--
-- All statements are idempotent (IF NOT EXISTS / DO $$ EXCEPTION blocks).
--
-- Reference:
--   - DATABASE_SCHEMA.md §4 (verbatim source)
--   - POSTGRESQL_MIGRATION.md §4 (migration rationale)
--   - DOCKER_DEPLOYMENT.md §3 (volume bind mount)
-- =============================================================================

-- CollabBoard Database Schema (PostgreSQL 16)
-- Run with: psql -d collabboard -f schema.sql

-- ============================================================
-- Custom Types
-- ============================================================
DO $$ BEGIN
    CREATE TYPE room_status AS ENUM ('active', 'empty', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE obj_type AS ENUM ('pencil', 'text', 'rectangle', 'circle', 'line', 'arrow', 'heart', 'image');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE op_type AS ENUM ('add', 'delete', 'modify');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE save_type AS ENUM ('auto', 'manual');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE mime_type AS ENUM ('image/png', 'image/jpeg');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 3.1  users
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    user_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username   VARCHAR(32) NOT NULL,
    color_hex  CHAR(7) NOT NULL DEFAULT '#FFFFFF'
                   CHECK (color_hex ~ '^#[0-9A-Fa-f]{6}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_username
    ON users (username);

-- ============================================================
-- 3.2  rooms
-- ============================================================
CREATE TABLE IF NOT EXISTS rooms (
    room_id        CHAR(6) PRIMARY KEY
                       CHECK (room_id ~ '^[A-Za-z0-9]{6}$'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_saved     TIMESTAMPTZ,
    is_dirty       BOOLEAN NOT NULL DEFAULT FALSE,
    total_objects  INTEGER NOT NULL DEFAULT 0,
    status         room_status NOT NULL DEFAULT 'active',
    seq_counter    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rooms_status
    ON rooms (status);
CREATE INDEX IF NOT EXISTS idx_rooms_last_activity
    ON rooms (last_activity);

-- ============================================================
-- 3.3  room_members
-- ============================================================
CREATE TABLE IF NOT EXISTS room_members (
    user_id   UUID NOT NULL REFERENCES users (user_id) ON DELETE CASCADE,
    room_id   CHAR(6) NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_rm_room
    ON room_members (room_id);

-- ============================================================
-- 3.4  canvas_objects
-- ============================================================
CREATE TABLE IF NOT EXISTS canvas_objects (
    obj_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      CHAR(6) NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    created_by   UUID NOT NULL REFERENCES users (user_id),
    obj_type     obj_type NOT NULL,
    z_index      INTEGER NOT NULL,
    color        CHAR(7) NOT NULL DEFAULT '#000000'
                     CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    stroke_width INTEGER NOT NULL DEFAULT 2 CHECK (stroke_width >= 0),
    properties   JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    is_deleted   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_co_room
    ON canvas_objects (room_id);
CREATE INDEX IF NOT EXISTS idx_co_room_zindex
    ON canvas_objects (room_id, z_index);
CREATE INDEX IF NOT EXISTS idx_co_creator
    ON canvas_objects (created_by);
CREATE INDEX IF NOT EXISTS idx_co_room_active
    ON canvas_objects (room_id) WHERE is_deleted = FALSE;
CREATE INDEX IF NOT EXISTS idx_co_properties
    ON canvas_objects USING GIN (properties);

-- ============================================================
-- 3.5  images
-- ============================================================
CREATE TABLE IF NOT EXISTS images (
    image_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id     CHAR(6) NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    obj_id      UUID NOT NULL REFERENCES canvas_objects (obj_id) ON DELETE CASCADE,
    filename    VARCHAR(255) NOT NULL,
    mime_type   mime_type NOT NULL,
    file_size   INTEGER NOT NULL CHECK (file_size > 0 AND file_size <= 2097152),
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_img_room
    ON images (room_id);
CREATE INDEX IF NOT EXISTS idx_img_obj
    ON images (obj_id);

-- ============================================================
-- 3.6  action_history
-- ============================================================
CREATE TABLE IF NOT EXISTS action_history (
    action_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id      CHAR(6) NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users (user_id),
    seq_num      INTEGER NOT NULL,
    op_type      op_type NOT NULL,
    obj_id       UUID NOT NULL,
    forward_data JSONB NOT NULL,
    inverse_data JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ah_room_seq
    ON action_history (room_id, seq_num);
CREATE INDEX IF NOT EXISTS idx_ah_user_room
    ON action_history (user_id, room_id);

-- ============================================================
-- 3.7  saved_canvases
-- ============================================================
CREATE TABLE IF NOT EXISTS saved_canvases (
    save_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id       CHAR(6) NOT NULL REFERENCES rooms (room_id) ON DELETE CASCADE,
    saved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    save_type     save_type NOT NULL DEFAULT 'auto',
    snapshot_json JSONB NOT NULL,
    total_objects INTEGER NOT NULL,
    seq_at_save   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sc_room_time
    ON saved_canvases (room_id, saved_at DESC);
