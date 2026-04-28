# ASG Commercial Properties — CRM Dashboard

Internal CRM and property-management tool for ASG Commercial Properties L.L.C. — Dubai-based real-estate brokerage.

GitHub is the source of truth. The VPS pulls the latest `main` and serves the static files.

---

## What's in here

A single-page app, three files:

| File         | Purpose                                                              |
|--------------|----------------------------------------------------------------------|
| `index.html` | All views, modals, sidebar nav, login screen                         |
| `app.js`     | All logic — auth, rendering, modals, storage, PDF export, file upload |
| `styles.css` | All styling — navy/gold theme, responsive layout                     |

No build step. Open `index.html` in a browser and it runs.

---

## Modules

### Properties (owned portfolio)
- Warehouses / Offices / Residential tabs
- Add/edit properties: location, size, ownership type (Own / Partnership / Management), tenant, lease, cheque schedule, photos/videos, documents (DREC, Ijari, Affection Plan, Tenancy Contract)
- Service Charges, Annual Maintenance Fees, and 5% VAT (auto-calculated on rent)
- Property detail modal with media gallery, full info, and document downloads

### Off-Plan (developer projects)
- Drill-down: **Developers grid → Projects grid → Project detail**
- 20 major UAE developers pre-seeded (Emaar, DAMAC, Sobha, Nakheel, Aldar, etc.)
- Add/edit developers (admin) and projects under each developer
- Photo gallery + brochure PDF per project
- Excel/CSV bulk import for projects
- PDF export on ASG letterhead + WhatsApp/email share-with-client

### Secondary (resale listings)
- Listings sourced from external owners — distinct from owned portfolio
- Both admin and agent can add directly (no pending queue)
- Visible to the whole sales team
- Photo gallery, owner contact, sale price / annual rent, status (Active/Reserved/Sold/Rented)
- PDF export + share-with-client

### Rentals
- Cross-portfolio cheque-payment tracker
- Per-property: cheque schedule + Service Charges + Maintenance + VAT block
- Filter by status (received/pending/bounced) and type
- Edit cheques per property

### Proposals
- Build payment-structure proposals on ASG letterhead
- Auto-syncs property's annual rent, service charges, maintenance, VAT into the proposal
- Saved proposals list with reprint / edit / delete
- Agents see only their own; admin sees all

### Team module (admin only)
Sub-tab structure on the left rail:
- **Overview** — KPIs, top performers, today's status, latest announcements, recent activity
- **Performance** — leaderboard (this month / all-time toggle) + activity timeline
- **Tasks** — admin to-dos: Schedule (availability, leaves), Announcements, Pending property submissions
- **Agents** — agent list with metric strips
- **Tasks Given** — assigned tasks
- **Leads** — leads pipeline + Meetings & Viewings tracker

### Agent dashboard
- Personal performance card (deals won, conversion %, revenue, properties shown, proposals)
- Team rank for the month
- Pipeline distribution chart
- Today panel (active tasks, overdue, active leads)
- Announcements banner
- Logout button in sidebar

### Meetings & Viewings (agent + admin)
- Agents log every client meeting and property viewing
- Push directly from a lead's detail modal (Schedule Meeting / Schedule Viewing buttons)
- Photo upload per meeting (stored in IndexedDB)
- Auto-logs to the linked lead's activity feed on schedule/status change
- Admin sees everyone's meetings in the Team → Leads tab

### Conversation threads
- Task notes — chat-bubble thread with author labels (`👑 Admin` vs agent name) — admin can reply
- Lead activity log — same treatment, admin can post replies

### Financials
- Year-by-year P&L per property type
- Rental income (prorated by months active × ownership share)
- Management fees from managed properties
- Service Charges + Maintenance + VAT aggregated separately
- TOTAL INCOME row at the bottom

### Construction, Map, Calendar, Reminders, Disputes
- Other operational tools that existed before this expansion — see existing UI

---

## Authentication

- **Admin login** stored in `localStorage` under `asg_credentials` (default `admin` / `asg2024`)
- **Agent login** — agent records carry `username` + `password` directly in `asg_agents`
- Session lives in `sessionStorage` under `asg_session` — cleared on tab close

This is **not production-grade auth.** Anyone with browser dev tools can read passwords from localStorage. Acceptable for an internal tool on a single trusted device. Replace with real backend auth before exposing to multiple users on a shared network.

---

## Data model — localStorage keys

