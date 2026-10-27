// Postgres persistence layer — single JSONB row holding the whole app database.
// This mirrors the shape of the existing frontend's in-memory DB object 1:1, so
// the (extensively tested) frontend logic barely needs to change: it just
// fetches/saves this blob over HTTP instead of via the old self-publishing
// artifact trick or localStorage.
const fs = require("fs");
const path = require("path");

let pool = null;

function getPool() {
  if (!pool) {
    // Required lazily so this module (and anything that merely imports it) can
    // still load in environments where the `pg` package isn't installed —
    // e.g. local logic/route tests that inject lib/db.memory.js instead and
    // never actually call getPool().
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
    });
  }
  return pool;
}

function loadSeed() {
  const seedPath = path.join(__dirname, "..", "seed.json");
  try {
    return JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch (e) {
    // Minimal fallback seed if seed.json is ever missing — keeps the server bootable.
    return {
      schemaVersion: 1,
      scouts: [{ id: "scout-1", name: "Miguel Ferreira", email: "m.alexsferreira@gmail.com", role: "Scout" }],
      currentScoutId: "scout-1",
      clubs: [], players: [], matches: [], matchPlayers: [], evaluations: [], playerNotes: [], fixtures: [], agendaTasks: [], shortlistEntries: [],
    };
  }
}

async function init() {
  const client = getPool();
  await client.query(`
    CREATE TABLE IF NOT EXISTS touchline_db (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
  `);
  const existing = await client.query("SELECT id FROM touchline_db WHERE id = 1");
  if (existing.rowCount === 0) {
    const seed = loadSeed();
    await client.query("INSERT INTO touchline_db (id, data) VALUES (1, $1)", [JSON.stringify(seed)]);
    console.log("touchline_db: seeded initial row (fresh install)");
  }
}

async function getDb() {
  const client = getPool();
  const res = await client.query("SELECT data, updated_at FROM touchline_db WHERE id = 1");
  if (res.rowCount === 0) {
    // Shouldn't happen after init(), but guard anyway.
    const seed = loadSeed();
    return { data: seed, updatedAt: null };
  }
  return { data: res.rows[0].data, updatedAt: res.rows[0].updated_at };
}

// Miguel (after a real incident where a long-idle browser tab's stale in-memory copy silently
// overwrote newer changes another tab/device had already saved — losing a new match, a "Watched"
// status change, and very nearly 12 lineup entries): "a app guarda tudo como um único bloco de
// estado de cada vez, sem fazer merge... proponho implementar uma proteção real (a app recusar
// guardar se detectar que alguém gravou por cima entretanto, pedindo para recarregar primeiro)."
//
// `baseUpdatedAt`, when provided, is the `updated_at` the CALLER last read (i.e. what its in-memory
// copy is actually based on). The UPDATE only applies if the row's `updated_at` still matches that
// exact value — if someone else has saved in between, it won't, and 0 rows are affected. That is
// the save silently clobbering a newer save, and it refuses to overwrite it: it throws a CONFLICT
// error carrying the row's actual current `updated_at`, which the caller uses to tell its user to
// reload (never to auto-merge — this app has no way to merge two shapes of the same JSON blob, so
// the only honest options are "discard the newer save" or "discard my own", and only a person can
// decide which, hence surfacing the conflict rather than picking for them).
// `baseUpdatedAt` omitted/null keeps the old unconditional behavior, for any caller that hasn't
// been updated to track it yet.
async function saveDb(data, baseUpdatedAt) {
  const client = getPool();
  if (baseUpdatedAt) {
    const res = await client.query(
      "UPDATE touchline_db SET data = $1, updated_at = now() WHERE id = 1 AND updated_at = $2 RETURNING updated_at",
      [JSON.stringify(data), baseUpdatedAt]
    );
    if (res.rowCount === 0) {
      const current = await client.query("SELECT updated_at FROM touchline_db WHERE id = 1");
      const err = new Error("save conflict: row changed since baseUpdatedAt was read");
      err.code = "CONFLICT";
      err.currentUpdatedAt = current.rowCount ? current.rows[0].updated_at : null;
      throw err;
    }
    return { updatedAt: res.rows[0].updated_at };
  }
  const res = await client.query(
    "UPDATE touchline_db SET data = $1, updated_at = now() WHERE id = 1 RETURNING updated_at",
    [JSON.stringify(data)]
  );
  return { updatedAt: res.rows[0].updated_at };
}

module.exports = { init, getDb, saveDb, getPool };
