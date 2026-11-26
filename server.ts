import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import { db, generateReferralCode, getSettingsMap, getUtcDayBounds, initDatabase } from './server/db.ts';
import { creditUserPointsAtomic, getUserDailyEarnedPoints } from './server/rewards.ts';
import {
  hashPassword,
  hashSecret,
  sanitizeExternalUrl,
  signSessionToken,
  verifyPassword,
  verifySecret,
  verifySessionToken,
  verifyTelegramInitData,
} from './server/security.ts';
import {
  clearTelegramWebhook,
  configureTelegramBotMenuAndCommands,
  getBotToken,
  getTelegramBotRuntimeState,
  getTelegramWebAppUrl,
  initTelegramBot,
  isDisallowedAuthProxyUrl,
  isTelegramPollingEnabled,
  notifyTelegramAdmins,
  notifyTelegramUser,
  processTelegramUpdate,
  startTelegramBotPollingIfEnabled,
  verifyPublicUrlAccessibility,
} from './server/telegram-bot.ts';
import { buildCleanProjectZipBuffer } from './server/zip-export.ts';

initDatabase();
void initTelegramBot();

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

interface AuthedRequest extends Request {
  userId?: number;
  adminEmail?: string;
}

function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.slice(7).trim();
}

function requireUserAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = getBearerToken(req);
  const session = verifySessionToken(token);
  if (!session || session.role !== 'user') {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const userId = Number(session.sub);
  const user = db.prepare('SELECT id, is_blocked FROM users WHERE id = ?').get(userId) as
    | { id: number; is_blocked: number }
    | undefined;
  if (!user) {
    res.status(401).json({ error: 'User account not found' });
    return;
  }
  if (user.is_blocked === 1) {
    res.status(403).json({ error: 'Account restricted by administrator' });
    return;
  }
  db.prepare('UPDATE users SET is_online = 1, last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), userId);
  req.userId = userId;
  next();
}

function requireAdminAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const token = getBearerToken(req);
  const session = verifySessionToken(token);
  if (!session || session.role !== 'admin') {
    res.status(401).json({ error: 'Administrator authentication required' });
    return;
  }
  req.adminEmail = session.sub;
  next();
}

function logAdminAudit(adminActor: string, action: string, targetType: string, targetId: string | number | bigint, details: unknown): void {
  db.prepare(
    `INSERT INTO audit_logs (admin_actor, action, target_type, target_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(adminActor, action, targetType, String(targetId), JSON.stringify(details ?? {}), new Date().toISOString());
}

function sanitizeAssetOrExternalUrl(raw: string): string {
  const val = raw.trim();
  if (!val) return '';
  if (val.startsWith('/src/assets/')) return val;
  return sanitizeExternalUrl(val);
}

// ==========================================
// 1. PUBLIC & TELEGRAM AUTH ROUTES
// ==========================================

app.get('/api/health', (_req, res) => {
  const rt = getTelegramBotRuntimeState();
  res.json({
    ok: true,
    timestamp: new Date().toISOString(),
    telegram: {
      botConfigured: Boolean(getBotToken()),
      pollingEnabled: isTelegramPollingEnabled(),
      pollingActive: rt.pollingActive,
      botConnected: Boolean(rt.connectedBotUsername),
      publicUrlConfigured: Boolean(getTelegramWebAppUrl()),
      menuConfigured: rt.menuConfigured,
      commandsConfigured: rt.commandsConfigured,
      lastError: rt.lastError || null,
    },
  });
});

app.get('/api/public/config', (_req, res) => {
  const settings = getSettingsMap();
  res.json({
    appName: settings.appName || 'NovaVault',
    logoUrl: settings.logoUrl || '/src/assets/images/app_brand_logo_1795540139729.jpg',
    botUsername: (settings.botUsername || '').replace(/^@/, ''),
  });
});

app.post('/api/auth/telegram', (req, res) => {
  const { initData } = req.body as { initData?: string };
  const botToken = getBotToken();
  if (!botToken) {
    res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN is not configured on the server yet' });
    return;
  }
  if (!initData || typeof initData !== 'string') {
    res.status(400).json({ error: 'Missing Telegram initData' });
    return;
  }

  const verified = verifyTelegramInitData(initData, botToken);
  if (!verified) {
    res.status(401).json({ error: 'Invalid or expired Telegram initData signature' });
    return;
  }

  const settings = getSettingsMap();
  const now = new Date().toISOString();
  const tgId = String(verified.user.id);
  const username = verified.user.username || `tg_${tgId.slice(-6)}`;
  const startRef = verified.startParam?.startsWith('ref_')
    ? verified.startParam.slice(4)
    : verified.startParam || '';

  try {
    const user = db.transaction(() => {
      let existing = db.prepare('SELECT id, is_blocked, telegram_id FROM users WHERE telegram_id = ?').get(tgId) as
        | { id: number; is_blocked: number; telegram_id: string }
        | undefined;

      if (!existing) {
        if (settings.registrationEnabled === 'false') {
          throw new Error('REG_PAUSED');
        }

        let referredById: number | null = null;
        if (startRef) {
          const referrer = db
            .prepare('SELECT id, telegram_id FROM users WHERE referral_code = ?')
            .get(startRef) as { id: number; telegram_id: string } | undefined;
          if (referrer && referrer.telegram_id !== tgId) {
            referredById = referrer.id;
          }
        }

        let myCode = generateReferralCode(username);
        for (let i = 0; i < 5; i++) {
          const clash = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(myCode);
          if (!clash) break;
          myCode = generateReferralCode(`${username}${i}`);
        }

        db.prepare(
          `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, is_online, last_seen_at, referral_code, referred_by_user_id, is_preview, language, created_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)`
        ).run(
          tgId,
          username,
          verified.user.first_name || '',
          verified.user.last_name || '',
          sanitizeExternalUrl(verified.user.photo_url),
          now,
          myCode,
          referredById,
          verified.user.language_code === 'bn' ? 'bn' : settings.defaultLanguage || 'en',
          now
        );

        existing = db.prepare('SELECT id, is_blocked, telegram_id FROM users WHERE telegram_id = ?').get(tgId) as {
          id: number;
          is_blocked: number;
          telegram_id: string;
        };
      } else {
        db.prepare(
          `UPDATE users SET username = ?, first_name = ?, last_name = ?, photo_url = ?, is_online = 1, last_seen_at = ?, is_preview = 0 WHERE id = ?`
        ).run(
          username,
          verified.user.first_name || '',
          verified.user.last_name || '',
          sanitizeExternalUrl(verified.user.photo_url),
          now,
          existing.id
        );
      }

      return existing;
    })();

    if (user.is_blocked === 1) {
      res.status(403).json({ error: 'Account restricted by administrator' });
      return;
    }

    const token = signSessionToken({ sub: String(user.id), role: 'user', telegramId: user.telegram_id });
    res.json({ token, mode: 'telegram' });
  } catch (err) {
    if (err instanceof Error && err.message === 'REG_PAUSED') {
      res.status(403).json({ error: 'New registrations are currently paused' });
      return;
    }
    res.status(500).json({ error: 'Unable to authenticate Telegram user' });
  }
});

// ==========================================
// 2. USER MINI APP API ROUTES
// ==========================================

app.get('/api/bootstrap', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const settings = getSettingsMap();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;

  const languages = db
    .prepare('SELECT code, name, native_name, is_enabled FROM languages WHERE is_enabled = 1')
    .all() as { code: string; name: string; native_name: string; is_enabled: number }[];

  const activeLang =
    typeof req.query.lang === 'string' && languages.some((l) => l.code === req.query.lang)
      ? req.query.lang
      : (user.language as string) || settings.defaultLanguage || 'en';

  const txRows = db
    .prepare('SELECT key, value FROM translations WHERE lang_code = ?')
    .all(activeLang) as { key: string; value: string }[];
  const enRows = db
    .prepare("SELECT key, value FROM translations WHERE lang_code = 'en'")
    .all() as { key: string; value: string }[];

  const i18n: Record<string, string> = {};
  for (const r of enRows) i18n[r.key] = r.value;
  for (const r of txRows) i18n[r.key] = r.value;

  const { startIso: utcDayStart, nextResetIso: defaultNextReset } = getUtcDayBounds(0);
  const checkinClaimedToday = Boolean(
    db
      .prepare("SELECT id FROM transactions WHERE user_id = ? AND type = 'daily_checkin' AND created_at >= ?")
      .get(userId, utcDayStart)
  );

  // Tasks with user submission status
  const nowIso = new Date().toISOString();
  const tasks =
    settings.tasksEnabled === 'false'
      ? []
      : (db
          .prepare(
            `SELECT id, title, description, category, icon_url, target_url, reward_points, verification_type, daily_limit, expires_at, is_active
             FROM tasks
             WHERE is_active = 1 AND (expires_at = '' OR expires_at > ?)
             ORDER BY id DESC`
          )
          .all(nowIso) as Array<{
    id: number;
    title: string;
    description: string;
    category: string;
    icon_url: string;
    target_url: string;
    reward_points: number;
    verification_type: string;
    daily_limit: number;
    expires_at: string;
  }>);

  const userSubmissions = db
    .prepare('SELECT task_id, status, review_note, created_at FROM task_submissions WHERE user_id = ? ORDER BY id DESC')
    .all(userId) as Array<{ task_id: number; status: string; review_note: string; created_at: string }>;

  const tasksWithStatus = tasks.map((t) => {
    const subs = userSubmissions.filter((s) => s.task_id === t.id);
    const todaySubs = subs.filter((s) => s.created_at >= utcDayStart);
    const latest = subs[0] || null;
    return {
      ...t,
      todayCount: todaySubs.length,
      latestStatus: latest ? latest.status : null,
      reviewNote: latest ? latest.review_note : '',
    };
  });

  // Ad Providers & Daily Ad Slots
  const providers = db
    .prepare(
      `SELECT id, name, provider_type, sdk_zone_id, ad_url_template, reward_points, daily_limit, reset_hour_utc, is_active
       FROM ad_providers WHERE is_active = 1 ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    name: string;
    provider_type: string;
    sdk_zone_id: string;
    ad_url_template: string;
    reward_points: number;
    daily_limit: number;
    reset_hour_utc: number;
  }>;

  const primaryProvider = settings.adsEnabled === 'false' ? null : providers[0] || null;
  let adProgram = null;
  if (primaryProvider) {
    const { startIso: adStartIso, nextResetIso: adNextReset } = getUtcDayBounds(primaryProvider.reset_hour_utc);
    const todaySessions = db
      .prepare('SELECT * FROM ad_sessions WHERE user_id = ? AND provider_id = ? AND created_at >= ? ORDER BY slot_number ASC')
      .all(userId, primaryProvider.id, adStartIso) as Array<{
      id: string;
      slot_number: number;
      status: string;
      reward_points: number;
      created_at: string;
      verified_at: string;
    }>;

    const verifiedToday = todaySessions.filter((s) => s.status === 'verified');
    const earnedAdsToday = verifiedToday.reduce((acc, s) => acc + s.reward_points, 0);
    const maxAdEarn = Number(settings.dailyMaxAdEarnings || '200');

    const slots = Array.from({ length: primaryProvider.daily_limit }, (_, idx) => {
      const slotNum = idx + 1;
      const existing = todaySessions.find((s) => s.slot_number === slotNum);
      return {
        slotNumber: slotNum,
        rewardPoints: primaryProvider.reward_points,
        status: existing ? existing.status : 'available',
        sessionId: existing ? existing.id : null,
      };
    });

    adProgram = {
      providerId: primaryProvider.id,
      providerName: primaryProvider.name,
      providerType: primaryProvider.provider_type,
      rewardPoints: primaryProvider.reward_points,
      dailyLimit: primaryProvider.daily_limit,
      completedToday: verifiedToday.length,
      remainingToday: Math.max(0, primaryProvider.daily_limit - verifiedToday.length),
      earnedToday: earnedAdsToday,
      dailyMaxAdEarnings: maxAdEarn,
      nextResetIso: adNextReset,
      slots,
    };
  }

  // Daily total earned across capped user earning sources
  const earnedTodayTotal = getUserDailyEarnedPoints(userId);
  const dailyMaxEarnings = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));

  // Games
  const games =
    settings.gamesEnabled === 'false'
      ? []
      : (db.prepare('SELECT * FROM games WHERE is_active = 1 ORDER BY id ASC').all() as Array<{
    id: number;
    slug: string;
    game_type: string;
    title: string;
    description: string;
    icon_url: string;
    target_url: string;
    reward_min: number;
    reward_max: number;
    daily_limit: number;
    cooldown_seconds: number;
  }>);

  const gamesWithQuota = games.map((g) => {
    const playsToday = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM game_plays WHERE user_id = ? AND game_id = ? AND created_at >= ?')
        .get(userId, g.id, utcDayStart) as { cnt: number }
    ).cnt;
    const lastPlay = db
      .prepare('SELECT created_at FROM game_plays WHERE user_id = ? AND game_id = ? ORDER BY id DESC LIMIT 1')
      .get(userId, g.id) as { created_at: string } | undefined;

    let cooldownRemaining = 0;
    if (lastPlay) {
      const elapsed = (Date.now() - new Date(lastPlay.created_at).getTime()) / 1000;
      if (elapsed < g.cooldown_seconds) {
        cooldownRemaining = Math.ceil(g.cooldown_seconds - elapsed);
      }
    }

    return {
      ...g,
      playsToday,
      playsLeft: Math.max(0, g.daily_limit - playsToday),
      cooldownRemaining,
    };
  });

  // Withdrawal methods & user history
  const withdrawalMethods = db
    .prepare(
      "SELECT id, name, code, networks_json, min_points, max_points, fee_percent FROM withdrawal_methods WHERE is_active = 1 AND LOWER(code) IN ('bkash', 'nagad')"
    )
    .all() as Array<{
    id: number;
    name: string;
    code: string;
    networks_json: string;
    min_points: number;
    max_points: number;
    fee_percent: number;
  }>;

  const withdrawals = db
    .prepare(
      `SELECT id, user_id, method_id, method_name, network, account_address, points_amount,
              fee_points, net_points, bdt_amount, fee_bdt, net_bdt, status, admin_note, tx_hash, created_at, updated_at
       FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 30`
    )
    .all(userId);

  const transactions = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(userId);

  // Referrals
  const referrals = db
    .prepare(
      `SELECT id, username, first_name, referral_qualified, created_at
       FROM users WHERE referred_by_user_id = ? ORDER BY id DESC LIMIT 50`
    )
    .all(userId);

  res.json({
    settings,
    user: {
      id: user.id,
      telegramId: user.telegram_id,
      username: user.username,
      firstName: user.first_name,
      lastName: user.last_name,
      photoUrl: user.photo_url,
      isOnline: Boolean(user.is_online),
      pointsBalance: user.points_balance,
      pendingBalance: user.pending_balance,
      totalEarned: user.total_earned,
      totalWithdrawn: user.total_withdrawn,
      referralCode: user.referral_code,
      referralEarnings: user.referral_earnings,
      isPreview: Boolean(user.is_preview),
      language: activeLang,
    },
    languages,
    i18n,
    dailyStats: {
      earnedToday: earnedTodayTotal,
      dailyMaxEarnings,
      checkinClaimedToday,
      nextResetIso: defaultNextReset,
    },
    adProgram,
    tasks: tasksWithStatus,
    games: gamesWithQuota,
    withdrawalMethods: withdrawalMethods.map((m) => ({
      ...m,
      networks: JSON.parse(m.networks_json || '[]') as string[],
    })),
    withdrawals,
    transactions,
    referrals,
  });
});

