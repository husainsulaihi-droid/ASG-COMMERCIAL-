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
- ✅ Phase 2 — Auth: login, sessions, password hashing, user CRUD
- ✅ Phase 3 — Core endpoints (properties, leads, tasks)
- ⏳ Phase 4 — Remaining endpoints (meetings, announcements, leaves, off-plan, secondary, proposals)
- ⏳ Phase 5 — File upload (photos, documents)
- ⏳ Phase 6 — Frontend rewire (replace localStorage with `fetch`)
- ⏳ Phase 7 — Multi-user testing & polish

## API endpoints

### Auth (Phase 2)

| Method | Path                  | Auth          | Purpose                                   |
|--------|-----------------------|---------------|-------------------------------------------|
| GET    | `/api/health`         | none          | Backend reachable + DB OK                 |
| POST   | `/api/auth/login`     | none          | `{username, password}` → sets cookie     |
| POST   | `/api/auth/logout`    | none          | Clears session cookie                     |
| GET    | `/api/auth/me`        | any user      | Current user info                         |

### Users (Phase 2)

| Method | Path                  | Auth          |
|--------|-----------------------|---------------|
| GET    | `/api/users`          | any user      |
| GET    | `/api/users/:id`      | admin or self |
| POST   | `/api/users`          | admin only    |
| PATCH  | `/api/users/:id`      | admin or self |
| DELETE | `/api/users/:id`      | admin only    |

### Properties (Phase 3)

| Method | Path                                   | Auth          |
|--------|----------------------------------------|---------------|
| GET    | `/api/properties`                      | any (filtered)|
| GET    | `/api/properties/:id`                  | any (filtered)|
| POST   | `/api/properties`                      | admin         |
| PATCH  | `/api/properties/:id`                  | admin         |
| DELETE | `/api/properties/:id`                  | admin         |
| GET    | `/api/properties/:id/cheques`          | admin         |
| POST   | `/api/properties/:id/cheques`          | admin         |
| PATCH  | `/api/properties/:id/cheques/:cid`     | admin         |
| DELETE | `/api/properties/:id/cheques/:cid`     | admin         |

Visibility: admin sees all; sales/general see vacant; leasing sees rented;
property_management sees managed; accounts sees none. Non-admin viewers
have rent/financial fields stripped; tenant info hidden unless leasing/PM role.

### Leads (Phase 3)

| Method | Path                                   | Auth                     |
|--------|----------------------------------------|--------------------------|
| GET    | `/api/leads`                           | any (own/team/all)       |
| GET    | `/api/leads/:id`                       | own/team/admin           |
| POST   | `/api/leads`                           | any (assignedTo defaults)|
| PATCH  | `/api/leads/:id`                       | own/team-leader/admin    |
| DELETE | `/api/leads/:id`                       | admin                    |
| GET    | `/api/leads/:id/activities`            | own/team/admin           |
| POST   | `/api/leads/:id/activities`            | own/team-leader/admin    |

Posting an activity with `stageChanged` mirrors the change to the lead row.

### Tasks (Phase 3)

| Method | Path                                   | Auth                          |
|--------|----------------------------------------|-------------------------------|
| GET    | `/api/tasks`                           | any (own/team/all)            |
| GET    | `/api/tasks/:id`                       | own/team/admin                |
| POST   | `/api/tasks`                           | admin / team leader           |
| PATCH  | `/api/tasks/:id`                       | own/team-leader/admin         |
| DELETE | `/api/tasks/:id`                       | admin / leader-of-assignee    |
| GET    | `/api/tasks/:id/notes`                 | own/team/admin                |
| POST   | `/api/tasks/:id/notes`                 | own/team/admin                |

Sessions: HttpOnly cookie `asg_session`, 30-day TTL. Passwords: bcrypt cost 12.
