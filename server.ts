import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import {
  closeDatabase,
  execute,
  generateReferralCode,
  getDatabaseMode,
  getSettingsMap,
  getUtcDayBounds,
  initDatabase,
  isUsingRealPostgres,
  queryAll,
  queryOne,
  withTransaction,
} from './server/db.ts';
import type { SqlExecutor } from './server/db.ts';
import {
  creditUserPointsAtomic,
  creditUserPointsInTx,
  dispatchPendingNotifications,
  getUserDailyEarnedPoints,
} from './server/rewards.ts';
import type { PendingTelegramNotification } from './server/rewards.ts';
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

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

interface AuthedRequest extends Request {
  userId?: number;
  adminEmail?: string;
}

function asyncHandler(
  fn: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<void> | void
) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function getBearerToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return undefined;
  return authHeader.slice(7).trim();
}

const requireUserAuth = asyncHandler(async (req: AuthedRequest, res: Response, next: NextFunction) => {
  const token = getBearerToken(req);
  const session = verifySessionToken(token);
  if (!session || session.role !== 'user') {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const userId = Number(session.sub);
  if (!Number.isInteger(userId) || userId <= 0) {
    res.status(401).json({ error: 'Invalid user session' });
    return;
  }
  const user = await queryOne<{ id: number; is_blocked: number }>('SELECT id, is_blocked FROM users WHERE id = $1', [userId]);
  if (!user) {
    res.status(401).json({ error: 'User account not found' });
    return;
  }
  if (user.is_blocked === 1) {
    res.status(403).json({ error: 'Account restricted by administrator' });
    return;
  }
  await execute('UPDATE users SET is_online = 1, last_seen_at = $1 WHERE id = $2', [new Date().toISOString(), userId]);
  req.userId = userId;
  next();
});

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

async function logAdminAudit(
  adminActor: string,
  action: string,
  targetType: string,
  targetId: string | number | bigint,
  details: unknown,
  executor?: SqlExecutor
): Promise<void> {
  await execute(
    `INSERT INTO audit_logs (admin_actor, action, target_type, target_id, details_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [adminActor, action, targetType, String(targetId), JSON.stringify(details ?? {}), new Date().toISOString()],
    executor
  );
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

app.get(
  '/api/health',
  asyncHandler(async (_req, res) => {
    const rt = getTelegramBotRuntimeState();
    const publicUrl = await getTelegramWebAppUrl();
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      database: getDatabaseMode(),
      telegram: {
        botConfigured: Boolean(getBotToken()),
        pollingEnabled: isTelegramPollingEnabled(),
        pollingActive: rt.pollingActive,
        botConnected: Boolean(rt.connectedBotUsername),
        publicUrlConfigured: Boolean(publicUrl),
        menuConfigured: rt.menuConfigured,
        commandsConfigured: rt.commandsConfigured,
        lastError: rt.lastError || null,
      },
    });
  })
);

app.get(
  '/api/public/config',
  asyncHandler(async (_req, res) => {
    const settings = await getSettingsMap();
    res.json({
      appName: settings.appName || 'NovaVault',
      logoUrl: settings.logoUrl || '/src/assets/images/app_brand_logo_1795540139729.jpg',
      botUsername: (settings.botUsername || '').replace(/^@/, ''),
    });
  })
);

app.post(
  '/api/auth/telegram',
  asyncHandler(async (req, res) => {
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

    const settings = await getSettingsMap();
    const now = new Date().toISOString();
    const tgId = String(verified.user.id);
    const username = verified.user.username || `tg_${tgId.slice(-6)}`;
    const startRef = verified.startParam?.startsWith('ref_')
      ? verified.startParam.slice(4)
      : verified.startParam || '';

    try {
      const user = await withTransaction(async (client) => {
        const existing = await queryOne<{ id: number; is_blocked: number; telegram_id: string }>(
          'SELECT id, is_blocked, telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE',
          [tgId],
          client
        );

        if (!existing) {
          if (settings.registrationEnabled === 'false') {
            throw new Error('REG_PAUSED');
          }

          let referredById: number | null = null;
          if (startRef) {
            const referrer = await queryOne<{ id: number; telegram_id: string }>(
              'SELECT id, telegram_id FROM users WHERE referral_code = $1',
              [startRef],
              client
            );
            if (referrer && referrer.telegram_id !== tgId) {
              referredById = referrer.id;
            }
          }

          let myCode = generateReferralCode(username);
          for (let i = 0; i < 5; i++) {
            const clash = await queryOne<{ id: number }>(
              'SELECT id FROM users WHERE referral_code = $1',
              [myCode],
              client
            );
            if (!clash) break;
            myCode = generateReferralCode(`${username}${i}`);
          }

          const created = await queryOne<{ id: number; is_blocked: number; telegram_id: string }>(
            `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, is_online, last_seen_at, referral_code, referred_by_user_id, is_preview, language, created_at)
             VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, 0, $9, $10)
             RETURNING id, is_blocked, telegram_id`,
            [
              tgId,
              username,
              verified.user.first_name || '',
              verified.user.last_name || '',
              sanitizeExternalUrl(verified.user.photo_url),
              now,
              myCode,
              referredById,
              verified.user.language_code === 'bn' ? 'bn' : settings.defaultLanguage || 'en',
              now,
            ],
            client
          );
          if (!created) {
            throw new Error('Failed to create Telegram user');
          }
          return created;
        }

        await client.query(
          `UPDATE users SET username = $1, first_name = $2, last_name = $3, photo_url = $4, is_online = 1, last_seen_at = $5, is_preview = 0 WHERE id = $6`,
          [
            username,
            verified.user.first_name || '',
            verified.user.last_name || '',
            sanitizeExternalUrl(verified.user.photo_url),
            now,
            existing.id,
          ]
        );
        return existing;
      });

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
  })
);

// ==========================================
// 2. USER MINI APP API ROUTES
// ==========================================

app.get(
  '/api/bootstrap',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const settings = await getSettingsMap();
    const user = await queryOne<Record<string, unknown>>('SELECT * FROM users WHERE id = $1', [userId]);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const languages = await queryAll<{ code: string; name: string; native_name: string; is_enabled: number }>(
      'SELECT code, name, native_name, is_enabled FROM languages WHERE is_enabled = 1'
    );

    const activeLang =
      typeof req.query.lang === 'string' && languages.some((l) => l.code === req.query.lang)
        ? req.query.lang
        : (user.language as string) || settings.defaultLanguage || 'en';

    const [txRows, enRows] = await Promise.all([
      queryAll<{ key: string; value: string }>('SELECT key, value FROM translations WHERE lang_code = $1', [activeLang]),
      queryAll<{ key: string; value: string }>("SELECT key, value FROM translations WHERE lang_code = 'en'"),
    ]);

    const i18n: Record<string, string> = {};
    for (const r of enRows) i18n[r.key] = r.value;
    for (const r of txRows) i18n[r.key] = r.value;

    const { startIso: utcDayStart, nextResetIso: defaultNextReset } = getUtcDayBounds(0);
    const checkinRow = await queryOne<{ id: number }>(
      "SELECT id FROM transactions WHERE user_id = $1 AND type = 'daily_checkin' AND created_at >= $2 LIMIT 1",
      [userId, utcDayStart]
    );
    const checkinClaimedToday = Boolean(checkinRow);

    // Tasks with user submission status
    const nowIso = new Date().toISOString();
    const tasks =
      settings.tasksEnabled === 'false'
        ? []
        : await queryAll<{
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
          }>(
            `SELECT id, title, description, category, icon_url, target_url, reward_points, verification_type, daily_limit, expires_at, is_active
             FROM tasks
             WHERE is_active = 1 AND (expires_at = '' OR expires_at > $1)
             ORDER BY id DESC`,
            [nowIso]
          );

    const userSubmissions = await queryAll<{
      task_id: number;
      status: string;
      review_note: string;
      created_at: string;
    }>('SELECT task_id, status, review_note, created_at FROM task_submissions WHERE user_id = $1 ORDER BY id DESC', [
      userId,
    ]);

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
    const providers = await queryAll<{
      id: number;
      name: string;
      provider_type: string;
      sdk_zone_id: string;
      ad_url_template: string;
      reward_points: number;
      daily_limit: number;
      reset_hour_utc: number;
    }>(
      `SELECT id, name, provider_type, sdk_zone_id, ad_url_template, reward_points, daily_limit, reset_hour_utc, is_active
       FROM ad_providers WHERE is_active = 1 ORDER BY id ASC`
    );

    const primaryProvider = settings.adsEnabled === 'false' ? null : providers[0] || null;
    let adProgram = null;
    if (primaryProvider) {
      const { startIso: adStartIso, nextResetIso: adNextReset } = getUtcDayBounds(primaryProvider.reset_hour_utc);
      const todaySessions = await queryAll<{
        id: string;
        slot_number: number;
        status: string;
        reward_points: number;
        created_at: string;
        verified_at: string;
      }>(
        'SELECT * FROM ad_sessions WHERE user_id = $1 AND provider_id = $2 AND created_at >= $3 ORDER BY slot_number ASC',
        [userId, primaryProvider.id, adStartIso]
      );

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
    const earnedTodayTotal = await getUserDailyEarnedPoints(userId);
    const dailyMaxEarnings = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));

    // Games
    const games =
      settings.gamesEnabled === 'false'
        ? []
        : await queryAll<{
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
          }>('SELECT * FROM games WHERE is_active = 1 ORDER BY id ASC');

    const gamesWithQuota = await Promise.all(
      games.map(async (g) => {
        const [playsRow, lastPlay] = await Promise.all([
          queryOne<{ cnt: number }>(
            'SELECT COUNT(*)::int AS cnt FROM game_plays WHERE user_id = $1 AND game_id = $2 AND created_at >= $3',
            [userId, g.id, utcDayStart]
          ),
          queryOne<{ created_at: string }>(
            'SELECT created_at FROM game_plays WHERE user_id = $1 AND game_id = $2 ORDER BY id DESC LIMIT 1',
            [userId, g.id]
          ),
        ]);

        const playsToday = playsRow?.cnt || 0;
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
      })
    );

    // Withdrawal methods & user history
    const [withdrawalMethods, withdrawals, transactions, referrals] = await Promise.all([
      queryAll<{
        id: number;
        name: string;
        code: string;
        networks_json: string;
        min_points: number;
        max_points: number;
        fee_percent: number;
      }>(
        "SELECT id, name, code, networks_json, min_points, max_points, fee_percent FROM withdrawal_methods WHERE is_active = 1 AND LOWER(code) IN ('bkash', 'nagad')"
      ),
      queryAll(
        `SELECT id, user_id, method_id, method_name, network, account_address, points_amount,
                fee_points, net_points, bdt_amount, fee_bdt, net_bdt, status, admin_note, tx_hash, created_at, updated_at
         FROM withdrawals WHERE user_id = $1 ORDER BY id DESC LIMIT 30`,
        [userId]
      ),
      queryAll('SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [userId]),
      queryAll(
        `SELECT id, username, first_name, referral_qualified, created_at
         FROM users WHERE referred_by_user_id = $1 ORDER BY id DESC LIMIT 50`,
        [userId]
      ),
    ]);

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
  })
);

app.post(
  '/api/user/language',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { language } = req.body as { language?: string };
    if (!language) {
      res.status(400).json({ error: 'Language code required' });
      return;
    }
    const lang = await queryOne<{ code: string }>('SELECT code FROM languages WHERE code = $1 AND is_enabled = 1', [
      language,
    ]);
    if (!lang) {
      res.status(404).json({ error: 'Language not available' });
      return;
    }
    await execute('UPDATE users SET language = $1 WHERE id = $2', [language, req.userId!]);
    res.json({ ok: true, language });
  })
);

app.post(
  '/api/checkin',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const settings = await getSettingsMap();
    if (settings.maintenanceMode === 'true') {
      res.status(503).json({ error: 'Maintenance mode active' });
      return;
    }
    if (settings.checkinEnabled === 'false') {
      res.status(403).json({ error: 'Daily check-in is temporarily paused by admin' });
      return;
    }
    const { startIso } = getUtcDayBounds(0);
    const existing = await queryOne<{ id: number }>(
      "SELECT id FROM transactions WHERE user_id = $1 AND type = 'daily_checkin' AND created_at >= $2 LIMIT 1",
      [userId, startIso]
    );
    if (existing) {
      res.status(409).json({ error: 'Daily check-in already claimed today' });
      return;
    }
    const reward = Math.max(1, Math.floor(Number(settings.dailyCheckinReward || '25')));
    try {
      const balance = await creditUserPointsAtomic({
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
  })
);

// ==========================================
// 3. TASKS & VERIFICATION ROUTES
// ==========================================

app.post(
  '/api/tasks/:id/submit',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const taskId = Number(req.params.id);
    const { proofText, secretCode } = req.body as { proofText?: string; secretCode?: string };
    const settings = await getSettingsMap();
    if (settings.maintenanceMode === 'true') {
      res.status(503).json({ error: 'Maintenance mode active' });
      return;
    }
    if (settings.tasksEnabled === 'false') {
      res.status(403).json({ error: 'Tasks are temporarily paused by admin' });
      return;
    }

    const task = await queryOne<{
      id: number;
      title: string;
      reward_points: number;
      verification_type: string;
      secret_code_hash: string;
      daily_limit: number;
      expires_at: string;
    }>('SELECT * FROM tasks WHERE id = $1 AND is_active = 1', [taskId]);

    if (!task) {
      res.status(404).json({ error: 'Task not found or inactive' });
      return;
    }
    if (task.expires_at && task.expires_at < new Date().toISOString()) {
      res.status(410).json({ error: 'Task has expired' });
      return;
    }

    const { startIso } = getUtcDayBounds(0);
    const todayCountRow = await queryOne<{ cnt: number }>(
      "SELECT COUNT(*)::int AS cnt FROM task_submissions WHERE user_id = $1 AND task_id = $2 AND status IN ('pending', 'approved') AND created_at >= $3",
      [userId, taskId, startIso]
    );

    if ((todayCountRow?.cnt || 0) >= task.daily_limit) {
      res.status(409).json({ error: 'Daily submission limit reached for this task' });
      return;
    }

    const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
    if (maxDaily > 0 && (await getUserDailyEarnedPoints(userId)) + task.reward_points > maxDaily) {
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

      try {
        const result = await withTransaction(async (client) => {
          await client.query(
            `INSERT INTO task_submissions (user_id, task_id, proof_text, status, review_note, created_at, reviewed_at)
             VALUES ($1, $2, 'Verified via secret code', 'approved', 'Auto-verified by server', $3, $4)`,
            [userId, taskId, now, now]
          );

          return creditUserPointsInTx(client, {
            userId,
            points: task.reward_points,
            txType: 'task_reward',
            description: `Task completed: ${task.title}`,
            referenceId: `task_${taskId}_${Date.now()}`,
          });
        });

        dispatchPendingNotifications(result.notifications);
        res.json({ ok: true, status: 'approved', reward: task.reward_points, balance: result.newBalance });
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

    await execute(
      `INSERT INTO task_submissions (user_id, task_id, proof_text, status, created_at)
       VALUES ($1, $2, $3, 'pending', $4)`,
      [userId, taskId, cleanProof, now]
    );

    res.json({ ok: true, status: 'pending' });
  })
);

// ==========================================
// 4. ADVERTISEMENT SESSION & S2S POSTBACK
// ==========================================

app.post(
  '/api/ads/start',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const { providerId, slotNumber } = req.body as { providerId?: number; slotNumber?: number };
    const settings = await getSettingsMap();
    if (settings.maintenanceMode === 'true') {
      res.status(503).json({ error: 'Maintenance mode active' });
      return;
    }
    if (settings.adsEnabled === 'false') {
      res.status(403).json({ error: 'Advertisements are temporarily paused by admin' });
      return;
    }

    const provider = await queryOne<{
      id: number;
      name: string;
      ad_url_template: string;
      reward_points: number;
      daily_limit: number;
      reset_hour_utc: number;
    }>('SELECT * FROM ad_providers WHERE id = $1 AND is_active = 1', [Number(providerId)]);

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
    const verifiedToday = await queryOne<{ pts: number; cnt: number }>(
      `SELECT COALESCE(SUM(reward_points), 0)::int AS pts, COUNT(*)::int AS cnt
       FROM ad_sessions
       WHERE user_id = $1 AND provider_id = $2 AND status = 'verified' AND created_at >= $3`,
      [userId, provider.id, startIso]
    );

    const maxAdEarn = Number(settings.dailyMaxAdEarnings || '200');
    const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
    if ((verifiedToday?.cnt || 0) >= provider.daily_limit || (verifiedToday?.pts || 0) >= maxAdEarn) {
      res.status(429).json({ error: 'Daily advertisement reward limit reached' });
      return;
    }
    if (maxDaily > 0 && (await getUserDailyEarnedPoints(userId)) + provider.reward_points > maxDaily) {
      res.status(429).json({ error: `Daily earning limit of ${maxDaily} PTS reached` });
      return;
    }

    // Return existing pending session for same slot if already opened today
    const existing = await queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM ad_sessions WHERE user_id = $1 AND provider_id = $2 AND slot_number = $3 AND created_at >= $4',
      [userId, provider.id, slot, startIso]
    );

    let sessionId: string;
    if (existing) {
      if (existing.status === 'verified') {
        res.status(409).json({ error: 'This daily ad slot is already completed' });
        return;
      }
      sessionId = existing.id;
    } else {
      sessionId = `ad_${crypto.randomBytes(10).toString('hex')}`;
      await execute(
        `INSERT INTO ad_sessions (id, user_id, provider_id, slot_number, status, reward_points, ip_address, created_at)
         VALUES ($1, $2, $3, $4, 'initiated', $5, $6, $7)`,
        [sessionId, userId, provider.id, slot, provider.reward_points, req.ip || '', new Date().toISOString()]
      );
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
  })
);

async function recordAdPostback(params: {
  providerId?: number | null;
  sessionId?: string;
  txId?: string;
  status: string;
  errorMessage?: string;
  rawReward?: string;
  ip?: string;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO ad_postbacks (provider_id, session_id, provider_tx_id, status, error_message, raw_reward, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.providerId ?? null,
        (params.sessionId || '').slice(0, 120),
        (params.txId || '').slice(0, 120),
        params.status,
        (params.errorMessage || '').slice(0, 250),
        (params.rawReward || '').slice(0, 60),
        (params.ip || '').slice(0, 80),
        new Date().toISOString(),
      ]
    );
  } catch {
    // Postback audit logging must not break response flow
  }
}

const handleAdPostback = asyncHandler(async (req: Request, res: Response) => {
  const clickId = String(req.query.click_id || req.query.subid || req.body?.click_id || req.body?.subid || '').trim();
  const token = String(
    req.query.token ||
      req.query.verify_token ||
      req.query.secret ||
      req.body?.token ||
      req.body?.verify_token ||
      req.body?.secret ||
      ''
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
    await recordAdPostback({
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

  const session = await queryOne<{
    id: string;
    user_id: number;
    provider_id: number;
    slot_number: number;
    status: string;
    reward_points: number;
  }>('SELECT * FROM ad_sessions WHERE id = $1', [clickId]);

  if (!session) {
    await recordAdPostback({
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

  const provider = await queryOne<{
    id: number;
    name: string;
    postback_secret_hash: string;
    daily_limit: number;
    reset_hour_utc: number;
  }>('SELECT * FROM ad_providers WHERE id = $1', [session.provider_id]);

  if (!provider || !verifySecret(token, provider.postback_secret_hash)) {
    await recordAdPostback({
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
      await recordAdPostback({
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
    await recordAdPostback({
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

  const settings = await getSettingsMap();
  const maxAdEarn = Number(settings.dailyMaxAdEarnings || '200');
  const { startIso } = getUtcDayBounds(provider.reset_hour_utc);

  try {
    const outcome = await withTransaction(async (client) => {
      if (txId) {
        const dupTx = await queryOne<{ id: string }>(
          'SELECT id FROM ad_sessions WHERE provider_id = $1 AND provider_tx_id = $2',
          [provider.id, txId],
          client
        );
        if (dupTx) {
          return { duplicateTx: true, balance: null as number | null, notifications: [] as PendingTelegramNotification[] };
        }
      }

      const stats = await queryOne<{ pts: number; cnt: number }>(
        `SELECT COALESCE(SUM(reward_points), 0)::int AS pts, COUNT(*)::int AS cnt
         FROM ad_sessions
         WHERE user_id = $1 AND provider_id = $2 AND status = 'verified' AND created_at >= $3`,
        [session.user_id, provider.id, startIso],
        client
      );

      if ((stats?.cnt || 0) >= provider.daily_limit || (stats?.pts || 0) + session.reward_points > maxAdEarn) {
        throw new Error('Daily ad earning cap reached');
      }

      const updated = await client.query(
        "UPDATE ad_sessions SET status = 'verified', provider_tx_id = $1, verified_at = $2 WHERE id = $3 AND status = 'initiated'",
        [txId, new Date().toISOString(), session.id]
      );

      if ((updated.rowCount ?? 0) === 0) {
        return { duplicateTx: false, balance: null as number | null, notifications: [] as PendingTelegramNotification[] };
      }

      const credit = await creditUserPointsInTx(client, {
        userId: session.user_id,
        points: session.reward_points,
        txType: 'ad_reward',
        description: `Verified ad view #${session.slot_number} (${provider.name})`,
        referenceId: txId || session.id,
      });

      return { duplicateTx: false, balance: credit.newBalance, notifications: credit.notifications };
    });

    if (outcome.duplicateTx) {
      await recordAdPostback({
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

    dispatchPendingNotifications(outcome.notifications);

    await recordAdPostback({
      providerId: provider.id,
      sessionId: clickId,
      txId,
      status: 'verified',
      rawReward: rawRewardStr || String(session.reward_points),
      ip,
    });

    const userRow = await queryOne<{ telegram_id: string }>('SELECT telegram_id FROM users WHERE id = $1', [
      session.user_id,
    ]);
    if (userRow && outcome.balance !== null) {
      void notifyTelegramUser(
        userRow.telegram_id,
        `<b>Ad Reward Credited!</b>\n+${session.reward_points} PTS verified from ${provider.name}.\nAvailable Balance: <b>${outcome.balance} PTS</b>`
      );
    }
    res.json({ ok: true, balance: outcome.balance });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Verification failed';
    await recordAdPostback({
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
});

app.get('/api/ads/postback', handleAdPostback);
app.post('/api/ads/postback', handleAdPostback);

// ==========================================
// 5. SERVER-VERIFIED MINI-GAMES
// ==========================================

app.post(
  '/api/games/:id/start',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const gameId = Number(req.params.id);
    const settings = await getSettingsMap();
    if (settings.maintenanceMode === 'true' || settings.gamesEnabled === 'false') {
      res.status(403).json({ error: 'Mini-games are currently paused by admin' });
      return;
    }
    const game = await queryOne<{ id: number; daily_limit: number; cooldown_seconds: number }>(
      'SELECT * FROM games WHERE id = $1 AND is_active = 1',
      [gameId]
    );

    if (!game) {
      res.status(404).json({ error: 'Game not found or disabled' });
      return;
    }

    const { startIso } = getUtcDayBounds(0);
    const [playsRow, lastPlay] = await Promise.all([
      queryOne<{ cnt: number }>(
        'SELECT COUNT(*)::int AS cnt FROM game_plays WHERE user_id = $1 AND game_id = $2 AND created_at >= $3',
        [userId, gameId, startIso]
      ),
      queryOne<{ created_at: string }>(
        'SELECT created_at FROM game_plays WHERE user_id = $1 AND game_id = $2 ORDER BY id DESC LIMIT 1',
        [userId, gameId]
      ),
    ]);

    if ((playsRow?.cnt || 0) >= game.daily_limit) {
      res.status(429).json({ error: 'Daily play limit reached for this game' });
      return;
    }

    if (lastPlay) {
      const elapsed = (Date.now() - new Date(lastPlay.created_at).getTime()) / 1000;
      if (elapsed < game.cooldown_seconds) {
        res.status(429).json({ error: `Cooldown active. Wait ${Math.ceil(game.cooldown_seconds - elapsed)}s` });
        return;
      }
    }

    const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
    if (maxDaily > 0 && (await getUserDailyEarnedPoints(userId)) >= maxDaily) {
      res.status(429).json({ error: `Daily earning limit of ${maxDaily} PTS reached` });
      return;
    }

    const nonce = `gm_${crypto.randomBytes(12).toString('hex')}`;
    await execute(
      "INSERT INTO game_sessions (nonce, user_id, game_id, status, created_at) VALUES ($1, $2, $3, 'started', $4)",
      [nonce, userId, gameId, new Date().toISOString()]
    );

    res.json({ ok: true, nonce });
  })
);

app.post(
  '/api/games/:id/claim',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const gameId = Number(req.params.id);
    const { nonce, score } = req.body as { nonce?: string; score?: number };
    const settings = await getSettingsMap();
    if (settings.maintenanceMode === 'true' || settings.gamesEnabled === 'false') {
      res.status(403).json({ error: 'Mini-games are currently paused by admin' });
      return;
    }

    if (!nonce || typeof nonce !== 'string') {
      res.status(400).json({ error: 'Missing server game session nonce' });
      return;
    }

    const game = await queryOne<{
      id: number;
      slug: string;
      game_type: string;
      title: string;
      reward_min: number;
      reward_max: number;
      daily_limit: number;
    }>('SELECT * FROM games WHERE id = $1 AND is_active = 1', [gameId]);

    if (!game) {
      res.status(404).json({ error: 'Game unavailable' });
      return;
    }

    try {
      const result = await withTransaction(async (client) => {
        const gs = await queryOne<{ nonce: string; created_at: string }>(
          "SELECT nonce, created_at FROM game_sessions WHERE nonce = $1 AND user_id = $2 AND game_id = $3 AND status = 'started' FOR UPDATE",
          [nonce, userId, gameId],
          client
        );

        if (!gs) {
          throw new Error('Invalid or already claimed game session');
        }

        const { startIso } = getUtcDayBounds(0);
        const playsRow = await queryOne<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM game_plays WHERE user_id = $1 AND game_id = $2 AND created_at >= $3',
          [userId, gameId, startIso],
          client
        );

        if ((playsRow?.cnt || 0) >= game.daily_limit) {
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

        await client.query("UPDATE game_sessions SET status = 'claimed' WHERE nonce = $1", [nonce]);
        const now = new Date().toISOString();
        await client.query(
          'INSERT INTO game_plays (user_id, game_id, score, reward_points, created_at) VALUES ($1, $2, $3, $4, $5)',
          [userId, gameId, Math.floor(Number(score || reward)), reward, now]
        );

        const credit = await creditUserPointsInTx(client, {
          userId,
          points: reward,
          txType: 'game_reward',
          description: `Mini-game reward: ${game.title}`,
          referenceId: nonce,
        });

        return { reward, balance: credit.newBalance, notifications: credit.notifications };
      });

      dispatchPendingNotifications(result.notifications);
      res.json({ ok: true, reward: result.reward, balance: result.balance });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Game claim failed' });
    }
  })
);

