-- ─── API Keys table ──────────────────────────────────────────────────────────
-- Run once via the Supabase SQL editor (or psql).

CREATE TABLE IF NOT EXISTS api_keys (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key          UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Look-ups by owner
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id);

-- Fast validation path: only active keys are looked up at request time
CREATE INDEX IF NOT EXISTS api_keys_key_active_idx ON api_keys (key) WHERE is_active = true;

-- ─── Pro plan ─────────────────────────────────────────────────────────────────
-- The plan column is stored as TEXT.  Valid values are: free | premium | pro
-- (No CHECK constraint was added when the table was created, so just document it.)

COMMENT ON COLUMN users.plan IS 'Valid values: free, premium, pro';
