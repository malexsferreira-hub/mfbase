// In-process stand-in for lib/db.js, implementing the exact same interface
// (init/getDb/saveDb). Used ONLY by the local test harness (tests/server.test.js),
// so server.js's routing/auth/static-serving logic can be exercised with real
// HTTP requests without needing the `pg` package or a live Postgres connection —
// neither of which is reachable in this sandbox. Production always uses lib/db.js.
const fs = require("fs");
const path = require("path");

function loadSeed() {
  const seedPath = path.join(__dirname, "..", "seed.json");
  return JSON.parse(fs.readFileSync(seedPath, "utf8"));
}

function createMemoryDb() {
  let row = null; // { data, updatedAt } | null until init()

  return {
    async init() {
      if (!row) row = { data: loadSeed(), updatedAt: new Date().toISOString() };
    },
    async getDb() {
      if (!row) row = { data: loadSeed(), updatedAt: null };
      return { data: row.data, updatedAt: row.updatedAt };
    },
    async saveDb(data) {
      row = { data, updatedAt: new Date().toISOString() };
      return { updatedAt: row.updatedAt };
    },
    // test-only helper, not part of the shared db interface
    _reset() { row = null; },
  };
}

module.exports = { createMemoryDb };
