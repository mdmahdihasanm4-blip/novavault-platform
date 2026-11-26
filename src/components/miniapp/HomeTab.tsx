import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  Coins,
  Gamepad2,
  MegaphoneOff,
  Play,
  Sparkles,
  Users,
  Video,
  Wallet,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { BootstrapPayload, MiniTab } from '../../types/app.ts';
import { CountdownTimer } from './CountdownTimer.tsx';

interface HomeTabProps {
  data: BootstrapPayload;
  t: (key: string, fallback?: string) => string;
  onNavigate: (tab: MiniTab) => void;
  onStartAd: (providerId: number, slotNumber: number) => Promise<void>;
  adLoadingSlot: number | null;
}

export function HomeTab({ data, t, onNavigate, onStartAd, adLoadingSlot }: HomeTabProps) {
  const { user, settings, dailyStats, adProgram, tasks, referrals, transactions } = data;
  const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));
  const estBdt = (user.pointsBalance / rate).toFixed(2);
  const youtubeTasks = tasks.filter((item) => item.category === 'youtube');
  const maxDailyGoal = Math.max(
    1,
    Number(dailyStats.dailyMaxEarnings || settings.dailyMaxEarnings || '500')
  );
  const progressPct = Math.min(100, Math.round((dailyStats.earnedToday / maxDailyGoal) * 100));
  const recentActivity = transactions.slice(0, 5);

  const displayName = [user.firstName, user.lastName].filter(Boolean).join(' ') || `@${user.username}`;

  return (
    <div className="space-y-6">
      {/* Top Split: Hero Purple Gradient Balance Card + Daily Progress / YouTube Spotlight */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Dominant Hero Balance Card */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18 }}
          className="lg:col-span-7 relative overflow-hidden rounded-3xl border border-violet-400/20 bg-gradient-to-br from-[#2C1B5A] via-[#1B133D] to-[#11152E] p-6 sm:p-7 shadow-[0_20px_50px_rgba(12,8,34,0.6)] flex flex-col justify-between"
        >
          {settings.bannerUrl && (
            <img
              src={settings.bannerUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-20 mix-blend-screen"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
          <div className="relative z-10 flex items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-violet-200/90">
                <span className="font-semibold text-white">{displayName}</span>
                {user.username && (
                  <>
                    <span aria-hidden="true" className="text-violet-300/60">·</span>
                    <span className="font-mono text-violet-300/90">@{user.username}</span>
                  </>
                )}
              </div>
              <p className="text-sm font-medium text-violet-200/80">{t('home.your_balance', 'Your Balance')}</p>
              <div className="mt-1.5 flex items-baseline gap-2.5">
                <span className="font-display text-4xl sm:text-5xl font-extrabold tracking-tight text-white tabular-nums">
                  {user.pointsBalance.toLocaleString()}
                </span>
                <span className="font-mono text-sm font-semibold text-violet-300">
                  {t('home.points_unit', 'PTS')}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-300">
                <span>{t('home.estimated_value', 'Estimated Value')}:</span>
                <span className="font-mono font-semibold text-emerald-300 tabular-nums">৳{estBdt} BDT</span>
                {user.pendingBalance > 0 && (
                  <>
                    <span aria-hidden="true" className="text-slate-500">·</span>
                    <span className="text-xs text-amber-300 tabular-nums">
                      {t('status.pending', 'Pending')}: {user.pendingBalance.toLocaleString()} {t('home.points_unit', 'PTS')}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="hidden sm:flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-500/20 border border-violet-400/30 text-violet-200">
              <Coins className="h-6 w-6" />
            </div>
          </div>

          {/* 3-Metric Portfolio Strip: Total Earned, Total Withdrawn, Referral Count */}
          <div className="relative z-10 mt-5 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/10 bg-[#0A0E1F]/65 p-3">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">{t('home.total_earned', 'Total Earned')}</p>
              <p className="mt-0.5 font-mono text-sm font-bold text-white tabular-nums truncate">
                {user.totalEarned.toLocaleString()} <span className="text-[10px] text-violet-300">{t('home.points_unit', 'PTS')}</span>
              </p>
            </div>
            <div className="min-w-0 border-l border-white/10 pl-2.5">
              <p className="text-[11px] text-slate-400 truncate">{t('home.total_withdrawn', 'Total Withdrawn')}</p>
              <p className="mt-0.5 font-mono text-sm font-bold text-emerald-300 tabular-nums truncate">
                {user.totalWithdrawn.toLocaleString()} <span className="text-[10px] text-emerald-400/80">{t('home.points_unit', 'PTS')}</span>
              </p>
            </div>
            <div className="min-w-0 border-l border-white/10 pl-2.5">
              <p className="text-[11px] text-slate-400 truncate">{t('home.referrals_count', 'Referrals')}</p>
              <p className="mt-0.5 font-mono text-sm font-bold text-indigo-300 tabular-nums truncate">
                {referrals.length}
              </p>
            </div>
          </div>

          {/* Quick Access Actions: Earn, Play, Refer, Withdraw */}
          <div className="relative z-10 mt-5 grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <button
              type="button"
              onClick={() => onNavigate('earn')}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 active:scale-[0.98] px-3 py-2 text-xs sm:text-sm font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.45)] transition-all whitespace-nowrap cursor-pointer"
            >
              <Sparkles className="h-4 w-4 shrink-0" />
              <span>{t('home.earn_btn', 'Earn')}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('play')}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-violet-400/30 bg-violet-500/15 hover:bg-violet-500/25 active:scale-[0.98] px-3 py-2 text-xs sm:text-sm font-semibold text-violet-100 transition-all whitespace-nowrap cursor-pointer"
            >
              <Gamepad2 className="h-4 w-4 shrink-0" />
              <span>{t('home.quick_play', 'Play')}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('refer')}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/8 hover:bg-white/14 active:scale-[0.98] px-3 py-2 text-xs sm:text-sm font-semibold text-white transition-all whitespace-nowrap cursor-pointer"
            >
              <Users className="h-4 w-4 shrink-0" />
              <span>{t('home.quick_refer', 'Refer')}</span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate('account')}
              className="min-h-[44px] inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/15 bg-white/8 hover:bg-white/14 active:scale-[0.98] px-3 py-2 text-xs sm:text-sm font-semibold text-white transition-all whitespace-nowrap cursor-pointer"
            >
              <Wallet className="h-4 w-4 shrink-0" />
              <span>{t('home.withdraw_btn', 'Withdraw')}</span>
            </button>
          </div>
        </motion.section>

        {/* Right Column: Daily Progress & YouTube Tasks Spotlight */}
        <div className="lg:col-span-5 flex flex-col gap-5">
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-base font-semibold text-white">
                {t('home.daily_progress', 'Daily Earning Progress')}
              </h2>
              <span className="font-mono text-sm font-semibold text-violet-300 tabular-nums">
                {dailyStats.earnedToday} / {maxDailyGoal} {t('home.points_unit', 'PTS')}
              </span>
            </div>
            <div className="mt-3.5 h-2.5 w-full overflow-hidden rounded-full bg-slate-800/90">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-indigo-400 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-violet-400" />
                <span>{t('home.next_reset', 'Next Reset')}</span>
              </span>
              <CountdownTimer targetIso={adProgram?.nextResetIso || dailyStats.nextResetIso} className="text-slate-200 font-medium" />
            </div>
          </div>

          {/* YouTube Tasks Card */}
          <button
            type="button"
            onClick={() => onNavigate('earn')}
            className="group relative flex-1 overflow-hidden rounded-3xl border border-white/10 bg-[#10152B] hover:border-violet-400/35 p-5 text-left transition-all cursor-pointer"
          >
            <div className="flex items-center gap-4">
              <div className="relative h-16 w-20 shrink-0 overflow-hidden rounded-2xl bg-[#181D3A] border border-white/10 flex items-center justify-center">
                <img
                  src="/src/assets/images/task_youtube_banner_1795540140230.jpg"
                  alt={t('home.youtube_tasks_title', 'YouTube Tasks')}
                  referrerPolicy="no-referrer"
                  className="h-full w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
                <Video className="h-6 w-6 text-violet-300 absolute pointer-events-none opacity-0" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-base font-semibold text-white truncate">
                    {t('home.youtube_tasks_title', 'YouTube Tasks')}
                  </h3>
                  <ArrowUpRight className="h-4 w-4 text-slate-400 group-hover:text-violet-300 transition-colors shrink-0" />
                </div>
                <p className="mt-1 text-xs text-slate-400 line-clamp-2">
                  {t('home.youtube_tasks_desc', 'Watch videos and verify codes to earn instant points')}
                </p>
                <div className="mt-2 flex items-center gap-2 text-xs text-violet-300 font-medium">
                  <span>{youtubeTasks.length} {t('earn.filter_youtube', 'YouTube')}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t('home.view_all_tasks', 'View All Tasks')}</span>
                </div>
              </div>
            </div>
          </button>
        </div>
      </div>

      {/* Watch Ads & Earn Section */}
      <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-white/8">
          <div>
            <h2 className="font-display text-lg font-bold text-white">
              {t('home.watch_ads_title', 'Watch Ads & Earn')}
            </h2>
            <p className="mt-0.5 text-xs sm:text-sm text-slate-400">
              {t('home.watch_ads_subtitle', 'Verified postback rewards per completed view')}
            </p>
          </div>
          {adProgram && (
            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-300">
              <span>
                {t('home.remaining_ads', 'Remaining Today')}:{' '}
                <strong className="font-mono text-violet-300 tabular-nums">
                  {adProgram.remainingToday}/{adProgram.dailyLimit}
                </strong>
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5 text-slate-400" />
                <CountdownTimer targetIso={adProgram.nextResetIso} className="text-slate-200" />
              </span>
            </div>
          )}
        </div>

        {!adProgram ? (
          <div className="py-8 text-center space-y-2">
            <MegaphoneOff className="mx-auto h-8 w-8 text-slate-500" />
            <p className="text-sm text-slate-400">
              {t('home.ads_unavailable', 'Advertisements are temporarily unavailable.')}
            </p>
          </div>
        ) : (
          <>
            <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3.5">
              {adProgram.slots.map((slot) => {
                const isDone = slot.status === 'verified';
                const isPending = slot.status === 'initiated';
                const limitReached =
                  adProgram.remainingToday <= 0 ||
                  adProgram.earnedToday >= adProgram.dailyMaxAdEarnings ||
                  dailyStats.earnedToday >= maxDailyGoal;
                const disabled = isDone || (limitReached && !isPending) || adLoadingSlot === slot.slotNumber;

                return (
                  <div
                    key={slot.slotNumber}
                    className={`rounded-2xl border p-4 flex items-center justify-between gap-3 transition-colors ${
                      isDone
                        ? 'border-emerald-500/25 bg-emerald-950/15'
                        : isPending
                          ? 'border-amber-500/30 bg-amber-950/15'
                          : 'border-white/8 bg-[#151B36] hover:border-violet-400/30'
                    }`}
                  >
                    <div className="min-w-0">
                      <p className="font-display text-sm font-semibold text-white truncate">
                        {t('home.watch_ad_prefix', 'Watch Ad')} #{slot.slotNumber}
                      </p>
                      <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                        <span>
                          {t('home.reward_label', 'Reward')}:{' '}
                          <strong className="font-mono text-violet-300 tabular-nums">
                            {slot.rewardPoints} {t('home.points_unit', 'PTS')}
                          </strong>
                        </span>
                      </div>
                    </div>

                    {isDone ? (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400 whitespace-nowrap shrink-0">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>{t('home.ad_completed', 'Completed')}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => void onStartAd(adProgram.providerId, slot.slotNumber)}
                        className={`min-h-[42px] inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-xs font-semibold transition-all whitespace-nowrap shrink-0 cursor-pointer ${
                          isPending
                            ? 'border border-amber-400/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                            : disabled
                              ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                              : 'bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_16px_rgba(124,58,237,0.35)] active:scale-[0.97]'
                        }`}
                      >
                        <Play className="h-3.5 w-3.5 fill-current" />
                        <span>
                          {adLoadingSlot === slot.slotNumber
                            ? '...'
                            : isPending
                              ? t('home.ad_waiting', 'Verifying')
                              : t('home.play_ad_btn', 'Play')}
                        </span>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="mt-4 text-xs text-slate-400">
              {t('earn.ad_postback_notice', 'Rewards are credited automatically after server postback confirmation.')}
            </p>
          </>
        )}
      </section>

      {/* Recent Activity Section */}
      <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-white/8">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-violet-400" />
            <h2 className="font-display text-base font-bold text-white">
              {t('home.recent_activity', 'Recent Activity')}
            </h2>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('account')}
            className="text-xs font-semibold text-violet-300 hover:text-violet-200 cursor-pointer"
          >
            {t('account.tx_history', 'Transaction Ledger')}
          </button>
        </div>

        {recentActivity.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">
            {t('home.no_activity', 'No activity yet. Start earning to see updates.')}
          </p>
        ) : (
          <div className="divide-y divide-white/8">
            {recentActivity.map((tx) => (
              <div key={tx.id} className="py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs sm:text-sm font-medium text-slate-100 truncate">{tx.description}</p>
                  <p className="text-[11px] text-slate-500">{new Date(tx.created_at).toLocaleString()}</p>
                </div>
                <span
                  className={`font-mono text-xs sm:text-sm font-bold tabular-nums whitespace-nowrap shrink-0 ${
                    tx.amount_points >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {tx.amount_points >= 0 ? `+${tx.amount_points}` : tx.amount_points} {t('home.points_unit', 'PTS')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
