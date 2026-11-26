import { db, getSettingsMap, getUtcDayBounds } from './db.ts';
import { notifyTelegramUser } from './telegram-bot.ts';

const DAILY_CAPPED_TYPES = new Set(['daily_checkin', 'task_reward', 'ad_reward', 'game_reward']);

export function getUserDailyEarnedPoints(userId: number): number {
  const { startIso } = getUtcDayBounds(0);
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_points), 0) as total FROM transactions
       WHERE user_id = ? AND amount_points > 0
       AND type IN ('daily_checkin', 'task_reward', 'ad_reward', 'game_reward')
       AND created_at >= ?`
    )
    .get(userId, startIso) as { total: number };
  return row.total || 0;
}

export function creditUserPointsAtomic(params: {
  userId: number;
  points: number;
  txType: string;
  description: string;
  referenceId?: string;
  bypassDailyCap?: boolean;
}): number {
  const { userId, points, txType, description, referenceId = '', bypassDailyCap = false } = params;
  if (!Number.isFinite(points) || points <= 0) {
    throw new Error('Points must be a positive integer');
  }
  const intPoints = Math.floor(points);
  const now = new Date().toISOString();

  const run = db.transaction(() => {
    const user = db
      .prepare('SELECT id, points_balance, referred_by_user_id, referral_qualified FROM users WHERE id = ?')
      .get(userId) as
      | { id: number; points_balance: number; referred_by_user_id: number | null; referral_qualified: number }
      | undefined;

    if (!user) throw new Error('User not found');

    if (!bypassDailyCap && DAILY_CAPPED_TYPES.has(txType)) {
      const settings = getSettingsMap();
      const maxDaily = Math.max(0, Math.floor(Number(settings.dailyMaxEarnings || '500')));
      if (maxDaily > 0) {
        const earnedToday = getUserDailyEarnedPoints(userId);
        if (earnedToday + intPoints > maxDaily) {
          throw new Error(`Daily earning limit of ${maxDaily} PTS reached. Try again after reset.`);
        }
      }
    }

    const newBalance = user.points_balance + intPoints;
    db.prepare(
      'UPDATE users SET points_balance = ?, total_earned = total_earned + ?, last_seen_at = ? WHERE id = ?'
    ).run(newBalance, intPoints, now, userId);

    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(userId, txType, intPoints, newBalance, description, referenceId, now);

    // Check referral qualification (anti-fraud: only triggers once per user after earning activity)
    if (user.referred_by_user_id && user.referral_qualified === 0 && txType !== 'referral_bonus') {
      evaluateReferralQualification(userId, user.referred_by_user_id, now);
    }

    return newBalance;
  });

  return run();
}

function evaluateReferralQualification(userId: number, referrerId: number, now: string): void {
  if (userId === referrerId) return;
  const settings = getSettingsMap();
  if (settings.referralsEnabled === 'false') return;
  const minTasks = Math.max(1, Number(settings.referralConditionMinTasks || '1'));

  const activityRow = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM transactions
       WHERE user_id = ? AND type IN ('ad_reward', 'task_reward', 'daily_checkin', 'game_reward')`
    )
    .get(userId) as { cnt: number };

  if (activityRow.cnt < minTasks) return;

  const rewardPts = Math.max(0, Math.floor(Number(settings.referralRewardPoints || '100')));
  const inviteeBonus = Math.max(0, Math.floor(Number(settings.referralInviteeBonus || '25')));
  const maxLevels = Math.max(1, Math.min(2, Number(settings.referralMaxLevels || '2')));
  const level2Percent = Math.max(0, Math.min(100, Number(settings.referralLevel2Percent || '20')));

  db.prepare('UPDATE users SET referral_qualified = 1 WHERE id = ? AND referral_qualified = 0').run(userId);

  if (rewardPts > 0) {
    const refUser = db
      .prepare('SELECT id, telegram_id, points_balance, referred_by_user_id FROM users WHERE id = ? AND is_blocked = 0')
      .get(referrerId) as
      | { id: number; telegram_id: string; points_balance: number; referred_by_user_id: number | null }
      | undefined;

    if (refUser) {
      const refNewBal = refUser.points_balance + rewardPts;
      db.prepare(
        'UPDATE users SET points_balance = ?, total_earned = total_earned + ?, referral_earnings = referral_earnings + ? WHERE id = ?'
      ).run(refNewBal, rewardPts, rewardPts, refUser.id);
      db.prepare(
        `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
         VALUES (?, 'referral_bonus', ?, ?, ?, ?, ?)`
      ).run(refUser.id, rewardPts, refNewBal, `Tier 1 referral reward (User #${userId})`, `ref_u_${userId}`, now);

      void notifyTelegramUser(
        refUser.telegram_id,
        `<b>Referral Bonus Credited!</b>\nA referred friend qualified and you earned <b>+${rewardPts} PTS</b>.\nNew Balance: <b>${refNewBal} PTS</b>`
      );

      // Level 2 referral reward if enabled
      if (maxLevels >= 2 && level2Percent > 0 && refUser.referred_by_user_id && refUser.referred_by_user_id !== userId) {
        const l2Pts = Math.floor((rewardPts * level2Percent) / 100);
        if (l2Pts > 0) {
          const l2User = db
            .prepare('SELECT id, telegram_id, points_balance FROM users WHERE id = ? AND is_blocked = 0')
            .get(refUser.referred_by_user_id) as { id: number; telegram_id: string; points_balance: number } | undefined;
          if (l2User) {
            const l2Bal = l2User.points_balance + l2Pts;
            db.prepare(
              'UPDATE users SET points_balance = ?, total_earned = total_earned + ?, referral_earnings = referral_earnings + ? WHERE id = ?'
            ).run(l2Bal, l2Pts, l2Pts, l2User.id);
            db.prepare(
              `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
               VALUES (?, 'referral_bonus', ?, ?, ?, ?, ?)`
            ).run(l2User.id, l2Pts, l2Bal, `Tier 2 referral reward (User #${userId})`, `ref2_u_${userId}`, now);
            void notifyTelegramUser(
              l2User.telegram_id,
              `<b>Tier 2 Referral Bonus!</b>\nYou earned <b>+${l2Pts} PTS</b>.\nNew Balance: <b>${l2Bal} PTS</b>`
            );
          }
        }
      }
    }
  }

  if (inviteeBonus > 0) {
    const u = db.prepare('SELECT points_balance FROM users WHERE id = ?').get(userId) as { points_balance: number };
    const uNewBal = u.points_balance + inviteeBonus;
    db.prepare('UPDATE users SET points_balance = ?, total_earned = total_earned + ? WHERE id = ?').run(
      uNewBal,
      inviteeBonus,
      userId
    );
    db.prepare(
      `INSERT INTO transactions (user_id, type, amount_points, balance_after, description, reference_id, created_at)
       VALUES (?, 'referral_bonus', ?, ?, 'Welcome referral welcome bonus', ?, ?)`
    ).run(userId, inviteeBonus, uNewBal, `ref_welcome_${userId}`, now);
  }
}