app.post('/api/user/language', requireUserAuth, (req: AuthedRequest, res) => {
  const { language } = req.body as { language?: string };
  if (!language) {
    res.status(400).json({ error: 'Language code required' });
    return;
  }
  const lang = db.prepare('SELECT code FROM languages WHERE code = ? AND is_enabled = 1').get(language);
  if (!lang) {
    res.status(404).json({ error: 'Language not available' });
    return;
  }
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, req.userId!);
  res.json({ ok: true, language });
});

app.post('/api/checkin', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true') {
    res.status(503).json({ error: 'Maintenance mode active' });
    return;
  }
  if (settings.checkinEnabled === 'false') {
    res.status(403).json({ error: 'Daily check-in is temporarily paused by admin' });
    return;
  }
  const { startIso } = getUtcDayBounds(0);
  const existing = db
    .prepare("SELECT id FROM transactions WHERE user_id = ? AND type = 'daily_checkin' AND created_at >= ?")
    .get(userId, startIso);
  if (existing) {
    res.status(409).json({ error: 'Daily check-in already claimed today' });
    return;
  }
  const reward = Math.max(1, Math.floor(Number(settings.dailyCheckinReward || '25')));
  try {
    const balance = creditUserPointsAtomic({
      userId,
      points: reward,
      txType: 'daily_checkin',
      description: 'Daily loyalty check-in reward',
      referenceId: `checkin_${startIso.slice(0, 10)}_${userId}`,
    });
    res.json({ ok: true, reward, balance });
  } catch (err) {
    res.status(429).json({ error: err instanceof Error ? err.message : 'Daily earning limit reached' });
  }
});

// ==========================================
// 3. TASKS & VERIFICATION ROUTES
// ==========================================

app.post('/api/tasks/:id/submit', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const taskId = Number(req.params.id);
  const { proofText, secretCode } = req.body as { proofText?: string; secretCode?: string };
  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true') {
    res.status(503).json({ error: 'Maintenance mode active' });
    return;
  }
  if (settings.tasksEnabled === 'false') {
    res.status(403).json({ error: 'Tasks are temporarily paused by admin' });
    return;
  }

  const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND is_active = 1').get(taskId) as
    | {
        id: number;
        title: string;
        reward_points: number;
        verification_type: string;
        secret_code_hash: string;
        daily_limit: number;
        expires_at: string;
      }
    | undefined;

  if (!task) {
    res.status(404).json({ error: 'Task not found or inactive' });
    return;
  }
  if (task.expires_at && task.expires_at < new Date().toISOString()) {
    res.status(410).json({ error: 'Task has expired' });
    return;
  }

  const { startIso } = getUtcDayBounds(0);
  const todayCount = (
    db
      .prepare(
        "SELECT COUNT(*) as cnt FROM task_submissions WHERE user_id = ? AND task_id = ? AND status IN ('pending', 'approved') AND created_at >= ?"
      )
      .get(userId, taskId, startIso) as { cnt: number }
  ).cnt;

  if (todayCount >= task.daily_limit) {
    res.status(409).json({ error: 'Daily submission limit reached for this task' });
    return;
  }

  const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
  if (maxDaily > 0 && getUserDailyEarnedPoints(userId) + task.reward_points > maxDaily) {
    res.status(429).json({ error: `Daily earning limit of ${maxDaily} PTS reached. Try again after reset.` });
    return;
  }

  const now = new Date().toISOString();

  if (task.verification_type === 'code_verify') {
    if (!secretCode || typeof secretCode !== 'string' || !task.secret_code_hash) {
      res.status(400).json({ error: 'Verification code is required' });
      return;
    }
    if (!verifySecret(secretCode, task.secret_code_hash)) {
      res.status(400).json({ error: 'Verification code did not match' });
      return;
    }

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO task_submissions (user_id, task_id, proof_text, status, review_note, created_at, reviewed_at)
         VALUES (?, ?, 'Verified via secret code', 'approved', 'Auto-verified by server', ?, ?)`
      ).run(userId, taskId, now, now);

      return creditUserPointsAtomic({
        userId,
        points: task.reward_points,
        txType: 'task_reward',
        description: `Task completed: ${task.title}`,
        referenceId: `task_${taskId}_${Date.now()}`,
      });
    });

    try {
      const balance = tx();
      res.json({ ok: true, status: 'approved', reward: task.reward_points, balance });
    } catch (err) {
      res.status(429).json({ error: err instanceof Error ? err.message : 'Daily earning limit reached' });
    }
    return;
  }

  // admin_approval or partner verification
  const cleanProof = (proofText || '').trim().slice(0, 300);
  if (!cleanProof) {
    res.status(400).json({ error: 'Please provide proof details before submitting' });
    return;
  }

  db.prepare(
    `INSERT INTO task_submissions (user_id, task_id, proof_text, status, created_at)
     VALUES (?, ?, ?, 'pending', ?)`
  ).run(userId, taskId, cleanProof, now);

  res.json({ ok: true, status: 'pending' });
});

// ==========================================
// 4. ADVERTISEMENT SESSION & S2S POSTBACK
// ==========================================

app.post('/api/ads/start', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { providerId, slotNumber } = req.body as { providerId?: number; slotNumber?: number };
  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true') {
    res.status(503).json({ error: 'Maintenance mode active' });
    return;
  }
  if (settings.adsEnabled === 'false') {
    res.status(403).json({ error: 'Advertisements are temporarily paused by admin' });
    return;
  }

  const provider = db.prepare('SELECT * FROM ad_providers WHERE id = ? AND is_active = 1').get(Number(providerId)) as
    | {
        id: number;
        name: string;
        ad_url_template: string;
        reward_points: number;
        daily_limit: number;
        reset_hour_utc: number;
      }
    | undefined;

  if (!provider) {
    res.status(404).json({ error: 'Ad provider not active' });
    return;
  }

  const slot = Number(slotNumber);
  if (!Number.isInteger(slot) || slot < 1 || slot > provider.daily_limit) {
    res.status(400).json({ error: 'Invalid advertisement slot' });
    return;
  }

  const { startIso } = getUtcDayBounds(provider.reset_hour_utc);
  const verifiedToday = db
    .prepare("SELECT COALESCE(SUM(reward_points), 0) as pts, COUNT(*) as cnt FROM ad_sessions WHERE user_id = ? AND provider_id = ? AND status = 'verified' AND created_at >= ?")
    .get(userId, provider.id, startIso) as { pts: number; cnt: number };

  const maxAdEarn = Number(settings.dailyMaxAdEarnings || '200');
  const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
  if (verifiedToday.cnt >= provider.daily_limit || verifiedToday.pts >= maxAdEarn) {
    res.status(429).json({ error: 'Daily advertisement reward limit reached' });
    return;
  }
  if (maxDaily > 0 && getUserDailyEarnedPoints(userId) + provider.reward_points > maxDaily) {
    res.status(429).json({ error: `Daily earning limit of ${maxDaily} PTS reached` });
    return;
  }

  // Return existing pending session for same slot if already opened today
  const existing = db
    .prepare('SELECT * FROM ad_sessions WHERE user_id = ? AND provider_id = ? AND slot_number = ? AND created_at >= ?')
    .get(userId, provider.id, slot, startIso) as { id: string; status: string } | undefined;

  let sessionId: string;
  if (existing) {
    if (existing.status === 'verified') {
      res.status(409).json({ error: 'This daily ad slot is already completed' });
      return;
    }
    sessionId = existing.id;
  } else {
    sessionId = `ad_${crypto.randomBytes(10).toString('hex')}`;
    db.prepare(
      `INSERT INTO ad_sessions (id, user_id, provider_id, slot_number, status, reward_points, ip_address, created_at)
       VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?)`
    ).run(sessionId, userId, provider.id, slot, provider.reward_points, req.ip || '', new Date().toISOString());
  }

  const adUrl = sanitizeExternalUrl(
    provider.ad_url_template
      .replace('{click_id}', encodeURIComponent(sessionId))
      .replace('{user_id}', encodeURIComponent(String(userId)))
  );

  res.json({
    ok: true,
    sessionId,
    adUrl,
    status: 'initiated',
  });
});

function recordAdPostback(params: {
  providerId?: number | null;
  sessionId?: string;
  txId?: string;
  status: string;
  errorMessage?: string;
  rawReward?: string;
  ip?: string;
}): void {
  try {
    db.prepare(
      `INSERT INTO ad_postbacks (provider_id, session_id, provider_tx_id, status, error_message, raw_reward, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      params.providerId ?? null,
      (params.sessionId || '').slice(0, 120),
      (params.txId || '').slice(0, 120),
      params.status,
      (params.errorMessage || '').slice(0, 250),
      (params.rawReward || '').slice(0, 60),
      (params.ip || '').slice(0, 80),
      new Date().toISOString()
    );
  } catch {
    // Postback audit logging must not break response flow
  }
}

