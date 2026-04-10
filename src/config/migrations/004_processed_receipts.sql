-- Migration 004: Add processed_receipts table
-- Run this against any existing database that was set up before Phase 5.
-- Safe to run multiple times (IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS processed_receipts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform        VARCHAR     NOT NULL CHECK (platform IN ('apple', 'google')),
  transaction_id  VARCHAR     UNIQUE NOT NULL,  -- prevents double-spend
  package_id      VARCHAR     NOT NULL,
  tokens_added    INT         NOT NULL,
  created_at      TIMESTAMP   NOT NULL DEFAULT now()
);

-- Index for fast duplicate checks by transaction_id (already covered by UNIQUE
-- constraint, but an explicit index name makes monitoring queries easier).
CREATE UNIQUE INDEX IF NOT EXISTS processed_receipts_transaction_id_idx
  ON processed_receipts (transaction_id);

-- Index to look up all receipts for a given user (Phase 6 admin panel).
CREATE INDEX IF NOT EXISTS processed_receipts_user_id_idx
  ON processed_receipts (user_id);
