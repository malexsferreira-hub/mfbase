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
      clubs: [], players: [], matches: [], matchPlayers: [], evaluations: [], playerNotes: [], fixtures: [], agendaTasks: [],
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

async function saveDb(data) {
  const client = getPool();
  const res = await client.query(
    "UPDATE touchline_db SET data = $1, updated_at = now() WHERE id = 1 RETURNING updated_at",
    [JSON.stringify(data)]
  );
  return { updatedAt: res.rows[0].updated_at };
}

module.exports = { init, getDb, saveDb, getPool };
