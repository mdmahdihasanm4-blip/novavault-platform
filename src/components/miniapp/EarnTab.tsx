import { CalendarCheck2, CheckCircle2, Clock, ExternalLink, KeyRound, MegaphoneOff, Play, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { safeOpenExternalUrl } from '../../lib/telegram.ts';
import type { BootstrapPayload, TaskItem } from '../../types/app.ts';
import { CountdownTimer } from './CountdownTimer.tsx';

interface EarnTabProps {
  data: BootstrapPayload;
  t: (key: string, fallback?: string) => string;
  onClaimCheckin: () => Promise<void>;
  onSubmitTask: (taskId: number, payload: { proofText?: string; secretCode?: string }) => Promise<void>;
  onStartAd: (providerId: number, slotNumber: number) => Promise<void>;
  adLoadingSlot: number | null;
  checkinLoading: boolean;
}

export function EarnTab({ data, t, onClaimCheckin, onSubmitTask, onStartAd, adLoadingSlot, checkinLoading }: EarnTabProps) {
  const [filter, setFilter] = useState<'all' | 'youtube' | 'social' | 'custom' | 'partner' | 'special_offer'>('all');
  const [inputs, setInputs] = useState<Record<number, string>>({});
  const [submittingId, setSubmittingId] = useState<number | null>(null);

  const filteredTasks = data.tasks.filter((task) => (filter === 'all' ? true : task.category === filter));
  const checkinReward = Number(data.settings.dailyCheckinReward || '25');
  const checkinPaused = data.settings.checkinEnabled === 'false';
  const tasksPaused = data.settings.tasksEnabled === 'false';
  const maxDailyEarnings = Math.max(1, Number(data.dailyStats.dailyMaxEarnings || data.settings.dailyMaxEarnings || '500'));
  const dailyCapReached = data.dailyStats.earnedToday >= maxDailyEarnings;
  const { adProgram } = data;

  const handleTaskSubmit = async (task: TaskItem) => {
    const val = (inputs[task.id] || '').trim();
    if (!val) return;
    setSubmittingId(task.id);
    try {
      if (task.verification_type === 'code_verify') {
        await onSubmitTask(task.id, { secretCode: val });
      } else {
        await onSubmitTask(task.id, { proofText: val });
      }
      setInputs((prev) => ({ ...prev, [task.id]: '' }));
    } finally {
      setSubmittingId(null);
    }
  };

  const categories: Array<{ id: 'all' | 'youtube' | 'social' | 'custom' | 'partner' | 'special_offer'; label: string }> = [
    { id: 'all', label: t('earn.filter_all', 'All') },
    { id: 'youtube', label: t('earn.filter_youtube', 'YouTube') },
    { id: 'social', label: t('earn.filter_social', 'Social') },
    { id: 'special_offer', label: t('earn.filter_offer', 'Special Offers') },
    { id: 'custom', label: t('earn.filter_custom', 'Missions') },
    { id: 'partner', label: t('earn.filter_partner', 'Partners') },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">{t('earn.title', 'Earn Rewards')}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {t('earn.subtitle', 'Complete verified missions, check-ins, and media tasks')}
          </p>
        </div>

        {/* Interactive Category Filter */}
        <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-white/10 bg-[#10152B] p-1">
          {categories.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                filter === c.id
                  ? 'bg-violet-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {/* Daily Check-In Banner */}
      <section className="rounded-3xl border border-violet-400/20 bg-gradient-to-r from-[#221747] to-[#131832] p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-violet-500/20 border border-violet-400/30 text-violet-200">
            <CalendarCheck2 className="h-6 w-6" />
          </div>
          <div>
            <h2 className="font-display text-base font-semibold text-white">
              {t('earn.daily_checkin_title', 'Daily Check-In')}
            </h2>
            <p className="mt-0.5 text-xs sm:text-sm text-slate-300">
              {t('earn.daily_checkin_desc', 'Claim your daily loyalty reward once every 24 hours')} ·{' '}
              <strong className="font-mono text-violet-300 tabular-nums">
                +{checkinReward} {t('home.points_unit', 'PTS')}
              </strong>
            </p>
          </div>
        </div>

        <button
          type="button"
          disabled={checkinPaused || data.dailyStats.checkinClaimedToday || checkinLoading}
          onClick={() => void onClaimCheckin()}
          className={`min-h-[44px] rounded-xl px-5 py-2.5 text-sm font-semibold transition-all whitespace-nowrap shrink-0 cursor-pointer ${
            checkinPaused
              ? 'border border-white/10 bg-slate-800 text-slate-400 cursor-not-allowed'
              : data.dailyStats.checkinClaimedToday
                ? 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 cursor-default'
                : 'bg-violet-600 hover:bg-violet-500 text-white shadow-[0_0_20px_rgba(124,58,237,0.4)] active:scale-[0.98]'
          }`}
        >
          {checkinPaused
            ? t('earn.checkin_paused', 'Daily check-in is temporarily paused.')
            : data.dailyStats.checkinClaimedToday
              ? t('earn.claimed_today', 'Claimed Today')
              : checkinLoading
                ? '...'
                : t('earn.claim_checkin_btn', 'Claim Daily Reward')}
        </button>
      </section>

      {/* Daily Earning Limit Bar */}
      <div className="rounded-2xl border border-white/10 bg-[#10152B] px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="text-slate-300">
          {t('home.daily_progress', 'Daily Earning Progress')}:{' '}
          <strong className="font-mono text-violet-300 tabular-nums">
            {data.dailyStats.earnedToday} / {maxDailyEarnings} {t('home.points_unit', 'PTS')}
          </strong>
        </span>
        {dailyCapReached && (
          <span className="font-semibold text-amber-300">
            {t('home.daily_cap_reached', 'Daily earning limit reached.')}
          </span>
        )}
      </div>

      {/* Daily Advertisements Section */}
      {!adProgram ? (
        <section className="rounded-3xl border border-white/10 bg-[#10152B] p-6 text-center space-y-2">
          <MegaphoneOff className="mx-auto h-7 w-7 text-slate-500" />
          <h2 className="font-display text-base font-bold text-white">
            {t('home.watch_ads_title', 'Watch Ads & Earn')}
          </h2>
          <p className="text-xs sm:text-sm text-slate-400">
            {t('home.ads_unavailable', 'Advertisements are temporarily unavailable.')}
          </p>
        </section>
      ) : (
        <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 border-b border-white/8">
            <div>
              <h2 className="font-display text-base font-bold text-white">
                {t('home.watch_ads_title', 'Watch Ads & Earn')}
              </h2>
              <p className="text-xs text-slate-400">
                {t('home.watch_ads_subtitle', 'Verified postback rewards per completed view')}
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-300">
              <span>
                {t('home.remaining_ads', 'Remaining Today')}:{' '}
                <strong className="font-mono text-violet-300 tabular-nums">
                  {adProgram.remainingToday}/{adProgram.dailyLimit}
                </strong>
              </span>
              <span aria-hidden="true" className="text-slate-600">·</span>
              <CountdownTimer targetIso={adProgram.nextResetIso} className="text-slate-200" />
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {adProgram.slots.map((slot) => {
              const isDone = slot.status === 'verified';
              const isPending = slot.status === 'initiated';
              const limitReached =
                adProgram.remainingToday <= 0 ||
                adProgram.earnedToday >= adProgram.dailyMaxAdEarnings ||
                dailyCapReached;
              const disabled = isDone || (limitReached && !isPending) || adLoadingSlot === slot.slotNumber;

              return (
                <div
                  key={slot.slotNumber}
                  className="rounded-2xl border border-white/8 bg-[#151B36] p-3.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-display text-sm font-semibold text-white truncate">
                      {t('home.watch_ad_prefix', 'Watch Ad')} #{slot.slotNumber}
                    </p>
                    <p className="text-xs text-slate-400 font-mono tabular-nums">
                      +{slot.rewardPoints} {t('home.points_unit', 'PTS')}
                    </p>
                  </div>
                  {isDone ? (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-400">
                      <CheckCircle2 className="h-4 w-4" />
                      <span>{t('home.ad_completed', 'Completed')}</span>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => void onStartAd(adProgram.providerId, slot.slotNumber)}
                      className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-500 px-3.5 text-xs font-semibold text-white cursor-pointer"
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
        </section>
      )}

      {/* Task List */}
      {tasksPaused ? (
        <div className="rounded-3xl border border-amber-400/25 bg-amber-950/15 p-8 text-center text-sm text-amber-200">
          {t('earn.tasks_paused', 'Tasks and missions are temporarily paused by admin.')}
        </div>
      ) : filteredTasks.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-[#10152B] p-10 text-center text-sm text-slate-400">
          {t('earn.no_tasks', 'No active tasks in this category right now.')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredTasks.map((task) => {
            const isApproved = task.latestStatus === 'approved' && task.todayCount >= task.daily_limit;
            const isPending = task.latestStatus === 'pending';
            const isRejected = task.latestStatus === 'rejected';
            const canSubmit = !isApproved && !isPending && task.todayCount < task.daily_limit;

            return (
              <article
                key={task.id}
                className="rounded-3xl border border-white/10 bg-[#10152B] p-5 flex flex-col justify-between gap-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        <span className="capitalize font-medium text-violet-300">{task.category}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {task.todayCount}/{task.daily_limit} {t('earn.daily_label', 'daily')}
                        </span>
                        {task.expires_at && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{new Date(task.expires_at).toLocaleDateString()}</span>
                          </>
                        )}
                      </div>
                      <h3 className="mt-1.5 font-display text-base font-semibold text-white">{task.title}</h3>
                    </div>

                    <span className="font-mono text-sm font-bold text-violet-300 tabular-nums whitespace-nowrap shrink-0">
                      +{task.reward_points} {t('home.points_unit', 'PTS')}
                    </span>
                  </div>

                  <p className="mt-2 text-xs sm:text-sm text-slate-400 leading-relaxed">{task.description}</p>
                </div>

                {/* Status / Verification Controls */}
                <div className="space-y-3 pt-3 border-t border-white/8">
                  <div className="flex items-center justify-between gap-2">
                    {task.target_url ? (
                      <button
                        type="button"
                        onClick={() => safeOpenExternalUrl(task.target_url)}
                        className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 px-4 py-2 text-xs font-semibold text-slate-100 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        <span>{t('earn.open_task_btn', 'Open Link')}</span>
                      </button>
                    ) : (
                      <span />
                    )}

                    {isApproved && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>{t('status.approved', 'Approved')}</span>
                      </span>
                    )}
                    {isPending && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-300">
                        <Clock className="h-4 w-4" />
                        <span>{t('status.pending', 'Pending')}</span>
                      </span>
                    )}
                    {isRejected && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
                        <XCircle className="h-4 w-4" />
                        <span>{t('status.rejected', 'Rejected')}</span>
                      </span>
                    )}
                  </div>

                  {isRejected && task.reviewNote && (
                    <p className="text-xs text-rose-300/90">{task.reviewNote}</p>
                  )}

                  {canSubmit && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={inputs[task.id] || ''}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [task.id]: e.target.value }))}
                        placeholder={
                          task.verification_type === 'code_verify'
                            ? t('earn.code_placeholder', 'Enter secret code from video')
                            : t('earn.proof_placeholder', 'Enter your username, link, or verification note')
                        }
                        className="min-h-[42px] flex-1 min-w-0 rounded-xl border border-white/10 bg-[#080B18] px-3.5 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
                      />
                      <button
                        type="button"
                        disabled={submittingId === task.id || !(inputs[task.id] || '').trim()}
                        onClick={() => void handleTaskSubmit(task)}
                        className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-40 px-4 py-2 text-xs font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {task.verification_type === 'code_verify' ? (
                          <KeyRound className="h-3.5 w-3.5" />
                        ) : (
                          <Send className="h-3.5 w-3.5" />
                        )}
                        <span>
                          {submittingId === task.id
                            ? '...'
                            : task.verification_type === 'code_verify'
                              ? t('earn.verify_code_btn', 'Verify Code')
                              : t('earn.submit_proof_btn', 'Submit Proof')}
                        </span>
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