// ==========================================
// 6. WALLET & WITHDRAWALS
// ==========================================

app.post(
  '/api/withdrawals',
  requireUserAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.userId!;
    const { methodId, network, accountAddress, pointsAmount } = req.body as {
      methodId?: number;
      network?: string;
      accountAddress?: string;
      pointsAmount?: number;
    };

    const settings = await getSettingsMap();
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

    const method = await queryOne<{
      id: number;
      name: string;
      code: string;
      networks_json: string;
      min_points: number;
      max_points: number;
      fee_percent: number;
    }>("SELECT * FROM withdrawal_methods WHERE id = $1 AND is_active = 1 AND LOWER(code) IN ('bkash', 'nagad')", [
      Number(methodId),
    ]);

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

    try {
      const result = await withTransaction(async (client) => {
        const user = await queryOne<{ points_balance: number }>(
          'SELECT points_balance FROM users WHERE id = $1 FOR UPDATE',
          [userId],
          client
        );
        if (!user || user.points_balance < pts) {
          throw new Error('Insufficient available balance');
        }

        const newBalance = user.points_balance - pts;
        await client.query('UPDATE users SET points_balance = $1, pending_balance = pending_balance + $2 WHERE id = $3', [
          newBalance,
          pts,
          userId,
        ]);

        const wdRow = await queryOne<{ id: number }>(
          `INSERT INTO withdrawals (user_id, method_id, method_name, network, account_address, points_amount, usdt_amount, fee_usdt, net_usdt, fee_points, net_points, bdt_amount, fee_bdt, net_bdt, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, $7, $8, $9, $10, $11, 'pending', $12, $13)
           RETURNING id`,
          [
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
            now,
          ],
          client
        );

        const withdrawalId = wdRow?.id ?? 0;

        await client.query(
          `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
           VALUES ($1, 'withdrawal_hold', $2, $3, $4, $5, $6)`,
          [userId, -pts, newBalance, `Withdrawal request via ${method.name} (${cleanNetwork})`, `wd_${withdrawalId}`, now]
        );

        return { withdrawalId, newBalance };
      });

      const uRow = await queryOne<{ username: string; telegram_id: string }>(
        'SELECT username, telegram_id FROM users WHERE id = $1',
        [userId]
      );
      void notifyTelegramAdmins(
        `<b>New Withdrawal Request #${result.withdrawalId}</b>\nUser: @${uRow?.username || 'user'} (ID: <code>${uRow?.telegram_id || userId}</code>)\nMethod: <b>${method.name}</b> (${cleanNetwork})\nNumber: <code>${cleanAddress}</code>\nAmount: <b>${pts} PTS</b> (Net: <b>৳${netBdt.toFixed(2)} BDT</b>)`
      );
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Withdrawal failed' });
    }
  })
);

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

