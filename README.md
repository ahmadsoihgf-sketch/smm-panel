# SMM Panel

A complete, self-hosted SMM (Social Media Marketing) panel. Users top up their
balance, place orders for Instagram/TikTok/YouTube/Facebook services, track
order status, and open support tickets. Admins manage services, categories,
API providers (with service sync/import), orders, users, fund requests, payment
methods, and site settings. Resellers get a simple API v2.

## Stack

- Node.js + Express 4, EJS templates, Tailwind CSS via CDN (no build step)
- Database: **SQLite** (local file, default) or **PostgreSQL** (optional, via `DATABASE_URL`)
- Sessions: `express-session` default in-memory store
- Passwords hashed with bcryptjs; receipt uploads via multer

## Quick start (local)

```bash
npm install
npm run seed     # creates data/panel.db with admin + demo accounts, services, payment methods
npm start        # http://localhost:3000
```

- Admin: `admin` / `admin123`
- Demo user: `demo` / `demo123`

> Change both passwords after first login (via the database or a new admin user).

## Database modes

| Mode | When | Notes |
|---|---|---|
| SQLite file (`data/panel.db`) | default, no `DATABASE_URL` | Zero setup. **Ephemeral on free hosting** — data is lost on restart/redeploy. |
| PostgreSQL | `DATABASE_URL` is set | Recommended for production. Tables + indexes are created automatically on startup. |

All SQL is written once with `?` placeholders; `db.js` rewrites them to `$1, $2…`
for `pg` and exposes a single async API (`query`/`get`/`run`/`insert`) that both
backends satisfy. Uses `better-sqlite3` when available, falls back to the
built-in `node:sqlite` (Node 22.5+) otherwise.

Free Postgres options: [Neon](https://neon.tech), [Supabase](https://supabase.com).
Paste the connection string into `DATABASE_URL`. If your provider needs plain
(non-SSL) connections, set `PGSSL=false`.

## Deploy on Render (free)

1. Push this folder to a GitHub repo.
2. In Render: **New → Blueprint**, point it at the repo (`render.yaml` is included).
   It creates a free web service with `npm install && npm run seed` as the build
   command and `npm start` as the start command, plus a generated `SESSION_SECRET`.
3. (Recommended) Add a free Postgres (Neon/Supabase) and set its connection string
   as the `DATABASE_URL` env var, otherwise the SQLite file resets on each deploy.

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `PORT` | no (default 3000) | HTTP port |
| `SESSION_SECRET` | **yes in production** | Signs session cookies |
| `DATABASE_URL` | no | Switches storage to PostgreSQL |
| `PGSSL` | no | Set `false` for non-SSL Postgres |
| `SQLITE_PATH` | no | Override SQLite file location |

## Reseller API v2

`POST /api/v2` with `key` + `action` (JSON or form-encoded):

| action | params | returns |
|---|---|---|
| `services` | – | active service list |
| `add` | `service`, `link`, `quantity` | `{ order: id }` |
| `status` | `order` | status / start_count / remains |
| `balance` | – | balance + currency |

## Differentiating features

- **Referral program** — every user gets a unique referral link (`/register?ref=CODE`).
  When a referred user's fund request is approved, the referrer automatically
  earns a commission (% set in Admin → Settings). Dashboard shows signups + earnings.
- **Announcements** — admin publishes banners (Admin → Announcements); active ones
  show as dismissible banners on the user dashboard.
- **Loyalty tiers** — lifetime order spend unlocks standing discounts
  (e.g. `[{"min_spent":5000,"discount_pct":2},...]` in Settings). Auto-applied on
  the new-order page ("VIP x% applied") and the reseller API; dashboard shows
  progress to the next tier.
- **Telegram notifications** — set bot token + chat ID in Settings ("Save & send
  test message" verifies it). Fire-and-forget alerts on every new order and fund
  request; failures never affect the request.
- **Favorite services** — star any service on the new-order page; favorites pin
  to the top of the service dropdown and appear as quick-pick chips.

## Project layout

```
server.js            Express app, sessions, view helpers, route mounting
db.js                Dual-backend DB layer (SQLite ⇄ PostgreSQL) + schema/indexes
seed.js              Seed script (npm run seed)
lib/provider.js      Generic SMM provider API client (form→JSON fallback, timeouts)
lib/paginate.js      50-per-page pagination helper
routes/auth.js       Landing, login, register, logout
routes/user.js       Dashboard, orders, funds, tickets, API docs
routes/admin.js      Dashboard, services, categories, providers (+sync), orders,
                     users, fund requests, payment methods, tickets, settings
routes/apiv2.js      Reseller API
views/               EJS templates (partials + public/user/admin pages)
test/mock-provider.js Fake provider API for local integration testing
render.yaml          Render Blueprint (free web service)
```

## Known limitations

- **Sessions** use the default in-memory store: logins are lost on restart and
  don't work across multiple instances. For production, plug in
  `connect-pg-simple` (Postgres) or `connect-sqlite3`.
- **Receipt uploads** are stored on the local filesystem (`public/uploads/receipts`),
  which is ephemeral on free hosting. For production, store them in S3/R2/Cloudinary.
- **SQLite on free hosting is ephemeral** — set `DATABASE_URL` for persistence.
- Provider API integrations assume the classic SMM API shape
  (`key` + `action=services|add|status|balance`); exotic providers may need a
  small adapter in `lib/provider.js`.
- Payment methods are manual (JazzCash/EasyPaisa style with receipt proof);
  automatic gateways (Stripe/crypto) are not built in.
- The seed payment account numbers are **PLACEHOLDERS** — update them in
  Admin → Payment Methods before going live.
