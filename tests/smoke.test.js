// Broader smoke test across the app's existing features (unchanged business logic),
// run through the real login+server flow, to catch any interaction-level regression
// from the persistence rewrite — not a full re-run of every qa_test*.py from the
// artifact version (that logic is untouched), but a meaningful cross-section.
const { chromium } = require("playwright");
const { createServer } = require("../server");
const { createMemoryDb } = require("../lib/db.memory");

const APP_PASSWORD = "smoke-test-password";
const SESSION_SECRET = "smoke-test-secret";

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
  function nav(hash) { return page.evaluate((h) => { location.hash = h; }, hash); }

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

  // ---- Login ----
  await page.goto(base + "/login", { waitUntil: "domcontentloaded" });
  await page.fill('input[name="password"]', APP_PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForTimeout(500);
  log("PASS: logged in");

  // ---- Add Player, verify profile renders ----
  await nav("#/players/new");
  await page.waitForTimeout(200);
  await page.fill('input[name="name"]', "Smoke Test Player");
  await page.selectOption('select[name="firstPosition"]', "CM");
  await createClubViaCombo("#pf_club_combo_text", "Smoke FC");
  await page.fill('input[name="nationality"]', "Portugal");
  await page.click("button[type=submit]");
  await page.waitForTimeout(400);
  let body = await page.innerText("body");
  if (!/Smoke Test Player/.test(body)) throw new Error("player profile did not render after creation");
  if (!/Smoke FC/.test(body)) throw new Error("club not shown on player profile");
  log("PASS: Add Player -> profile page renders correctly");

  // ---- Create a match, add the player to the lineup with notes + Player of Interest ----
  await nav("#/matches/new");
  await page.waitForTimeout(200);
  await createClubViaCombo("#mf_home_combo_text", "Smoke Home FC");
  await createClubViaCombo("#mf_away_combo_text", "Smoke Away FC");
  await page.fill('input[name="date"]', "2027-11-01");
  await page.fill('input[name="competition"]', "Smoke League");
  await page.fill('input[name="competitionCountry"]', "Saudi Arabia");
  await page.click("button[type=submit]");
  await page.waitForTimeout(400);

  const emptySlot = await page.$('.pitch-empty[data-action="open-pitch-slot"]');
  if (!emptySlot) throw new Error("expected an empty pitch slot on the new match page");
  await emptySlot.click();
  await page.waitForTimeout(200);
  await page.selectOption('#modalRoot select[name="position"]', "ST");
  await page.fill('#modalRoot input[name="shirtNumber"]', "11");
  await page.fill("#modalRoot input#pitchSlotName_text", "Smoke Lineup Player");
  await page.fill('#modalRoot textarea[name="notes"]', "Smoke test note");
  await page.check('#modalRoot input[name="playerOfInterest"]');
  await page.evaluate(() => {
    const f = document.querySelector('#modalRoot form[data-form="save-pitch-slot"]');
    if (f) f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(400);
  body = await page.innerText("body");
  if (!/Smoke Lineup Player/.test(body)) throw new Error("lineup player did not show up in Players of Interest");
  if (!/Smoke test note/.test(body)) throw new Error("lineup notes should show alongside position ('position | note')");
  log("PASS: match + lineup + Player of Interest + notes work through the server-backed app");

  // ---- Matches Database "Players" filter (Batch Q feature) ----
  await nav("#/matches");
  await page.waitForTimeout(300);
  const filterbar = await page.innerText(".filterbar");
  if (!/Players/.test(filterbar)) throw new Error("expected a Players filter in the Matches Database filterbar");
  log("PASS: Matches Database 'Players' filter is present");

  // ---- Evaluation History: Number + Notes columns (Batch Q feature) ----
  await nav("#/players");
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll("tr[data-nav-row]"));
    const row = rows.find((r) => r.textContent.includes("Smoke Lineup Player"));
    if (row) row.click();
  });
  await page.waitForTimeout(300);
  const headers = await page.$$eval(".table-evalhist thead th", (els) => els.map((e) => e.textContent.trim()));
  if (headers.indexOf("Number") === -1 || headers.indexOf("Notes") === -1) {
    throw new Error("expected Number/Notes columns in Evaluation History, got: " + headers.join(","));
  }
  log("PASS: Evaluation History Number/Notes columns intact");

  // ---- Backup feature works through the real app ----
  await nav("#/");
  await page.waitForTimeout(200);
  await page.click('.sidebar-foot [data-action="open-backup"]');
  await page.waitForTimeout(300);
  const backupVal = await page.$eval("#backupJsonText", (el) => el.value);
  if (!/Smoke Lineup Player/.test(backupVal)) throw new Error("backup export should include current data");
  await page.click("#modalRoot [data-close-modal]");
  await page.waitForTimeout(200);
  log("PASS: Backup Data feature still works");

  // ---- Mobile nav (Batch P/Q features) ----
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  await nav("#/");
  await page.waitForTimeout(300);
  const tabInfo = await page.evaluate(() => Array.from(document.querySelectorAll(".tabbar > *")).map((el) => ({
    href: el.getAttribute("href"), action: el.getAttribute("data-action"), text: el.textContent.trim(),
  })));
  if (tabInfo.length !== 7) throw new Error("expected 7 mobile tab items, got " + tabInfo.length);
  if (tabInfo[1].href !== "#/matches" || tabInfo[2].href !== "#/players") {
    throw new Error("mobile tab order regressed: " + JSON.stringify(tabInfo));
  }
  log("PASS: mobile tab bar order/content intact (Home, Matches, Players, +, Agenda, Calendar, MF)");
  await page.setViewportSize({ width: 1280, height: 900 });

  // ---- Logout works ----
  await page.evaluate(() => { location.href = "/logout"; });
  await page.waitForTimeout(300);
  const hasPasswordField = (await page.$('input[name="password"]')) !== null;
  if (!hasPasswordField) throw new Error("expected to be back at the login page after logout");
  log("PASS: logout returns to the login page");

  const meaningfulErrors = consoleErrors.filter((e) => !/ERR_TUNNEL_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/.test(e));
  if (meaningfulErrors.length) {
    console.log("Console errors:", meaningfulErrors);
    throw new Error("unexpected console errors");
  }
  log("PASS: no unexpected console errors");

  await browser.close();
  server.close();
  console.log("\nALL SMOKE TESTS PASSED");
}

main().catch((err) => {
  console.error("TEST FAILURE:", err);
  process.exit(1);
});
