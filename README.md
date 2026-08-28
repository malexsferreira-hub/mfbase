# MF Base — standalone server

The Touchline / MF Base scouting app, migrated off the Claude-artifact
self-publishing trick onto a real standalone server: a static frontend
(`public/index.html`, unchanged in every way except how it loads/saves data)
served behind a shared-password login, with a tiny JSON API (`GET`/`PUT
/api/db`) backed by Postgres as the single source of truth. Any device that
logs in reads and writes the same server-side row, so data is never tied to
one browser or one device again, and code deploys can never touch it.

## Layout

- `server.js` — the whole HTTP layer (routing, auth, static files, API),
  written against Node's core `http` module only. Zero framework dependency.
- `lib/auth.js` — password check + signed session cookie (HMAC, no external
  deps). Unit-tested in `lib/auth.test.js`.
- `lib/db.js` — Postgres-backed persistence (`pg`), single JSONB row holding
  the whole app database (same shape the frontend already uses).
- `lib/db.memory.js` — in-process stand-in for `lib/db.js` used only by the
  local test suite, so the HTTP/auth/static layer can be tested without a
  live Postgres connection.
- `bin/www.js` — production entry point (wires `lib/db.js` + env vars into
  `server.js` and starts listening).
- `public/` — the app itself, unchanged business logic. `manifest.json` +
  `icons/` + `sw.js` make it installable ("Add to Home Screen") now that it
  lives on its own domain.
- `scripts/update-fixtures.js` — safely merges a new SAFF fixtures list into
  the *live* database over the network (a data update, never a code deploy —
  see "Updating the monthly calendar" below).
- `tests/` — `server.test.js` (HTTP-level, zero deps), `ui.test.js` /
  `smoke.test.js` (real-browser tests via Playwright, local dev only).

## Environment variables

| Variable         | Required | Notes                                                          |
|-------------------|----------|------------------------------------------------------------------|
| `DATABASE_URL`    | yes      | Postgres connection string (Render sets this automatically when the web service is linked to the Postgres instance). |
| `APP_PASSWORD`    | yes      | The shared password that gates the whole app.                  |
| `SESSION_SECRET`  | yes      | Random string used to sign the session cookie. Render can generate this automatically (see `render.yaml`). |
| `PORT`            | no       | Defaults to 3000; Render sets this itself.                     |
| `INSECURE_COOKIES`| no       | Set to `true` only for local HTTP testing — disables the `Secure` cookie flag, which otherwise blocks login over plain HTTP. Never set this in production (HTTPS). |
| `PGSSL`           | no       | Set to `false` to disable SSL for a local Postgres without SSL configured. Leave unset in production. |

## Local development / testing

No live Postgres or `pg` package needed for the test suite — `tests/server.test.js`
and `tests/ui.test.js`/`tests/smoke.test.js` all run against `lib/db.memory.js`.

```
npm test                 # server.test.js + lib/auth.test.js (zero external deps)
node tests/ui.test.js    # real-browser test via Playwright (dev machine only)
node tests/smoke.test.js # broader real-browser smoke test
```

To run the real production server against a local Postgres:

```
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/mfbase \
APP_PASSWORD=devpassword SESSION_SECRET=dev-secret INSECURE_COOKIES=true \
npm start
```

## Updating the monthly calendar

This used to mean editing code and republishing the whole artifact. It
doesn't anymore — the fixtures list lives in the same database row as
everything else, so updating it is a **data** operation, not a **code**
deploy, and can never touch players/matches/evaluations:

```
MFBASE_URL=https://<your-app>.onrender.com \
MFBASE_PASSWORD=<the app password> \
node scripts/update-fixtures.js path/to/new-fixtures.json
```

It merges by fixture `id`: existing fixtures already linked to a match (i.e.
already added to the Agenda) keep that link even if their other fields
change; fixtures no longer in the new list are dropped; new ones are added.

## Deploying

See `render.yaml` for a one-shot Blueprint (web service + Postgres, wired
together, with `SESSION_SECRET` auto-generated). `APP_PASSWORD` is left for
manual entry (`sync: false`) since it shouldn't live in the repo.
