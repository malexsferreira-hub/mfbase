#!/usr/bin/env node
// Production entry point: wires the real Postgres-backed db module into the
// server and starts listening. Render sets PORT; DATABASE_URL comes from the
// linked Postgres instance; APP_PASSWORD and SESSION_SECRET are set as env vars.
const { createServer } = require("../server");
const db = require("../lib/db");

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!APP_PASSWORD) {
  console.error("FATAL: APP_PASSWORD env var is not set.");
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error("FATAL: SESSION_SECRET env var is not set.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL env var is not set.");
  process.exit(1);
}

db.init()
  .then(function () {
    const server = createServer(db, {
      appPassword: APP_PASSWORD,
      sessionSecret: SESSION_SECRET,
      secureCookies: process.env.INSECURE_COOKIES !== "true",
    });
    server.listen(PORT, function () {
      console.log("MF Base server listening on port " + PORT);
    });
  })
  .catch(function (err) {
    console.error("FATAL: failed to initialize database:", err);
    process.exit(1);
  });
