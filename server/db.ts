import crypto from 'node:crypto';
import pg from 'pg';
import type { PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { newDb } from 'pg-mem';
import { DEFAULT_TRANSLATIONS } from './translations-seed.ts';
import { hashSecret } from './security.ts';

const { Pool } = pg;

export type DatabaseMode = 'postgresql' | 'pg-mem-preview';

export interface SqlExecutor {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

let poolInstance: pg.Pool | null = null;
let databaseMode: DatabaseMode = 'postgresql';

function getCleanDatabaseUrl(): string {
  return (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
}

export function isUsingRealPostgres(): boolean {
  const dbUrl = getCleanDatabaseUrl();
  return /^postgres(ql)?:\/\//i.test(dbUrl);
}

export function getDatabaseMode(): DatabaseMode {
  return databaseMode;
}

export function resolvePostgresSslConfig(databaseUrl: string): PoolConfig['ssl'] {
  const envSsl = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  const pgSslMode = (process.env.PGSSLMODE || '').trim().toLowerCase();

  if (envSsl === 'false' || envSsl === '0' || pgSslMode === 'disable') {
    return false;
  }
  if (envSsl === 'true' || envSsl === '1') {
    return { rejectUnauthorized: false };
  }

  try {
    const parsed = new URL(databaseUrl);
    const sslMode = (parsed.searchParams.get('sslmode') || '').trim().toLowerCase();
    if (sslMode === 'disable') {
      return false;
    }
    if (sslMode === 'require' || sslMode === 'verify-ca' || sslMode === 'verify-full' || sslMode === 'no-verify') {
      return { rejectUnauthorized: false };
    }
    if (pgSslMode === 'require' || pgSslMode === 'verify-ca' || pgSslMode === 'verify-full') {
      return { rejectUnauthorized: false };
    }

    const host = parsed.hostname.toLowerCase();
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    // External Render/cloud hosts have FQDNs with dots (e.g. *.oregon-postgres.render.com);
    // internal Render hostnames (e.g. dpg-xxxxx-a) do not contain dots and use private networking.
    const isExternalHost = !isLoopback && host.includes('.');
    if (isExternalHost) {
      return { rejectUnauthorized: false };
    }
  } catch {
    if (process.env.NODE_ENV === 'production') {
      return { rejectUnauthorized: false };
    }
  }

  return undefined;
}

function createPoolInstance(): { pool: pg.Pool; mode: DatabaseMode } {
  const dbUrl = getCleanDatabaseUrl();
  const isProd = process.env.NODE_ENV === 'production';

  if (dbUrl) {
    if (!/^postgres(ql)?:\/\//i.test(dbUrl)) {
      throw new Error(
        'Invalid DATABASE_URL scheme. NovaVault requires a PostgreSQL connection string (postgresql:// or postgres://).'
      );
    }

    const ssl = resolvePostgresSslConfig(dbUrl);
    const pool = new Pool({
      connectionString: dbUrl,
      ssl,
      max: Math.max(2, Math.floor(Number(process.env.PG_POOL_MAX || '15'))),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected PostgreSQL pool error:', err instanceof Error ? err.message : err);
    });

    return { pool, mode: 'postgresql' };
  }

  if (isProd) {
    throw new Error(
      'DATABASE_URL environment variable is required in production. Attach a PostgreSQL database (e.g. Render PostgreSQL).'
    );
  }

  console.warn(
    'DATABASE_URL is not set; using in-memory PostgreSQL (pg-mem) for local preview. Set DATABASE_URL to connect to persistent PostgreSQL.'
  );
  const memDb = newDb({ autoCreateForeignKeyIndices: true });
  const pgAdapter = memDb.adapters.createPg();
  const MemPool = pgAdapter.Pool as unknown as new () => pg.Pool;
  return { pool: new MemPool(), mode: 'pg-mem-preview' };
}

export function getPool(): pg.Pool {
  if (!poolInstance) {
    const created = createPoolInstance();
    poolInstance = created.pool;
    databaseMode = created.mode;
  }
  return poolInstance;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: SqlExecutor
): Promise<QueryResult<T>> {
  const target = executor ?? getPool();
  return target.query<T>(text, params);
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: SqlExecutor
): Promise<T | undefined> {
  const res = await query<T>(text, params, executor);
  return res.rows[0];
}

export async function queryAll<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  executor?: SqlExecutor
): Promise<T[]> {
  const res = await query<T>(text, params, executor);
  return res.rows;
}

export async function execute(
  text: string,
  params: unknown[] = [],
  executor?: SqlExecutor
): Promise<{ rowCount: number }> {
  const res = await query(text, params, executor);
  return { rowCount: res.rowCount ?? 0 };
}

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures when connection is already broken
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closeDatabase(): Promise<void> {
  if (poolInstance) {
    const p = poolInstance;
    poolInstance = null;
    await p.end();
  }
}

export async function initDatabase(): Promise<void> {
  const pool = getPool();
  await pool.query('SELECT 1');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      proof_text TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      review_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      reviewed_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ad_providers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      sdk_zone_id TEXT NOT NULL DEFAULT '',
      placement_id TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      ad_url_template TEXT NOT NULL DEFAULT '',
      postback_secret_hash TEXT NOT NULL,
      reward_points INTEGER NOT NULL DEFAULT 10,
      payout_per_conversion_bdt DOUBLE PRECISION NOT NULL DEFAULT 0,
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
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      networks_json TEXT NOT NULL DEFAULT '[]',
      min_points INTEGER NOT NULL DEFAULT 1000,
      max_points INTEGER NOT NULL DEFAULT 100000,
      fee_percent DOUBLE PRECISION NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS withdrawals (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      method_id INTEGER NOT NULL REFERENCES withdrawal_methods(id),
      method_name TEXT NOT NULL,
      network TEXT NOT NULL,
      account_address TEXT NOT NULL,
      points_amount INTEGER NOT NULL,
      usdt_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_usdt DOUBLE PRECISION NOT NULL DEFAULT 0,
      net_usdt DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_points DOUBLE PRECISION NOT NULL DEFAULT 0,
      net_points DOUBLE PRECISION NOT NULL DEFAULT 0,
      bdt_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      fee_bdt DOUBLE PRECISION NOT NULL DEFAULT 0,
      net_bdt DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      admin_note TEXT NOT NULL DEFAULT '',
      tx_hash TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS games (
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      score INTEGER NOT NULL DEFAULT 0,
      reward_points INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      amount_points INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      description TEXT NOT NULL,
      reference_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_credentials (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      admin_actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
  `);

  await runMigrations();
  await seedInitialData();
}

async function hasColumn(table: string, col: string): Promise<boolean> {
  const rows = await queryAll<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  return rows.some((r) => r.column_name === col);
}

async function runMigrations(): Promise<void> {
  await execute("ALTER TABLE ad_providers ADD COLUMN IF NOT EXISTS api_key TEXT NOT NULL DEFAULT ''");
  await execute("ALTER TABLE ad_providers ADD COLUMN IF NOT EXISTS placement_id TEXT NOT NULL DEFAULT ''");
  await execute(
    'ALTER TABLE ad_providers ADD COLUMN IF NOT EXISTS payout_per_conversion_bdt DOUBLE PRECISION NOT NULL DEFAULT 0'
  );
  await execute("ALTER TABLE ad_sessions ADD COLUMN IF NOT EXISTS provider_tx_id TEXT NOT NULL DEFAULT ''");

  await execute(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_ad_sessions_provider_tx_id ON ad_sessions(provider_id, provider_tx_id) WHERE provider_tx_id != ''"
  );

  if (!(await hasColumn('games', 'game_type'))) {
    await execute("ALTER TABLE games ADD COLUMN IF NOT EXISTS game_type TEXT NOT NULL DEFAULT 'spin_wheel'");
    await execute("UPDATE games SET game_type = 'prism_memory' WHERE slug = 'prism-memory'");
  }
  await execute("ALTER TABLE games ADD COLUMN IF NOT EXISTS target_url TEXT NOT NULL DEFAULT ''");

  await execute('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_points DOUBLE PRECISION NOT NULL DEFAULT 0');
  await execute('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS net_points DOUBLE PRECISION NOT NULL DEFAULT 0');
  await execute('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS bdt_amount DOUBLE PRECISION NOT NULL DEFAULT 0');
  await execute('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS fee_bdt DOUBLE PRECISION NOT NULL DEFAULT 0');
  await execute('ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS net_bdt DOUBLE PRECISION NOT NULL DEFAULT 0');

  await execute(
    `UPDATE withdrawals
     SET bdt_amount = CASE WHEN bdt_amount = 0 THEN (points_amount / 10.0) ELSE bdt_amount END,
         net_points = CASE WHEN net_points = 0 THEN points_amount ELSE net_points END,
         net_bdt = CASE WHEN net_bdt = 0 THEN (points_amount / 10.0) ELSE net_bdt END
     WHERE bdt_amount = 0 OR net_points = 0 OR net_bdt = 0`
  );

  // Remove USDT withdrawal option completely; keep only bKash & Nagad active
  await execute(
    "DELETE FROM withdrawal_methods WHERE LOWER(code) = 'usdt' AND id NOT IN (SELECT DISTINCT method_id FROM withdrawals)"
  );
  await execute("UPDATE withdrawal_methods SET is_active = 0 WHERE LOWER(code) = 'usdt'");
  await execute(
    "DELETE FROM app_settings WHERE key IN ('exchangeRatePointsPerUsdt', 'minWithdrawalUsdt', 'maxWithdrawalUsdt')"
  );

  await execute(
    "UPDATE translations SET value = 'bKash / Nagad Account Number' WHERE lang_code = 'en' AND key = 'account.address_label' AND value = 'Wallet Address or Account Number'"
  );
  await execute(
    "UPDATE translations SET value = 'বিকাশ / নগদ অ্যাকাউন্ট নম্বর' WHERE lang_code = 'bn' AND key = 'account.address_label' AND value = 'ওয়ালেট ঠিকানা বা অ্যাকাউন্ট নম্বর'"
  );
  await execute(
    "UPDATE translations SET value = 'Account Type' WHERE lang_code = 'en' AND key = 'account.select_network' AND value = 'Network / Type'"
  );
  await execute(
    "UPDATE translations SET value = 'অ্যাকাউন্টের ধরন' WHERE lang_code = 'bn' AND key = 'account.select_network' AND value = 'নেটওয়ার্ক / ধরন'"
  );

  // Deactivate unconfigured placeholder demo ad URL so fake ads are never shown
  await execute(
    "UPDATE ad_providers SET is_active = 0 WHERE ad_url_template LIKE '%core.telegram.org/bots/webapps#implementing-mini-apps%'"
  );
}

async function seedInitialData(): Promise<void> {
  const now = new Date().toISOString();

  await withTransaction(async (client) => {
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
      termsText:
        'Rewards are granted only for verified activity. Automated bots, multi-accounting, or self-referrals result in immediate suspension.',
      privacyText:
        'We store your Telegram ID, username, and ledger records strictly to operate rewards and process requested payouts.',
    };

    const settingEntries = Object.entries(defaultSettings);
    if (settingEntries.length > 0) {
      const placeholders: string[] = [];
      const values: unknown[] = [];
      settingEntries.forEach(([k, v], idx) => {
        const base = idx * 2;
        placeholders.push(`($${base + 1}, $${base + 2})`);
        values.push(k, v);
      });
      await client.query(
        `INSERT INTO app_settings (key, value) VALUES ${placeholders.join(', ')} ON CONFLICT (key) DO NOTHING`,
        values
      );
    }

    // 2. Languages & Translations
    await client.query(
      `INSERT INTO languages (code, name, native_name, is_enabled)
       VALUES ($1, $2, $3, $4), ($5, $6, $7, $8)
       ON CONFLICT (code) DO NOTHING`,
      ['en', 'English', 'English', 1, 'bn', 'Bengali', 'বাংলা', 1]
    );

    const txTuples: Array<[string, string, string, string]> = [];
    for (const item of DEFAULT_TRANSLATIONS) {
      txTuples.push(['en', item.key, item.en, item.category]);
      txTuples.push(['bn', item.key, item.bn, item.category]);
    }
    const chunkSize = 80;
    for (let i = 0; i < txTuples.length; i += chunkSize) {
      const slice = txTuples.slice(i, i + chunkSize);
      const placeholders: string[] = [];
      const values: unknown[] = [];
      slice.forEach(([langCode, key, val, category], idx) => {
        const base = idx * 4;
        placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
        values.push(langCode, key, val, category);
      });
      await client.query(
        `INSERT INTO translations (lang_code, key, value, category)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (lang_code, key) DO NOTHING`,
        values
      );
    }

    // 3. Seed Default Tasks if empty
    const taskCountRes = await client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM tasks');
    const taskCount = taskCountRes.rows[0]?.cnt ?? 0;
    if (taskCount === 0) {
      const insertTaskSql = `
        INSERT INTO tasks (title, description, category, icon_url, target_url, reward_points, verification_type, secret_code_hash, daily_limit, expires_at, is_active, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `;
      await client.query(insertTaskSql, [
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
        now,
      ]);
      await client.query(insertTaskSql, [
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
        now,
      ]);
      await client.query(insertTaskSql, [
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
        now,
      ]);
      await client.query(insertTaskSql, [
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
        now,
      ]);
    }

    // 4. Do not seed fake ad providers; admins configure real providers via Admin Panel.

    // 5. Ensure only bKash and Nagad withdrawal methods exist
    const insertMethodSql = `
      INSERT INTO withdrawal_methods (name, code, networks_json, min_points, max_points, fee_percent, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (code) DO NOTHING
    `;
    await client.query(insertMethodSql, ['bKash', 'bkash', JSON.stringify(['Personal', 'Agent']), 500, 100000, 1.5, 1]);
    await client.query(insertMethodSql, ['Nagad', 'nagad', JSON.stringify(['Personal', 'Agent']), 500, 100000, 1.5, 1]);

    // 6. Seed Default Mini-Games if empty
    const gameCountRes = await client.query<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM games');
    const gameCount = gameCountRes.rows[0]?.cnt ?? 0;
    if (gameCount === 0) {
      const insertGameSql = `
        INSERT INTO games (slug, game_type, title, description, icon_url, target_url, reward_min, reward_max, daily_limit, cooldown_seconds, is_active)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `;
      await client.query(insertGameSql, [
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
        1,
      ]);
      await client.query(insertGameSql, [
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
        1,
      ]);
    }
  });
}

export async function getSettingsMap(executor?: SqlExecutor): Promise<Record<string, string>> {
  const rows = await queryAll<{ key: string; value: string }>('SELECT key, value FROM app_settings', [], executor);
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