app.get(
  '/api/admin/auth/status',
  asyncHandler(async (_req, res) => {
    const envConfigured = Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0);
    const telegramAdminIdsConfigured =
      (process.env.TELEGRAM_ADMIN_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean).length > 0;
    const countRow = await queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM admin_credentials');
    const existingCount = countRow?.cnt || 0;
    res.json({
      needsInitialSetup: !envConfigured && existingCount === 0,
      envOverrideActive: envConfigured,
      telegramAdminIdsConfigured,
    });
  })
);

app.post(
  '/api/admin/auth/claim',
  asyncHandler(async (req, res) => {
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

    try {
      await withTransaction(async (client) => {
        const countRow = await queryOne<{ cnt: number }>(
          'SELECT COUNT(*)::int AS cnt FROM admin_credentials',
          [],
          client
        );
        if ((countRow?.cnt || 0) > 0) {
          throw new Error('Admin account already claimed');
        }
        const hash = hashPassword(password);
        await client.query('INSERT INTO admin_credentials (email, password_hash, created_at) VALUES ($1, $2, $3)', [
          cleanEmail,
          hash,
          new Date().toISOString(),
        ]);
      });

      const token = signSessionToken({ sub: cleanEmail, role: 'admin' }, 60 * 60 * 12);
      await logAdminAudit(cleanEmail, 'ADMIN_CLAIMED', 'admin', cleanEmail, {});
      res.json({ ok: true, token, email: cleanEmail });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Claim failed' });
    }
  })
);