function handleAdPostback(req: Request, res: Response): void {
  const clickId = String(req.query.click_id || req.query.subid || req.body?.click_id || req.body?.subid || '').trim();
  const token = String(
    req.query.token || req.query.verify_token || req.query.secret || req.body?.token || req.body?.verify_token || req.body?.secret || ''
  ).trim();
  const txId = String(
    req.query.tx_id || req.query.transaction_id || req.query.event_id || req.body?.tx_id || req.body?.transaction_id || ''
  )
    .trim()
    .slice(0, 120);
  const rawReward = req.query.reward ?? req.body?.reward;
  const rawRewardStr = rawReward !== undefined && rawReward !== null ? String(rawReward) : '';
  const ip = req.ip || '';

  if (!clickId || !token) {
    recordAdPostback({
      sessionId: clickId,
      txId,
      status: 'missing_params',
      errorMessage: 'Missing click_id or token',
      rawReward: rawRewardStr,
      ip,
    });
    res.status(400).json({ error: 'Missing click_id or token' });
    return;
  }

  const session = db.prepare('SELECT * FROM ad_sessions WHERE id = ?').get(clickId) as
    | { id: string; user_id: number; provider_id: number; slot_number: number; status: string; reward_points: number }
    | undefined;

  if (!session) {
    recordAdPostback({
      sessionId: clickId,
      txId,
      status: 'session_not_found',
      errorMessage: 'Ad session not found',
      rawReward: rawRewardStr,
      ip,
    });
    res.status(404).json({ error: 'Ad session not found' });
    return;
  }

  const provider = db.prepare('SELECT * FROM ad_providers WHERE id = ?').get(session.provider_id) as
    | { id: number; name: string; postback_secret_hash: string; daily_limit: number; reset_hour_utc: number }
    | undefined;

  if (!provider || !verifySecret(token, provider.postback_secret_hash)) {
    recordAdPostback({
      providerId: session.provider_id,
      sessionId: clickId,
      txId,
      status: 'invalid_token',
      errorMessage: 'Invalid postback signature token',
      rawReward: rawRewardStr,
      ip,
    });
    res.status(403).json({ error: 'Invalid postback signature token' });
    return;
  }

  if (rawReward !== undefined && rawReward !== '') {
    const parsedReward = Number(rawReward);
    if (!Number.isFinite(parsedReward) || parsedReward <= 0 || parsedReward > session.reward_points) {
      recordAdPostback({
        providerId: provider.id,
        sessionId: clickId,
        txId,
        status: 'invalid_reward',
        errorMessage: 'Invalid postback reward amount',
        rawReward: rawRewardStr,
        ip,
      });
      res.status(400).json({ error: 'Invalid postback reward amount' });
      return;
    }
  }

  if (session.status === 'verified') {
    recordAdPostback({
      providerId: provider.id,
      sessionId: clickId,
      txId,
      status: 'already_verified',
      errorMessage: 'Session already verified',
      rawReward: rawRewardStr,
      ip,
    });
    res.json({ ok: true, alreadyVerified: true });
    return;
  }

  const settings = getSettingsMap();
  const maxAdEarn = Number(settings.dailyMaxAdEarnings || '200');
  const { startIso } = getUtcDayBounds(provider.reset_hour_utc);

  const tx = db.transaction(() => {
    if (txId) {
      const dupTx = db
        .prepare('SELECT id FROM ad_sessions WHERE provider_id = ? AND provider_tx_id = ?')
        .get(provider.id, txId) as { id: string } | undefined;
      if (dupTx) {
        return { duplicateTx: true, balance: null };
      }
    }

    const stats = db
      .prepare("SELECT COALESCE(SUM(reward_points), 0) as pts, COUNT(*) as cnt FROM ad_sessions WHERE user_id = ? AND provider_id = ? AND status = 'verified' AND created_at >= ?")
      .get(session.user_id, provider.id, startIso) as { pts: number; cnt: number };

    if (stats.cnt >= provider.daily_limit || stats.pts + session.reward_points > maxAdEarn) {
      throw new Error('Daily ad earning cap reached');
    }

    const updated = db
      .prepare("UPDATE ad_sessions SET status = 'verified', provider_tx_id = ?, verified_at = ? WHERE id = ? AND status = 'initiated'")
      .run(txId, new Date().toISOString(), session.id);

    if (updated.changes === 0) {
      return { duplicateTx: false, balance: null };
    }

    const balance = creditUserPointsAtomic({
      userId: session.user_id,
      points: session.reward_points,
      txType: 'ad_reward',
      description: `Verified ad view #${session.slot_number} (${provider.name})`,
      referenceId: txId || session.id,
    });
    return { duplicateTx: false, balance };
  });

  try {
    const outcome = tx();
    if (outcome.duplicateTx) {
      recordAdPostback({
        providerId: provider.id,
        sessionId: clickId,
        txId,
        status: 'duplicate_tx',
        errorMessage: 'Duplicate provider transaction ID',
        rawReward: rawRewardStr,
        ip,
      });
      res.status(409).json({ error: 'Duplicate provider transaction ID' });
      return;
    }
    recordAdPostback({
      providerId: provider.id,
      sessionId: clickId,
      txId,
      status: 'verified',
      rawReward: rawRewardStr || String(session.reward_points),
      ip,
    });
    const userRow = db.prepare('SELECT telegram_id FROM users WHERE id = ?').get(session.user_id) as
      | { telegram_id: string }
      | undefined;
    if (userRow && outcome.balance !== null) {
      void notifyTelegramUser(
        userRow.telegram_id,
        `<b>Ad Reward Credited!</b>\n+${session.reward_points} PTS verified from ${provider.name}.\nAvailable Balance: <b>${outcome.balance} PTS</b>`
      );
    }
    res.json({ ok: true, balance: outcome.balance });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed';
    recordAdPostback({
      providerId: provider.id,
      sessionId: clickId,
      txId,
      status: 'cap_reached',
      errorMessage: msg,
      rawReward: rawRewardStr,
      ip,
    });
    res.status(429).json({ error: msg });
  }
}

app.get('/api/ads/postback', handleAdPostback);
app.post('/api/ads/postback', handleAdPostback);

// ==========================================
// 5. SERVER-VERIFIED MINI-GAMES
// ==========================================

app.post('/api/games/:id/start', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const gameId = Number(req.params.id);
  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true' || settings.gamesEnabled === 'false') {
    res.status(403).json({ error: 'Mini-games are currently paused by admin' });
    return;
  }
  const game = db.prepare('SELECT * FROM games WHERE id = ? AND is_active = 1').get(gameId) as
    | { id: number; daily_limit: number; cooldown_seconds: number }
    | undefined;

  if (!game) {
    res.status(404).json({ error: 'Game not found or disabled' });
    return;
  }

  const { startIso } = getUtcDayBounds(0);
  const playsToday = (
    db
      .prepare('SELECT COUNT(*) as cnt FROM game_plays WHERE user_id = ? AND game_id = ? AND created_at >= ?')
      .get(userId, gameId, startIso) as { cnt: number }
  ).cnt;

  if (playsToday >= game.daily_limit) {
    res.status(429).json({ error: 'Daily play limit reached for this game' });
    return;
  }

  const lastPlay = db
    .prepare('SELECT created_at FROM game_plays WHERE user_id = ? AND game_id = ? ORDER BY id DESC LIMIT 1')
    .get(userId, gameId) as { created_at: string } | undefined;

  if (lastPlay) {
    const elapsed = (Date.now() - new Date(lastPlay.created_at).getTime()) / 1000;
    if (elapsed < game.cooldown_seconds) {
      res.status(429).json({ error: `Cooldown active. Wait ${Math.ceil(game.cooldown_seconds - elapsed)}s` });
      return;
    }
  }

  const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
  if (maxDaily > 0 && getUserDailyEarnedPoints(userId) >= maxDaily) {
    res.status(429).json({ error: `Daily earning limit of ${maxDaily} PTS reached` });
    return;
  }

  const nonce = `gm_${crypto.randomBytes(12).toString('hex')}`;
  db.prepare("INSERT INTO game_sessions (nonce, user_id, game_id, status, created_at) VALUES (?, ?, ?, 'started', ?)").run(
    nonce,
    userId,
    gameId,
    new Date().toISOString()
  );

  res.json({ ok: true, nonce });
});

