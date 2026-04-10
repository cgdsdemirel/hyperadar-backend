-- Migration 005: Add pipeline_logs table
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS pipeline_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMP   NOT NULL DEFAULT now(),
  completed_at    TIMESTAMP,
  status          VARCHAR     NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'success', 'failed')),
  trends_added    INT         NOT NULL DEFAULT 0,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS pipeline_logs_started_at_idx
  ON pipeline_logs (started_at DESC);
