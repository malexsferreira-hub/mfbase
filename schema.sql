-- MF Base (Touchline) — single-blob persistence schema.
-- Mirrors the shape of the app's in-memory DB object: one row holds the whole
-- database as JSONB. This keeps the migration low-risk (no rewrite of the
-- existing, heavily-tested frontend data model) while giving it a real,
-- durable, shared datastore instead of the old self-publishing-artifact trick.
CREATE TABLE IF NOT EXISTS touchline_db (
  id INTEGER PRIMARY KEY DEFAULT 1,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 1)
);