app.post('/api/games/:id/claim', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const gameId = Number(req.params.id);
  const { nonce, score } = req.body as { nonce?: string; score?: number };
  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true' || settings.gamesEnabled === 'false') {
    res.status(403).json({ error: 'Mini-games are currently paused by admin' });
    return;
  }

  if (!nonce || typeof nonce !== 'string') {
    res.status(400).json({ error: 'Missing server game session nonce' });
    return;
  }

  const game = db.prepare('SELECT * FROM games WHERE id = ? AND is_active = 1').get(gameId) as
    | { id: number; slug: string; game_type: string; title: string; reward_min: number; reward_max: number; daily_limit: number }
    | undefined;

  if (!game) {
    res.status(404).json({ error: 'Game unavailable' });
    return;
  }

  const tx = db.transaction(() => {
    const gs = db
      .prepare("SELECT * FROM game_sessions WHERE nonce = ? AND user_id = ? AND game_id = ? AND status = 'started'")
      .get(nonce, userId, gameId) as { nonce: string; created_at: string } | undefined;

    if (!gs) {
      throw new Error('Invalid or already claimed game session');
    }

    const { startIso } = getUtcDayBounds(0);
    const playsToday = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM game_plays WHERE user_id = ? AND game_id = ? AND created_at >= ?')
        .get(userId, gameId, startIso) as { cnt: number }
    ).cnt;

    if (playsToday >= game.daily_limit) {
      throw new Error('Daily play limit reached');
    }

    // Server computes reward strictly within configured bounds
    const min = Math.max(1, game.reward_min);
    const max = Math.max(min, game.reward_max);
    const gType = game.game_type || (game.slug === 'prism-memory' ? 'prism_memory' : 'spin_wheel');
    let reward: number;
    if (gType === 'prism_memory' || gType === 'vault_tap' || gType === 'external_offer') {
      const elapsedSec = (Date.now() - new Date(gs.created_at).getTime()) / 1000;
      if (elapsedSec < 2) {
        throw new Error('Game completion verification failed');
      }
      const normalized = Math.max(0, Math.min(1, Number(score || 50) / 100));
      reward = Math.round(min + (max - min) * normalized);
    } else {
      reward = crypto.randomInt(min, max + 1);
    }

    db.prepare("UPDATE game_sessions SET status = 'claimed' WHERE nonce = ?").run(nonce);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO game_plays (user_id, game_id, score, reward_points, created_at) VALUES (?, ?, ?, ?, ?)').run(
      userId,
      gameId,
      Math.floor(Number(score || reward)),
      reward,
      now
    );

    const balance = creditUserPointsAtomic({
      userId,
      points: reward,
      txType: 'game_reward',
      description: `Mini-game reward: ${game.title}`,
      referenceId: nonce,
    });

    return { reward, balance };
  });

  try {
    const result = tx();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Game claim failed' });
  }
});

// ==========================================
// 6. WALLET & WITHDRAWALS
// ==========================================

app.post('/api/withdrawals', requireUserAuth, (req: AuthedRequest, res) => {
  const userId = req.userId!;
  const { methodId, network, accountAddress, pointsAmount } = req.body as {
    methodId?: number;
    network?: string;
    accountAddress?: string;
    pointsAmount?: number;
  };

  const settings = getSettingsMap();
  if (settings.maintenanceMode === 'true') {
    res.status(503).json({ error: 'Maintenance mode active' });
    return;
  }
  if (settings.withdrawalsEnabled === 'false') {
    res.status(403).json({ error: 'Withdrawals are temporarily paused by admin' });
    return;
  }

  const cleanAddress = (accountAddress || '').trim().replace(/[\s-]/g, '');
  const pts = Math.floor(Number(pointsAmount || 0));
  if (!/^(\+?88)?01[3-9]\d{8}$/.test(cleanAddress)) {
    res.status(400).json({ error: 'Valid bKash or Nagad mobile number (e.g. 017XXXXXXXX) is required' });
    return;
  }
  if (!Number.isFinite(pts) || pts <= 0) {
    res.status(400).json({ error: 'Positive withdrawal amount is required' });
    return;
  }

  const method = db
    .prepare("SELECT * FROM withdrawal_methods WHERE id = ? AND is_active = 1 AND LOWER(code) IN ('bkash', 'nagad')")
    .get(Number(methodId)) as
    | { id: number; name: string; code: string; networks_json: string; min_points: number; max_points: number; fee_percent: number }
    | undefined;

  if (!method) {
    res.status(404).json({ error: 'Withdrawal method unavailable. Only bKash and Nagad are supported.' });
    return;
  }

  const allowedNetworks = JSON.parse(method.networks_json || '[]') as string[];
  const cleanNetwork = String(network || allowedNetworks[0] || 'Personal');
  if (allowedNetworks.length > 0 && !allowedNetworks.includes(cleanNetwork)) {
    res.status(400).json({ error: 'Unsupported account type for this payment method' });
    return;
  }

  const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));
  const globalMinPts = Math.max(1, Math.floor(Number(settings.minWithdrawalPoints || '500')));
  const globalMaxPts = Math.max(globalMinPts, Math.floor(Number(settings.maxWithdrawalPoints || '100000')));
  const effectiveMin = Math.max(method.min_points, globalMinPts);
  const effectiveMax = Math.min(method.max_points, globalMaxPts);

  if (pts < effectiveMin || pts > effectiveMax) {
    res.status(400).json({ error: `Amount must be between ${effectiveMin} and ${effectiveMax} points` });
    return;
  }

  const feePct = method.fee_percent > 0 ? method.fee_percent : Number(settings.withdrawalFeePercent || '0');
  const feePoints = Number(((pts * feePct) / 100).toFixed(2));
  const netPoints = Number(Math.max(0, pts - feePoints).toFixed(2));
  const bdtAmount = Number((pts / rate).toFixed(2));
  const feeBdt = Number(((bdtAmount * feePct) / 100).toFixed(2));
  const netBdt = Number(Math.max(0, bdtAmount - feeBdt).toFixed(2));
  const now = new Date().toISOString();

  const tx = db.transaction(() => {
    const user = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(userId) as { points_balance: number };
    if (user.points_balance < pts) {
      throw new Error('Insufficient available balance');
    }

    const newBalance = user.points_balance - pts;
    db.prepare('UPDATE users SET points_balance = ?, pending_balance = pending_balance + ? WHERE id = ?').run(
      newBalance,
      pts,
      userId
    );

    const info = db
      .prepare(
        `INSERT INTO withdrawals (user_id, method_id, method_name, network, account_address, points_amount, usdt_amount, fee_usdt, net_usdt, fee_points, net_points, bdt_amount, fee_bdt, net_bdt, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, 'pending', ?, ?)`
      )
      .run(
        userId,
        method.id,
        method.name,
        cleanNetwork,
        cleanAddress,
        pts,
        feePoints,
        netPoints,
        bdtAmount,
        feeBdt,
        netBdt,
        now,
        now
      );

    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
       VALUES (?, 'withdrawal_hold', ?, ?, ?, ?, ?)`
    ).run(userId, -pts, newBalance, `Withdrawal request via ${method.name} (${cleanNetwork})`, `wd_${info.lastInsertRowid}`, now);

    return { withdrawalId: info.lastInsertRowid, newBalance };
  });

  try {
    const result = tx();
    const uRow = db.prepare('SELECT username, telegram_id FROM users WHERE id = ?').get(userId) as
      | { username: string; telegram_id: string }
      | undefined;
    void notifyTelegramAdmins(
      `<b>New Withdrawal Request #${result.withdrawalId}</b>\nUser: @${uRow?.username || 'user'} (ID: <code>${uRow?.telegram_id || userId}</code>)\nMethod: <b>${method.name}</b> (${cleanNetwork})\nNumber: <code>${cleanAddress}</code>\nAmount: <b>${pts} PTS</b> (Net: <b>৳${netBdt.toFixed(2)} BDT</b>)`
    );
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Withdrawal failed' });
  }
});

// ==========================================
// 7. TELEGRAM BOT WEBHOOK
// ==========================================

app.post('/api/telegram/webhook', async (req, res) => {
  try {
    await processTelegramUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook processing error:', err);
    res.status(500).json({ ok: false });
  }
});

// ==========================================
// 8. ADMIN AUTH & COMPLETE ADMIN PANEL APIS
// ==========================================

app.get('/api/admin/auth/status', (_req, res) => {
  const envConfigured = Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0);
  const telegramAdminIdsConfigured =
    (process.env.TELEGRAM_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean).length > 0;
  const existingCount = (db.prepare('SELECT COUNT(*) as cnt FROM admin_credentials').get() as { cnt: number }).cnt;
  res.json({
    needsInitialSetup: !envConfigured && existingCount === 0,
    envOverrideActive: envConfigured,
    telegramAdminIdsConfigured,
  });
});

app.post('/api/admin/auth/claim', (req, res) => {
  if (process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0) {
    res.status(403).json({ error: 'ADMIN_PASSCODE is configured via server environment variables' });
    return;
  }
  const { email, password } = req.body as { email?: string; password?: string };
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@') || !password || password.length < 8) {
    res.status(400).json({ error: 'Valid email and password (minimum 8 characters) required' });
    return;
  }

  const tx = db.transaction(() => {
    const cnt = (db.prepare('SELECT COUNT(*) as cnt FROM admin_credentials').get() as { cnt: number }).cnt;
    if (cnt > 0) {
      throw new Error('Admin account already claimed');
    }
    const hash = hashPassword(password);
    db.prepare('INSERT INTO admin_credentials (email, password_hash, created_at) VALUES (?, ?, ?)').run(
      cleanEmail,
      hash,
      new Date().toISOString()
    );
  });

  try {
    tx();
    const token = signSessionToken({ sub: cleanEmail, role: 'admin' }, 60 * 60 * 12);
    logAdminAudit(cleanEmail, 'ADMIN_CLAIMED', 'admin', cleanEmail, {});
    res.json({ ok: true, token, email: cleanEmail });
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : 'Claim failed' });
  }
});

app.post('/api/admin/auth/login', (req, res) => {
  const { email, password, initData } = req.body as { email?: string; password?: string; initData?: string };
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!password) {
    res.status(400).json({ error: 'Password or Admin Passcode is required' });
    return;
  }

  const allowedTelegramAdminIds = (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let verifiedTgAdminId: string | undefined;
  if (initData && typeof initData === 'string' && initData.trim()) {
    const botToken = getBotToken();
    const verified = botToken ? verifyTelegramInitData(initData, botToken) : null;
    if (!verified) {
      res.status(401).json({ error: 'Invalid Telegram session for admin authentication' });
      return;
    }
    const tgId = String(verified.user.id);
    if (allowedTelegramAdminIds.length > 0 && !allowedTelegramAdminIds.includes(tgId)) {
      res.status(403).json({ error: 'Your Telegram ID is not authorized in TELEGRAM_ADMIN_IDS' });
      return;
    }
    verifiedTgAdminId = tgId;
  }

  const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
  if (envPasscode) {
    const a = Buffer.from(password);
    const b = Buffer.from(envPasscode);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(401).json({ error: 'Invalid administrator credentials' });
      return;
    }
    const actor = verifiedTgAdminId ? `tg:${verifiedTgAdminId}` : cleanEmail || 'env-admin';
    const token = signSessionToken({ sub: actor, role: 'admin', telegramId: verifiedTgAdminId }, 60 * 60 * 12);
    res.json({ ok: true, token, email: actor });
    return;
  }

  const admin = db.prepare('SELECT * FROM admin_credentials WHERE email = ?').get(cleanEmail) as
    | { email: string; password_hash: string }
    | undefined;

  if (!admin || !verifyPassword(password, admin.password_hash)) {
    res.status(401).json({ error: 'Invalid email or password' });
    return;
  }

  const token = signSessionToken({ sub: admin.email, role: 'admin', telegramId: verifiedTgAdminId }, 60 * 60 * 12);
  res.json({ ok: true, token, email: admin.email });
});

