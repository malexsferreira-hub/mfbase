#!/usr/bin/env node
// Safely merges a new list of SAFF fixtures into the LIVE database over the network —
// never touches players/matches/evaluations, and never overwrites a fixture's matchId
// link (i.e. "already added to the Agenda") for a fixture that still exists in the new
// list. This is how the monthly calendar refresh works now that the app has a real
// backend: a data update, not a code deploy, so it can never clobber real usage data.
//
// Usage:
//   MFBASE_URL=https://<app>.onrender.com MFBASE_PASSWORD=<password> \
//     node scripts/update-fixtures.js path/to/new-fixtures.json
//
// new-fixtures.json is an array of {id, date, time, competition, team1, team2, venue}.
const fs = require("fs");

async function main() {
  const filePath = process.argv[2];
  const baseUrl = process.env.MFBASE_URL;
  const password = process.env.MFBASE_PASSWORD;
  if (!filePath || !baseUrl || !password) {
    console.error("Usage: MFBASE_URL=... MFBASE_PASSWORD=... node scripts/update-fixtures.js <fixtures.json>");
    process.exit(1);
  }
  const newFixtures = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(newFixtures)) throw new Error("fixtures file must contain a JSON array");

  // --- log in to get a session cookie ---
  const loginRes = await fetch(baseUrl.replace(/\/$/, "") + "/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "password=" + encodeURIComponent(password),
  });
  const setCookie = loginRes.headers.get("set-cookie");
  if (!setCookie) throw new Error("login failed — check MFBASE_PASSWORD");
  const cookie = setCookie.split(";")[0];

  // --- fetch the current live database ---
  const getRes = await fetch(baseUrl.replace(/\/$/, "") + "/api/db", { headers: { Cookie: cookie } });
  if (!getRes.ok) throw new Error("GET /api/db failed: " + getRes.status);
  const current = (await getRes.json()).data;

  // --- merge: keep matchId links from existing fixtures that are still present in the
  // new list; fixtures no longer present (e.g. past months rolling off) are dropped;
  // brand-new fixtures are added as-is ---
  const existingById = {};
  (current.fixtures || []).forEach((f) => { if (f && f.id) existingById[f.id] = f; });
  let kept = 0, added = 0, linksPreserved = 0;
  const merged = newFixtures.map((f) => {
    const existing = existingById[f.id];
    if (existing) {
      kept++;
      if (existing.matchId) { linksPreserved++; return Object.assign({}, f, { matchId: existing.matchId }); }
      return f;
    }
    added++;
    return f;
  });
  current.fixtures = merged;

  // --- save it back ---
  const putRes = await fetch(baseUrl.replace(/\/$/, "") + "/api/db", {
    method: "PUT", headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(current),
  });
  if (!putRes.ok) throw new Error("PUT /api/db failed: " + putRes.status);

  console.log("Fixtures updated: " + merged.length + " total (" + kept + " kept, " + added + " new, " + linksPreserved + " Agenda links preserved). Players, matches and evaluations were not touched.");
}

main().catch((err) => { console.error("FAILED:", err.message || err); process.exit(1); });
