import {
  ArrowDownToLine,
  ExternalLink,
  FileText,
  Globe,
  HelpCircle,
  Shield,
  ShieldCheck,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';
import { safeOpenExternalUrl } from '../../lib/telegram.ts';
import type { BootstrapPayload } from '../../types/app.ts';

interface AccountTabProps {
  data: BootstrapPayload;
  token: string;
  t: (key: string, fallback?: string) => string;
  onRefresh: (lang?: string) => Promise<void>;
  onToast: (msg: string, type?: 'success' | 'error') => void;
  onOpenAdmin: () => void;
}

export function AccountTab({ data, token, t, onRefresh, onToast, onOpenAdmin }: AccountTabProps) {
  const { user, settings, withdrawalMethods, withdrawals, transactions, languages } = data;
  const rate = Math.max(1, Number(settings.pointsPerBdt || '10'));

  const [selectedMethodId, setSelectedMethodId] = useState<number>(withdrawalMethods[0]?.id || 0);
  const activeMethod = withdrawalMethods.find((m) => m.id === selectedMethodId) || withdrawalMethods[0] || null;

  const [network, setNetwork] = useState<string>(activeMethod?.networks[0] || '');
  const [accountAddress, setAccountAddress] = useState('');
  const [pointsInput, setPointsInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [legalModal, setLegalModal] = useState<'terms' | 'privacy' | null>(null);

  useEffect(() => {
    if (activeMethod) {
      setNetwork(activeMethod.networks[0] || '');
    }
  }, [activeMethod?.id]);

  const ptsNum = Math.max(0, Math.floor(Number(pointsInput || '0')));
  const feePct = activeMethod
    ? activeMethod.fee_percent > 0
      ? activeMethod.fee_percent
      : Number(settings.withdrawalFeePercent || '0')
    : 0;
  const bdtGross = ptsNum / rate;
  const feeBdt = (bdtGross * feePct) / 100;
  const netBdt = Math.max(0, bdtGross - feeBdt);

  const withdrawalsPaused = settings.withdrawalsEnabled === 'false';

  const handleWithdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeMethod || submitting || withdrawalsPaused) return;
    setSubmitting(true);
    try {
      await apiFetch(
        '/api/withdrawals',
        {
          method: 'POST',
          body: JSON.stringify({
            methodId: activeMethod.id,
            network,
            accountAddress,
            pointsAmount: ptsNum,
          }),
        },
        token
      );
      setAccountAddress('');
      setPointsInput('');
      onToast(t('msg.withdraw_submitted', 'Withdrawal request submitted for admin approval.'), 'success');
      await onRefresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLanguageChange = async (langCode: string) => {
    try {
      await apiFetch('/api/user/language', { method: 'POST', body: JSON.stringify({ language: langCode }) }, token);
      await onRefresh(langCode);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('err.generic', 'Failed to switch language'), 'error');
    }
  };

  const statusColor = (status: string) => {
    if (status === 'paid' || status === 'approved') return 'text-emerald-400';
    if (status === 'rejected') return 'text-rose-400';
    return 'text-amber-300';
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">{t('account.title', 'Account & Wallet')}</h1>
          <p className="mt-1 text-xs sm:text-sm text-slate-400">
            @{user.username} · {t('account.telegram_id', 'Telegram ID')} <span className="font-mono">{user.telegramId}</span>
          </p>
        </div>

        <button
          type="button"
          onClick={onOpenAdmin}
          className="min-h-[42px] inline-flex items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/15 hover:bg-violet-500/25 px-4 py-2 text-xs font-semibold text-violet-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <ShieldCheck className="h-4 w-4" />
          <span>{t('account.admin_panel', 'Admin Panel')}</span>
        </button>
      </div>

      {/* Wallet Overview 4-Card Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
        <div className="rounded-2xl border border-white/10 bg-[#10152B] p-4">
          <span className="text-xs text-slate-400">{t('account.available_balance', 'Available Balance')}</span>
          <p className="mt-1.5 font-mono text-xl font-bold text-white tabular-nums">
            {user.pointsBalance.toLocaleString()} <span className="text-xs text-violet-300">{t('home.points_unit', 'PTS')}</span>
          </p>
          <p className="mt-0.5 font-mono text-xs text-emerald-300 tabular-nums">৳{(user.pointsBalance / rate).toFixed(2)} BDT</p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#10152B] p-4">
          <span className="text-xs text-slate-400">{t('account.pending_balance', 'Pending Withdrawal')}</span>
          <p className="mt-1.5 font-mono text-xl font-bold text-amber-300 tabular-nums">
            {user.pendingBalance.toLocaleString()} <span className="text-xs">{t('home.points_unit', 'PTS')}</span>
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#10152B] p-4">
          <span className="text-xs text-slate-400">{t('account.total_earned', 'Total Earned')}</span>
          <p className="mt-1.5 font-mono text-xl font-bold text-violet-300 tabular-nums">
            {user.totalEarned.toLocaleString()} <span className="text-xs">{t('home.points_unit', 'PTS')}</span>
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-[#10152B] p-4">
          <span className="text-xs text-slate-400">{t('account.total_withdrawn', 'Total Withdrawn')}</span>
          <p className="mt-1.5 font-mono text-xl font-bold text-emerald-300 tabular-nums">
            {user.totalWithdrawn.toLocaleString()} <span className="text-xs">{t('home.points_unit', 'PTS')}</span>
          </p>
        </div>
      </div>

      {/* Main Split: Withdraw Form + Settings & Support */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Withdrawal Form */}
        <section className="lg:col-span-7 rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
          <div className="flex items-center gap-2.5 pb-4 border-b border-white/8">
            <Wallet className="h-5 w-5 text-violet-400" />
            <h2 className="font-display text-lg font-bold text-white">
              {t('account.withdraw_section', 'Withdraw Funds')}
            </h2>
          </div>

          {withdrawalsPaused ? (
            <div className="mt-4 rounded-2xl border border-amber-400/25 bg-amber-950/20 p-5 text-sm text-amber-200">
              {t('account.withdrawals_paused', 'Withdrawals are temporarily paused by admin.')}
            </div>
          ) : withdrawalMethods.length === 0 ? (
            <p className="py-6 text-sm text-slate-400">
              {t('account.no_methods', 'No withdrawal methods are currently active.')}
            </p>
          ) : (
            <form onSubmit={(e) => void handleWithdraw(e)} className="mt-5 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-2">
                  {t('account.select_method', 'Payment Method')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {withdrawalMethods.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setSelectedMethodId(m.id)}
                      className={`min-h-[42px] rounded-xl px-4 py-2 text-xs font-semibold border transition-colors cursor-pointer ${
                        activeMethod?.id === m.id
                          ? 'border-violet-400 bg-violet-600 text-white'
                          : 'border-white/10 bg-[#080B18] text-slate-300 hover:border-white/25'
                      }`}
                    >
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>

              {activeMethod && activeMethod.networks.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-2">
                    {t('account.select_network', 'Account Type')}
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {activeMethod.networks.map((net) => (
                      <button
                        key={net}
                        type="button"
                        onClick={() => setNetwork(net)}
                        className={`min-h-[38px] rounded-lg px-3.5 py-1.5 text-xs font-medium border transition-colors cursor-pointer ${
                          network === net
                            ? 'border-violet-400 bg-violet-500/20 text-violet-200'
                            : 'border-white/10 bg-[#080B18] text-slate-400 hover:text-white'
                        }`}
                      >
                        {net}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  {t('account.address_label', 'bKash / Nagad Account Number')}
                </label>
                <input
                  type="tel"
                  required
                  value={accountAddress}
                  onChange={(e) => setAccountAddress(e.target.value)}
                  placeholder="01XXXXXXXXX"
                  className="min-h-[44px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none font-mono"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs text-slate-300 mb-1.5">
                  <label>{t('account.amount_label', 'Points to Withdraw')}</label>
                  {activeMethod && (
                    <span className="font-mono text-slate-400 tabular-nums">
                      Min {activeMethod.min_points.toLocaleString()} · Max {activeMethod.max_points.toLocaleString()}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    required
                    min={activeMethod?.min_points || 100}
                    max={user.pointsBalance}
                    value={pointsInput}
                    onChange={(e) => setPointsInput(e.target.value)}
                    placeholder="500"
                    className="min-h-[44px] flex-1 rounded-xl border border-white/10 bg-[#080B18] px-3.5 font-mono text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none tabular-nums"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const maxAllowed = activeMethod ? Math.min(user.pointsBalance, activeMethod.max_points) : user.pointsBalance;
                      setPointsInput(String(Math.max(0, Math.floor(maxAllowed))));
                    }}
                    className="min-h-[44px] rounded-xl border border-violet-400/30 bg-violet-500/15 hover:bg-violet-500/25 px-3.5 text-xs font-semibold text-violet-200 cursor-pointer"
                  >
                    Max
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-white/8 bg-[#0B0F20] p-3.5 flex items-center justify-between text-xs">
                <div>
                  <span className="text-slate-400">{t('account.fee_label', 'Fee')} ({feePct}%):</span>{' '}
                  <span className="font-mono text-slate-200 tabular-nums">৳{feeBdt.toFixed(2)}</span>
                </div>
                <div>
                  <span className="text-slate-400">{t('account.receive_label', 'You Receive')}:</span>{' '}
                  <strong className="font-mono text-emerald-300 tabular-nums">৳{netBdt.toFixed(2)} BDT</strong>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || ptsNum <= 0 || ptsNum > user.pointsBalance}
                className="min-h-[46px] w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-500 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_rgba(124,58,237,0.35)] disabled:shadow-none transition-all cursor-pointer"
              >
                <ArrowDownToLine className="h-4 w-4" />
                <span>{submitting ? '...' : t('account.submit_withdraw', 'Submit Withdrawal Request')}</span>
              </button>
            </form>
          )}
        </section>

        {/* Right Column: Preferences, Language & Support */}
        <section className="lg:col-span-5 space-y-4">
          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 space-y-4">
            <div className="flex items-center gap-2.5">
              <Globe className="h-4 w-4 text-violet-400" />
              <h3 className="font-display text-base font-semibold text-white">
                {t('account.language_label', 'App Language')}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {languages.map((lang) => (
                <button
                  key={lang.code}
                  type="button"
                  onClick={() => void handleLanguageChange(lang.code)}
                  className={`min-h-[40px] rounded-xl px-4 py-2 text-xs font-semibold border transition-colors cursor-pointer ${
                    user.language === lang.code
                      ? 'border-violet-400 bg-violet-600 text-white'
                      : 'border-white/10 bg-[#080B18] text-slate-300 hover:border-white/25'
                  }`}
                >
                  {lang.native_name} ({lang.code.toUpperCase()})
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-3xl border border-white/10 bg-[#10152B] p-5 divide-y divide-white/8">
            <button
              type="button"
              onClick={() => safeOpenExternalUrl(settings.supportUrl)}
              className="w-full py-3.5 flex items-center justify-between text-sm text-slate-200 hover:text-white cursor-pointer"
            >
              <span className="inline-flex items-center gap-2.5">
                <HelpCircle className="h-4 w-4 text-violet-400" />
                <span>{t('account.support_label', 'Support & Community')}</span>
              </span>
              <ExternalLink className="h-4 w-4 text-slate-500" />
            </button>
            <button
              type="button"
              onClick={() => setLegalModal('terms')}
              className="w-full py-3.5 flex items-center justify-between text-sm text-slate-200 hover:text-white cursor-pointer"
            >
              <span className="inline-flex items-center gap-2.5">
                <FileText className="h-4 w-4 text-violet-400" />
                <span>{t('account.terms_label', 'Terms & Conditions')}</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setLegalModal('privacy')}
              className="w-full py-3.5 flex items-center justify-between text-sm text-slate-200 hover:text-white cursor-pointer"
            >
              <span className="inline-flex items-center gap-2.5">
                <Shield className="h-4 w-4 text-violet-400" />
                <span>{t('account.privacy_label', 'Privacy Policy')}</span>
              </span>
            </button>
          </div>
        </section>
      </div>

      {/* Withdrawal History & Transaction Ledger */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
          <h2 className="font-display text-base font-bold text-white pb-3 border-b border-white/8">
            {t('account.withdraw_history', 'Withdrawal History')}
          </h2>
          {withdrawals.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              {t('account.no_withdrawals', 'No withdrawal requests yet.')}
            </p>
          ) : (
            <div className="divide-y divide-white/8">
              {withdrawals.map((w) => (
                <div key={w.id} className="py-3.5 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">
                      {w.method_name} · <span className="text-slate-400">{w.network}</span>
                    </p>
                    <p className="mt-0.5 font-mono text-xs text-slate-400 truncate">{w.account_address}</p>
                    {w.admin_note && <p className="mt-1 text-xs text-slate-300">{w.admin_note}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-mono text-sm font-bold text-white tabular-nums">
                      ৳{Number(w.net_bdt || 0).toFixed(2)} BDT
                    </p>
                    <p className="font-mono text-[11px] text-slate-400 tabular-nums">
                      {w.points_amount.toLocaleString()} {t('home.points_unit', 'PTS')}
                    </p>
                    <p className={`text-xs font-semibold capitalize ${statusColor(w.status)}`}>
                      {t(`status.${w.status}`, w.status)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-white/10 bg-[#10152B] p-5 sm:p-6">
          <h2 className="font-display text-base font-bold text-white pb-3 border-b border-white/8">
            {t('account.tx_history', 'Transaction Ledger')}
          </h2>
          {transactions.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-400">
              {t('account.no_transactions', 'No transactions recorded yet.')}
            </p>
          ) : (
            <div className="divide-y divide-white/8 max-h-96 overflow-y-auto pr-1">
              {transactions.map((tx) => (
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

      {/* Terms / Privacy Modal */}
      {legalModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-3xl border border-white/15 bg-[#10152B] p-6 shadow-2xl">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="font-display text-lg font-bold text-white">
                {legalModal === 'terms'
                  ? t('account.terms_label', 'Terms & Conditions')
                  : t('account.privacy_label', 'Privacy Policy')}
              </h3>
              <button
                type="button"
                onClick={() => setLegalModal(null)}
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-xl text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-slate-300 whitespace-pre-line">
              {legalModal === 'terms' ? settings.termsText : settings.privacyText}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
