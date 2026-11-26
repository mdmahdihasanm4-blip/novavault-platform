import { Check, Copy, Share2, Users } from 'lucide-react';
import { useState } from 'react';
import { safeOpenExternalUrl } from '../../lib/telegram.ts';
import type { BootstrapPayload } from '../../types/app.ts';

interface ReferTabProps {
  data: BootstrapPayload;
  t: (key: string, fallback?: string) => string;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

export function ReferTab({ data, t, onToast }: ReferTabProps) {
  const [copied, setCopied] = useState(false);
  const { user, settings, referrals } = data;

  const botUsername = (settings.botUsername || 'NovaVaultRewardBot').replace(/^@/, '');
  const tgInviteLink = `https://t.me/${botUsername}?startapp=ref_${user.referralCode}`;
  const rewardPts = Number(settings.referralRewardPoints || '100');
  const level2Pct = Number(settings.referralLevel2Percent || '20');
  const maxLevels = Number(settings.referralMaxLevels || '2');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(tgInviteLink);
      setCopied(true);
      onToast(t('refer.copied', 'Referral link copied'), 'success');
      setTimeout(() => setCopied(false), 1800);
    } catch {
      onToast(tgInviteLink, 'success');
    }
  };

  const handleShare = () => {
    const shareText = encodeURIComponent(
      `Join ${settings.appName} and earn verified daily rewards using my invite link:`
    );
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(tgInviteLink)}&text=${shareText}`;
    safeOpenExternalUrl(shareUrl);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">{t('refer.title', 'Invite Friends')}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {t('refer.subtitle', 'Earn verified rewards when friends join and complete tasks')}
        </p>
      </div>

      {settings.referralsEnabled === 'false' && (
        <div className="rounded-2xl border border-amber-400/25 bg-amber-950/20 px-4 py-3 text-xs sm:text-sm text-amber-200">
          {t('refer.paused', 'Referral bonuses are temporarily paused by admin.')}
        </div>
      )}

      {/* Invite Card & Metrics Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        <section className="lg:col-span-7 rounded-3xl border border-violet-400/20 bg-gradient-to-br from-[#271952] via-[#171234] to-[#10152B] p-6 flex flex-col justify-between gap-5">
          <div>
            <p className="text-xs font-medium text-violet-200/80">{t('refer.your_link', 'Your Referral Link')}</p>
            <div className="mt-2.5 rounded-2xl border border-white/10 bg-[#080B18]/80 px-4 py-3 font-mono text-xs sm:text-sm text-slate-200 break-all">
              {tgInviteLink}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="min-h-[46px] flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(124,58,237,0.4)] transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              <span>{copied ? t('refer.copied', 'Copied') : t('refer.copy_link', 'Copy Link')}</span>
            </button>

            <button
              type="button"
              onClick={handleShare}
              className="min-h-[46px] flex-1 sm:flex-none inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/8 hover:bg-white/14 px-5 py-2.5 text-sm font-semibold text-white transition-all whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Share2 className="h-4 w-4" />
              <span>{t('refer.share_telegram', 'Share in Telegram')}</span>
            </button>
          </div>
        </section>

        {/* Stats Grid */}
        <section className="lg:col-span-5 grid grid-cols-2 gap-3.5">
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 flex flex-col justify-between">
            <span className="text-xs text-slate-400">{t('refer.total_invited', 'Invited Friends')}</span>
            <p className="mt-2 font-display text-3xl font-bold text-white tabular-nums">{referrals.length}</p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 flex flex-col justify-between">
            <span className="text-xs text-slate-400">{t('refer.total_earnings', 'Referral Earnings')}</span>
            <p className="mt-2 font-display text-3xl font-bold text-emerald-300 tabular-nums">
              {user.referralEarnings.toLocaleString()}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 flex flex-col justify-between">
            <span className="text-xs text-slate-400">{t('refer.reward_per_invite', 'Reward Per Qualified Invite')}</span>
            <p className="mt-2 font-mono text-xl font-bold text-violet-300 tabular-nums">
              +{rewardPts} {t('home.points_unit', 'PTS')}
            </p>
          </div>
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 flex flex-col justify-between">
            <span className="text-xs text-slate-400">{t('refer.level2_bonus', 'Tier 2 Bonus')}</span>
            <p className="mt-2 font-mono text-xl font-bold text-indigo-300 tabular-nums">
              {maxLevels >= 2 ? `${level2Pct}%` : t('status.off', 'Off')}
            </p>
          </div>
        </section>
      </div>

      {/* Referral History */}
      <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
        <div className="flex items-center justify-between pb-4 border-b border-white/8">
          <h2 className="font-display text-base font-bold text-white">{t('refer.history_title', 'Referral History')}</h2>
          <span className="font-mono text-xs text-slate-400 tabular-nums">{referrals.length}</span>
        </div>

        {referrals.length === 0 ? (
          <div className="py-10 text-center">
            <Users className="mx-auto h-8 w-8 text-slate-600" />
            <p className="mt-2 text-sm text-slate-400">
              {t('refer.no_referrals', 'You have not invited any friends yet.')}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-white/8">
            {referrals.map((ref) => (
              <div key={ref.id} className="py-3.5 flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white truncate">
                    {ref.first_name || ref.username} <span className="text-xs text-slate-400">@{ref.username}</span>
                  </p>
                  <p className="text-xs text-slate-500">{new Date(ref.created_at).toLocaleDateString()}</p>
                </div>
                <span
                  className={`text-xs font-semibold whitespace-nowrap ${
                    ref.referral_qualified ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                >
                  {ref.referral_qualified ? t('status.verified', 'Verified') : t('status.pending', 'Pending')}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
