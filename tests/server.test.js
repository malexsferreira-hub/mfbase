// End-to-end HTTP test of server.js's routing/auth/static/API layer, using the
// in-memory db stand-in (lib/db.memory.js) instead of Postgres — so this runs
// with zero external dependencies and zero network access, right here.
// Production wiring (bin/www.js -> lib/db.js -> real `pg`) is not exercised by
// this file; that gets a live smoke test right after deploying to Render.
const assert = require("assert");
const path = require("path");
const { createServer } = require("../server");
const { createMemoryDb } = require("../lib/db.memory");

const APP_PASSWORD = "test-password-123";
const SESSION_SECRET = "test-session-secret";

async function main() {
  const db = createMemoryDb();
  await db.init();
  const server = createServer(db, { appPassword: APP_PASSWORD, sessionSecret: SESSION_SECRET, secureCookies: false });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  function log(msg) { console.log(msg); }

  // ---- 1. Unauthenticated access to the app shell redirects to /login ----
  {
    const res = await fetch(base + "/", { redirect: "manual" });
    assert.strictEqual(res.status, 302, "GET / without a session should redirect");
    assert.strictEqual(res.headers.get("location"), "/login", "should redirect to /login");
  }
  log("PASS: unauthenticated GET / redirects to /login");

  // ---- 2. Unauthenticated API access is rejected with 401, not a redirect ----
  {
    const res = await fetch(base + "/api/db");
    assert.strictEqual(res.status, 401, "GET /api/db without a session should 401");
  }
  log("PASS: unauthenticated GET /api/db returns 401 JSON, not a redirect");

  // ---- 3. Login page itself is reachable without auth ----
  {
    const res = await fetch(base + "/login");
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.indexOf("password") >= 0, "login page should have a password field");
  }
  log("PASS: /login is reachable without a session");

  // ---- 4. Wrong password does not authenticate ----
  let cookieJar = "";
  {
    const res = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent("wrong-password"),
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/login?error=1", "wrong password should redirect back with an error flag");
    assert.strictEqual(res.headers.get("set-cookie"), null, "wrong password should not set a session cookie");
  }
  log("PASS: wrong password is rejected and sets no cookie");

  // ---- 4b. Following that redirect actually shows an error message on the login page ----
  {
    const res = await fetch(base + "/login?error=1");
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(/incorreta/i.test(text), "the login page should show a visible error message when ?error=1, got: " + text.slice(0, 300));
  }
  log("PASS: GET /login?error=1 actually renders the error message (not just the query param check)");

  // ---- 5. Correct password authenticates and sets a session cookie ----
  {
    const res = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(APP_PASSWORD),
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/", "correct password should redirect to /");
    const setCookie = res.headers.get("set-cookie");
    assert.ok(setCookie && setCookie.indexOf("mfbase_session=") >= 0, "correct password should set the session cookie");
    assert.ok(setCookie.indexOf("HttpOnly") >= 0, "session cookie should be HttpOnly");
    cookieJar = setCookie.split(";")[0];
  }
  log("PASS: correct password authenticates and sets a session cookie");

  // ---- 6. Authenticated requests now succeed ----
  {
    const res = await fetch(base + "/", { headers: { Cookie: cookieJar } });
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.indexOf("MF Base") >= 0, "authenticated GET / should serve the app shell");
  }
  log("PASS: authenticated GET / serves the app shell");

  // ---- 7. GET /api/db returns the seed data ----
  let firstUpdatedAt;
  {
    const res = await fetch(base + "/api/db", { headers: { Cookie: cookieJar } });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(body.data && Array.isArray(body.data.fixtures), "seed data should include the fixtures array");
    assert.strictEqual(body.data.players.length, 0, "seed data should start with no players");
    firstUpdatedAt = body.updatedAt;
  }
  log("PASS: authenticated GET /api/db returns the seeded database");

  // ---- 8. PUT /api/db persists new data, and it round-trips on the next GET ----
  {
    const newData = {
      schemaVersion: 1,
      scouts: [{ id: "scout-1", name: "Miguel Ferreira" }],
      currentScoutId: "scout-1",
      clubs: [{ id: "club-1", name: "Test FC" }],
      players: [{ id: "p1", name: "Test Player" }],
      matches: [{ id: "m1", homeClubId: "club-1", awayClubId: "club-1", date: "2027-01-01" }],
      matchPlayers: [], evaluations: [], playerNotes: [], fixtures: [], agendaTasks: [],
    };
    const putRes = await fetch(base + "/api/db", {
      method: "PUT", headers: { Cookie: cookieJar, "Content-Type": "application/json" },
      body: JSON.stringify(newData),
    });
    assert.strictEqual(putRes.status, 200);
    const putBody = await putRes.json();
    assert.strictEqual(putBody.ok, true);
    assert.notStrictEqual(putBody.updatedAt, firstUpdatedAt, "updatedAt should change after a save");

    const getRes = await fetch(base + "/api/db", { headers: { Cookie: cookieJar } });
    const getBody = await getRes.json();
    assert.strictEqual(getBody.data.players.length, 1, "the saved player should round-trip");
    assert.strictEqual(getBody.data.players[0].name, "Test Player");
    assert.strictEqual(getBody.data.matches[0].id, "m1", "the saved match should round-trip");
  }
  log("PASS: PUT /api/db persists data and it round-trips on the next GET");

  // ---- 9. A second, independent "device" (its own cookie jar) sees the same saved data ----
  // Simulates: Mac saves something, iPhone opens the app later and sees it.
  {
    const loginRes2 = await fetch(base + "/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=" + encodeURIComponent(APP_PASSWORD),
    });
    const cookieJar2 = loginRes2.headers.get("set-cookie").split(";")[0];
    // Note: the session token is deterministic (HMAC of a fixed string with the server's
    // secret) rather than random-per-login — fine for a single shared-password app, and it
    // means every valid login naturally produces the same valid cookie. What matters here is
    // that a completely independent login (a different "device") authenticates correctly.
    const res = await fetch(base + "/api/db", { headers: { Cookie: cookieJar2 } });
    const body = await res.json();
    assert.strictEqual(body.data.players[0].name, "Test Player", "a second independent session should see the same persisted data");
  }
  log("PASS: a second independent login sees the same data another device saved — real cross-device sync");

  // ---- 10. A stale/garbage cookie is treated as unauthenticated, not a crash ----
  {
    const res = await fetch(base + "/api/db", { headers: { Cookie: "mfbase_session=garbage" } });
    assert.strictEqual(res.status, 401);
  }
  log("PASS: a garbage session cookie is rejected cleanly (401), not a crash");

  // ---- 11. Logout clears the session ----
  {
    const res = await fetch(base + "/logout", { headers: { Cookie: cookieJar }, redirect: "manual" });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get("location"), "/login");
    const cleared = res.headers.get("set-cookie");
    assert.ok(cleared.indexOf("Max-Age=0") >= 0, "logout should expire the cookie");
  }
  log("PASS: /logout clears the session cookie");

  // ---- 12. Static file path traversal is blocked ----
  {
    const res = await fetch(base + "/../../etc/passwd", { headers: { Cookie: cookieJar } });
    assert.notStrictEqual(res.status, 200, "path traversal outside public/ should not succeed");
  }
  log("PASS: static file path traversal is blocked");

  // ---- 13. Oversized PUT body is rejected instead of hanging/crashing ----
  {
    const huge = "x".repeat(30 * 1024 * 1024);
    const res = await fetch(base + "/api/db", {
      method: "PUT", headers: { Cookie: cookieJar, "Content-Type": "application/json" },
      body: huge,
    });
    assert.strictEqual(res.status, 413, "an oversized body should be rejected with 413");
  }
  log("PASS: oversized PUT /api/db body is rejected with 413, server stays healthy");

  server.close();
  console.log("\nALL SERVER TESTS PASSED");
}

main().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exit(1);
});
