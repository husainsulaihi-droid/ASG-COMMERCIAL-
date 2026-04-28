# Deployment Guide — VPS

This guide covers the **backend** deployment. The frontend is already auto-pulled from GitHub via cron.

After this is done, your VPS will:
- Serve the frontend (already working)
- Run the Node.js backend on `127.0.0.1:3000` as a systemd service
- nginx routes `/api/*` to the backend, everything else stays static

---

## One-time backend setup on the VPS

SSH into your VPS, then run these blocks in order.

### 1. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version    # should print v20.x
```

### 2. Create the data directory (DB + uploads)

The backend code in `/var/www/asg/backend/` gets overwritten on every `git pull`.
The actual data lives outside that folder so it survives deploys.

```bash
mkdir -p /var/asg/data /var/asg/uploads
chown -R www-data:www-data /var/asg
```

### 3. Install backend dependencies

```bash
cd /var/www/asg/backend
npm install --production
```

### 4. Initialize the database

```bash
DB_PATH=/var/asg/data/asg.db npm run init-db
# Should print: [db] Initializing fresh database at /var/asg/data/asg.db...
#               [db] Schema loaded. Database ready.
#               [init-db] Done.
```

### 5. Install the systemd service

```bash
cp /var/www/asg/deploy/asg-backend.service /etc/systemd/system/asg-backend.service
systemctl daemon-reload
systemctl enable asg-backend
systemctl start asg-backend
```

Verify it's running:

```bash
systemctl status asg-backend
# should show "active (running)"

curl http://127.0.0.1:3000/api/health
# {"status":"ok","timestamp":"...","db":true,"version":"0.1.0"}
```

### 6. Update nginx to reverse-proxy /api/*

```bash
cp /var/www/asg/deploy/nginx-asg.conf /etc/nginx/sites-available/asg
nginx -t       # test syntax
systemctl reload nginx
```

Verify from outside:

```bash
curl https://crm.asgproperties.ae/api/health
# Same JSON response. If you get this, the backend is live.
```

---

## Auto-redeploying after code changes

The cron job already does `git pull` every 2 minutes. **But it doesn't restart the backend automatically.**

To make backend code changes take effect, after pushing to GitHub, SSH into the VPS and run:

```bash
cd /var/www/asg/backend
npm install --production    # only needed if package.json changed
systemctl restart asg-backend
```

We'll automate this in a later phase (a post-pull hook script). For now, manual restart is fine since backend changes are infrequent compared to frontend changes.

---

## Logs

```bash
# Backend logs
tail -f /var/log/asg-backend.log

# nginx access/error logs
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log

# git-pull deploy log
tail -f /var/log/asg-deploy.log
```

---

## Troubleshooting

**Backend won't start**
```bash
journalctl -u asg-backend -n 50
```
Look at the last 50 lines of systemd's log for the service.

**`/api/health` returns 502 Bad Gateway**
Means nginx couldn't reach the backend. Check:
1. `systemctl status asg-backend` — is it running?
2. `curl http://127.0.0.1:3000/api/health` — does the backend respond directly?
3. If yes to both, check `/etc/nginx/sites-available/asg` is correct.

**Database error on startup**
```bash
ls -la /var/asg/data/
```
The `asg.db` file should exist and be owned by `www-data`. If not, re-run step 4.