app.post(
  '/api/admin/auth/login',
  asyncHandler(async (req, res) => {
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

    const admin = await queryOne<{ email: string; password_hash: string }>(
      'SELECT * FROM admin_credentials WHERE email = $1',
      [cleanEmail]
    );

    if (!admin || !verifyPassword(password, admin.password_hash)) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const token = signSessionToken({ sub: admin.email, role: 'admin', telegramId: verifiedTgAdminId }, 60 * 60 * 12);
    res.json({ ok: true, token, email: admin.email });
  })
);

app.get(
  '/api/admin/overview',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const { startIso } = getUtcDayBounds(0);
    const activeThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();

    const [
      userAgg,
      activeUsersRow,
      newUsersTodayRow,
      wdTotalRow,
      wdPaidRow,
      wdPendingRow,
      referralsRow,
      adImpressionsRow,
      verifiedAdsRow,
      verifiedAdsTodayRow,
      postbackErrorsRow,
      activeProvidersRow,
      dailyPointsRow,
      pendingTaskReviewsRow,
      recentAudits,
    ] = await Promise.all([
      queryOne<{ total_users: number; total_earned: number; total_withdrawn: number }>(
        `SELECT COUNT(*)::int AS total_users,
                COALESCE(SUM(total_earned), 0)::int AS total_earned,
                COALESCE(SUM(total_withdrawn), 0)::int AS total_withdrawn
         FROM users`
      ),
      queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users WHERE last_seen_at >= $1', [activeThreshold]),
      queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users WHERE created_at >= $1', [startIso]),
      queryOne<{ sum_bdt: number }>('SELECT COALESCE(SUM(net_bdt), 0)::double precision AS sum_bdt FROM withdrawals'),
      queryOne<{ sum_bdt: number }>(
        "SELECT COALESCE(SUM(net_bdt), 0)::double precision AS sum_bdt FROM withdrawals WHERE status = 'paid'"
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM withdrawals WHERE status = 'pending'"),
      queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM users WHERE referred_by_user_id IS NOT NULL'),
      queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM ad_sessions'),
      queryOne<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM ad_sessions WHERE status = 'verified'"),
      queryOne<{ cnt: number }>(
        "SELECT COUNT(*)::int AS cnt FROM ad_sessions WHERE status = 'verified' AND created_at >= $1",
        [startIso]
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM ad_postbacks WHERE status != 'verified'"),
      queryOne<{ cnt: number }>('SELECT COUNT(*)::int AS cnt FROM ad_providers WHERE is_active = 1'),
      queryOne<{ sum_pts: number }>(
        'SELECT COALESCE(SUM(amount_points), 0)::int AS sum_pts FROM transactions WHERE amount_points > 0 AND created_at >= $1',
        [startIso]
      ),
      queryOne<{ cnt: number }>("SELECT COUNT(*)::int AS cnt FROM task_submissions WHERE status = 'pending'"),
      queryAll('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 20'),
    ]);

    const metrics = {
      totalUsers: userAgg?.total_users || 0,
      activeUsers: activeUsersRow?.cnt || 0,
      newUsersToday: newUsersTodayRow?.cnt || 0,
      totalPointsDistributed: userAgg?.total_earned || 0,
      totalPointsWithdrawn: userAgg?.total_withdrawn || 0,
      totalWithdrawalRequestsBdt: Number(wdTotalRow?.sum_bdt || 0),
      totalPaidWithdrawalsBdt: Number(wdPaidRow?.sum_bdt || 0),
      pendingWithdrawals: wdPendingRow?.cnt || 0,
      totalReferrals: referralsRow?.cnt || 0,
      adImpressionsTotal: adImpressionsRow?.cnt || 0,
      verifiedAdsTotal: verifiedAdsRow?.cnt || 0,
      verifiedAdsToday: verifiedAdsTodayRow?.cnt || 0,
      postbackErrorsCount: postbackErrorsRow?.cnt || 0,
      activeAdProvidersCount: activeProvidersRow?.cnt || 0,
      dailyPointsEarned: dailyPointsRow?.sum_pts || 0,
      pendingTaskReviews: pendingTaskReviewsRow?.cnt || 0,
    };

    res.json({ metrics, recentAudits });
  })
);