app.get('/api/admin/overview', requireAdminAuth, (_req, res) => {
  const { startIso } = getUtcDayBounds(0);
  const activeThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  const metrics = db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM users WHERE last_seen_at >= ?) as activeUsers,
        (SELECT COUNT(*) FROM users WHERE created_at >= ?) as newUsersToday,
        (SELECT COALESCE(SUM(total_earned), 0) FROM users) as totalPointsDistributed,
        (SELECT COALESCE(SUM(total_withdrawn), 0) FROM users) as totalPointsWithdrawn,
        (SELECT COALESCE(SUM(net_bdt), 0) FROM withdrawals) as totalWithdrawalRequestsBdt,
        (SELECT COALESCE(SUM(net_bdt), 0) FROM withdrawals WHERE status = 'paid') as totalPaidWithdrawalsBdt,
        (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') as pendingWithdrawals,
        (SELECT COUNT(*) FROM users WHERE referred_by_user_id IS NOT NULL) as totalReferrals,
        (SELECT COUNT(*) FROM ad_sessions) as adImpressionsTotal,
        (SELECT COUNT(*) FROM ad_sessions WHERE status = 'verified') as verifiedAdsTotal,
        (SELECT COUNT(*) FROM ad_sessions WHERE status = 'verified' AND created_at >= ?) as verifiedAdsToday,
        (SELECT COUNT(*) FROM ad_postbacks WHERE status != 'verified') as postbackErrorsCount,
        (SELECT COUNT(*) FROM ad_providers WHERE is_active = 1) as activeAdProvidersCount,
        (SELECT COALESCE(SUM(amount_points), 0) FROM transactions WHERE amount_points > 0 AND created_at >= ?) as dailyPointsEarned,
        (SELECT COUNT(*) FROM task_submissions WHERE status = 'pending') as pendingTaskReviews`
    )
    .get(activeThreshold, startIso, startIso, startIso);

  const recentAudits = db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 20').all();
  res.json({ metrics, recentAudits });
});

// Admin Users Management
app.get('/api/admin/users', requireAdminAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  let users;
  if (q) {
    const like = `%${q}%`;
    users = db
      .prepare(
        `SELECT * FROM users WHERE username LIKE ? OR telegram_id LIKE ? OR first_name LIKE ? OR referral_code LIKE ? ORDER BY id DESC LIMIT 100`
      )
      .all(like, like, like, like);
  } else {
    users = db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT 100').all();
  }
  res.json({ users });
});

app.get('/api/admin/users/:id/transactions', requireAdminAuth, (req, res) => {
  const transactions = db
    .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(Number(req.params.id));
  res.json({ transactions });
});

app.post('/api/admin/users/:id/block', requireAdminAuth, (req: AuthedRequest, res) => {
  const userId = Number(req.params.id);
  const { blocked } = req.body as { blocked?: boolean };
  const val = blocked ? 1 : 0;
  db.prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(val, userId);
  logAdminAudit(req.adminEmail!, val ? 'USER_BLOCKED' : 'USER_UNBLOCKED', 'user', userId, { blocked: Boolean(val) });
  res.json({ ok: true });
});

app.post('/api/admin/users/:id/adjust-balance', requireAdminAuth, (req: AuthedRequest, res) => {
  const userId = Number(req.params.id);
  const { deltaPoints, reason } = req.body as { deltaPoints?: number; reason?: string };
  const delta = Math.trunc(Number(deltaPoints || 0));
  const cleanReason = (reason || 'Admin balance adjustment').trim().slice(0, 200);
  if (!delta) {
    res.status(400).json({ error: 'Non-zero integer deltaPoints required' });
    return;
  }

  const tx = db.transaction(() => {
    const user = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(userId) as
      | { points_balance: number }
      | undefined;
    if (!user) throw new Error('User not found');
    const newBal = Math.max(0, user.points_balance + delta);
    const actualDelta = newBal - user.points_balance;
    const now = new Date().toISOString();

    db.prepare('UPDATE users SET points_balance = ?, total_earned = total_earned + ? WHERE id = ?').run(
      newBal,
      actualDelta > 0 ? actualDelta : 0,
      userId
    );
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
       VALUES (?, 'admin_adjustment', ?, ?, ?, ?, ?)`
    ).run(userId, actualDelta, newBal, cleanReason, `adm_${Date.now()}`, now);

    logAdminAudit(req.adminEmail!, 'BALANCE_ADJUSTED', 'user', userId, { delta: actualDelta, newBal, reason: cleanReason });
    return newBal;
  });

  try {
    const newBalance = tx();
    res.json({ ok: true, newBalance });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Adjustment failed' });
  }
});

// Admin Tasks & Submissions Management
app.get('/api/admin/tasks', requireAdminAuth, (_req, res) => {
  const tasks = db.prepare('SELECT id, title, description, category, icon_url, target_url, reward_points, verification_type, daily_limit, expires_at, is_active, created_at FROM tasks ORDER BY id DESC').all();
  const submissions = db
    .prepare(
      `SELECT s.*, u.username, u.telegram_id, t.title as task_title, t.reward_points
       FROM task_submissions s
       JOIN users u ON u.id = s.user_id
       JOIN tasks t ON t.id = s.task_id
       ORDER BY CASE WHEN s.status = 'pending' THEN 0 ELSE 1 END, s.id DESC
       LIMIT 100`
    )
    .all();
  res.json({ tasks, submissions });
});

app.post('/api/admin/tasks', requireAdminAuth, (req: AuthedRequest, res) => {
  const { title, description, category, iconUrl, targetUrl, rewardPoints, verificationType, secretCode, dailyLimit, expiresAt, isActive } =
    req.body as Record<string, unknown>;

  if (!title || !description || !category) {
    res.status(400).json({ error: 'Title, description, and category are required' });
    return;
  }

  const info = db
    .prepare(
      `INSERT INTO tasks (title, description, category, icon_url, target_url, reward_points, verification_type, secret_code_hash, daily_limit, expires_at, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(title).trim(),
      String(description).trim(),
      String(category),
      sanitizeAssetOrExternalUrl(String(iconUrl || '')),
      sanitizeExternalUrl(String(targetUrl || '')),
      Math.max(1, Math.floor(Number(rewardPoints || 10))),
      String(verificationType || 'admin_approval'),
      secretCode ? hashSecret(String(secretCode)) : '',
      Math.max(1, Math.floor(Number(dailyLimit || 1))),
      String(expiresAt || ''),
      isActive === false ? 0 : 1,
      new Date().toISOString()
    );

  logAdminAudit(req.adminEmail!, 'TASK_CREATED', 'task', info.lastInsertRowid, { title });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/tasks/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const taskId = Number(req.params.id);
  const { title, description, category, iconUrl, targetUrl, rewardPoints, verificationType, secretCode, dailyLimit, expiresAt, isActive } =
    req.body as Record<string, unknown>;

  const existing = db.prepare('SELECT secret_code_hash FROM tasks WHERE id = ?').get(taskId) as
    | { secret_code_hash: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Task not found' });
    return;
  }

  db.prepare(
    `UPDATE tasks SET title = ?, description = ?, category = ?, icon_url = ?, target_url = ?, reward_points = ?, verification_type = ?, secret_code_hash = ?, daily_limit = ?, expires_at = ?, is_active = ?
     WHERE id = ?`
  ).run(
    String(title || '').trim(),
    String(description || '').trim(),
    String(category || 'custom'),
    sanitizeAssetOrExternalUrl(String(iconUrl || '')),
    sanitizeExternalUrl(String(targetUrl || '')),
    Math.max(1, Math.floor(Number(rewardPoints || 10))),
    String(verificationType || 'admin_approval'),
    secretCode ? hashSecret(String(secretCode)) : existing.secret_code_hash,
    Math.max(1, Math.floor(Number(dailyLimit || 1))),
    String(expiresAt || ''),
    isActive === false ? 0 : 1,
    taskId
  );

  logAdminAudit(req.adminEmail!, 'TASK_UPDATED', 'task', taskId, { title, isActive });
  res.json({ ok: true });
});

app.delete('/api/admin/tasks/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const taskId = Number(req.params.id);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  logAdminAudit(req.adminEmail!, 'TASK_DELETED', 'task', taskId, {});
  res.json({ ok: true });
});

app.post('/api/admin/submissions/:id/review', requireAdminAuth, (req: AuthedRequest, res) => {
  const subId = Number(req.params.id);
  const { decision, note } = req.body as { decision?: 'approved' | 'rejected'; note?: string };
  if (decision !== 'approved' && decision !== 'rejected') {
    res.status(400).json({ error: 'Invalid decision' });
    return;
  }

  const tx = db.transaction(() => {
    const sub = db
      .prepare(
        `SELECT s.*, t.title as task_title, t.reward_points
         FROM task_submissions s JOIN tasks t ON t.id = s.task_id
         WHERE s.id = ?`
      )
      .get(subId) as
      | { id: number; user_id: number; task_id: number; status: string; task_title: string; reward_points: number }
      | undefined;

    if (!sub) throw new Error('Submission not found');
    if (sub.status !== 'pending') throw new Error('Submission already reviewed');

    const now = new Date().toISOString();
    db.prepare('UPDATE task_submissions SET status = ?, review_note = ?, reviewed_at = ? WHERE id = ?').run(
      decision,
      (note || '').trim().slice(0, 200),
      now,
      subId
    );

    if (decision === 'approved') {
      creditUserPointsAtomic({
        userId: sub.user_id,
        points: sub.reward_points,
        txType: 'task_reward',
        description: `Approved task: ${sub.task_title}`,
        referenceId: `sub_${subId}`,
      });
    }

    logAdminAudit(req.adminEmail!, `SUBMISSION_${decision.toUpperCase()}`, 'task_submission', subId, {
      userId: sub.user_id,
      reward: sub.reward_points,
    });
  });

  try {
    tx();
    const subInfo = db
      .prepare(
        `SELECT u.telegram_id, t.title, t.reward_points
         FROM task_submissions s
         JOIN users u ON u.id = s.user_id
         JOIN tasks t ON t.id = s.task_id
         WHERE s.id = ?`
      )
      .get(subId) as { telegram_id: string; title: string; reward_points: number } | undefined;
    if (subInfo) {
      void notifyTelegramUser(
        subInfo.telegram_id,
        decision === 'approved'
          ? `<b>Task Approved!</b>\nYour submission for <b>${subInfo.title}</b> was approved.\nReward Credited: <b>+${subInfo.reward_points} PTS</b>`
          : `<b>Task Submission Rejected</b>\nYour submission for <b>${subInfo.title}</b> was not approved.${note ? `\nNote: ${note}` : ''}`
      );
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Review failed' });
  }
});

// Admin Global Transaction History
app.get('/api/admin/transactions', requireAdminAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';
  const conditions: string[] = [];
  const params: Array<string> = [];

  if (type && type !== 'all') {
    conditions.push('t.type = ?');
    params.push(type);
  }
  if (q) {
    const like = `%${q}%`;
    conditions.push('(u.username LIKE ? OR u.telegram_id LIKE ? OR t.description LIKE ? OR t.reference_id LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const transactions = db
    .prepare(
      `SELECT t.*, u.username, u.telegram_id
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       ${whereClause}
       ORDER BY t.id DESC LIMIT 150`
    )
    .all(...params);

  res.json({ transactions });
});

// Admin Advertisement Providers, Performance & Postback Logs
app.get('/api/admin/ads', requireAdminAuth, (_req, res) => {
  const settings = getSettingsMap();
  const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));
  const rawProviders = db
    .prepare(
      `SELECT id, name, provider_type, sdk_zone_id, placement_id, api_key, ad_url_template, reward_points, payout_per_conversion_bdt, daily_limit, reset_hour_utc, is_active, created_at
       FROM ad_providers ORDER BY id DESC`
    )
    .all() as Array<{
    id: number;
    name: string;
    provider_type: string;
    sdk_zone_id: string;
    placement_id: string;
    api_key: string;
    ad_url_template: string;
    reward_points: number;
    payout_per_conversion_bdt: number;
    daily_limit: number;
    reset_hour_utc: number;
    is_active: number;
    created_at: string;
  }>;

  const providers = rawProviders.map(({ api_key, ...rest }) => {
    const sessStats = db
      .prepare(
        `SELECT COUNT(*) as impressions,
                COALESCE(SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END), 0) as verifiedConversions,
                COALESCE(SUM(CASE WHEN status = 'verified' THEN reward_points ELSE 0 END), 0) as userRewardPointsCost
         FROM ad_sessions WHERE provider_id = ?`
      )
      .get(rest.id) as { impressions: number; verifiedConversions: number; userRewardPointsCost: number };

    const pbStats = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status = 'duplicate_tx' THEN 1 ELSE 0 END), 0) as duplicateCount,
                COALESCE(SUM(CASE WHEN status NOT IN ('verified', 'already_verified', 'duplicate_tx') THEN 1 ELSE 0 END), 0) as errorCount
         FROM ad_postbacks WHERE provider_id = ?`
      )
      .get(rest.id) as { duplicateCount: number; errorCount: number };

    const userRewardBdtCost = Number(((sessStats.userRewardPointsCost || 0) / rate).toFixed(2));
    const estimatedRevenueBdt = Number(((sessStats.verifiedConversions || 0) * (rest.payout_per_conversion_bdt || 0)).toFixed(2));

    return {
      ...rest,
      has_api_key: Boolean(api_key),
      api_key_masked: api_key ? `••••${api_key.slice(-4)}` : '',
      impressions: sessStats.impressions || 0,
      verifiedConversions: sessStats.verifiedConversions || 0,
      duplicateCount: pbStats.duplicateCount || 0,
      errorCount: pbStats.errorCount || 0,
      userRewardPointsCost: sessStats.userRewardPointsCost || 0,
      userRewardBdtCost,
      estimatedRevenueBdt,
    };
  });

  const sessions = db
    .prepare(
      `SELECT a.*, u.username, p.name as provider_name
       FROM ad_sessions a
       JOIN users u ON u.id = a.user_id
       JOIN ad_providers p ON p.id = a.provider_id
       ORDER BY a.created_at DESC LIMIT 60`
    )
    .all();

  const postbacks = db
    .prepare(
      `SELECT pb.*, COALESCE(p.name, 'Unknown') as provider_name
       FROM ad_postbacks pb
       LEFT JOIN ad_providers p ON p.id = pb.provider_id
       ORDER BY pb.id DESC LIMIT 60`
    )
    .all();

  const summary = {
    impressions: providers.reduce((s, p) => s + p.impressions, 0),
    verifiedConversions: providers.reduce((s, p) => s + p.verifiedConversions, 0),
    duplicateOrErrors: providers.reduce((s, p) => s + p.duplicateCount + p.errorCount, 0),
    userRewardPointsCost: providers.reduce((s, p) => s + p.userRewardPointsCost, 0),
    userRewardBdtCost: Number(providers.reduce((s, p) => s + p.userRewardBdtCost, 0).toFixed(2)),
    estimatedRevenueBdt: Number(providers.reduce((s, p) => s + p.estimatedRevenueBdt, 0).toFixed(2)),
  };

  res.json({ providers, sessions, postbacks, summary });
});

