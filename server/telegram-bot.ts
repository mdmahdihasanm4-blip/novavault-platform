import { db, generateReferralCode, getSettingsMap } from './db.ts';
import { sanitizeExternalUrl } from './security.ts';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      username?: string;
      first_name?: string;
      last_name?: string;
      language_code?: string;
    };
    chat: {
      id: number;
      type: string;
    };
    text?: string;
  };
}

export interface TelegramBotRuntimeState {
  pollingActive: boolean;
  connectedBotUsername: string;
  lastError: string;
  lastPollAt: string;
  menuConfigured: boolean;
  menuButtonUrl: string;
  commandsConfigured: boolean;
}

const runtimeState: TelegramBotRuntimeState = {
  pollingActive: false,
  connectedBotUsername: '',
  lastError: '',
  lastPollAt: '',
  menuConfigured: false,
  menuButtonUrl: '',
  commandsConfigured: false,
};

export function getTelegramBotRuntimeState(): TelegramBotRuntimeState {
  return { ...runtimeState };
}

function redactBotToken(msg: string): string {
  return msg.replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, 'bot[REDACTED]');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function getBotToken(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim().replace(/^["']|["']$/g, '');
}

export function isTelegramPollingEnabled(): boolean {
  const raw = (process.env.TELEGRAM_BOT_POLLING || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

export function getTelegramAdminIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Reject AI Studio dev/preview URLs and Google authentication proxy URLs.
 * Telegram Mini App WebViews cannot complete Google OAuth/AI Studio cookie checks.
 */
export function isDisallowedAuthProxyUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    if (host.startsWith('ais-dev-') || host.startsWith('ais-pre-')) return true;
    if (host === 'aistudio.google.com' || host.endsWith('.aistudio.google.com')) return true;
    if (host === 'accounts.google.com') return true;
    if (host.endsWith('.corp.google.com')) return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
    return false;
  } catch {
    return true;
  }
}

export function getTelegramWebAppUrl(overrideUrl?: string): string {
  const settings = getSettingsMap();
  const candidates = [
    overrideUrl,
    settings.publicAppUrl,
    process.env.PUBLIC_APP_URL,
    process.env.APP_URL,
  ];
  for (const raw of candidates) {
    if (!raw || raw === 'MY_APP_URL') continue;
    const cleaned = raw.trim().replace(/^["']|["']$/g, '');
    const clean = sanitizeExternalUrl(cleaned);
    if (clean && clean.startsWith('https://') && !isDisallowedAuthProxyUrl(clean)) {
      return clean.replace(/\/$/, '');
    }
  }
  return '';
}

/**
 * Verifies that a public HTTPS URL serves NovaVault directly (200 OK JSON on /api/health)
 * without redirecting to a Google Account sign-in or cookie-check page.
 */
export async function verifyPublicUrlAccessibility(baseUrl: string): Promise<{
  ok: boolean;
  error?: string;
}> {
  if (!baseUrl || !baseUrl.startsWith('https://')) {
    return { ok: false, error: 'Public URL must start with https://' };
  }
  if (isDisallowedAuthProxyUrl(baseUrl)) {
    return {
      ok: false,
      error:
        'AI Studio editor/preview URLs (ais-dev / ais-pre) require Google Account sign-in and cannot be used in Telegram. Deploy to a public HTTPS host and set PUBLIC_APP_URL.',
    };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '';
      return {
        ok: false,
        error: `URL redirected (HTTP ${res.status} → ${loc || 'auth wall'}). Telegram Mini Apps require direct public HTTPS access without login redirects.`,
      };
    }
    if (!res.ok) {
      return { ok: false, error: `Public health check returned HTTP ${res.status}` };
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      return {
        ok: false,
        error: 'URL did not return NovaVault API JSON (received HTML login or proxy page instead).',
      };
    }
    const json = (await res.json()) as { ok?: boolean };
    if (!json?.ok) {
      return { ok: false, error: 'Public /api/health endpoint did not return { ok: true }' };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? redactBotToken(err.message) : 'Unable to reach public URL',
    };
  }
}

async function sendTelegramMessage(
  botToken: string,
  chatId: number | string,
  text: string,
  replyMarkup?: Record<string, unknown>
): Promise<void> {
  if (!botToken || process.env.TELEGRAM_DISABLE_NOTIFICATIONS === 'true') return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`Telegram sendMessage HTTP ${res.status}: ${redactBotToken(errBody).slice(0, 200)}`);
    }
  } catch (err) {
    console.error('Telegram sendMessage failed:', err instanceof Error ? redactBotToken(err.message) : 'Network error');
  }
}