| Key                          | Stored data                                              |
|------------------------------|----------------------------------------------------------|
| `asg_credentials`            | Admin username + password                                |
| `asg_session`                | Active session (sessionStorage, not local)               |
| `asg_props`                  | Owned portfolio (warehouses/offices/residential)         |
| `asg_pending_props`          | Agent-submitted properties awaiting admin approval       |
| `asg_agents`                 | Agent accounts + roles + permissions + availability     |
| `asg_tasks`                  | Admin-assigned tasks for agents (with notes thread)     |
| `asg_leads`                  | Sales leads + activity log                               |
| `asg_meetings`               | Meetings & viewings (photos in IndexedDB)                |
| `asg_announcements`          | Internal announcements with read-by tracking             |
| `asg_leaves`                 | Agent leave records                                       |
| `asg_proposals`              | Saved payment-structure proposals                         |
| `asg_offplan_developers`     | UAE developers (with logos as base64)                    |
| `asg_offplan_projects`       | Off-plan projects (photos as base64, brochure as base64) |
| `asg_secondary_listings`     | Secondary/resale listings (photos as base64)             |
| `asg_construction_projects`  | Construction projects                                     |
| `asg_disputes`               | Disputes log                                              |
| `asg_api_settings`           | Saved API keys (Meta Ads, etc.)                          |

Files (property docs, media, meeting photos) larger than what fits in localStorage are stored in **IndexedDB** under `asg_files` store with key references in the localStorage records.

---

## Critical caveat — data is per-browser, not shared

Every piece of data lives in the user's browser. Two devices = two separate datasets. Two agents on different laptops = no data sync between them.

This is acceptable for:
- Single-user / single-device use
- A demo or design preview
- A backup of curated data you re-import via Excel

This is **not** acceptable for:
- Multi-agent collaboration
- A live brokerage operation with multiple seats

To go multi-user, the app needs a backend (planned — see Roadmap).

---

## Local development

```bash
git clone https://github.com/husainsulaihi-droid/ASG-COMMERCIAL-.git
cd ASG-COMMERCIAL-
# Open index.html directly in any modern browser, or run:
python3 -m http.server 8000
# then visit http://localhost:8000
```

No `npm install`, no bundler. Edit the three files and refresh.

---

## VPS deployment (auto-pull from GitHub)

### One-time setup on the VPS

```bash
# 1. Install nginx
sudo apt update
sudo apt install -y nginx git

# 2. Clone the repo
sudo git clone https://github.com/husainsulaihi-droid/ASG-COMMERCIAL-.git /var/www/asg
sudo chown -R www-data:www-data /var/www/asg

# 3. Configure nginx (/etc/nginx/sites-available/asg)
server {
    listen 80;
    server_name your-domain.com;
    root /var/www/asg;
    index index.html;
    location / {
        try_files $uri $uri/ =404;
    }
}

# 4. Enable site + reload
sudo ln -s /etc/nginx/sites-available/asg /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# 5. (Optional) HTTPS via Let's Encrypt
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

### Auto-pull every 2 minutes via cron

```bash
sudo crontab -e
# Add this line:
*/2 * * * * cd /var/www/asg && git pull origin main >> /var/log/asg-deploy.log 2>&1
```

For instant deploys instead of polling, set up a GitHub webhook → small Node listener that runs `git pull`.

---

## Roadmap

When the backend lands, these flip from "planned" to "implemented":

- **Real auth + multi-user data sync** — Postgres or SQLite + JWT sessions
- **Google Sheets sync** (see next section)
- **RERA / DLD / Property Finder / Bayut connectors** for Off-Plan auto-update
- **Notifications** — email + WhatsApp (via Twilio or Meta WhatsApp API)
- **Real Meta Ads webhook ingestion** for leads
- **Backups** — daily DB snapshots to S3/object storage

The frontend stays mostly as-is during the migration. We add API endpoints and swap localStorage reads/writes for `fetch` calls — module by module.

---

## Theme

- Navy `#1a1f2e` for box backgrounds
- Gold `#c9a84c` for accents (top stripes, active state, highlights)
- White interior on inner row tiles for readability
- Inter / system sans-serif font, base 15px

ASG letterhead format applied across all generated PDFs (proposals, off-plan briefs, secondary listing briefs).

---

## Contact

Dubai · ASG Commercial Properties L.L.C.
Office No. 1006, 10th Floor, Dubai National Insurance Building, Port Saeed
+971 4 264 2899 · info@asggroup.ae · www.asgholdings.ae