app.post('/api/admin/ads/providers', requireAdminAuth, (req: AuthedRequest, res) => {
  const {
    name,
    providerType,
    sdkZoneId,
    placementId,
    apiKey,
    adUrlTemplate,
    postbackSecret,
    rewardPoints,
    payoutPerConversionBdt,
    dailyLimit,
    resetHourUtc,
    isActive,
  } = req.body as Record<string, unknown>;

  if (!name || !postbackSecret) {
    res.status(400).json({ error: 'Provider name and postback secret are required' });
    return;
  }

  const cleanAdUrl = sanitizeExternalUrl(String(adUrlTemplate || ''));
  if (!cleanAdUrl) {
    res.status(400).json({ error: 'A valid HTTP/HTTPS Ad URL template is required' });
    return;
  }

  const info = db
    .prepare(
      `INSERT INTO ad_providers (name, provider_type, sdk_zone_id, placement_id, api_key, ad_url_template, postback_secret_hash, reward_points, payout_per_conversion_bdt, daily_limit, reset_hour_utc, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      String(name).trim(),
      String(providerType || 'monetag'),
      String(sdkZoneId || '').trim(),
      String(placementId || '').trim(),
      String(apiKey || '').trim(),
      cleanAdUrl,
      hashSecret(String(postbackSecret)),
      Math.max(1, Math.floor(Number(rewardPoints || 10))),
      Math.max(0, Number(payoutPerConversionBdt || 0)),
      Math.max(1, Math.floor(Number(dailyLimit || 6))),
      Math.max(0, Math.min(23, Math.floor(Number(resetHourUtc || 0)))),
      isActive === false ? 0 : 1,
      new Date().toISOString()
    );

  logAdminAudit(req.adminEmail!, 'AD_PROVIDER_CREATED', 'ad_provider', info.lastInsertRowid, { name });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/ads/providers/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const {
    name,
    providerType,
    sdkZoneId,
    placementId,
    apiKey,
    adUrlTemplate,
    postbackSecret,
    rewardPoints,
    payoutPerConversionBdt,
    dailyLimit,
    resetHourUtc,
    isActive,
  } = req.body as Record<string, unknown>;

  const existing = db.prepare('SELECT postback_secret_hash, api_key, ad_url_template FROM ad_providers WHERE id = ?').get(id) as
    | { postback_secret_hash: string; api_key: string; ad_url_template: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Ad provider not found' });
    return;
  }

  const cleanAdUrl = sanitizeExternalUrl(String(adUrlTemplate || '')) || existing.ad_url_template;

  db.prepare(
    `UPDATE ad_providers SET name = ?, provider_type = ?, sdk_zone_id = ?, placement_id = ?, api_key = ?, ad_url_template = ?, postback_secret_hash = ?, reward_points = ?, payout_per_conversion_bdt = ?, daily_limit = ?, reset_hour_utc = ?, is_active = ?
     WHERE id = ?`
  ).run(
    String(name || '').trim(),
    String(providerType || 'monetag'),
    String(sdkZoneId || '').trim(),
    String(placementId || '').trim(),
    typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : existing.api_key,
    cleanAdUrl,
    postbackSecret ? hashSecret(String(postbackSecret)) : existing.postback_secret_hash,
    Math.max(1, Math.floor(Number(rewardPoints || 10))),
    Math.max(0, Number(payoutPerConversionBdt || 0)),
    Math.max(1, Math.floor(Number(dailyLimit || 6))),
    Math.max(0, Math.min(23, Math.floor(Number(resetHourUtc || 0)))),
    isActive === false ? 0 : 1,
    id
  );

  logAdminAudit(req.adminEmail!, 'AD_PROVIDER_UPDATED', 'ad_provider', id, { name, rewardPoints, dailyLimit, isActive });
  res.json({ ok: true });
});

app.delete('/api/admin/ads/providers/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  db.prepare('DELETE FROM ad_providers WHERE id = ?').run(id);
  logAdminAudit(req.adminEmail!, 'AD_PROVIDER_DELETED', 'ad_provider', id, {});
  res.json({ ok: true });
});

app.post('/api/admin/ads/sessions/:id/verify', requireAdminAuth, (req: AuthedRequest, res) => {
  const sessionId = req.params.id;
  const session = db.prepare('SELECT * FROM ad_sessions WHERE id = ?').get(sessionId) as
    | { id: string; user_id: number; provider_id: number; slot_number: number; status: string; reward_points: number }
    | undefined;

  if (!session) {
    res.status(404).json({ error: 'Ad session not found' });
    return;
  }
  if (session.status === 'verified') {
    res.json({ ok: true, alreadyVerified: true });
    return;
  }

  const tx = db.transaction(() => {
    db.prepare("UPDATE ad_sessions SET status = 'verified', verified_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      session.id
    );
    creditUserPointsAtomic({
      userId: session.user_id,
      points: session.reward_points,
      txType: 'ad_reward',
      description: `Admin-verified ad session #${session.slot_number}`,
      referenceId: session.id,
    });
    logAdminAudit(req.adminEmail!, 'AD_SESSION_MANUALLY_VERIFIED', 'ad_session', session.id, {
      userId: session.user_id,
      reward: session.reward_points,
    });
  });
  tx();
  res.json({ ok: true });
});

// Admin Withdrawals & Payment Methods (bKash and Nagad only)
app.get('/api/admin/withdrawals', requireAdminAuth, (_req, res) => {
  const methods = db
    .prepare("SELECT * FROM withdrawal_methods WHERE LOWER(code) IN ('bkash', 'nagad') ORDER BY id ASC")
    .all() as Array<{
    id: number;
    name: string;
    code: string;
    networks_json: string;
    min_points: number;
    max_points: number;
    fee_percent: number;
    is_active: number;
  }>;
  const withdrawals = db
    .prepare(
      `SELECT w.id, w.user_id, w.method_id, w.method_name, w.network, w.account_address, w.points_amount,
              w.fee_points, w.net_points, w.bdt_amount, w.fee_bdt, w.net_bdt, w.status, w.admin_note, w.tx_hash,
              w.created_at, w.updated_at, u.username, u.telegram_id
       FROM withdrawals w JOIN users u ON u.id = w.user_id
       ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.status = 'approved' THEN 1 ELSE 2 END, w.id DESC
       LIMIT 150`
    )
    .all();

  res.json({
    methods: methods.map((m) => ({ ...m, networks: JSON.parse(m.networks_json || '[]') })),
    withdrawals,
  });
});