// Admin Users Management
app.get(
  '/api/admin/users',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const users = q
      ? await queryAll(
          `SELECT * FROM users
           WHERE username ILIKE $1 OR telegram_id ILIKE $1 OR first_name ILIKE $1 OR referral_code ILIKE $1
           ORDER BY id DESC LIMIT 100`,
          [`%${q}%`]
        )
      : await queryAll('SELECT * FROM users ORDER BY id DESC LIMIT 100');
    res.json({ users });
  })
);

app.get(
  '/api/admin/users/:id/transactions',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const transactions = await queryAll('SELECT * FROM transactions WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [
      Number(req.params.id),
    ]);
    res.json({ transactions });
  })
);

app.post(
  '/api/admin/users/:id/block',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = Number(req.params.id);
    const { blocked } = req.body as { blocked?: boolean };
    const val = blocked ? 1 : 0;
    await execute('UPDATE users SET is_blocked = $1 WHERE id = $2', [val, userId]);
    await logAdminAudit(req.adminEmail!, val ? 'USER_BLOCKED' : 'USER_UNBLOCKED', 'user', userId, {
      blocked: Boolean(val),
    });
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/users/:id/adjust-balance',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = Number(req.params.id);
    const { deltaPoints, reason } = req.body as { deltaPoints?: number; reason?: string };
    const delta = Math.trunc(Number(deltaPoints || 0));
    const cleanReason = (reason || 'Admin balance adjustment').trim().slice(0, 200);
    if (!delta) {
      res.status(400).json({ error: 'Non-zero integer deltaPoints required' });
      return;
    }

    try {
      const newBalance = await withTransaction(async (client) => {
        const user = await queryOne<{ points_balance: number }>(
          'SELECT points_balance FROM users WHERE id = $1 FOR UPDATE',
          [userId],
          client
        );
        if (!user) throw new Error('User not found');
        const newBal = Math.max(0, user.points_balance + delta);
        const actualDelta = newBal - user.points_balance;
        const now = new Date().toISOString();

        await client.query('UPDATE users SET points_balance = $1, total_earned = total_earned + $2 WHERE id = $3', [
          newBal,
          actualDelta > 0 ? actualDelta : 0,
          userId,
        ]);
        await client.query(
          `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
           VALUES ($1, 'admin_adjustment', $2, $3, $4, $5, $6)`,
          [userId, actualDelta, newBal, cleanReason, `adm_${Date.now()}`, now]
        );

        await logAdminAudit(
          req.adminEmail!,
          'BALANCE_ADJUSTED',
          'user',
          userId,
          { delta: actualDelta, newBal, reason: cleanReason },
          client
        );
        return newBal;
      });

      res.json({ ok: true, newBalance });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Adjustment failed' });
    }
  })
);

// Admin Tasks & Submissions Management
app.get(
  '/api/admin/tasks',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const [tasks, submissions] = await Promise.all([
      queryAll(
        'SELECT id, title, description, category, icon_url, target_url, reward_points, verification_type, daily_limit, expires_at, is_active, created_at FROM tasks ORDER BY id DESC'
      ),
      queryAll(
        `SELECT s.*, u.username, u.telegram_id, t.title AS task_title, t.reward_points
         FROM task_submissions s
         JOIN users u ON u.id = s.user_id
         JOIN tasks t ON t.id = s.task_id
         ORDER BY CASE WHEN s.status = 'pending' THEN 0 ELSE 1 END, s.id DESC
         LIMIT 100`
      ),
    ]);
    res.json({ tasks, submissions });
  })
);

app.post(
  '/api/admin/tasks',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { title, description, category, iconUrl, targetUrl, rewardPoints, verificationType, secretCode, dailyLimit, expiresAt, isActive } =
      req.body as Record<string, unknown>;

    if (!title || !description || !category) {
      res.status(400).json({ error: 'Title, description, and category are required' });
      return;
    }

    const row = await queryOne<{ id: number }>(
      `INSERT INTO tasks (title, description, category, icon_url, target_url, reward_points, verification_type, secret_code_hash, daily_limit, expires_at, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id`,
      [
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
        new Date().toISOString(),
      ]
    );

    const newId = row?.id ?? 0;
    await logAdminAudit(req.adminEmail!, 'TASK_CREATED', 'task', newId, { title });
    res.json({ ok: true, id: newId });
  })
);

app.put(
  '/api/admin/tasks/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const taskId = Number(req.params.id);
    const { title, description, category, iconUrl, targetUrl, rewardPoints, verificationType, secretCode, dailyLimit, expiresAt, isActive } =
      req.body as Record<string, unknown>;

    const existing = await queryOne<{ secret_code_hash: string }>('SELECT secret_code_hash FROM tasks WHERE id = $1', [
      taskId,
    ]);
    if (!existing) {
      res.status(404).json({ error: 'Task not found' });
      return;
    }

    await execute(
      `UPDATE tasks SET title = $1, description = $2, category = $3, icon_url = $4, target_url = $5, reward_points = $6, verification_type = $7, secret_code_hash = $8, daily_limit = $9, expires_at = $10, is_active = $11
       WHERE id = $12`,
      [
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
        taskId,
      ]
    );

    await logAdminAudit(req.adminEmail!, 'TASK_UPDATED', 'task', taskId, { title, isActive });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/tasks/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const taskId = Number(req.params.id);
    await execute('DELETE FROM tasks WHERE id = $1', [taskId]);
    await logAdminAudit(req.adminEmail!, 'TASK_DELETED', 'task', taskId, {});
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/submissions/:id/review',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const subId = Number(req.params.id);
    const { decision, note } = req.body as { decision?: 'approved' | 'rejected'; note?: string };
    if (decision !== 'approved' && decision !== 'rejected') {
      res.status(400).json({ error: 'Invalid decision' });
      return;
    }

    try {
      const notifications = await withTransaction(async (client) => {
        const sub = await queryOne<{
          id: number;
          user_id: number;
          task_id: number;
          status: string;
        }>('SELECT id, user_id, task_id, status FROM task_submissions WHERE id = $1 FOR UPDATE', [subId], client);

        if (!sub) throw new Error('Submission not found');
        if (sub.status !== 'pending') throw new Error('Submission already reviewed');

        const task = await queryOne<{ title: string; reward_points: number }>(
          'SELECT title, reward_points FROM tasks WHERE id = $1',
          [sub.task_id],
          client
        );
        if (!task) throw new Error('Associated task not found');

        const now = new Date().toISOString();
        await client.query('UPDATE task_submissions SET status = $1, review_note = $2, reviewed_at = $3 WHERE id = $4', [
          decision,
          (note || '').trim().slice(0, 200),
          now,
          subId,
        ]);

        let pendingNotes: PendingTelegramNotification[] = [];
        if (decision === 'approved') {
          const credit = await creditUserPointsInTx(client, {
            userId: sub.user_id,
            points: task.reward_points,
            txType: 'task_reward',
            description: `Approved task: ${task.title}`,
            referenceId: `sub_${subId}`,
          });
          pendingNotes = credit.notifications;
        }

        await logAdminAudit(
          req.adminEmail!,
          `SUBMISSION_${decision.toUpperCase()}`,
          'task_submission',
          subId,
          { userId: sub.user_id, reward: task.reward_points },
          client
        );

        return pendingNotes;
      });

      dispatchPendingNotifications(notifications);

      const subInfo = await queryOne<{ telegram_id: string; title: string; reward_points: number }>(
        `SELECT u.telegram_id, t.title, t.reward_points
         FROM task_submissions s
         JOIN users u ON u.id = s.user_id
         JOIN tasks t ON t.id = s.task_id
         WHERE s.id = $1`,
        [subId]
      );
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
  })
);