export async function notifyTelegramUser(telegramId: string, htmlMessage: string): Promise<void> {
  const token = getBotToken();
  if (!token || !telegramId || !/^\d+$/.test(telegramId)) return;
  await sendTelegramMessage(token, telegramId, htmlMessage);
}

export async function notifyTelegramAdmins(htmlMessage: string): Promise<void> {
  const token = getBotToken();
  const adminIds = getTelegramAdminIds();
  if (!token || adminIds.length === 0) return;
  await Promise.all(adminIds.map((id) => sendTelegramMessage(token, id, htmlMessage)));
}

export async function configureTelegramBotMenuAndCommands(overrideUrl?: string): Promise<{
  ok: boolean;
  botUsername: string;
  menuButtonUrl: string;
  menuConfigured: boolean;
  commandsConfigured: boolean;
  error?: string;
}> {
  const token = getBotToken();
  if (!token) {
    return {
      ok: false,
      botUsername: '',
      menuButtonUrl: '',
      menuConfigured: false,
      commandsConfigured: false,
      error: 'TELEGRAM_BOT_TOKEN is not configured',
    };
  }

  const settings = getSettingsMap();
  const appName = (settings.appName || 'NovaVault').trim() || 'NovaVault';

  if (overrideUrl) {
    const cleanedOverride = sanitizeExternalUrl(overrideUrl.trim().replace(/^["']|["']$/g, ''));
    if (!cleanedOverride || isDisallowedAuthProxyUrl(cleanedOverride)) {
      return {
        ok: false,
        botUsername: runtimeState.connectedBotUsername,
        menuButtonUrl: '',
        menuConfigured: false,
        commandsConfigured: runtimeState.commandsConfigured,
        error:
          'Cannot use an AI Studio (ais-dev / ais-pre) or Google-authenticated URL. Enter your public HTTPS production URL (e.g. from Render, Koyeb, or Railway).',
      };
    }
  }

  const webAppUrl = getTelegramWebAppUrl(overrideUrl);

  let botUsername = runtimeState.connectedBotUsername;
  let commandsConfigured = false;
  let menuConfigured = false;
  let lastError = '';

  try {
    // 1. Verify bot identity and auto-sync botUsername for referral deep links
    const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const meJson = (await meRes.json()) as {
      ok: boolean;
      result?: { username?: string; first_name?: string };
      description?: string;
    };
    if (!meJson.ok) {
      lastError = meJson.description || `getMe failed (${meRes.status})`;
      runtimeState.lastError = lastError;
      return {
        ok: false,
        botUsername: '',
        menuButtonUrl: webAppUrl,
        menuConfigured: false,
        commandsConfigured: false,
        error: lastError,
      };
    }

    if (meJson.result?.username) {
      botUsername = meJson.result.username;
      runtimeState.connectedBotUsername = botUsername;
      const currentBotSetting = (settings.botUsername || '').trim();
      if (!currentBotSetting || currentBotSetting === 'NovaVaultRewardBot') {
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('botUsername', ?)").run(botUsername);
      }
    }

    // 2. Register bot slash command menu
    const cmdRes = await fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: `Launch ${appName} Mini App` },
          { command: 'balance', description: 'Check your points and BDT balance' },
          { command: 'refer', description: 'Get your referral invite link & stats' },
          { command: 'help', description: 'View available commands' },
          { command: 'admin', description: 'Admin summary (authorized IDs only)' },
        ],
      }),
    });
    const cmdJson = (await cmdRes.json()) as { ok: boolean; description?: string };
    commandsConfigured = Boolean(cmdJson.ok);
    runtimeState.commandsConfigured = commandsConfigured;
    if (!cmdJson.ok && cmdJson.description) {
      lastError = cmdJson.description;
    }

    // 3. Configure persistent Mini App Menu Launch Button ONLY if a real public HTTPS URL passes health check
    if (webAppUrl) {
      const accessCheck = await verifyPublicUrlAccessibility(webAppUrl);
      if (!accessCheck.ok) {
        lastError = accessCheck.error || 'Public URL failed accessibility check';
        runtimeState.menuConfigured = false;
        runtimeState.menuButtonUrl = '';
      } else {
        const btnText = `Open ${appName}`.slice(0, 32);
        const menuRes = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            menu_button: {
              type: 'web_app',
              text: btnText,
              web_app: { url: webAppUrl },
            },
          }),
        });
        const menuJson = (await menuRes.json()) as { ok: boolean; description?: string };
        menuConfigured = Boolean(menuJson.ok);
        runtimeState.menuConfigured = menuConfigured;
        if (menuConfigured) {
          runtimeState.menuButtonUrl = webAppUrl;
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('publicAppUrl', ?)").run(webAppUrl);
        } else if (menuJson.description) {
          lastError = menuJson.description;
        }
      }
    } else {
      // Check if Telegram currently has a stale/Google-auth-gated menu button (ais-dev / ais-pre) and reset it
      const currMenuRes = await fetch(`https://api.telegram.org/bot${token}/getChatMenuButton`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const currMenu = (await currMenuRes.json()) as {
        ok: boolean;
        result?: { type?: string; web_app?: { url?: string } };
      };
      const existingUrl = currMenu.result?.web_app?.url || '';
      if (existingUrl && isDisallowedAuthProxyUrl(existingUrl)) {
        await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ menu_button: { type: 'commands' } }),
        });
      }
      runtimeState.menuConfigured = false;
      runtimeState.menuButtonUrl = '';
      lastError =
        'No public HTTPS URL configured (AI Studio ais-dev/ais-pre URLs require Google sign-in and are blocked). Set PUBLIC_APP_URL after deploying to a public host.';
    }

    runtimeState.lastError = lastError;
    return {
      ok: commandsConfigured && menuConfigured,
      botUsername,
      menuButtonUrl: menuConfigured ? webAppUrl : '',
      menuConfigured,
      commandsConfigured,
      error: lastError || undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? redactBotToken(err.message) : 'Telegram Bot API request failed';
    runtimeState.lastError = msg;
    return {
      ok: false,
      botUsername,
      menuButtonUrl: '',
      menuConfigured,
      commandsConfigured,
      error: msg,
    };
  }
}

