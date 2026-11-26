# NovaVault — Telegram Reward Mini App & Admin Panel

Complete full-stack Telegram Reward Mini App built with React, TypeScript, Tailwind CSS, Express, and embedded SQLite (`better-sqlite3`). Uses Telegram-native `initData` authentication for regular users and a dedicated `ADMIN_PASSCODE`-protected Admin Panel at `/#admin`.

---

## 1. Why Telegram Mini Apps Cannot Use AI Studio Preview URLs

AI Studio preview URLs (`ais-dev-*.run.app` / `ais-pre-*.run.app`) sit behind Google's authentication proxy and return an `HTTP 302` redirect to Google Sign-In for unauthenticated browsers. Because Telegram WebViews open without your Google session, pointing your bot to an AI Studio preview URL triggers a Google Account Sign-In screen.

NovaVault automatically **blocks** `ais-dev-*`, `ais-pre-*`, and Google auth URLs from being saved as the Telegram Mini App launch URL, and resets any stale AI Studio Menu Button back to standard bot commands until a verified public HTTPS URL (`PUBLIC_APP_URL`) is deployed.

---

## 2. Free Public HTTPS Deployment Options

### Option A: Render (Free Web Service — Recommended)
1. Push this project to a GitHub repository.
2. In [Render](https://render.com), click **New + -> Blueprint** (or **New + -> Web Service**), connect your repo (it detects `render.yaml`), and keep the **Free** plan.
3. Set the required Environment Variables in Render:
   - `NODE_ENV=production`
   - `PUBLIC_APP_URL=https://<your-service>.onrender.com`
   - `TELEGRAM_BOT_TOKEN=<your BotFather token>`
   - `TELEGRAM_ADMIN_IDS=<your numeric Telegram ID>`
   - `ADMIN_PASSCODE=<your admin password>`
   - `TELEGRAM_BOT_POLLING=false` (or `true` if you prefer polling without registering a webhook)
4. Deploy. Once live, open `https://<your-service>.onrender.com/#admin` -> **Settings** -> **Verify & Set Mini App Launch Button** (and **Register Webhook Automatically** if `TELEGRAM_BOT_POLLING=false`).

> **Persistent Database Storage Recommendation:** By default NovaVault stores data in `data/novavault.db` via embedded SQLite (`better-sqlite3` with WAL mode). On free PaaS hosts with ephemeral filesystems, set `DATA_DIR` to a mounted persistent volume/disk before handling live financial payouts so user balances and withdrawal ledgers survive container restarts and redeploys.

### Option B: Koyeb (Free Web Service)
1. Connect your GitHub repository in [Koyeb](https://www.koyeb.com) using the **Free** instance.
2. Set Build command: `npm install && npm run build`, Run command: `npm start`, Port: `3000` (or `PORT` env), and health check path `/api/health`.
3. Add the same environment variables (`PUBLIC_APP_URL=https://<your-app>.koyeb.app`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_IDS`, `ADMIN_PASSCODE`, `TELEGRAM_BOT_POLLING=false`).

### Option C: Google Cloud Run (Free Tier Quota, Public Access)
If deploying directly to Google Cloud Run (free tier includes 2M requests/month):
1. Deploy with `--allow-unauthenticated` so Telegram WebViews are never redirected to Google Sign-In.
2. Set `PUBLIC_APP_URL` to the public `*.run.app` URL and verify `/api/health` in an incognito browser returns HTTP 200 JSON.

---

## 3. Verification Checklist (Incognito + Telegram)

1. **Incognito Browser Check**: Open `https://<your-public-url>/api/health` in an incognito/logged-out browser. Confirm it returns `HTTP 200` JSON (`{"ok":true,...}`) with **no Google Sign-In screen**.
2. **Root App Check**: Open `https://<your-public-url>/` in an incognito browser. Confirm NovaVault loads immediately and displays `"Please open NovaVault through our official Telegram bot."` (no Gmail/Google/email login).
3. **Admin Setup**: Open `https://<your-public-url>/#admin`, log in with `ADMIN_PASSCODE`, go to **Settings**, confirm `PUBLIC_APP_URL`, and click **Verify & Set Mini App Launch Button**.
4. **Telegram Check**: Send `/start` to your bot in Telegram and tap either the **Open NovaVault Mini App** button or the persistent Menu Launch Button. Verify it opens directly into your NovaVault dashboard authenticated via Telegram `initData`. Supported bot commands: `/start`, `/balance`, `/refer`, `/help`, `/admin`.
5. **Clean Project Export**: In Admin Console -> **Settings & Bot**, click **Download Clean Project ZIP** (`/api/admin/export-project.zip`) to download clean deployment source code with `.env`, database files, and `node_modules` automatically excluded.

---

## 4. Local Development

```bash
npm install
npm run dev
```

- Health check: `http://localhost:3000/api/health`
- Admin Panel: `http://localhost:3000/#admin`
- Telegram user authentication requires a valid Telegram Mini App `initData` signed by `TELEGRAM_BOT_TOKEN`.