// Admin Global Transaction History
app.get(
  '/api/admin/transactions',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const type = typeof req.query.type === 'string' ? req.query.type.trim() : '';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (type && type !== 'all') {
      params.push(type);
      conditions.push(`t.type = $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      const p = `$${params.length}`;
      conditions.push(`(u.username ILIKE ${p} OR u.telegram_id ILIKE ${p} OR t.description ILIKE ${p} OR t.reference_id ILIKE ${p})`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const transactions = await queryAll(
      `SELECT t.*, u.username, u.telegram_id
       FROM transactions t
       JOIN users u ON u.id = t.user_id
       ${whereClause}
       ORDER BY t.id DESC LIMIT 150`,
      params
    );

    res.json({ transactions });
  })
);

// Admin Advertisement Providers, Performance & Postback Logs
app.get(
  '/api/admin/ads',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const settings = await getSettingsMap();
    const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));
    const rawProviders = await queryAll<{
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
    }>(
      `SELECT id, name, provider_type, sdk_zone_id, placement_id, api_key, ad_url_template, reward_points, payout_per_conversion_bdt, daily_limit, reset_hour_utc, is_active, created_at
       FROM ad_providers ORDER BY id DESC`
    );

    const providers = await Promise.all(
      rawProviders.map(async ({ api_key, ...rest }) => {
        const [sessStats, pbStats] = await Promise.all([
          queryOne<{
            impressions: number;
            verified_conversions: number;
            user_reward_points_cost: number;
          }>(
            `SELECT COUNT(*)::int AS impressions,
                    COALESCE(SUM(CASE WHEN status = 'verified' THEN 1 ELSE 0 END), 0)::int AS verified_conversions,
                    COALESCE(SUM(CASE WHEN status = 'verified' THEN reward_points ELSE 0 END), 0)::int AS user_reward_points_cost
             FROM ad_sessions WHERE provider_id = $1`,
            [rest.id]
          ),
          queryOne<{ duplicate_count: number; error_count: number }>(
            `SELECT COALESCE(SUM(CASE WHEN status = 'duplicate_tx' THEN 1 ELSE 0 END), 0)::int AS duplicate_count,
                    COALESCE(SUM(CASE WHEN status NOT IN ('verified', 'already_verified', 'duplicate_tx') THEN 1 ELSE 0 END), 0)::int AS error_count
             FROM ad_postbacks WHERE provider_id = $1`,
            [rest.id]
          ),
        ]);

        const impressions = sessStats?.impressions || 0;
        const verifiedConversions = sessStats?.verified_conversions || 0;
        const userRewardPointsCost = sessStats?.user_reward_points_cost || 0;
        const duplicateCount = pbStats?.duplicate_count || 0;
        const errorCount = pbStats?.error_count || 0;
        const userRewardBdtCost = Number((userRewardPointsCost / rate).toFixed(2));
        const estimatedRevenueBdt = Number((verifiedConversions * (rest.payout_per_conversion_bdt || 0)).toFixed(2));

        return {
          ...rest,
          has_api_key: Boolean(api_key),
          api_key_masked: api_key ? `••••${api_key.slice(-4)}` : '',
          impressions,
          verifiedConversions,
          duplicateCount,
          errorCount,
          userRewardPointsCost,
          userRewardBdtCost,
          estimatedRevenueBdt,
        };
      })
    );

    const [sessions, postbacks] = await Promise.all([
      queryAll(
        `SELECT a.*, u.username, p.name AS provider_name
         FROM ad_sessions a
         JOIN users u ON u.id = a.user_id
         JOIN ad_providers p ON p.id = a.provider_id
         ORDER BY a.created_at DESC LIMIT 60`
      ),
      queryAll(
        `SELECT pb.*, COALESCE(p.name, 'Unknown') AS provider_name
         FROM ad_postbacks pb
         LEFT JOIN ad_providers p ON p.id = pb.provider_id
         ORDER BY pb.id DESC LIMIT 60`
      ),
    ]);

    const summary = {
      impressions: providers.reduce((s, p) => s + p.impressions, 0),
      verifiedConversions: providers.reduce((s, p) => s + p.verifiedConversions, 0),
      duplicateOrErrors: providers.reduce((s, p) => s + p.duplicateCount + p.errorCount, 0),
      userRewardPointsCost: providers.reduce((s, p) => s + p.userRewardPointsCost, 0),
      userRewardBdtCost: Number(providers.reduce((s, p) => s + p.userRewardBdtCost, 0).toFixed(2)),
      estimatedRevenueBdt: Number(providers.reduce((s, p) => s + p.estimatedRevenueBdt, 0).toFixed(2)),
    };

    res.json({ providers, sessions, postbacks, summary });
  })
);

app.post(
  '/api/admin/ads/providers',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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

    const row = await queryOne<{ id: number }>(
      `INSERT INTO ad_providers (name, provider_type, sdk_zone_id, placement_id, api_key, ad_url_template, postback_secret_hash, reward_points, payout_per_conversion_bdt, daily_limit, reset_hour_utc, is_active, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
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
        new Date().toISOString(),
      ]
    );

    const newId = row?.id ?? 0;
    await logAdminAudit(req.adminEmail!, 'AD_PROVIDER_CREATED', 'ad_provider', newId, { name });
    res.json({ ok: true, id: newId });
  })
);

app.put(
  '/api/admin/ads/providers/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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

    const existing = await queryOne<{ postback_secret_hash: string; api_key: string; ad_url_template: string }>(
      'SELECT postback_secret_hash, api_key, ad_url_template FROM ad_providers WHERE id = $1',
      [id]
    );
    if (!existing) {
      res.status(404).json({ error: 'Ad provider not found' });
      return;
    }

    const cleanAdUrl = sanitizeExternalUrl(String(adUrlTemplate || '')) || existing.ad_url_template;

    await execute(
      `UPDATE ad_providers SET name = $1, provider_type = $2, sdk_zone_id = $3, placement_id = $4, api_key = $5, ad_url_template = $6, postback_secret_hash = $7, reward_points = $8, payout_per_conversion_bdt = $9, daily_limit = $10, reset_hour_utc = $11, is_active = $12
       WHERE id = $13`,
      [
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
        id,
      ]
    );

    await logAdminAudit(req.adminEmail!, 'AD_PROVIDER_UPDATED', 'ad_provider', id, {
      name,
      rewardPoints,
      dailyLimit,
      isActive,
    });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/ads/providers/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = Number(req.params.id);
    await execute('DELETE FROM ad_providers WHERE id = $1', [id]);
    await logAdminAudit(req.adminEmail!, 'AD_PROVIDER_DELETED', 'ad_provider', id, {});
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/ads/sessions/:id/verify',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const sessionId = req.params.id;

    try {
      const outcome = await withTransaction(async (client) => {
        const session = await queryOne<{
          id: string;
          user_id: number;
          provider_id: number;
          slot_number: number;
          status: string;
          reward_points: number;
        }>('SELECT * FROM ad_sessions WHERE id = $1 FOR UPDATE', [sessionId], client);

        if (!session) {
          return { notFound: true, alreadyVerified: false, notifications: [] as PendingTelegramNotification[] };
        }
        if (session.status === 'verified') {
          return { notFound: false, alreadyVerified: true, notifications: [] as PendingTelegramNotification[] };
        }

        await client.query("UPDATE ad_sessions SET status = 'verified', verified_at = $1 WHERE id = $2", [
          new Date().toISOString(),
          session.id,
        ]);
        const credit = await creditUserPointsInTx(client, {
          userId: session.user_id,
          points: session.reward_points,
          txType: 'ad_reward',
          description: `Admin-verified ad session #${session.slot_number}`,
          referenceId: session.id,
        });
        await logAdminAudit(
          req.adminEmail!,
          'AD_SESSION_MANUALLY_VERIFIED',
          'ad_session',
          session.id,
          { userId: session.user_id, reward: session.reward_points },
          client
        );

        return { notFound: false, alreadyVerified: false, notifications: credit.notifications };
      });

      if (outcome.notFound) {
        res.status(404).json({ error: 'Ad session not found' });
        return;
      }
      if (outcome.alreadyVerified) {
        res.json({ ok: true, alreadyVerified: true });
        return;
      }

      dispatchPendingNotifications(outcome.notifications);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Manual verification failed' });
    }
  })
);

