# NovaVault — Telegram Reward Mini App & Admin Panel

Complete full-stack Telegram Reward Mini App built with React, TypeScript, Tailwind CSS, Express, and **PostgreSQL (`pg`)**. Uses Telegram-native `initData` authentication for regular users and a dedicated `ADMIN_PASSCODE`-protected Admin Panel at `/#admin`.

---

## 1. Why Telegram Mini Apps Cannot Use AI Studio Preview URLs

AI Studio preview URLs (`ais-dev-*.run.app` / `ais-pre-*.run.app`) sit behind Google's authentication proxy and return an `HTTP 302` redirect to Google Sign-In for unauthenticated browsers. Because Telegram WebViews open without your Google session, pointing your bot to an AI Studio preview URL triggers a Google Account Sign-In screen.

NovaVault automatically **blocks** `ais-dev-*`, `ais-pre-*`, and Google auth URLs from being saved as the Telegram Mini App launch URL, and resets any stale AI Studio Menu Button back to standard bot commands until a verified public HTTPS URL (`PUBLIC_APP_URL`) is deployed.

---

## 2. Deploying to Render with PostgreSQL

### Option A: Render Blueprint (Recommended)
1. Push this project to a GitHub repository.
2. In [Render](https://render.com), click **New + -> Blueprint** and connect your repository. Render detects `render.yaml`, automatically provisions the `novavault-db` PostgreSQL database, and binds `DATABASE_URL` to the web service.
3. Set the required Environment Variables in Render:
   - `NODE_ENV=production`
   - `PUBLIC_APP_URL=https://<your-service>.onrender.com`
   - `TELEGRAM_BOT_TOKEN=<your BotFather token>`
   - `TELEGRAM_ADMIN_IDS=<your numeric Telegram ID>`
   - `ADMIN_PASSCODE=<your admin password>`
   - `TELEGRAM_BOT_POLLING=false` (or `true` if you prefer polling without registering a webhook)
   - `DATABASE_URL` (auto-populated by Blueprint, or paste your Render PostgreSQL Internal/External Connection String)
   - `SESSION_SECRET` (recommended random secret so sessions persist across server restarts)
4. Deploy. NovaVault automatically creates all PostgreSQL tables, runs schema migrations, and seeds initial translations, withdrawal methods (`bKash` & `Nagad`), default tasks, and games before listening on port `PORT`.
5. Once live, open `https://<your-service>.onrender.com/#admin` -> **Settings** -> **Verify & Set Mini App Launch Button** (and **Register Webhook Automatically** if `TELEGRAM_BOT_POLLING=false`).

### SSL Handling for PostgreSQL
- **Render Internal Connection String** (`dpg-...-a/...`): Connects over Render's private network without requiring forced SSL.
- **Render External Connection String** (`*.oregon-postgres.render.com` or `?sslmode=require`): Automatically enables TLS with `{ rejectUnauthorized: false }`.
- You can explicitly override SSL behavior using `DATABASE_SSL=true|false` or standard `?sslmode=require|disable` query params.

### Option B: Koyeb / Cloud Run + External PostgreSQL
1. Provision a PostgreSQL database (Render, Neon, Supabase, or Cloud SQL) and set `DATABASE_URL`.
2. Build command: `npm install && npm run build`
3. Start command: `npm start`
4. Health check path: `/api/health`

---

## 3. Verification Checklist (Incognito + Telegram)

1. **Incognito Browser Check**: Open `https://<your-public-url>/api/health` in an incognito/logged-out browser. Confirm it returns `HTTP 200` JSON (`{"ok":true,"database":"postgresql",...}`) with **no Google Sign-In screen**.
2. **Root App Check**: Open `https://<your-public-url>/` in an incognito browser. Confirm NovaVault loads immediately and displays `"Please open NovaVault through our official Telegram bot."` (no Gmail/Google/email login).
3. **Admin Setup**: Open `https://<your-public-url>/#admin`, log in with `ADMIN_PASSCODE`, go to **Settings**, confirm `PUBLIC_APP_URL`, and click **Verify & Set Mini App Launch Button**.
4. **Telegram Check**: Send `/start` to your bot in Telegram and tap either the **Open NovaVault Mini App** button or the persistent Menu Launch Button. Verify it opens directly into your NovaVault dashboard authenticated via Telegram `initData`. Supported bot commands: `/start`, `/balance`, `/refer`, `/help`, `/admin`.
5. **Clean Project Export**: In Admin Console -> **Settings & Bot**, click **Download Clean Project ZIP** (`/api/admin/export-project.zip`) to download clean deployment source code with `.env`, runtime files, and `node_modules` automatically excluded.

---

## 4. Local Development

```bash
npm install
npm run dev
```

- If `DATABASE_URL` is set locally, NovaVault connects directly to PostgreSQL.
- If `DATABASE_URL` is omitted in non-production local dev/preview, NovaVault runs an in-memory PostgreSQL (`pg-mem`) instance so preview works cleanly without requiring a local Postgres daemon.
- Health check: `http://localhost:3000/api/health`
- Admin Panel: `http://localhost:3000/#admin`
- Telegram user authentication requires a valid Telegram Mini App `initData` signed by `TELEGRAM_BOT_TOKEN`.
