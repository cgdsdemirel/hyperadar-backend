-- HypeRadar Database Schema
-- Run this against your Supabase/PostgreSQL instance to initialize the schema.

-- Enable pgcrypto for gen_random_uuid() if not already enabled
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────
-- users
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR     UNIQUE NOT NULL,
  password_hash  VARCHAR     NOT NULL,
  plan           VARCHAR     NOT NULL DEFAULT 'free', -- 'free' or 'premium'
  created_at     TIMESTAMP   NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────
-- token_balances
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_balances (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  monthly_tokens    INT         NOT NULL DEFAULT 0,
  purchased_tokens  INT         NOT NULL DEFAULT 0,
  reset_date        TIMESTAMP   -- next monthly reset date
);

-- ─────────────────────────────────────────
-- token_packages
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_packages (
  id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR   NOT NULL,
  token_amount  INT       NOT NULL,
  price_usd     NUMERIC   NOT NULL,
  is_active     BOOLEAN   NOT NULL DEFAULT true
);

-- ─────────────────────────────────────────
-- queries
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS queries (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  regions      TEXT[]      NOT NULL DEFAULT '{}',
  categories   TEXT[]      NOT NULL DEFAULT '{}',
  token_spent  INT         NOT NULL DEFAULT 0,
  created_at   TIMESTAMP   NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────
-- trends
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trends (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  title              VARCHAR     NOT NULL,
  description        TEXT,
  category           VARCHAR,
  region             VARCHAR,
  lang               VARCHAR,
  score              INT         CHECK (score >= 0 AND score <= 100), -- 0 to 100
  monetization_hint  TEXT,
  source             VARCHAR,
  created_at         TIMESTAMP   NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────
-- ad_views
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ad_views (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  completed_at TIMESTAMP   NOT NULL DEFAULT now(),
  query_id     UUID        REFERENCES queries(id) ON DELETE SET NULL -- nullable
);

-- ─────────────────────────────────────────
-- processed_receipts
-- Prevents double-spending: transaction_id is globally unique.
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_receipts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        VARCHAR     NOT NULL CHECK (platform IN ('apple', 'google')),
  transaction_id  VARCHAR     UNIQUE NOT NULL,
  package_id      VARCHAR     NOT NULL,
  tokens_added    INT         NOT NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────
-- pipeline_logs
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pipeline_logs (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMP   NOT NULL DEFAULT now(),
  completed_at    TIMESTAMP,
  status          VARCHAR     NOT NULL DEFAULT 'running'
                              CHECK (status IN ('running', 'success', 'failed')),
  trends_added    INT         NOT NULL DEFAULT 0,
  error_message   TEXT
);

-- ─────────────────────────────────────────
-- refresh_tokens
-- ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  revoked     BOOLEAN     DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- Trend score history — snapshots for timeline visualization
CREATE TABLE IF NOT EXISTS trend_score_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trend_id UUID NOT NULL REFERENCES trends(id) ON DELETE CASCADE,
  score NUMERIC NOT NULL,
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trend_score_history_trend ON trend_score_history(trend_id);
CREATE INDEX IF NOT EXISTS idx_trend_score_history_recorded ON trend_score_history(recorded_at DESC);