// Admin Withdrawals & Payment Methods (bKash and Nagad only)
app.get(
  '/api/admin/withdrawals',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const [methods, withdrawals] = await Promise.all([
      queryAll<{
        id: number;
        name: string;
        code: string;
        networks_json: string;
        min_points: number;
        max_points: number;
        fee_percent: number;
        is_active: number;
      }>("SELECT * FROM withdrawal_methods WHERE LOWER(code) IN ('bkash', 'nagad') ORDER BY id ASC"),
      queryAll(
        `SELECT w.id, w.user_id, w.method_id, w.method_name, w.network, w.account_address, w.points_amount,
                w.fee_points, w.net_points, w.bdt_amount, w.fee_bdt, w.net_bdt, w.status, w.admin_note, w.tx_hash,
                w.created_at, w.updated_at, u.username, u.telegram_id
         FROM withdrawals w JOIN users u ON u.id = w.user_id
         ORDER BY CASE WHEN w.status = 'pending' THEN 0 WHEN w.status = 'approved' THEN 1 ELSE 2 END, w.id DESC
         LIMIT 150`
      ),
    ]);

    res.json({
      methods: methods.map((m) => ({ ...m, networks: JSON.parse(m.networks_json || '[]') })),
      withdrawals,
    });
  })
);

app.post(
  '/api/admin/withdrawal-methods',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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
      await execute(
        `UPDATE withdrawal_methods SET name = $1, code = $2, networks_json = $3, min_points = $4, max_points = $5, fee_percent = $6, is_active = $7 WHERE id = $8`,
        [
          name.trim(),
          cleanCode,
          networksJson,
          Math.max(1, Math.floor(Number(minPoints || 500))),
          Math.max(1, Math.floor(Number(maxPoints || 100000))),
          Math.max(0, Number(feePercent || 0)),
          isActive === false ? 0 : 1,
          id,
        ]
      );
    } else {
      await execute(
        `INSERT INTO withdrawal_methods (name, code, networks_json, min_points, max_points, fee_percent, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          name.trim(),
          cleanCode,
          networksJson,
          Math.max(1, Math.floor(Number(minPoints || 500))),
          Math.max(1, Math.floor(Number(maxPoints || 100000))),
          Math.max(0, Number(feePercent || 0)),
          isActive === false ? 0 : 1,
        ]
      );
    }
    await logAdminAudit(req.adminEmail!, 'WITHDRAWAL_METHOD_SAVED', 'withdrawal_method', id || cleanCode, { name });
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/withdrawals/:id/status',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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

    try {
      await withTransaction(async (client) => {
        const wd = await queryOne<{
          id: number;
          user_id: number;
          points_amount: number;
          status: string;
          method_name: string;
        }>('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE', [wdId], client);

        if (!wd) throw new Error('Withdrawal not found');
        if (wd.status === 'paid' || wd.status === 'rejected') {
          throw new Error('Finalized withdrawals cannot be modified');
        }

        const now = new Date().toISOString();
        await client.query(
          'UPDATE withdrawals SET status = $1, admin_note = $2, tx_hash = $3, updated_at = $4 WHERE id = $5',
          [status, (adminNote || '').trim().slice(0, 250), (txHash || '').trim().slice(0, 150), now, wdId]
        );

        if (status === 'rejected') {
          const user = await queryOne<{ points_balance: number; pending_balance: number }>(
            'SELECT points_balance, pending_balance FROM users WHERE id = $1 FOR UPDATE',
            [wd.user_id],
            client
          );
          if (!user) throw new Error('User not found');
          const newBal = user.points_balance + wd.points_amount;
          const newPending = Math.max(0, user.pending_balance - wd.points_amount);
          await client.query('UPDATE users SET points_balance = $1, pending_balance = $2 WHERE id = $3', [
            newBal,
            newPending,
            wd.user_id,
          ]);
          await client.query(
            `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
             VALUES ($1, 'withdrawal_refund', $2, $3, $4, $5, $6)`,
            [
              wd.user_id,
              wd.points_amount,
              newBal,
              `Withdrawal rejected & refunded (${wd.method_name})`,
              `wd_ref_${wdId}`,
              now,
            ]
          );
        } else if (status === 'paid') {
          const user = await queryOne<{ pending_balance: number }>(
            'SELECT pending_balance FROM users WHERE id = $1 FOR UPDATE',
            [wd.user_id],
            client
          );
          const newPending = Math.max(0, (user?.pending_balance || 0) - wd.points_amount);
          await client.query(
            'UPDATE users SET pending_balance = $1, total_withdrawn = total_withdrawn + $2 WHERE id = $3',
            [newPending, wd.points_amount, wd.user_id]
          );
        }

        await logAdminAudit(
          req.adminEmail!,
          `WITHDRAWAL_${status.toUpperCase()}`,
          'withdrawal',
          wdId,
          { userId: wd.user_id, points: wd.points_amount, txHash: txHash || '' },
          client
        );
      });

      const wdInfo = await queryOne<{
        method_name: string;
        network: string;
        account_address: string;
        points_amount: number;
        net_bdt: number;
        admin_note: string;
        tx_hash: string;
        telegram_id: string;
      }>(
        `SELECT w.method_name, w.network, w.account_address, w.points_amount, w.net_bdt, w.admin_note, w.tx_hash, u.telegram_id
         FROM withdrawals w JOIN users u ON u.id = w.user_id WHERE w.id = $1`,
        [wdId]
      );
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
  })
);

// Admin Games Management (Create, Edit, Enable/Disable, Delete)
app.get(
  '/api/admin/games',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const [games, recentPlays] = await Promise.all([
      queryAll('SELECT * FROM games ORDER BY id ASC'),
      queryAll(
        `SELECT gp.*, u.username, g.title AS game_title
         FROM game_plays gp
         JOIN users u ON u.id = gp.user_id
         JOIN games g ON g.id = gp.game_id
         ORDER BY gp.id DESC LIMIT 50`
      ),
    ]);
    res.json({ games, recentPlays });
  })
);

app.post(
  '/api/admin/games',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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
    const baseSlug =
      cleanTitle
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 28) || 'game';
    const slug = `${baseSlug}-${crypto.randomBytes(3).toString('hex')}`;
    const minPts = Math.max(1, Math.floor(Number(rewardMin || 5)));
    const maxPts = Math.max(minPts, Math.floor(Number(rewardMax || 30)));

    const row = await queryOne<{ id: number }>(
      `INSERT INTO games (slug, game_type, title, description, icon_url, target_url, reward_min, reward_max, daily_limit, cooldown_seconds, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
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
        isActive === false ? 0 : 1,
      ]
    );

    const newId = row?.id ?? 0;
    await logAdminAudit(req.adminEmail!, 'GAME_CREATED', 'game', newId, { title: cleanTitle, gameType: cleanType });
    res.json({ ok: true, id: newId });
  })
);

app.put(
  '/api/admin/games/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const gameId = Number(req.params.id);
    const { title, description, gameType, iconUrl, targetUrl, rewardMin, rewardMax, dailyLimit, cooldownSeconds, isActive } =
      req.body as Record<string, unknown>;

    const existing = await queryOne<{ game_type: string; icon_url: string; target_url: string }>(
      'SELECT game_type, icon_url, target_url FROM games WHERE id = $1',
      [gameId]
    );
    if (!existing) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }

    const allowedTypes = new Set(['spin_wheel', 'prism_memory', 'vault_tap', 'external_offer']);
    const cleanType = allowedTypes.has(String(gameType || '')) ? String(gameType) : existing.game_type;
    const minPts = Math.max(1, Math.floor(Number(rewardMin || 5)));
    const maxPts = Math.max(minPts, Math.floor(Number(rewardMax || 30)));

    await execute(
      `UPDATE games SET title = $1, description = $2, game_type = $3, icon_url = $4, target_url = $5, reward_min = $6, reward_max = $7, daily_limit = $8, cooldown_seconds = $9, is_active = $10 WHERE id = $11`,
      [
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
        gameId,
      ]
    );

    await logAdminAudit(req.adminEmail!, 'GAME_UPDATED', 'game', gameId, { title, isActive });
    res.json({ ok: true });
  })
);

