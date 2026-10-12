-- Distributed Job Processing System: PostgreSQL schema
-- Loaded automatically by the postgres container from /docker-entrypoint-initdb.d

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- One row per job submitted by a user
CREATE TABLE jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  f                INT  NOT NULL CHECK (f > 1 AND f < 100000),
  c                INT  NOT NULL CHECK (c > 1 AND c < 1000000),
  status           TEXT NOT NULL DEFAULT 'PENDING'
                   CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED')),
                   -- PENDING = created, no task finished yet ("waiting")
  files_generated  INT  NOT NULL DEFAULT 0,          -- raw files that exist so far
  result_path      TEXT,                             -- relative to DATA_DIR, e.g. <jobId>/result.csv
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX jobs_status ON jobs (status, created_at);

-- One row per unit of work
CREATE TABLE tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('GENERATE','COMBINE')),
  payload      JSONB NOT NULL,
               -- GENERATE: {"fileIndexes":[0,1,2,3,4]}
               -- COMBINE:  {"inputs":[{"itemId":"...","path":"...","count":5}, ...]}  (1..5 inputs)
  is_final     BOOLEAN NOT NULL DEFAULT false,
  status       TEXT NOT NULL DEFAULT 'PENDING'
               CHECK (status IN ('PENDING','QUEUED','DONE','FAILED')),
               -- PENDING = not yet published; QUEUED = published (waiting or being processed)
  attempts     INT  NOT NULL DEFAULT 0,             -- incremented each time it is published
  backup_sent  BOOLEAN NOT NULL DEFAULT false,      -- a backup copy was published
  worker_id    TEXT,                                -- worker whose result was accepted
  duration_ms  INT,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at    TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ
);
CREATE INDEX tasks_job_status ON tasks (job_id, status);
CREATE INDEX tasks_pending    ON tasks (created_at) WHERE status = 'PENDING';

-- Waiting items are the READY rows: every raw file and every partial result is one item
CREATE TABLE items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id       UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  path         TEXT NOT NULL UNIQUE,                 -- relative to DATA_DIR; unique blocks duplicates
  count        INT  NOT NULL CHECK (count >= 1),     -- how many original files it represents
  state        TEXT NOT NULL DEFAULT 'READY' CHECK (state IN ('READY','USED')),
  produced_by  UUID REFERENCES tasks(id) ON DELETE SET NULL,
  used_by      UUID REFERENCES tasks(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX items_waiting ON items (job_id, state, created_at);

-- Live worker status, written by worker heartbeats
CREATE TABLE workers (
  id                       TEXT PRIMARY KEY,
  status                   TEXT NOT NULL CHECK (status IN ('IDLE','BUSY','DRAINING','DEAD')),
  slowdown                 REAL NOT NULL DEFAULT 1,     -- artificial slowdown factor (demo)
  current_task_id          UUID,
  current_task_started_at  TIMESTAMPTZ,
  tasks_done               INT NOT NULL DEFAULT 0,
  last_seen                TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- System settings
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
-- desired_workers is seeded by the worker manager from INITIAL_WORKERS (ON CONFLICT DO NOTHING)

-- Activity log shown in the UI
CREATE TABLE events (
  id         BIGSERIAL PRIMARY KEY,
  job_id     UUID,
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);