export async function processTelegramUpdate(update: TelegramUpdate): Promise<void> {
  const botToken = getBotToken();
  const msg = update.message;
  if (!msg || !msg.from || !msg.text) return;

  const tgId = String(msg.from.id);
  const chatId = msg.chat.id;
  const rawText = msg.text.trim();
  const command = rawText.split(/\s+/)[0].split('@')[0].toLowerCase();
  const settings = getSettingsMap();
  const appName = settings.appName || 'NovaVault';
  const safeAppName = escapeHtml(appName);
  const appUrl = getTelegramWebAppUrl();

  // Ensure user exists or sync profile
  const now = new Date().toISOString();
  let user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId) as
    | { id: number; points_balance: number; referral_code: string; total_earned: number }
    | undefined;

  const tgUsername = msg.from.username || `user_${tgId.slice(-6)}`;

  if (!user) {
    const refCode = generateReferralCode(tgUsername);
    let referredById: number | null = null;

    if (command === '/start') {
      const parts = rawText.split(/\s+/);
      const param = (parts[1] || '').trim();
      const code = param.startsWith('ref_') ? param.slice(4) : param;
      if (code) {
        const referrer = db
          .prepare('SELECT id, telegram_id FROM users WHERE referral_code = ?')
          .get(code) as { id: number; telegram_id: string } | undefined;
        if (referrer && referrer.telegram_id !== tgId) {
          referredById = referrer.id;
        }
      }
    }

    db.prepare(`
      INSERT INTO users (telegram_id, username, first_name, last_name, is_online, last_seen_at, referral_code, referred_by_user_id, language, created_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      tgId,
      tgUsername,
      msg.from.first_name || '',
      msg.from.last_name || '',
      now,
      refCode,
      referredById,
      msg.from.language_code === 'bn' ? 'bn' : settings.defaultLanguage || 'en',
      now
    );

    user = db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(tgId) as {
      id: number;
      points_balance: number;
      referral_code: string;
      total_earned: number;
    };
  } else {
    db.prepare(
      `UPDATE users SET username = ?, first_name = ?, last_name = ?, is_online = 1, last_seen_at = ? WHERE id = ?`
    ).run(tgUsername, msg.from.first_name || '', msg.from.last_name || '', now, user.id);
  }

  const openButton = appUrl
    ? {
        inline_keyboard: [
          [
            {
              text: `Open ${appName}`,
              web_app: { url: appUrl },
            },
          ],
        ],
      }
    : undefined;

  if (command === '/start') {
    const urlNotice = appUrl
      ? ''
      : `\n\n<i>Mini App launch button is pending public HTTPS deployment (PUBLIC_APP_URL).</i>`;
    await sendTelegramMessage(
      botToken,
      chatId,
      `Welcome to <b>${safeAppName}</b>!\n\nComplete verified tasks, watch daily ads, play mini-games, and invite friends to earn rewards.\n\nYour Referral Code: <code>${escapeHtml(user.referral_code)}</code>${urlNotice}`,
      openButton
    );
    return;
  }

  if (command === '/balance') {
    const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));
    const bdt = (user.points_balance / rate).toFixed(2);
    await sendTelegramMessage(
      botToken,
      chatId,
      `<b>${safeAppName} Wallet</b>\nAvailable Points: <b>${user.points_balance} PTS</b>\nEstimated Value: <b>৳${bdt} BDT</b>`,
      openButton
    );
    return;
  }

  if (command === '/admin') {
    const adminIds = (process.env.TELEGRAM_ADMIN_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!adminIds.includes(tgId)) {
      await sendTelegramMessage(botToken, chatId, 'Unauthorized: Admin Telegram ID required.');
      return;
    }
    const stats = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE is_preview = 0) as totalUsers,
          (SELECT COUNT(*) FROM withdrawals WHERE status = 'pending') as pendingWithdrawals,
          (SELECT COUNT(*) FROM task_submissions WHERE status = 'pending') as pendingTasks`
      )
      .get() as { totalUsers: number; pendingWithdrawals: number; pendingTasks: number };

    const adminButton = appUrl
      ? {
          inline_keyboard: [
            [
              {
                text: `Open Admin Panel`,
                web_app: { url: `${appUrl}/#admin` },
              },
            ],
          ],
        }
      : undefined;

    await sendTelegramMessage(
      botToken,
      chatId,
      `<b>${safeAppName} Admin Summary</b>\nUsers: ${stats.totalUsers}\nPending Withdrawals: ${stats.pendingWithdrawals}\nPending Task Reviews: ${stats.pendingTasks}\n\nOpen the Admin Panel at ${appUrl ? `${escapeHtml(appUrl)}/#admin` : 'your public Admin URL once deployed'}.`,
      adminButton
    );
    return;
  }

  if (command === '/refer' || command === '/referral') {
    const botUser = (settings.botUsername || runtimeState.connectedBotUsername || 'NovaVaultRewardBot').replace(/^@/, '');
    const inviteLink = `https://t.me/${botUser}?startapp=ref_${user.referral_code}`;
    const refStats = db
      .prepare(
        `SELECT COUNT(*) as total,
                COALESCE(SUM(CASE WHEN referral_qualified = 1 THEN 1 ELSE 0 END), 0) as qualified
         FROM users WHERE referred_by_user_id = ?`
      )
      .get(user.id) as { total: number; qualified: number };
    const rewardPts = Number(settings.referralRewardPoints || '100');
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(
      `Join ${appName} and earn verified daily rewards!`
    )}`;

    await sendTelegramMessage(
      botToken,
      chatId,
      `<b>${safeAppName} Referral Program</b>\n\nInvite friends and earn <b>+${rewardPts} PTS</b> per qualified referral.\n\nYour Code: <code>${escapeHtml(user.referral_code)}</code>\nInvited Friends: <b>${refStats.total}</b> (Qualified: <b>${refStats.qualified}</b>)\n\nShare Link:\n<code>${escapeHtml(inviteLink)}</code>`,
      {
        inline_keyboard: [
          [{ text: 'Share Invite Link', url: shareUrl }],
          ...(appUrl ? [[{ text: `Open ${appName}`, web_app: { url: appUrl } }]] : []),
        ],
      }
    );
    return;
  }

  if (command === '/help') {
    await sendTelegramMessage(
      botToken,
      chatId,
      `<b>Commands</b>\n/start - Launch ${safeAppName}\n/balance - Check points & BDT estimate\n/refer - Get referral link & stats\n/help - Show help`,
      openButton
    );
  }
}

let pollingStarted = false;

export async function clearTelegramWebhook(): Promise<{ ok: boolean; error?: string }> {
  const token = getBotToken();
  if (!token) return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`);
    const json = (await res.json()) as { ok: boolean; description?: string };
    return { ok: Boolean(json.ok), error: json.ok ? undefined : json.description };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? redactBotToken(err.message) : 'deleteWebhook failed' };
  }
}