app.post('/api/admin/withdrawal-methods', requireAdminAuth, (req: AuthedRequest, res) => {
  const { id, name, code, networks, minPoints, maxPoints, feePercent, isActive } = req.body as {
    id?: number;
    name?: string;
    code?: string;
    networks?: string[];
    minPoints?: number;
    maxPoints?: number;
    feePercent?: number;
    isActive?: boolean;
  };

  const cleanCode = (code || '').trim().toLowerCase();
  if (!name || !['bkash', 'nagad'].includes(cleanCode)) {
    res.status(400).json({ error: 'Only bKash and Nagad withdrawal methods are supported' });
    return;
  }
  const networksJson = JSON.stringify(Array.isArray(networks) && networks.length > 0 ? networks : ['Personal', 'Agent']);
  if (id) {
    db.prepare(
      `UPDATE withdrawal_methods SET name = ?, code = ?, networks_json = ?, min_points = ?, max_points = ?, fee_percent = ?, is_active = ? WHERE id = ?`
    ).run(
      name.trim(),
      cleanCode,
      networksJson,
      Math.max(1, Math.floor(Number(minPoints || 500))),
      Math.max(1, Math.floor(Number(maxPoints || 100000))),
      Math.max(0, Number(feePercent || 0)),
      isActive === false ? 0 : 1,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO withdrawal_methods (name, code, networks_json, min_points, max_points, fee_percent, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      name.trim(),
      cleanCode,
      networksJson,
      Math.max(1, Math.floor(Number(minPoints || 500))),
      Math.max(1, Math.floor(Number(maxPoints || 100000))),
      Math.max(0, Number(feePercent || 0)),
      isActive === false ? 0 : 1
    );
  }
  logAdminAudit(req.adminEmail!, 'WITHDRAWAL_METHOD_SAVED', 'withdrawal_method', id || cleanCode, { name });
  res.json({ ok: true });
});

app.post('/api/admin/withdrawals/:id/status', requireAdminAuth, (req: AuthedRequest, res) => {
  const wdId = Number(req.params.id);
  const { status, adminNote, txHash } = req.body as {
    status?: 'approved' | 'rejected' | 'paid';
    adminNote?: string;
    txHash?: string;
  };

  if (!status || !['approved', 'rejected', 'paid'].includes(status)) {
    res.status(400).json({ error: 'Valid status required (approved, rejected, paid)' });
    return;
  }

  const tx = db.transaction(() => {
    const wd = db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(wdId) as
      | { id: number; user_id: number; points_amount: number; status: string; method_name: string }
      | undefined;

    if (!wd) throw new Error('Withdrawal not found');
    if (wd.status === 'paid' || wd.status === 'rejected') {
      throw new Error('Finalized withdrawals cannot be modified');
    }

    const now = new Date().toISOString();
    db.prepare('UPDATE withdrawals SET status = ?, admin_note = ?, tx_hash = ?, updated_at = ? WHERE id = ?').run(
      status,
      (adminNote || '').trim().slice(0, 250),
      (txHash || '').trim().slice(0, 150),
      now,
      wdId
    );

    if (status === 'rejected') {
      const user = db.prepare('SELECT points_balance, pending_balance FROM users WHERE id = ?').get(wd.user_id) as {
        points_balance: number;
        pending_balance: number;
      };
      const newBal = user.points_balance + wd.points_amount;
      const newPending = Math.max(0, user.pending_balance - wd.points_amount);
      db.prepare('UPDATE users SET points_balance = ?, pending_balance = ? WHERE id = ?').run(
        newBal,
        newPending,
        wd.user_id
      );
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
         VALUES (?, 'withdrawal_refund', ?, ?, ?, ?, ?)`
      ).run(wd.user_id, wd.points_amount, newBal, `Withdrawal rejected & refunded (${wd.method_name})`, `wd_ref_${wdId}`, now);
    } else if (status === 'paid') {
      db.prepare(
        'UPDATE users SET pending_balance = MAX(0, pending_balance - ?), total_withdrawn = total_withdrawn + ? WHERE id = ?'
      ).run(wd.points_amount, wd.points_amount, wd.user_id);
    }

    logAdminAudit(req.adminEmail!, `WITHDRAWAL_${status.toUpperCase()}`, 'withdrawal', wdId, {
      userId: wd.user_id,
      points: wd.points_amount,
      txHash: txHash || '',
    });
  });

  try {
    tx();
    const wdInfo = db
      .prepare(
        `SELECT w.method_name, w.network, w.account_address, w.points_amount, w.net_bdt, w.admin_note, w.tx_hash, u.telegram_id
         FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = ?`
      )
      .get(wdId) as
      | {
          method_name: string;
          network: string;
          account_address: string;
          points_amount: number;
          net_bdt: number;
          admin_note: string;
          tx_hash: string;
          telegram_id: string;
        }
      | undefined;
    if (wdInfo) {
      const msgMap: Record<'approved' | 'rejected' | 'paid', string> = {
        approved: `<b>Withdrawal Approved</b>\nRequest #${wdId} (${wdInfo.method_name} · ৳${Number(wdInfo.net_bdt || 0).toFixed(2)} BDT) has been approved and queued for payout.`,
        paid: `<b>Withdrawal Paid!</b>\n৳${Number(wdInfo.net_bdt || 0).toFixed(2)} BDT has been sent via ${wdInfo.method_name} (${wdInfo.network}) to <code>${wdInfo.account_address}</code>.${wdInfo.tx_hash ? `\nTX Ref: <code>${wdInfo.tx_hash}</code>` : ''}`,
        rejected: `<b>Withdrawal Rejected &amp; Refunded</b>\nRequest #${wdId} was declined and <b>${wdInfo.points_amount} PTS</b> has been refunded to your available balance.${wdInfo.admin_note ? `\nNote: ${wdInfo.admin_note}` : ''}`,
      };
      void notifyTelegramUser(wdInfo.telegram_id, msgMap[status]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Status update failed' });
  }
});

// Admin Games Management (Create, Edit, Enable/Disable, Delete)
app.get('/api/admin/games', requireAdminAuth, (_req, res) => {
  const games = db.prepare('SELECT * FROM games ORDER BY id ASC').all();
  const recentPlays = db
    .prepare(
      `SELECT gp.*, u.username, g.title as game_title
       FROM game_plays gp
       JOIN users u ON u.id = gp.user_id
       JOIN games g ON g.id = gp.game_id
       ORDER BY gp.id DESC LIMIT 50`
    )
    .all();
  res.json({ games, recentPlays });
});

app.post('/api/admin/games', requireAdminAuth, (req: AuthedRequest, res) => {
  const { title, description, gameType, iconUrl, targetUrl, rewardMin, rewardMax, dailyLimit, cooldownSeconds, isActive } =
    req.body as Record<string, unknown>;

  const cleanTitle = String(title || '').trim();
  const cleanDesc = String(description || '').trim();
  if (!cleanTitle || !cleanDesc) {
    res.status(400).json({ error: 'Game title and description are required' });
    return;
  }

  const allowedTypes = new Set(['spin_wheel', 'prism_memory', 'vault_tap', 'external_offer']);
  const cleanType = allowedTypes.has(String(gameType || '')) ? String(gameType) : 'vault_tap';
  const baseSlug = cleanTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28) || 'game';
  const slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
  const minPts = Math.max(1, Math.floor(Number(rewardMin || 5)));
  const maxPts = Math.max(minPts, Math.floor(Number(rewardMax || 30)));

  const info = db
    .prepare(
      `INSERT INTO games (slug, game_type, title, description, icon_url, target_url, reward_min, reward_max, daily_limit, cooldown_seconds, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      slug,
      cleanType,
      cleanTitle,
      cleanDesc,
      sanitizeAssetOrExternalUrl(String(iconUrl || '')),
      sanitizeExternalUrl(String(targetUrl || '')),
      minPts,
      maxPts,
      Math.max(1, Math.floor(Number(dailyLimit || 3))),
      Math.max(0, Math.floor(Number(cooldownSeconds || 20))),
      isActive === false ? 0 : 1
    );

  logAdminAudit(req.adminEmail!, 'GAME_CREATED', 'game', info.lastInsertRowid, { title: cleanTitle, gameType: cleanType });
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/admin/games/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const gameId = Number(req.params.id);
  const { title, description, gameType, iconUrl, targetUrl, rewardMin, rewardMax, dailyLimit, cooldownSeconds, isActive } =
    req.body as Record<string, unknown>;

  const existing = db.prepare('SELECT game_type, icon_url, target_url FROM games WHERE id = ?').get(gameId) as
    | { game_type: string; icon_url: string; target_url: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }

  const allowedTypes = new Set(['spin_wheel', 'prism_memory', 'vault_tap', 'external_offer']);
  const cleanType = allowedTypes.has(String(gameType || '')) ? String(gameType) : existing.game_type;
  const minPts = Math.max(1, Math.floor(Number(rewardMin || 5)));
  const maxPts = Math.max(minPts, Math.floor(Number(rewardMax || 30)));

  db.prepare(
    `UPDATE games SET title = ?, description = ?, game_type = ?, icon_url = ?, target_url = ?, reward_min = ?, reward_max = ?, daily_limit = ?, cooldown_seconds = ?, is_active = ? WHERE id = ?`
  ).run(
    String(title || '').trim(),
    String(description || '').trim(),
    cleanType,
    typeof iconUrl === 'string' ? sanitizeAssetOrExternalUrl(iconUrl) : existing.icon_url,
    typeof targetUrl === 'string' ? sanitizeExternalUrl(targetUrl) : existing.target_url,
    minPts,
    maxPts,
    Math.max(1, Math.floor(Number(dailyLimit || 3))),
    Math.max(0, Math.floor(Number(cooldownSeconds || 20))),
    isActive === false ? 0 : 1,
    gameId
  );

  logAdminAudit(req.adminEmail!, 'GAME_UPDATED', 'game', gameId, { title, isActive });
  res.json({ ok: true });
});

app.delete('/api/admin/games/:id', requireAdminAuth, (req: AuthedRequest, res) => {
  const gameId = Number(req.params.id);
  const info = db.prepare('DELETE FROM games WHERE id = ?').run(gameId);
  if (info.changes === 0) {
    res.status(404).json({ error: 'Game not found' });
    return;
  }
  logAdminAudit(req.adminEmail!, 'GAME_DELETED', 'game', gameId, {});
  res.json({ ok: true });
});

// Admin Languages & Full Text Editor
app.get('/api/admin/i18n', requireAdminAuth, (_req, res) => {
  const languages = db.prepare('SELECT * FROM languages ORDER BY code ASC').all();
  const translations = db.prepare('SELECT * FROM translations ORDER BY category ASC, key ASC, lang_code ASC').all();
  const settings = getSettingsMap();
  res.json({ languages, translations, defaultLanguage: settings.defaultLanguage || 'en' });
});

app.post('/api/admin/i18n/languages', requireAdminAuth, (req: AuthedRequest, res) => {
  const { code, name, nativeName, isEnabled } = req.body as {
    code?: string;
    name?: string;
    nativeName?: string;
    isEnabled?: boolean;
  };
  const cleanCode = (code || '').trim().toLowerCase().replace(/[^a-z-]/g, '').slice(0, 10);
  if (!cleanCode || !name || !nativeName) {
    res.status(400).json({ error: 'Language code, name, and native name are required' });
    return;
  }
  db.prepare('INSERT OR REPLACE INTO languages (code, name, native_name, is_enabled) VALUES (?, ?, ?, ?)').run(
    cleanCode,
    name.trim(),
    nativeName.trim(),
    isEnabled === false ? 0 : 1
  );

  // Copy English keys as starting template if new language has no entries yet
  const enRows = db.prepare("SELECT key, value, category FROM translations WHERE lang_code = 'en'").all() as Array<{
    key: string;
    value: string;
    category: string;
  }>;
  const insertMissing = db.prepare(
    'INSERT OR IGNORE INTO translations (lang_code, key, value, category) VALUES (?, ?, ?, ?)'
  );
  for (const r of enRows) {
    insertMissing.run(cleanCode, r.key, r.value, r.category);
  }

  logAdminAudit(req.adminEmail!, 'LANGUAGE_SAVED', 'language', cleanCode, { name, isEnabled });
  res.json({ ok: true });
});

app.post('/api/admin/i18n/translations', requireAdminAuth, (req: AuthedRequest, res) => {
  const { langCode, updates, defaultLanguage } = req.body as {
    langCode?: string;
    updates?: Array<{ key: string; value: string; category?: string }>;
    defaultLanguage?: string;
  };

  const tx = db.transaction(() => {
    if (langCode && Array.isArray(updates)) {
      const upsert = db.prepare(
        'INSERT OR REPLACE INTO translations (lang_code, key, value, category) VALUES (?, ?, ?, COALESCE((SELECT category FROM translations WHERE lang_code = ? AND key = ?), ?))'
      );
      for (const item of updates) {
        if (item.key && typeof item.value === 'string') {
          upsert.run(langCode, item.key, item.value, langCode, item.key, item.category || 'Custom');
        }
      }
    }
    if (defaultLanguage) {
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('defaultLanguage', ?)").run(defaultLanguage);
    }
  });
  tx();
  logAdminAudit(req.adminEmail!, 'TRANSLATIONS_PUBLISHED', 'i18n', langCode || 'global', {
    count: updates?.length || 0,
    defaultLanguage,
  });
  res.json({ ok: true });
});

// Admin App Settings & Referrals Config
app.get('/api/admin/settings', requireAdminAuth, (_req, res) => {
  const settings = getSettingsMap();
  const referrals = db
    .prepare(
      `SELECT u.id, u.username, u.telegram_id, u.referral_qualified, u.created_at, r.username as referrer_username
       FROM users u
       JOIN users r ON r.id = u.referred_by_user_id
       ORDER BY u.id DESC LIMIT 80`
    )
    .all();
  res.json({ settings, referrals });
});

app.put('/api/admin/settings', requireAdminAuth, (req: AuthedRequest, res) => {
  const payload = req.body as Record<string, string>;
  if (typeof payload.publicAppUrl === 'string' && payload.publicAppUrl.trim()) {
    const cleanUrl = sanitizeExternalUrl(payload.publicAppUrl.trim());
    if (!cleanUrl || !cleanUrl.startsWith('https://') || isDisallowedAuthProxyUrl(cleanUrl)) {
      res.status(400).json({
        error:
          'Public Production URL must be a publicly reachable HTTPS URL (AI Studio ais-dev/ais-pre URLs require Google Sign-In and cannot be used).',
      });
      return;
    }
    payload.publicAppUrl = cleanUrl.replace(/\/$/, '');
  }

  const upsert = db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        upsert.run(k, String(v));
      }
    }
  });
  tx();
  logAdminAudit(req.adminEmail!, 'SETTINGS_UPDATED', 'app_settings', 'global', Object.keys(payload));
  if (getBotToken()) {
    void configureTelegramBotMenuAndCommands();
  }
  res.json({ ok: true });
});

// Admin Telegram Bot Integration Check, Menu Button & Webhook/Polling Setup
app.get('/api/admin/telegram/status', requireAdminAuth, async (_req, res) => {
  const token = getBotToken();
  const publicAppUrl = getTelegramWebAppUrl();
  const envAppUrlIsAiStudio = isDisallowedAuthProxyUrl(process.env.APP_URL || '');
  const pollingEnabled = isTelegramPollingEnabled();
  const adminIdsConfigured = (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean).length > 0;
  const runtime = getTelegramBotRuntimeState();

  if (!token) {
    res.json({
      configured: false,
      appUrl: publicAppUrl,
      publicAppUrl,
      envAppUrlIsAiStudio,
      pollingEnabled,
      adminIdsConfigured,
      runtime,
    });
    return;
  }

  try {
    const [meRes, hookRes, menuRes] = await Promise.all([
      fetch(`https://api.telegram.org/bot${token}/getMe`),
      fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
      fetch(`https://api.telegram.org/bot${token}/getChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    ]);
    const meJson = (await meRes.json()) as { ok: boolean; result?: { username?: string; first_name?: string } };
    const hookJson = (await hookRes.json()) as { ok: boolean; result?: { url?: string; pending_update_count?: number } };
    const menuJson = (await menuRes.json()) as {
      ok: boolean;
      result?: { type?: string; text?: string; web_app?: { url?: string } };
    };
    res.json({
      configured: true,
      appUrl: publicAppUrl,
      publicAppUrl,
      envAppUrlIsAiStudio,
      pollingEnabled,
      adminIdsConfigured,
      runtime,
      bot: meJson.ok ? meJson.result : null,
      webhook: hookJson.ok ? hookJson.result : null,
      menuButton: menuJson.ok ? menuJson.result : null,
    });
  } catch (err) {
    res.status(502).json({
      configured: true,
      appUrl: publicAppUrl,
      publicAppUrl,
      envAppUrlIsAiStudio,
      pollingEnabled,
      adminIdsConfigured,
      runtime,
      error: err instanceof Error ? err.message : 'Unable to reach Telegram Bot API',
    });
  }
});

app.post('/api/admin/telegram/configure-menu', requireAdminAuth, async (req: AuthedRequest, res) => {
  const { publicUrl } = req.body as { publicUrl?: string };
  const result = await configureTelegramBotMenuAndCommands(publicUrl?.trim() || undefined);
  if (!result.ok) {
    res.status(400).json({ error: result.error || 'Failed to configure Telegram Mini App launch button' });
    return;
  }
  logAdminAudit(req.adminEmail!, 'TELEGRAM_MENU_CONFIGURED', 'telegram_bot', result.botUsername || 'menu', {
    menuButtonUrl: result.menuButtonUrl,
  });
  res.json(result);
});

app.post('/api/admin/telegram/enable-polling', requireAdminAuth, async (req: AuthedRequest, res) => {
  const cleared = await clearTelegramWebhook();
  if (!cleared.ok) {
    res.status(400).json({ error: cleared.error || 'Failed to clear Telegram webhook' });
    return;
  }
  startTelegramBotPollingIfEnabled();
  logAdminAudit(req.adminEmail!, 'TELEGRAM_POLLING_ENABLED', 'telegram_bot', 'polling', {});
  res.json({ ok: true, pollingEnabled: isTelegramPollingEnabled() });
});

app.post('/api/admin/telegram/register-webhook', requireAdminAuth, async (req: AuthedRequest, res) => {
  const token = getBotToken();
  if (!token) {
    res.status(400).json({ error: 'TELEGRAM_BOT_TOKEN is not set in server Secrets / .env' });
    return;
  }
  const { publicUrl } = req.body as { publicUrl?: string };
  const trimmedUrl = publicUrl?.trim() || '';
  if (trimmedUrl && isDisallowedAuthProxyUrl(trimmedUrl)) {
    res.status(400).json({
      error:
        'AI Studio URLs (ais-dev / ais-pre) require Google Sign-In and cannot be used for Telegram webhooks. Enter your public HTTPS production URL.',
    });
    return;
  }

  const baseUrl = getTelegramWebAppUrl(trimmedUrl || undefined);
  if (!baseUrl) {
    res.status(400).json({
      error:
        'A public HTTPS production URL (PUBLIC_APP_URL) is required for Telegram webhooks. AI Studio URLs are blocked.',
    });
    return;
  }

  const accessCheck = await verifyPublicUrlAccessibility(baseUrl);
  if (!accessCheck.ok) {
    res.status(400).json({ error: accessCheck.error || 'Public URL failed accessibility check' });
    return;
  }

  const webhookUrl = `${baseUrl}/api/telegram/webhook`;
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const tgJson = (await tgRes.json()) as { ok: boolean; description?: string };
    if (!tgJson.ok) {
      res.status(400).json({ error: tgJson.description || 'Telegram setWebhook failed' });
      return;
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('publicAppUrl', ?)").run(baseUrl);
    logAdminAudit(req.adminEmail!, 'TELEGRAM_WEBHOOK_REGISTERED', 'telegram_bot', 'webhook', { webhookUrl });
    res.json({ ok: true, webhookUrl });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to register webhook' });
  }
});

// Admin Server Environment Readiness & Clean Project ZIP Export
app.get('/api/admin/env-status', requireAdminAuth, (_req, res) => {
  res.json({
    env: {
      TELEGRAM_BOT_TOKEN: Boolean(getBotToken()),
      TELEGRAM_ADMIN_IDS: (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).length > 0,
      ADMIN_PASSCODE: Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0),
      PUBLIC_APP_URL: Boolean(getTelegramWebAppUrl()),
      DATABASE_URL: Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0),
      DATA_DIR: Boolean(process.env.DATA_DIR && process.env.DATA_DIR.trim().length > 0),
      SESSION_SECRET: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length > 0),
      TELEGRAM_BOT_POLLING: isTelegramPollingEnabled(),
    },
    nodeEnv: process.env.NODE_ENV || 'development',
  });
});

app.get('/api/admin/export-project.zip', requireAdminAuth, (req: AuthedRequest, res) => {
  try {
    const zipBuffer = buildCleanProjectZipBuffer(process.cwd());
    logAdminAudit(req.adminEmail!, 'PROJECT_ZIP_EXPORTED', 'system', 'zip', { bytes: zipBuffer.length });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="novavault-platform-source.zip"');
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to package project ZIP' });
  }
});

// ==========================================
// 9. VITE DEV / PRODUCTION STATIC HOSTING
// ==========================================

async function startServer(): Promise<void> {
  const port = Number(process.env.PORT || 3000);
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`NovaVault server listening on http://0.0.0.0:${port}`);
  });
}

void startServer();
