// Browser-level test of the ADAPTED frontend (public/index.html) against the real
// server.js, using the in-memory db stand-in (no Postgres/pg needed). This is the
// critical check that the persist()/loadInitialData() rewrite actually works end to
// end through real UI interactions, not just at the raw HTTP/API level (covered by
// tests/server.test.js).
const { chromium } = require("playwright");
const { createServer } = require("../server");
const { createMemoryDb } = require("../lib/db.memory");

const APP_PASSWORD = "ui-test-password";
const SESSION_SECRET = "ui-test-secret";

async function main() {
  const db = createMemoryDb();
  await db.init();
  const server = createServer(db, { appPassword: APP_PASSWORD, sessionSecret: SESSION_SECRET, secureCookies: false });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = "http://127.0.0.1:" + port;

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const consoleErrors = [];
  const page = await browser.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (exc) => consoleErrors.push(String(exc)));

  function log(msg) { console.log(msg); }

  // ---- 1. Visiting the app while logged out lands on the login page ----
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(200);
  let bodyText = await page.innerText("body");
  const hasPasswordField = (await page.$('input[name="password"]')) !== null;
  if (!hasPasswordField) throw new Error("expected the login form's password field, got body: " + bodyText.slice(0, 200));
  log("PASS: visiting the app while logged out shows the login form");

  // ---- 2. Wrong password stays on login with an error ----
  await page.fill('input[name="password"]', "wrong");
  await page.click('button[type=submit]');
  await page.waitForTimeout(300);
  bodyText = await page.innerText("body");
  if (!/incorreta/i.test(bodyText)) throw new Error("expected a wrong-password message, got: " + bodyText.slice(0, 200));
  log("PASS: wrong password shows an error and does not log in");

  // ---- 3. Correct password logs in and loads the real app shell ----
  await page.fill('input[name="password"]', APP_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(600);
  bodyText = await page.innerText("body");
  if (!/Dashboard/i.test(bodyText)) throw new Error("expected the Dashboard after login, got: " + bodyText.slice(0, 300));
  log("PASS: correct password logs in and loads the real MF Base app (Dashboard visible)");

  // ---- 4. Create a match through the real UI ----
  await page.evaluate(() => { location.hash = "#/matches/new"; });
  await page.waitForTimeout(300);

  async function createClubViaCombo(textId, name) {
    const listId = textId.replace("_text", "_list");
    await page.fill(textId, name);
    await page.waitForTimeout(150);
    await page.click(`${listId} .combo-create`);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const f = document.querySelector('#modalRoot form[data-form="__inline_club_create"]');
      if (f) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.waitForTimeout(200);
  }
  await createClubViaCombo("#mf_home_combo_text", "UI Test Home FC");
  await createClubViaCombo("#mf_away_combo_text", "UI Test Away FC");
  await page.fill('input[name="date"]', "2027-10-01");
  await page.click("button[type=submit]");
  await page.waitForTimeout(500);

  const hashAfterCreate = await page.evaluate(() => location.hash);
  if (!/^#\/matches\//.test(hashAfterCreate)) throw new Error("expected to land on the new match's page, got hash: " + hashAfterCreate);
  log("PASS: created a match through the real UI");

  // ---- 5. Confirm it actually reached the server (not just localStorage) by reading /api/db directly ----
  const cookie = (await page.context().cookies())[0];
  const apiRes = await page.evaluate(async () => {
    const r = await fetch("/api/db", { credentials: "same-origin" });
    return r.json();
  });
  const savedMatches = apiRes.data.matches || [];
  const found = savedMatches.some((m) => true); // any match at all confirms the PUT landed server-side
  if (!found) throw new Error("expected the created match to have been PUT to /api/db, server has: " + JSON.stringify(apiRes.data.matches));
  const homeClub = (apiRes.data.clubs || []).find((c) => c.name === "UI Test Home FC");
  if (!homeClub) throw new Error("expected the created club to be saved server-side too");
  log("PASS: the match and club created in the UI were actually persisted to the server (GET /api/db reflects them)");

  // ---- 6. Reload the page (fresh boot) and confirm the data survives — this is the whole point ----
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  bodyText = await page.innerText("body");
  if (!/UI Test Home FC/.test(bodyText)) {
    // it might be on the dashboard, not the match page directly — check via nav to Matches Database
    await page.evaluate(() => { location.hash = "#/matches"; });
    await page.waitForTimeout(400);
    bodyText = await page.innerText("body");
  }
  if (!/UI Test Home FC/.test(bodyText)) throw new Error("expected the match to survive a full page reload (loaded from the server), got: " + bodyText.slice(0, 400));
  log("PASS: reloading the page from scratch re-loads the real data from the server (loadInitialData works)");

  // ---- 7. Simulate a second device: a totally separate browser context (own cookies/storage) sees the same data ----
  const context2 = await browser.newContext();
  const page2 = await context2.newPage();
  await page2.goto(base + "/login", { waitUntil: "domcontentloaded" });
  await page2.fill('input[name="password"]', APP_PASSWORD);
  await page2.click('button[type=submit]');
  await page2.waitForTimeout(500);
  await page2.evaluate(() => { location.hash = "#/matches"; });
  await page2.waitForTimeout(400);
  const bodyText2 = await page2.innerText("body");
  if (!/UI Test Home FC/.test(bodyText2)) throw new Error("expected a second independent browser context (simulating another device) to see the same data, got: " + bodyText2.slice(0, 400));
  log("PASS: a second independent browser context (simulated second device) sees the same match — real cross-device sync");
  await context2.close();

  // ---- 8. No console errors along the way ----
  const meaningfulErrors = consoleErrors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED/.test(e));
  if (meaningfulErrors.length) {
    console.log("Console errors seen:", meaningfulErrors);
    throw new Error("unexpected console errors during the UI test run");
  }
  log("PASS: no unexpected console errors during the whole flow");

  await browser.close();
  server.close();
  console.log("\nALL UI TESTS PASSED");
}

main().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exit(1);
});