app.delete(
  '/api/admin/games/:id',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const gameId = Number(req.params.id);
    const info = await execute('DELETE FROM games WHERE id = $1', [gameId]);
    if (info.rowCount === 0) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    await logAdminAudit(req.adminEmail!, 'GAME_DELETED', 'game', gameId, {});
    res.json({ ok: true });
  })
);

// Admin Languages & Full Text Editor
app.get(
  '/api/admin/i18n',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const [languages, translations, settings] = await Promise.all([
      queryAll('SELECT * FROM languages ORDER BY code ASC'),
      queryAll('SELECT * FROM translations ORDER BY category ASC, key ASC, lang_code ASC'),
      getSettingsMap(),
    ]);
    res.json({ languages, translations, defaultLanguage: settings.defaultLanguage || 'en' });
  })
);

app.post(
  '/api/admin/i18n/languages',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { code, name, nativeName, isEnabled } = req.body as {
      code?: string;
      name?: string;
      nativeName?: string;
      isEnabled?: boolean;
    };
    const cleanCode = (code || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z-]/g, '')
      .slice(0, 10);
    if (!cleanCode || !name || !nativeName) {
      res.status(400).json({ error: 'Language code, name, and native name are required' });
      return;
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO languages (code, name, native_name, is_enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET
           name = EXCLUDED.name,
           native_name = EXCLUDED.native_name,
           is_enabled = EXCLUDED.is_enabled`,
        [cleanCode, name.trim(), nativeName.trim(), isEnabled === false ? 0 : 1]
      );

      // Copy English keys as starting template if new language has no entries yet
      const enRows = await queryAll<{ key: string; value: string; category: string }>(
        "SELECT key, value, category FROM translations WHERE lang_code = 'en'",
        [],
        client
      );
      for (const r of enRows) {
        await client.query(
          `INSERT INTO translations (lang_code, key, value, category)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (lang_code, key) DO NOTHING`,
          [cleanCode, r.key, r.value, r.category]
        );
      }
    });

    await logAdminAudit(req.adminEmail!, 'LANGUAGE_SAVED', 'language', cleanCode, { name, isEnabled });
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/i18n/translations',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { langCode, updates, defaultLanguage } = req.body as {
      langCode?: string;
      updates?: Array<{ key: string; value: string; category?: string }>;
      defaultLanguage?: string;
    };

    await withTransaction(async (client) => {
      if (langCode && Array.isArray(updates)) {
        for (const item of updates) {
          if (item.key && typeof item.value === 'string') {
            await client.query(
              `INSERT INTO translations (lang_code, key, value, category)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT (lang_code, key) DO UPDATE SET value = EXCLUDED.value`,
              [langCode, item.key, item.value, item.category || 'Custom']
            );
          }
        }
      }
      if (defaultLanguage) {
        await client.query(
          `INSERT INTO app_settings (key, value) VALUES ('defaultLanguage', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [defaultLanguage]
        );
      }
    });

    await logAdminAudit(req.adminEmail!, 'TRANSLATIONS_PUBLISHED', 'i18n', langCode || 'global', {
      count: updates?.length || 0,
      defaultLanguage,
    });
    res.json({ ok: true });
  })
);

// Admin App Settings & Referrals Config
app.get(
  '/api/admin/settings',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const [settings, referrals] = await Promise.all([
      getSettingsMap(),
      queryAll(
        `SELECT u.id, u.username, u.telegram_id, u.referral_qualified, u.created_at, r.username AS referrer_username
         FROM users u
         JOIN users r ON r.id = u.referred_by_user_id
         ORDER BY u.id DESC LIMIT 80`
      ),
    ]);
    res.json({ settings, referrals });
  })
);

app.put(
  '/api/admin/settings',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const payload = req.body as Record<string, unknown>;
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

    await withTransaction(async (client) => {
      for (const [k, v] of Object.entries(payload)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          await client.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [k, String(v)]
          );
        }
      }
    });

    await logAdminAudit(req.adminEmail!, 'SETTINGS_UPDATED', 'app_settings', 'global', Object.keys(payload));
    if (getBotToken()) {
      void configureTelegramBotMenuAndCommands();
    }
    res.json({ ok: true });
  })
);

// Admin Telegram Bot Integration Check, Menu Button & Webhook/Polling Setup
app.get(
  '/api/admin/telegram/status',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const token = getBotToken();
    const publicAppUrl = await getTelegramWebAppUrl();
    const envAppUrlIsAiStudio = isDisallowedAuthProxyUrl(process.env.APP_URL || '');
    const pollingEnabled = isTelegramPollingEnabled();
    const adminIdsConfigured =
      (process.env.TELEGRAM_ADMIN_IDS || '')
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
      const hookJson = (await hookRes.json()) as {
        ok: boolean;
        result?: { url?: string; pending_update_count?: number };
      };
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
  })
);

app.post(
  '/api/admin/telegram/configure-menu',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { publicUrl } = req.body as { publicUrl?: string };
    const result = await configureTelegramBotMenuAndCommands(publicUrl?.trim() || undefined);
    if (!result.ok) {
      res.status(400).json({ error: result.error || 'Failed to configure Telegram Mini App launch button' });
      return;
    }
    await logAdminAudit(req.adminEmail!, 'TELEGRAM_MENU_CONFIGURED', 'telegram_bot', result.botUsername || 'menu', {
      menuButtonUrl: result.menuButtonUrl,
    });
    res.json(result);
  })
);

app.post(
  '/api/admin/telegram/enable-polling',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    const cleared = await clearTelegramWebhook();
    if (!cleared.ok) {
      res.status(400).json({ error: cleared.error || 'Failed to clear Telegram webhook' });
      return;
    }
    startTelegramBotPollingIfEnabled();
    await logAdminAudit(req.adminEmail!, 'TELEGRAM_POLLING_ENABLED', 'telegram_bot', 'polling', {});
    res.json({ ok: true, pollingEnabled: isTelegramPollingEnabled() });
  })
);

app.post(
  '/api/admin/telegram/register-webhook',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
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

    const baseUrl = await getTelegramWebAppUrl(trimmedUrl || undefined);
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
      await execute(
        `INSERT INTO app_settings (key, value) VALUES ('publicAppUrl', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [baseUrl]
      );
      await logAdminAudit(req.adminEmail!, 'TELEGRAM_WEBHOOK_REGISTERED', 'telegram_bot', 'webhook', { webhookUrl });
      res.json({ ok: true, webhookUrl });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Failed to register webhook' });
    }
  })
);

// Admin Server Environment Readiness & Clean Project ZIP Export
app.get(
  '/api/admin/env-status',
  requireAdminAuth,
  asyncHandler(async (_req, res) => {
    const publicAppUrlSet = Boolean(await getTelegramWebAppUrl());
    res.json({
      env: {
        TELEGRAM_BOT_TOKEN: Boolean(getBotToken()),
        TELEGRAM_ADMIN_IDS:
          (process.env.TELEGRAM_ADMIN_IDS || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean).length > 0,
        ADMIN_PASSCODE: Boolean(process.env.ADMIN_PASSCODE && process.env.ADMIN_PASSCODE.trim().length > 0),
        PUBLIC_APP_URL: publicAppUrlSet,
        DATABASE_URL: isUsingRealPostgres(),
        SESSION_SECRET: Boolean(process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length > 0),
        TELEGRAM_BOT_POLLING: isTelegramPollingEnabled(),
      },
      databaseMode: getDatabaseMode(),
      nodeEnv: process.env.NODE_ENV || 'development',
    });
  })
);

app.get(
  '/api/admin/export-project.zip',
  requireAdminAuth,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const zipBuffer = buildCleanProjectZipBuffer(process.cwd());
      await logAdminAudit(req.adminEmail!, 'PROJECT_ZIP_EXPORTED', 'system', 'zip', { bytes: zipBuffer.length });
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="novavault-platform-source.zip"');
      res.send(zipBuffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to package project ZIP' });
    }
  })
);

// ==========================================
// 9. VITE DEV / PRODUCTION STATIC HOSTING
// ==========================================

async function startServer(): Promise<void> {
  await initDatabase();

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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('Unhandled server error:', err);
    if (res.headersSent) return;
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' });
  });

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`NovaVault server listening on http://0.0.0.0:${port} (database: ${getDatabaseMode()})`);
    void initTelegramBot();
  });

  const shutdown = () => {
    server.close(() => {
      void closeDatabase().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void startServer().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