export async function initTelegramBot(): Promise<void> {
  const token = getBotToken();
  if (!token) {
    console.log('Telegram bot token not set; skipping Telegram bot initialization.');
    return;
  }

  const setupRes = await configureTelegramBotMenuAndCommands();
  if (setupRes.ok) {
    console.log(
      `Telegram bot @${setupRes.botUsername || 'unknown'} initialized (Menu button: ${setupRes.menuButtonUrl}).`
    );
  } else {
    console.warn(`Telegram bot setup notice: ${setupRes.error || 'partial configuration'}`);
  }

  startTelegramBotPollingIfEnabled();
}

export function startTelegramBotPollingIfEnabled(): void {
  const token = getBotToken();
  const shouldPoll = isTelegramPollingEnabled();
  if (!token || !shouldPoll || pollingStarted) return;
  pollingStarted = true;
  runtimeState.pollingActive = true;

  let offset = 0;

  const runPolling = async () => {
    // Clear any existing webhook before long-polling to avoid HTTP 409 Conflict
    const cleared = await clearTelegramWebhook();
    if (!cleared.ok && cleared.error) {
      runtimeState.lastError = redactBotToken(cleared.error);
      console.warn('Telegram deleteWebhook warning:', runtimeState.lastError);
    }

    const poll = async () => {
      let nextDelayMs = 1000;
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${offset}`
        );
        runtimeState.lastPollAt = new Date().toISOString();
        if (res.ok) {
          const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[]; description?: string };
          if (data.ok && Array.isArray(data.result)) {
            if (runtimeState.menuConfigured) {
              runtimeState.lastError = '';
            }
            for (const upd of data.result) {
              offset = Math.max(offset, upd.update_id + 1);
              await processTelegramUpdate(upd);
            }
          } else if (!data.ok) {
            runtimeState.lastError = redactBotToken(data.description || 'Telegram getUpdates returned ok=false');
            nextDelayMs = 5000;
          }
        } else {
          const errJson = (await res.json().catch(() => ({}))) as { description?: string };
          runtimeState.lastError = redactBotToken(errJson.description || `Telegram HTTP ${res.status}`);
          console.error(`Telegram polling error: ${runtimeState.lastError}`);
          if (res.status === 409) {
            await clearTelegramWebhook();
          }
          nextDelayMs = 5000;
        }
      } catch (err) {
        runtimeState.lastError = err instanceof Error ? redactBotToken(err.message) : 'Network error during polling';
        console.error('Telegram polling error:', runtimeState.lastError);
        nextDelayMs = 5000;
      }
      setTimeout(poll, nextDelayMs);
    };

    void poll();
    console.log('Telegram bot long-polling started.');
  };

  void runPolling();
}
