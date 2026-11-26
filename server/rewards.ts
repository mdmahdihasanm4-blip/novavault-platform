import type { PoolClient } from 'pg';
import { getSettingsMap, getUtcDayBounds, queryOne, withTransaction } from './db.ts';
import type { SqlExecutor } from './db.ts';
import { notifyTelegramUser } from './telegram-bot.ts';

const DAILY_CAPPED_TYPES = new Set(['daily_checkin', 'task_reward', 'ad_reward', 'game_reward']);

export interface PendingTelegramNotification {
  telegramId: string;
  html: string;
}

export interface CreditPointsParams {
  userId: number;
  points: number;
  txType: string;
  description: string;
  referenceId?: string;
  bypassDailyCap?: boolean;
}

export async function getUserDailyEarnedPoints(userId: number, executor?: SqlExecutor): Promise<number> {
  const { startIso } = getUtcDayBounds(0);
  const row = await queryOne<{ total: number }>(
    `SELECT COALESCE(SUM(amount_points), 0)::int AS total
     FROM transactions
     WHERE user_id = $1
       AND amount_points > 0
       AND type IN ('daily_checkin', 'task_reward', 'ad_reward', 'game_reward')
       AND created_at >= $2`,
    [userId, startIso],
    executor
  );
  return row?.total || 0;
}

export function dispatchPendingNotifications(notifications: PendingTelegramNotification[]): void {
  for (const item of notifications) {
    void notifyTelegramUser(item.telegramId, item.html);
  }
}

