-- Migration 006: Favorites table
-- Run once in Supabase SQL Editor (or via migration tool)

CREATE TABLE IF NOT EXISTS favorites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  trend_id   UUID NOT NULL REFERENCES trends(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(user_id, trend_id)
);

CREATE INDEX IF NOT EXISTS favorites_user_id_idx ON favorites (user_id);
