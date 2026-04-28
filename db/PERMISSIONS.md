# Permissions & Visibility — Backend API

This is the rulebook the API enforces server-side. Frontend UI hides what users shouldn't see, but the API is the source of truth — even if a user opens dev tools and calls endpoints manually, the API will reject what they shouldn't have.

## Account types

| Account type | How identified |
|---|---|
| **Admin** | `users.role = 'admin'` |
| **Team Leader** | `users.role = 'agent'` AND `users.is_team_leader = 1` |
| **Agent** | `users.role = 'agent'` AND `users.is_team_leader = 0` |

Team leaders are still agents (they have their own leads/tasks/deals) — the flag just gives them extra rights over their team.

## Team hierarchy

- Each agent has a `team_leader_id` pointing at their team leader (nullable).
- A team leader has `is_team_leader = 1` and (usually) no `team_leader_id` — they report directly to admin.
- A team leader's "team" = all users where `team_leader_id = team_leader.id`.
- Admin assigns: who is a team leader, and who reports to whom.

## Module-by-module access

### Properties (owned portfolio: warehouses, offices, residential)

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Read full record (with financials, tenants, ownership, cheques) | ✅ | ❌ | ❌ |
| Read scoped subset based on `agent_role` | ✅ | ✅ | ✅ |
| Create / Edit / Delete | ✅ | ❌ | ❌ |

**Agent role-based scoping:**
- `sales` → only `status = 'vacant'` properties
- `leasing` → only `status = 'rented'` properties
- `property_management` → only `ownership = 'management'` properties
- `accounts` → no inventory access
- `general` → vacant only (default same as sales)

**Always stripped from agents/team leaders' view (admin-only fields):**
`annual_rent`, `service_charges`, `maintenance_fees`, `vat`, `purchase_price`, `market_value`, `mgmt_fee`, `partner_name`, `our_share`, all cheque records.

**Tenant fields** (`tenant_name`, `tenant_phone`, `tenant_email`, `lease_start`, `lease_end`) only visible if the agent's role lets them see the property AND the user has `permissions.viewTenant = true`.

### Pending property submissions

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| List all submissions | ✅ | ❌ | ❌ |
| Approve / Reject | ✅ | ❌ | ❌ |
| Submit own | ❌ | ✅ | ✅ |
| List own submissions | ✅ | ✅ | ✅ |

### Leads

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Read all leads | ✅ | Their team's leads + own | Own only |
| Create new lead | ✅ | ✅ | ✅ |
| Assign / Reassign | All agents | Within their team only | ❌ (cannot reassign their own) |
| Edit lead details | ✅ | Their team's leads + own | Own only |
| Delete lead | ✅ | Their team's leads + own | ❌ |
| Add lead activity | ✅ | ✅ (any lead they can see) | ✅ (own leads) |

### Tasks

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Read all tasks | ✅ | Their team's + own | Own only |
| Create / Assign task | ✅ to anyone | ✅ to their team only | ❌ |
| Update task status | Any task | Their team's + own | Own only |
| Add task note | Any task | ✅ (any task they can see) | Own only |
| Delete task | ✅ | Their team's + own | ❌ |

### Meetings & Viewings

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Read all meetings | ✅ | Their team's + own | Own only |
| Create meeting | ✅ for anyone | ✅ for self or team agent | ✅ for self |
| Edit meeting status / notes / photos | Any | Their team's + own | Own only |
| Delete meeting | ✅ | Their team's + own | Own only |

### Off-Plan (developers + projects)

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Browse all developers / projects | ✅ | ✅ | ✅ |
| Add / Edit / Delete developer | ✅ | ❌ | ❌ |
| Add / Edit / Delete project | ✅ | ❌ | ❌ |
| Excel import | ✅ | ❌ | ❌ |
| Download PDF / Share with client | ✅ | ✅ | ✅ |

### Secondary (resale) listings

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Browse all listings | ✅ | ✅ | ✅ |
| Add new listing | ✅ | ✅ | ✅ |
| Edit / Delete | Any | Their team's + own | Own only |
| Download PDF / Share | ✅ | ✅ | ✅ |

### Proposals

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Create proposal | ✅ | ✅ | ✅ |
| List own proposals | ✅ | ✅ | ✅ |
| List all proposals | ✅ | Their team's + own | Own only |
| Edit / Delete proposal | Any | Their team's + own | Own only |

### Announcements

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Read all (non-expired) | ✅ | ✅ | ✅ |
| Mark as read | ✅ | ✅ | ✅ |
| Create / Edit / Delete | ✅ | ❌ | ❌ |
| See "read by X/Y" counts | ✅ | ❌ | ❌ |

### Leaves

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Add leave for any user | ✅ | For their team only | ❌ |
| List all leaves | ✅ | Their team + own | Own + team-mates' (so they know who's out) |
| Delete leave | ✅ | Their team + own | ❌ |

### Performance / Activity Timeline / Schedule Board

| Module | Admin sees | Team Leader sees | Agent sees |
|---|---|---|---|
| Leaderboard | All agents | Their team only | Self only |
| Activity timeline | All events | Their team's events | Own events |
| Schedule board (today's status) | All agents | Their team | Self |

### Disputes / Construction Projects / Financials / Rentals

All admin-only. Team leaders and agents have **zero access** to these endpoints.

### User accounts (admin/agent management)

| Action | Admin | Team Leader | Agent |
|---|---|---|---|
| Create new agent | ✅ | ❌ | ❌ |
| Set / change agent's `team_leader_id` | ✅ | ❌ | ❌ |
| Mark agent as team leader | ✅ | ❌ | ❌ |
| Edit own profile (name, email, phone, password, availability) | ✅ | ✅ | ✅ |
| Edit other agents | ✅ | ❌ | ❌ |
| Deactivate / delete agents | ✅ | ❌ | ❌ |

## Implementation notes for the API

- Every endpoint that returns lists filters server-side based on the rules above. Never return rows the caller shouldn't see, even if the frontend "would have hidden them."
- Every endpoint that mutates checks ownership/team membership before applying the change. Reject with 403 if not permitted.
- For team leader queries, the canonical filter is:
  ```sql
  WHERE assigned_to IN (SELECT id FROM users WHERE team_leader_id = :user_id OR id = :user_id)
  ```
- Audit fields (`created_by_id`, `updated_by_id`) are written by the API automatically — frontend cannot set them.
