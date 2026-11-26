import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { DEFAULT_TRANSLATIONS } from './translations-seed.ts';
import { hashSecret } from './security.ts';

function resolveDatabasePath(): string {
  const rawDbUrl = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  if (rawDbUrl) {
    if (rawDbUrl.startsWith('file:')) {
      const filePart = rawDbUrl.slice(5).replace(/^\/\//, '');
      if (filePart) return path.resolve(filePart);
    } else if (!rawDbUrl.includes('://')) {
      const resolved = path.resolve(rawDbUrl);
      if (resolved.endsWith('.db') || resolved.endsWith('.sqlite') || resolved.endsWith('.sqlite3')) {
        return resolved;
      }
      return path.join(resolved, 'novavault.db');
    } else {
      console.warn(
        'NovaVault uses embedded SQLite (better-sqlite3). Non-file DATABASE_URL scheme detected; falling back to local SQLite storage.'
      );
    }
  }

  const dataDir = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(process.cwd(), 'data');
  return path.join(dataDir, 'novavault.db');
}

const DB_PATH = resolveDatabasePath();
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

export const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      first_name TEXT NOT NULL DEFAULT '',
      last_name TEXT NOT NULL DEFAULT '',
      photo_url TEXT NOT NULL DEFAULT '',
      is_online INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL,
      points_balance INTEGER NOT NULL DEFAULT 0,
      pending_balance INTEGER NOT NULL DEFAULT 0,
      total_earned INTEGER NOT NULL DEFAULT 0,
      total_withdrawn INTEGER NOT NULL DEFAULT 0,
      referral_code TEXT UNIQUE NOT NULL,
      referred_by_user_id INTEGER REFERENCES users(id),
      referral_qualified INTEGER NOT NULL DEFAULT 0,
      referral_earnings INTEGER NOT NULL DEFAULT 0,
      is_blocked INTEGER NOT NULL DEFAULT 0,
      is_preview INTEGER NOT NULL DEFAULT 0,
      language TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS languages (
      code TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      native_name TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS translations (
      lang_code TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'General',
      PRIMARY KEY (lang_code, key)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      icon_url TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      reward_points INTEGER NOT NULL,
      verification_type TEXT NOT NULL,
      secret_code_hash TEXT NOT NULL DEFAULT '',
      daily_limit INTEGER NOT NULL DEFAULT 1,
      expires_at TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      proof_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ad_providers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      sdk_zone_id TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      ad_url_template TEXT NOT NULL DEFAULT '',
      postback_secret_hash TEXT NOT NULL,
      reward_points INTEGER NOT NULL DEFAULT 10,
      daily_limit INTEGER NOT NULL DEFAULT 10,
      reset_hour_utc INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ad_sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      provider_id INTEGER NOT NULL REFERENCES ad_providers(id) ON DELETE CASCADE,
      slot_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'initiated',
      reward_points INTEGER NOT NULL,
      provider_tx_id TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      verified_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ad_postbacks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id INTEGER,
      session_id TEXT NOT NULL DEFAULT '',
      provider_tx_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      raw_reward TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS withdrawal_methods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      networks_json TEXT NOT NULL DEFAULT '[]',
      min_points INTEGER NOT NULL DEFAULT 1000,
      max_points INTEGER NOT NULL DEFAULT 100000,
      fee_percent REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      method_id INTEGER NOT NULL REFERENCES withdrawal_methods(id),
      method_name TEXT NOT NULL,
      network TEXT NOT NULL,
      account_address TEXT NOT NULL,
      points_amount INTEGER NOT NULL,
      usdt_amount REAL NOT NULL,
      fee_usdt REAL NOT NULL,
      net_usdt REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT UNIQUE NOT NULL,
      game_type TEXT NOT NULL DEFAULT 'spin_wheel',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      icon_url TEXT NOT NULL DEFAULT '',
      target_url TEXT NOT NULL DEFAULT '',
      reward_min INTEGER NOT NULL DEFAULT 5,
      reward_max INTEGER NOT NULL DEFAULT 30,
      daily_limit INTEGER NOT NULL DEFAULT 5,
      cooldown_seconds INTEGER NOT NULL DEFAULT 30,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS game_sessions (
      nonce TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'started',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS game_plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      reward_points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount_points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL,
      reference_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      admin_actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  runMigrations();
  seedInitialData();
}

function hasColumn(table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === col);
}

function runMigrations(): void {
  if (!hasColumn('ad_providers', 'api_key')) {
    db.exec("ALTER TABLE ad_providers ADD COLUMN api_key TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('ad_providers', 'placement_id')) {
    db.exec("ALTER TABLE ad_providers ADD COLUMN placement_id TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn('ad_providers', 'payout_per_conversion_bdt')) {
    db.exec('ALTER TABLE ad_providers ADD COLUMN payout_per_conversion_bdt REAL NOT NULL DEFAULT 0');
  }
  if (!hasColumn('ad_sessions', 'provider_tx_id')) {
    db.exec("ALTER TABLE ad_sessions ADD COLUMN provider_tx_id TEXT NOT NULL DEFAULT ''");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_sessions_provider_tx_id ON ad_sessions(provider_id, provider_tx_id) WHERE provider_tx_id != ''"
  );
  if (!hasColumn('games', 'game_type')) {
    db.exec("ALTER TABLE games ADD COLUMN game_type TEXT NOT NULL DEFAULT 'spin_wheel'");
    db.exec("UPDATE games SET game_type = 'prism_memory' WHERE slug = 'prism-memory'");
  }
  if (!hasColumn('games', 'target_url')) {
    db.exec("ALTER TABLE games ADD COLUMN target_url TEXT NOT NULL DEFAULT ''");
  }
  // Withdrawal BDT/PTS columns (replaces legacy USDT columns)
  if (!hasColumn('withdrawals', 'fee_points')) {
    db.exec('ALTER TABLE withdrawals ADD COLUMN fee_points REAL NOT NULL DEFAULT 0');
  }
  if (!hasColumn('withdrawals', 'net_points')) {
    db.exec('ALTER TABLE withdrawals ADD COLUMN net_points REAL NOT NULL DEFAULT 0');
  }
  if (!hasColumn('withdrawals', 'bdt_amount')) {
    db.exec('ALTER TABLE withdrawals ADD COLUMN bdt_amount REAL NOT NULL DEFAULT 0');
  }
  if (!hasColumn('withdrawals', 'fee_bdt')) {
    db.exec('ALTER TABLE withdrawals ADD COLUMN fee_bdt REAL NOT NULL DEFAULT 0');
  }
  if (!hasColumn('withdrawals', 'net_bdt')) {
    db.exec('ALTER TABLE withdrawals ADD COLUMN net_bdt REAL NOT NULL DEFAULT 0');
  }
  db.exec(
    `UPDATE withdrawals
     SET bdt_amount = CASE WHEN bdt_amount = 0 THEN ROUND(points_amount / 10.0, 2) ELSE bdt_amount END,
         net_points = CASE WHEN net_points = 0 THEN points_amount ELSE net_points END,
         net_bdt = CASE WHEN net_bdt = 0 THEN ROUND(points_amount / 10.0, 2) ELSE net_bdt END`
  );

  // Remove USDT withdrawal option completely; keep only bKash & Nagad active
  db.exec(
    "DELETE FROM withdrawal_methods WHERE LOWER(code) = 'usdt' AND id NOT IN (SELECT DISTINCT method_id FROM withdrawals)"
  );
  db.exec("UPDATE withdrawal_methods SET is_active = 0 WHERE LOWER(code) = 'usdt'");
  db.exec("DELETE FROM app_settings WHERE key IN ('exchangeRatePointsPerUsdt', 'minWithdrawalUsdt', 'maxWithdrawalUsdt')");
  db.exec(
    `UPDATE translations SET value = 'bKash / Nagad Account Number' WHERE lang_code = 'en' AND key = 'account.address_label' AND value = 'Wallet Address or Account Number';
     UPDATE translations SET value = 'বিকাশ / নগদ অ্যাকাউন্ট নম্বর' WHERE lang_code = 'bn' AND key = 'account.address_label' AND value = 'ওয়ালেট ঠিকানা বা অ্যাকাউন্ট নম্বর';
     UPDATE translations SET value = 'Account Type' WHERE lang_code = 'en' AND key = 'account.select_network' AND value = 'Network / Type';
     UPDATE translations SET value = 'অ্যাকাউন্টের ধরন' WHERE lang_code = 'bn' AND key = 'account.select_network' AND value = 'নেটওয়ার্ক / ধরন';`
  );

  // Deactivate unconfigured placeholder demo ad URL so fake ads are never shown
  db.exec(
    "UPDATE ad_providers SET is_active = 0 WHERE ad_url_template LIKE '%core.telegram.org/bots/webapps#implementing-mini-apps%'"
  );
}

function seedInitialData(): void {
  const now = new Date().toISOString();

  // 1. Default App Settings
  const defaultSettings: Record<string, string> = {
    appName: 'NovaVault',
    logoUrl: '/src/assets/images/app_brand_logo_1795540139729.jpg',
    iconUrl: '/src/assets/images/app_brand_logo_1795540139729.jpg',
    bannerUrl: '/src/assets/images/hero_vault_banner_1795540140575.jpg',
    primaryColor: '#7C3AED',
    bgColor: '#080B18',
    maintenanceMode: 'false',
    registrationEnabled: 'true',
    adsEnabled: 'true',
    checkinEnabled: 'true',
    tasksEnabled: 'true',
    gamesEnabled: 'true',
    referralsEnabled: 'true',
    withdrawalsEnabled: 'true',
    defaultLanguage: 'en',
    pointsPerBdt: '10',
    minWithdrawalPoints: '500',
    maxWithdrawalPoints: '100000',
    withdrawalFeePercent: '1.5',
    dailyCheckinReward: '25',
    dailyMaxEarnings: '500',
    dailyMaxAdEarnings: '200',
    referralRewardPoints: '100',
    referralInviteeBonus: '25',
    referralConditionMinTasks: '1',
    referralMaxLevels: '2',
    referralLevel2Percent: '20',
    supportUrl: 'https://t.me/novavault_support',
    channelUrl: 'https://t.me/novavault_announcements',
    botUsername: 'NovaVaultRewardBot',
    termsText: 'Rewards are granted only for verified activity. Automated bots, multi-accounting, or self-referrals result in immediate suspension.',
    privacyText: 'We store your Telegram ID, username, and ledger records strictly to operate rewards and process requested payouts.',
  };

  const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(defaultSettings)) {
    insertSetting.run(k, v);
  }

  // 2. Languages & Translations
  const insertLang = db.prepare('INSERT OR IGNORE INTO languages (code, name, native_name, is_enabled) VALUES (?, ?, ?, ?)');
  insertLang.run('en', 'English', 'English', 1);
  insertLang.run('bn', 'Bengali', 'বাংলা', 1);

  const insertTx = db.prepare('INSERT OR IGNORE INTO translations (lang_code, key, value, category) VALUES (?, ?, ?, ?)');
  for (const item of DEFAULT_TRANSLATIONS) {
    insertTx.run('en', item.key, item.en, item.category);
    insertTx.run('bn', item.key, item.bn, item.category);
  }

  // 3. Seed Default Tasks if empty
  const taskCount = (db.prepare('SELECT COUNT(*) as cnt FROM tasks').get() as { cnt: number }).cnt;
  if (taskCount === 0) {
    const insertTask = db.prepare(`
      INSERT INTO tasks (title, description, category, icon_url, target_url, reward_points, verification_type, secret_code_hash, daily_limit, expires_at, is_active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertTask.run(
      'Watch Platform Walkthrough Video',
      'Watch the full 3-minute walkthrough on YouTube and enter the verification code shown in the video.',
      'youtube',
      '/src/assets/images/task_youtube_banner_1795540140230.jpg',
      'https://www.youtube.com/@Telegram',
      50,
      'code_verify',
      hashSecret('NOVA2026'),
      1,
      '',
      1,
      now
    );
    insertTask.run(
      'Join Official Telegram Channel',
      'Subscribe to the official community channel and submit your Telegram handle for admin verification.',
      'social',
      '',
      'https://t.me/telegram',
      40,
      'admin_approval',
      '',
      1,
      '',
      1,
      now
    );
    insertTask.run(
      'Follow X / Twitter Updates',
      'Follow our community feed and paste your profile link or handle for verification.',
      'social',
      '',
      'https://x.com/telegram',
      35,
      'admin_approval',
      '',
      1,
      '',
      1,
      now
    );
    insertTask.run(
      'Partner Ecosystem Survey',
      'Explore the partner announcement post and submit confirmation feedback.',
      'partner',
      '',
      'https://core.telegram.org/bots/webapps',
      60,
      'admin_approval',
      '',
      1,
      '',
      1,
      now
    );
  }

  // 4. Do not seed fake ad providers; admins configure real providers via Admin Panel.

  // 5. Ensure only bKash and Nagad withdrawal methods exist
  const insertMethod = db.prepare(`
    INSERT OR IGNORE INTO withdrawal_methods (name, code, networks_json, min_points, max_points, fee_percent, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertMethod.run('bKash', 'bkash', JSON.stringify(['Personal', 'Agent']), 500, 100000, 1.5, 1);
  insertMethod.run('Nagad', 'nagad', JSON.stringify(['Personal', 'Agent']), 500, 100000, 1.5, 1);

  // 6. Seed Default Mini-Games if empty
  const gameCount = (db.prepare('SELECT COUNT(*) as cnt FROM games').get() as { cnt: number }).cnt;
  if (gameCount === 0) {
    const insertGame = db.prepare(`
      INSERT INTO games (slug, game_type, title, description, icon_url, target_url, reward_min, reward_max, daily_limit, cooldown_seconds, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertGame.run(
      'spin-wheel',
      'spin_wheel',
      'Vault Spin Wheel',
      'Spin the server-verified reward compass up to 3 times daily.',
      '/src/assets/images/game_spin_wheel_1795540141322.jpg',
      '',
      5,
      30,
      3,
      20,
      1
    );
    insertGame.run(
      'prism-memory',
      'prism_memory',
      'Prism Memory Match',
      'Match all 6 geometric pairs within 45 seconds to unlock bonus points.',
      '/src/assets/images/app_brand_logo_1795540139729.jpg',
      '',
      10,
      35,
      3,
      30,
      1
    );
  }
}

export function getSettingsMap(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM app_settings').all() as { key: string; value: string }[];
  const out: Record<string, string> = {};
  for (const r of rows) {
    out[r.key] = r.value;
  }
  return out;
}

export function generateReferralCode(seedStr: string): string {
  const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
  const prefix = seedStr.replace(/[^a-zA-Z0-9]/g, '').slice(0, 4).toUpperCase() || 'NV';
  return `${prefix}${randomPart}`;
}

export function getUtcDayBounds(resetHourUtc = 0): { startIso: string; nextResetIso: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), resetHourUtc, 0, 0, 0));
  if (now.getTime() < start.getTime()) {
    start.setUTCDate(start.getUTCDate() - 1);
  }
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return {
    startIso: start.toISOString(),
    nextResetIso: next.toISOString(),
  };
}
