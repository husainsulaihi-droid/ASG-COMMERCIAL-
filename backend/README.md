# ASG Backend

Express + SQLite REST API. Sits behind nginx, accessed via `/api/*` from the frontend.

## Run locally

```bash
cd backend
npm install
npm run init-db   # one-time, creates asg.db from db/schema.sql
npm start         # listens on http://127.0.0.1:3000
```

Test it:

```bash
curl http://127.0.0.1:3000/api/health
# {"status":"ok","timestamp":"...","db":true,"version":"0.1.0"}
```

## Run on the VPS

See [`../deploy/DEPLOY.md`](../deploy/DEPLOY.md) for full instructions.
TL;DR — install dependencies, copy the systemd service file, enable it, update nginx to reverse-proxy `/api/*`.

## Env vars

| Name      | Default                       | Notes                                                              |
|-----------|-------------------------------|--------------------------------------------------------------------|
| `PORT`    | `3000`                        | TCP port the server listens on                                     |
| `HOST`    | `127.0.0.1`                   | Bind address — keep on localhost; nginx is the only public-facing  |
| `DB_PATH` | `./asg.db`                    | Where the SQLite file lives. Production: `/var/asg/data/asg.db`    |

## Structure

```
backend/
  server.js      Main HTTP server + middleware + routes
  db.js          SQLite connection + schema bootstrap
  init-db.js     One-shot script to create the DB
  package.json   Dependencies + npm scripts
```

## Phase status

- ✅ Phase 1 — Skeleton: `/api/health` works, DB initializes from schema
- ⏳ Phase 2 — Auth: login, sessions, password hashing
- ⏳ Phase 3 — Core endpoints (properties, agents, tasks, leads)
- ⏳ Phase 4 — Remaining endpoints (meetings, announcements, leaves, off-plan, secondary, proposals)
- ⏳ Phase 5 — File upload (photos, documents)
- ⏳ Phase 6 — Frontend rewire (replace localStorage with `fetch`)
- ⏳ Phase 7 — Multi-user testing & polish