export async function creditUserPointsInTx(
  client: PoolClient,
  params: CreditPointsParams
): Promise<{ newBalance: number; notifications: PendingTelegramNotification[] }> {
  const { userId, points, txType, description, referenceId = '', bypassDailyCap = false } = params;
  if (!Number.isFinite(points) || points <= 0) {
    throw new Error('Points must be a positive integer');
  }
  const intPoints = Math.floor(points);
  const now = new Date().toISOString();
  const notifications: PendingTelegramNotification[] = [];

  const user = await queryOne<{
    id: number;
    points_balance: number;
    referred_by_user_id: number | null;
    referral_qualified: number;
  }>(
    'SELECT id, points_balance, referred_by_user_id, referral_qualified FROM users WHERE id = $1 FOR UPDATE',
    [userId],
    client
  );

  if (!user) {
    throw new Error('User not found');
  }

  if (!bypassDailyCap && DAILY_CAPPED_TYPES.has(txType)) {
    const settings = await getSettingsMap(client);
    const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
    if (maxDaily > 0) {
      const earnedToday = await getUserDailyEarnedPoints(userId, client);
      if (earnedToday + intPoints > maxDaily) {
        throw new Error(`Daily earning limit of ${maxDaily} PTS reached. Try again after reset.`);
      }
    }
  }

  const newBalance = user.points_balance + intPoints;
  await client.query(
    'UPDATE users SET points_balance = $1, total_earned = total_earned + $2, last_seen_at = $3 WHERE id = $4',
    [newBalance, intPoints, now, userId]
  );

  await client.query(
    `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId, txType, intPoints, newBalance, description, referenceId, now]
  );

  let finalBalance = newBalance;

  // Check referral qualification (anti-fraud: only triggers once per user after earning activity)
  if (user.referred_by_user_id && user.referral_qualified === 0 && txType !== 'referral_bonus') {
    const refOutcome = await evaluateReferralQualification(
      client,
      userId,
      user.referred_by_user_id,
      newBalance,
      now,
      notifications
    );
    finalBalance = refOutcome;
  }

  return { newBalance: finalBalance, notifications };
}

export async function creditUserPointsAtomic(params: CreditPointsParams): Promise<number> {
  const { newBalance, notifications } = await withTransaction(async (client) =>
    creditUserPointsInTx(client, params)
  );
  dispatchPendingNotifications(notifications);
  return newBalance;
}

async function evaluateReferralQualification(
  client: PoolClient,
  userId: number,
  referrerId: number,
  currentUserBalance: number,
  now: string,
  notifications: PendingTelegramNotification[]
): Promise<number> {
  if (userId === referrerId) return currentUserBalance;
  const settings = await getSettingsMap(client);
  if (settings.referralsEnabled === 'false') return currentUserBalance;
  const minTasks = Math.max(1, Number(settings.referralConditionMinTasks || '1'));

  const activityRow = await queryOne<{ cnt: number }>(
    `SELECT COUNT(*)::int AS cnt
     FROM transactions
     WHERE user_id = $1 AND type IN ('ad_reward', 'task_reward', 'daily_checkin', 'game_reward')`,
    [userId],
    client
  );

  if ((activityRow?.cnt || 0) < minTasks) return currentUserBalance;

  const rewardPts = Math.max(0, Math.floor(Number(settings.referralRewardPoints || '100')));
  const inviteeBonus = Math.max(0, Math.floor(Number(settings.referralInviteeBonus || '25')));
  const maxLevels = Math.max(1, Math.min(2, Number(settings.referralMaxLevels || '2')));
  const level2Percent = Math.max(0, Math.min(100, Number(settings.referralLevel2Percent || '20')));

  const qualRes = await client.query(
    'UPDATE users SET referral_qualified = 1 WHERE id = $1 AND referral_qualified = 0',
    [userId]
  );
  if ((qualRes.rowCount ?? 0) === 0) {
    return currentUserBalance;
  }

  if (rewardPts > 0) {
    const refUser = await queryOne<{
      id: number;
      telegram_id: string;
      points_balance: number;
      referred_by_user_id: number | null;
    }>(
      'SELECT id, telegram_id, points_balance, referred_by_user_id FROM users WHERE id = $1 AND is_blocked = 0 FOR UPDATE',
      [referrerId],
      client
    );

    if (refUser) {
      const refNewBal = refUser.points_balance + rewardPts;
      await client.query(
        'UPDATE users SET points_balance = $1, total_earned = total_earned + $2, referral_earnings = referral_earnings + $3 WHERE id = $4',
        [refNewBal, rewardPts, rewardPts, refUser.id]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
         VALUES ($1, 'referral_bonus', $2, $3, $4, $5, $6)`,
        [refUser.id, rewardPts, refNewBal, `Tier 1 referral reward (User #${userId})`, `ref_u_${userId}`, now]
      );

      notifications.push({
        telegramId: refUser.telegram_id,
        html: `<b>Referral Bonus Credited!</b>\nA referred friend qualified and you earned <b>+${rewardPts} PTS</b>.\nNew Balance: <b>${refNewBal} PTS</b>`,
      });

      // Level 2 referral reward if enabled
      if (maxLevels >= 2 && level2Percent > 0 && refUser.referred_by_user_id && refUser.referred_by_user_id !== userId) {
        const l2Pts = Math.floor((rewardPts * level2Percent) / 100);
        if (l2Pts > 0) {
          const l2User = await queryOne<{
            id: number;
            telegram_id: string;
            points_balance: number;
          }>(
            'SELECT id, telegram_id, points_balance FROM users WHERE id = $1 AND is_blocked = 0 FOR UPDATE',
            [refUser.referred_by_user_id],
            client
          );
          if (l2User) {
            const l2Bal = l2User.points_balance + l2Pts;
            await client.query(
              'UPDATE users SET points_balance = $1, total_earned = total_earned + $2, referral_earnings = referral_earnings + $3 WHERE id = $4',
              [l2Bal, l2Pts, l2Pts, l2User.id]
            );
            await client.query(
              `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
               VALUES ($1, 'referral_bonus', $2, $3, $4, $5, $6)`,
              [l2User.id, l2Pts, l2Bal, `Tier 2 referral reward (User #${userId})`, `ref2_u_${userId}`, now]
            );
            notifications.push({
              telegramId: l2User.telegram_id,
              html: `<b>Tier 2 Referral Bonus!</b>\nYou earned <b>+${l2Pts} PTS</b>.\nNew Balance: <b>${l2Bal} PTS</b>`,
            });
          }
        }
      }
    }
  }

  let updatedBalance = currentUserBalance;
  if (inviteeBonus > 0) {
    const u = await queryOne<{ points_balance: number }>('SELECT points_balance FROM users WHERE id = $1', [userId], client);
    if (u) {
      updatedBalance = u.points_balance + inviteeBonus;
      await client.query(
        'UPDATE users SET points_balance = $1, total_earned = total_earned + $2 WHERE id = $3',
        [updatedBalance, inviteeBonus, userId]
      );
      await client.query(
        `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
         VALUES ($1, 'referral_bonus', $2, $3, 'Welcome referral welcome bonus', $4, $5)`,
        [userId, inviteeBonus, updatedBalance, `ref_welcome_${userId}`, now]
      );
    }
  }

  return updatedBalance;
}
