import {
  ArrowLeft,
  Bot,
  CheckSquare,
  Download,
  Gamepad2,
  Languages,
  LayoutDashboard,
  LogOut,
  Menu,
  Megaphone,
  Receipt,
  Save,
  Search,
  Server,
  Settings,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';
import type { AppSettings } from '../../types/app.ts';
import { AdminAdsSection, AdminTasksSection, AdminUsersSection } from './AdminUsersTasksAds.tsx';
import { AdminGamesSection, AdminI18nSection, AdminWithdrawalsSection } from './AdminWithdrawalsGamesI18n.tsx';

type AdminSection = 'overview' | 'users' | 'tasks' | 'ads' | 'withdrawals' | 'transactions' | 'games' | 'i18n' | 'settings';

interface AdminPanelProps {
  adminToken: string;
  adminEmail: string;
  onLogout: () => void;
  onBackToApp: () => void;
  onToast: (m: string, t?: 'success' | 'error') => void;
}

export function AdminPanel({ adminToken, adminEmail, onLogout, onBackToApp, onToast }: AdminPanelProps) {
  const [section, setSection] = useState<AdminSection>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [metrics, setMetrics] = useState<Record<string, number> | null>(null);
  const [audits, setAudits] = useState<Array<{ id: number; admin_actor: string; action: string; target_type: string; target_id: string; created_at: string }>>([]);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [referralsList, setReferralsList] = useState<Array<{ id: number; username: string; referrer_username: string; referral_qualified: number; created_at: string }>>([]);
  const [savingSettings, setSavingSettings] = useState(false);
  const [tgStatus, setTgStatus] = useState<{
    configured: boolean;
    appUrl?: string;
    publicAppUrl?: string;
    envAppUrlIsAiStudio?: boolean;
    pollingEnabled?: boolean;
    adminIdsConfigured?: boolean;
    bot?: { username?: string; first_name?: string } | null;
    webhook?: { url?: string; pending_update_count?: number } | null;
    menuButton?: { type?: string; text?: string; web_app?: { url?: string } } | null;
    runtime?: {
      pollingActive?: boolean;
      connectedBotUsername?: string;
      lastError?: string;
      lastPollAt?: string;
      menuConfigured?: boolean;
      menuButtonUrl?: string;
      commandsConfigured?: boolean;
    };
  } | null>(null);
  const [publicUrlInput, setPublicUrlInput] = useState('');
  const [registeringWebhook, setRegisteringWebhook] = useState(false);
  const [configuringMenu, setConfiguringMenu] = useState(false);
  const [envStatus, setEnvStatus] = useState<{ env: Record<string, boolean>; nodeEnv: string } | null>(null);
  const [exportingZip, setExportingZip] = useState(false);

  const isLocalOrAiStudioOrigin =
    typeof window !== 'undefined' &&
    (/^(ais-dev-|ais-pre-)/.test(window.location.hostname) ||
      window.location.hostname.endsWith('aistudio.google.com') ||
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1');

  const loadOverview = async () => {
    try {
      const res = await apiFetch<{ metrics: Record<string, number>; recentAudits: typeof audits }>(
        '/api/admin/overview',
        {},
        adminToken
      );
      setMetrics(res.metrics);
      setAudits(res.recentAudits);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load dashboard', 'error');
    }
  };

  const loadSettings = async () => {
    try {
      const [res, tg, envRes] = await Promise.all([
        apiFetch<{ settings: AppSettings; referrals: typeof referralsList }>('/api/admin/settings', {}, adminToken),
        apiFetch<NonNullable<typeof tgStatus>>('/api/admin/telegram/status', {}, adminToken).catch(() => null),
        apiFetch<{ env: Record<string, boolean>; nodeEnv: string }>('/api/admin/env-status', {}, adminToken).catch(() => null),
      ]);
      setSettingsDraft(res.settings);
      setReferralsList(res.referrals);
      setTgStatus(tg);
      setEnvStatus(envRes);
      const detectedPublic =
        tg?.publicAppUrl ||
        res.settings.publicAppUrl ||
        (!isLocalOrAiStudioOrigin && typeof window !== 'undefined' ? window.location.origin : '');
      setPublicUrlInput(detectedPublic);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load settings', 'error');
    }
  };

  const downloadProjectZip = async () => {
    setExportingZip(true);
    try {
      const res = await fetch('/api/admin/export-project.zip', {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(errJson.error || 'Failed to export project ZIP');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'novavault-platform-source.zip';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onToast('Clean project ZIP downloaded (secrets excluded)', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Export failed', 'error');
    } finally {
      setExportingZip(false);
    }
  };

  const configureMenuButton = async () => {
    const targetUrl = publicUrlInput.trim();
    if (!targetUrl) {
      onToast('Enter your public HTTPS production URL (e.g. https://novavault.onrender.com) first.', 'error');
      return;
    }
    setConfiguringMenu(true);
    try {
      const res = await apiFetch<{ botUsername?: string; menuButtonUrl?: string }>(
        '/api/admin/telegram/configure-menu',
        { method: 'POST', body: JSON.stringify({ publicUrl: targetUrl }) },
        adminToken
      );
      onToast(
        `Verified & set Mini App launch button${res.botUsername ? ` for @${res.botUsername}` : ''}`,
        'success'
      );
      await loadSettings();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Menu configuration failed', 'error');
    } finally {
      setConfiguringMenu(false);
    }
  };

  const enablePollingMode = async () => {
    setRegisteringWebhook(true);
    try {
      await apiFetch('/api/admin/telegram/enable-polling', { method: 'POST' }, adminToken);
      onToast('Webhook cleared and polling mode ensured', 'success');
      await loadSettings();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to enable polling', 'error');
    } finally {
      setRegisteringWebhook(false);
    }
  };

  const registerWebhook = async () => {
    const targetUrl = publicUrlInput.trim();
    if (!targetUrl) {
      onToast('Enter your public HTTPS production URL before registering a webhook.', 'error');
      return;
    }
    setRegisteringWebhook(true);
    try {
      const res = await apiFetch<{ webhookUrl: string }>(
        '/api/admin/telegram/register-webhook',
        { method: 'POST', body: JSON.stringify({ publicUrl: targetUrl }) },
        adminToken
      );
      onToast(`Webhook registered: ${res.webhookUrl}`, 'success');
      await loadSettings();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Webhook registration failed', 'error');
    } finally {
      setRegisteringWebhook(false);
    }
  };

  useEffect(() => {
    if (section === 'overview') void loadOverview();
    if (section === 'settings') void loadSettings();
  }, [section]);

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsDraft) return;
    setSavingSettings(true);
    try {
      await apiFetch('/api/admin/settings', { method: 'PUT', body: JSON.stringify(settingsDraft) }, adminToken);
      onToast('App settings saved and applied live', 'success');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    } finally {
      setSavingSettings(false);
    }
  };

  const navItems: Array<{ id: AdminSection; label: string; Icon: typeof LayoutDashboard }> = [
    { id: 'overview', label: 'Overview', Icon: LayoutDashboard },
    { id: 'users', label: 'Users', Icon: Users },
    { id: 'tasks', label: 'Tasks & Reviews', Icon: CheckSquare },
    { id: 'ads', label: 'Ads & Postbacks', Icon: Megaphone },
    { id: 'withdrawals', label: 'Withdrawals', Icon: Wallet },
    { id: 'transactions', label: 'Transactions', Icon: Receipt },
    { id: 'games', label: 'Mini-Games', Icon: Gamepad2 },
    { id: 'i18n', label: 'Language & Text', Icon: Languages },
    { id: 'settings', label: 'Settings & Bot', Icon: Settings },
  ];

  const kpiCards = metrics
    ? [
        { label: 'Total Users', value: metrics.totalUsers },
        { label: 'Active (15m)', value: metrics.activeUsers },
        { label: 'New Users Today', value: metrics.newUsersToday },
        { label: 'Points Distributed', value: metrics.totalPointsDistributed },
        { label: 'Total Withdrawn (PTS)', value: metrics.totalPointsWithdrawn },
        { label: 'Withdraw Requests (৳ BDT)', value: Number(metrics.totalWithdrawalRequestsBdt || 0) },
        { label: 'Paid Payouts (৳ BDT)', value: Number(metrics.totalPaidWithdrawalsBdt || 0) },
        { label: 'Pending Withdrawals', value: metrics.pendingWithdrawals },
        { label: 'Total Referrals', value: metrics.totalReferrals },
        { label: 'Ad Impressions', value: metrics.adImpressionsTotal || 0 },
        { label: 'Verified Ads Today', value: metrics.verifiedAdsToday },
        { label: 'Postback Errors', value: metrics.postbackErrorsCount || 0 },
        { label: 'Active Ad Providers', value: metrics.activeAdProvidersCount || 0 },
        { label: 'Daily Points Earned', value: metrics.dailyPointsEarned },
        { label: 'Pending Task Reviews', value: metrics.pendingTaskReviews },
      ]
    : [];

  return (
    <div className="min-h-screen bg-[#080B18] text-slate-100 flex flex-col lg:flex-row">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col border-r border-white/10 bg-[#0C1022] p-4 shrink-0">
        <div className="px-2 pb-4 border-b border-white/10">
          <p className="font-display text-lg font-bold text-white">Admin Console</p>
          <p className="text-xs text-slate-400 truncate">{adminEmail}</p>
        </div>

        <nav className="mt-4 flex-1 space-y-1">
          {navItems.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={`w-full min-h-[42px] flex items-center gap-3 rounded-xl px-3.5 text-sm font-medium transition-colors cursor-pointer ${
                section === id ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-white/5 hover:text-white'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        <div className="pt-4 border-t border-white/10 space-y-2">
          <button
            type="button"
            onClick={onBackToApp}
            className="w-full min-h-[40px] flex items-center gap-2 rounded-xl border border-white/10 px-3.5 text-xs font-semibold text-slate-200 hover:bg-white/5 cursor-pointer"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Open Mini App</span>
          </button>
          <button
            type="button"
            onClick={onLogout}
            className="w-full min-h-[40px] flex items-center gap-2 rounded-xl px-3.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 cursor-pointer"
          >
            <LogOut className="h-4 w-4" />
            <span>Sign Out</span>
          </button>
        </div>
      </aside>

      {/* Mobile Header + Drawer */}
      <header className="lg:hidden sticky top-0 z-40 flex items-center justify-between border-b border-white/10 bg-[#0C1022]/95 backdrop-blur-md px-4 h-14">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-slate-200 cursor-pointer"
          aria-label="Open admin menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <span className="font-display text-sm font-bold text-white truncate">
          {navItems.find((n) => n.id === section)?.label}
        </span>
        <button
          type="button"
          onClick={onBackToApp}
          className="min-h-[38px] rounded-lg border border-white/15 px-3 text-xs font-semibold text-slate-200 cursor-pointer"
        >
          App
        </button>
      </header>

      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="fixed inset-0 bg-black/70" onClick={() => setMobileMenuOpen(false)} />
          <div className="relative w-72 max-w-[82vw] bg-[#0C1022] border-r border-white/10 p-4 flex flex-col z-10">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <span className="font-display text-base font-bold text-white">Admin Console</span>
              <button type="button" onClick={() => setMobileMenuOpen(false)} className="p-2 text-slate-400 cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <nav className="mt-4 flex-1 space-y-1 overflow-y-auto">
              {navItems.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setSection(id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full min-h-[44px] flex items-center gap-3 rounded-xl px-3.5 text-sm font-medium cursor-pointer ${
                    section === id ? 'bg-violet-600 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                </button>
              ))}
            </nav>
            <button
              type="button"
              onClick={onLogout}
              className="mt-4 min-h-[42px] flex items-center gap-2 rounded-xl px-3.5 text-xs font-semibold text-rose-300 hover:bg-rose-500/10 cursor-pointer"
            >
              <LogOut className="h-4 w-4" />
              <span>Sign Out</span>
            </button>
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-6xl w-full mx-auto space-y-6">
        {section === 'overview' && (
          <div className="space-y-6">
            <h2 className="font-display text-xl font-bold text-white">Platform Overview</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
              {kpiCards.map((k) => (
                <div key={k.label} className="rounded-2xl border border-white/10 bg-[#10152B] p-4">
                  <span className="text-xs text-slate-400">{k.label}</span>
                  <p className="mt-1.5 font-mono text-2xl font-bold text-white tabular-nums">
                    {(k.value ?? 0).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>

            <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
              <h3 className="font-display text-base font-bold text-white mb-3">Administrator Audit Log</h3>
              {audits.length === 0 ? (
                <p className="text-sm text-slate-400">No admin actions logged yet.</p>
              ) : (
                <div className="divide-y divide-white/8">
                  {audits.map((a) => (
                    <div key={a.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-xs">
                      <span className="text-slate-200">
                        <strong className="text-violet-300">{a.action}</strong> · {a.target_type} #{a.target_id} ({a.admin_actor})
                      </span>
                      <span className="font-mono text-slate-500">{new Date(a.created_at).toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}

        {section === 'users' && <AdminUsersSection adminToken={adminToken} onToast={onToast} />}
        {section === 'tasks' && <AdminTasksSection adminToken={adminToken} onToast={onToast} />}
        {section === 'ads' && <AdminAdsSection adminToken={adminToken} onToast={onToast} />}
        {section === 'withdrawals' && <AdminWithdrawalsSection adminToken={adminToken} onToast={onToast} />}
        {section === 'transactions' && <AdminTransactionsSection adminToken={adminToken} onToast={onToast} />}
        {section === 'games' && <AdminGamesSection adminToken={adminToken} onToast={onToast} />}
        {section === 'i18n' && <AdminI18nSection adminToken={adminToken} onToast={onToast} />}

        {section === 'settings' && settingsDraft && (
          <div className="space-y-6">
            <h2 className="font-display text-xl font-bold text-white">App Settings, Referrals & Telegram Bot</h2>

            <form onSubmit={(e) => void saveSettings(e)} className="space-y-6">
              {/* Branding & Theme */}
              <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-4">
                <h3 className="font-display text-base font-bold text-white">Branding & Appearance</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">App Name</label>
                    <input
                      type="text"
                      value={settingsDraft.appName || ''}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, appName: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Telegram Bot Username (without @)</label>
                    <input
                      type="text"
                      value={settingsDraft.botUsername || ''}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, botUsername: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Logo URL</label>
                    <input
                      type="text"
                      value={settingsDraft.logoUrl || ''}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, logoUrl: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Hero Banner URL</label>
                    <input
                      type="text"
                      value={settingsDraft.bannerUrl || ''}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, bannerUrl: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Primary Accent Color</label>
                    <input
                      type="text"
                      value={settingsDraft.primaryColor || '#7C3AED'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, primaryColor: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Canvas Background Color</label>
                    <input
                      type="text"
                      value={settingsDraft.bgColor || '#080B18'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, bgColor: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap gap-5 pt-2">
                  <label className="inline-flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingsDraft.maintenanceMode === 'true'}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, maintenanceMode: e.target.checked ? 'true' : 'false' })
                      }
                    />
                    <span>Maintenance Mode (Pause Earning & Withdrawals)</span>
                  </label>
                  <label className="inline-flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settingsDraft.registrationEnabled !== 'false'}
                      onChange={(e) =>
                        setSettingsDraft({ ...settingsDraft, registrationEnabled: e.target.checked ? 'true' : 'false' })
                      }
                    />
                    <span>Allow New Registrations</span>
                  </label>
                </div>

                <div className="pt-3 border-t border-white/10">
                  <p className="text-xs font-semibold text-slate-300 mb-2.5">Platform Feature Toggles</p>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs sm:text-sm">
                    {[
                      { key: 'adsEnabled', label: 'Watch Ads' },
                      { key: 'checkinEnabled', label: 'Daily Check-In' },
                      { key: 'tasksEnabled', label: 'Tasks & Offers' },
                      { key: 'gamesEnabled', label: 'Mini-Games' },
                      { key: 'referralsEnabled', label: 'Referrals' },
                      { key: 'withdrawalsEnabled', label: 'Withdrawals (bKash/Nagad)' },
                    ].map((feat) => (
                      <label key={feat.key} className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={settingsDraft[feat.key] !== 'false'}
                          onChange={(e) =>
                            setSettingsDraft({ ...settingsDraft, [feat.key]: e.target.checked ? 'true' : 'false' })
                          }
                        />
                        <span>{feat.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </section>

              {/* Economy, Withdrawals & Referrals */}
              <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-4">
                <h3 className="font-display text-base font-bold text-white">Economy, Withdrawals & Referral Rules</h3>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Points per ৳1 BDT</label>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.pointsPerBdt || '10'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, pointsPerBdt: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Min Withdraw (PTS)</label>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.minWithdrawalPoints || '500'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, minWithdrawalPoints: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Max Withdraw (PTS)</label>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.maxWithdrawalPoints || '100000'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, maxWithdrawalPoints: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Daily Check-In (PTS)</label>
                    <input
                      type="number"
                      value={settingsDraft.dailyCheckinReward || '25'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, dailyCheckinReward: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Max Daily Ad Earn (PTS)</label>
                    <input
                      type="number"
                      value={settingsDraft.dailyMaxAdEarnings || '200'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, dailyMaxAdEarnings: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Global Daily Earn Cap (PTS)</label>
                    <input
                      type="number"
                      min={0}
                      value={settingsDraft.dailyMaxEarnings || '500'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, dailyMaxEarnings: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Referral Reward (PTS)</label>
                    <input
                      type="number"
                      value={settingsDraft.referralRewardPoints || '100'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, referralRewardPoints: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Invitee Bonus (PTS)</label>
                    <input
                      type="number"
                      value={settingsDraft.referralInviteeBonus || '25'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, referralInviteeBonus: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Min Tasks to Qualify Ref</label>
                    <input
                      type="number"
                      min={1}
                      value={settingsDraft.referralConditionMinTasks || '1'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, referralConditionMinTasks: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Tier 2 Ref Bonus (%)</label>
                    <input
                      type="number"
                      value={settingsDraft.referralLevel2Percent || '20'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, referralLevel2Percent: e.target.value })}
                      className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                    />
                  </div>
                </div>
              </section>

              {/* Links & Legal */}
              <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-4">
                <h3 className="font-display text-base font-bold text-white">Support Links & Legal</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <input
                    type="url"
                    value={settingsDraft.supportUrl || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, supportUrl: e.target.value })}
                    placeholder="Support URL"
                    className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                  />
                  <input
                    type="url"
                    value={settingsDraft.channelUrl || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, channelUrl: e.target.value })}
                    placeholder="Official Channel URL"
                    className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                  />
                </div>
                <textarea
                  rows={3}
                  value={settingsDraft.termsText || ''}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, termsText: e.target.value })}
                  placeholder="Terms & Conditions"
                  className="w-full rounded-xl border border-white/10 bg-[#080B18] p-3 text-sm text-white"
                />
                <textarea
                  rows={3}
                  value={settingsDraft.privacyText || ''}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, privacyText: e.target.value })}
                  placeholder="Privacy Policy"
                  className="w-full rounded-xl border border-white/10 bg-[#080B18] p-3 text-sm text-white"
                />
                <button
                  type="submit"
                  disabled={savingSettings}
                  className="min-h-[44px] inline-flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 px-6 text-sm font-semibold text-white cursor-pointer"
                >
                  <Save className="h-4 w-4" />
                  <span>{savingSettings ? 'Saving...' : 'Save All Settings'}</span>
                </button>
              </section>
            </form>

            {/* BotFather & Free-Tier Setup Guide */}
            <section className="rounded-2xl border border-violet-400/25 bg-[#121733] p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Bot className="h-5 w-5 text-violet-300" />
                  <h3 className="font-display text-base font-bold text-white">Telegram BotFather & Public URL Setup</h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={configuringMenu || !tgStatus?.configured}
                    onClick={() => void configureMenuButton()}
                    className="min-h-[38px] rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-500 px-4 text-xs font-semibold text-white cursor-pointer"
                  >
                    {configuringMenu ? 'Verifying & Configuring...' : 'Verify & Set Mini App Launch Button'}
                  </button>
                  {tgStatus?.pollingEnabled ? (
                    tgStatus.webhook?.url ? (
                      <button
                        type="button"
                        disabled={registeringWebhook || !tgStatus?.configured}
                        onClick={() => void enablePollingMode()}
                        className="min-h-[38px] rounded-xl border border-amber-400/35 bg-amber-500/15 hover:bg-amber-500/25 px-4 text-xs font-semibold text-amber-200 cursor-pointer"
                      >
                        {registeringWebhook ? 'Switching...' : 'Clear Webhook & Use Polling'}
                      </button>
                    ) : null
                  ) : (
                    <button
                      type="button"
                      disabled={registeringWebhook || !tgStatus?.configured}
                      onClick={() => void registerWebhook()}
                      className="min-h-[38px] rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 disabled:bg-slate-800 disabled:text-slate-500 px-4 text-xs font-semibold text-white cursor-pointer"
                    >
                      {registeringWebhook ? 'Verifying & Registering...' : 'Register Webhook Automatically'}
                    </button>
                  )}
                </div>
              </div>

              {(isLocalOrAiStudioOrigin || tgStatus?.envAppUrlIsAiStudio) && !tgStatus?.publicAppUrl && (
                <div className="rounded-xl border border-amber-400/35 bg-amber-500/10 p-3.5 text-xs text-amber-200 leading-relaxed">
                  <strong>Why Telegram asks for Google Sign-In on AI Studio URLs:</strong> AI Studio preview hosts (
                  <code>ais-dev-*</code> / <code>ais-pre-*</code>) sit behind a Google Account authentication proxy and
                  return an HTTP 302 login redirect in Telegram. Deploy NovaVault to a public host (e.g. Render free
                  tier, Koyeb free tier, or Cloud Run with public unauthenticated access) and enter that public HTTPS URL
                  below.
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-300 mb-1.5 font-medium">
                  Public HTTPS Production URL (<code>PUBLIC_APP_URL</code>)
                </label>
                <input
                  type="url"
                  value={publicUrlInput}
                  onChange={(e) => setPublicUrlInput(e.target.value)}
                  placeholder="https://your-novavault-app.onrender.com"
                  className="min-h-[42px] w-full rounded-xl border border-white/15 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  Clicking <strong>Verify &amp; Set Mini App Launch Button</strong> checks that{' '}
                  <code>/api/health</code> returns public HTTP 200 JSON without any Google Sign-In redirect before
                  updating your Telegram bot.
                </p>
              </div>

              {tgStatus && (
                <div className="rounded-xl border border-white/10 bg-[#080B18] p-3.5 text-xs space-y-1.5">
                  <p>
                    Bot Token Status:{' '}
                    <strong className={tgStatus.configured ? 'text-emerald-400' : 'text-amber-300'}>
                      {tgStatus.configured ? 'Configured on Server' : 'Not Configured Yet (Set TELEGRAM_BOT_TOKEN in Secrets)'}
                    </strong>
                  </p>
                  <p>
                    Update Mode:{' '}
                    <strong className="text-violet-300">
                      {tgStatus.pollingEnabled ? 'Long-Polling (TELEGRAM_BOT_POLLING=true)' : 'Webhook Mode'}
                    </strong>
                    {tgStatus.pollingEnabled && tgStatus.runtime?.pollingActive && (
                      <span className="ml-2 text-emerald-400">· Polling Active</span>
                    )}
                  </p>
                  <p>
                    Admin Telegram IDs (<code>TELEGRAM_ADMIN_IDS</code>):{' '}
                    <strong className={tgStatus.adminIdsConfigured ? 'text-emerald-400' : 'text-amber-300'}>
                      {tgStatus.adminIdsConfigured ? 'Configured' : 'Not Set'}
                    </strong>
                  </p>
                  {tgStatus.bot?.username && (
                    <p className="text-slate-300">
                      Connected Bot: <span className="font-mono text-violet-300">@{tgStatus.bot.username}</span>
                    </p>
                  )}
                  <p className="text-slate-300 break-all">
                    Mini App Launch Button:{' '}
                    {tgStatus.menuButton?.web_app?.url ? (
                      <span className="font-mono text-emerald-300">
                        {tgStatus.menuButton.text || 'Launch'} → {tgStatus.menuButton.web_app.url}
                      </span>
                    ) : (
                      <span className="text-amber-300">
                        Not set to a Mini App URL yet (blocked AI Studio Google-auth URLs)
                      </span>
                    )}
                  </p>
                  {tgStatus.webhook?.url && (
                    <p className="text-slate-300 break-all">
                      Active Webhook: <span className="font-mono text-emerald-300">{tgStatus.webhook.url}</span>
                    </p>
                  )}
                  {tgStatus.runtime?.lastError && (
                    <p className="text-rose-400 break-all">Last Bot API Notice: {tgStatus.runtime.lastError}</p>
                  )}
                </div>
              )}

              <ol className="list-decimal list-inside space-y-1.5 text-xs sm:text-sm text-slate-300 leading-relaxed">
                <li>
                  Deploy NovaVault to a free public HTTPS host (such as <strong>Render Free Web Service</strong> via the
                  included <code>render.yaml</code> or <strong>Koyeb Free Tier</strong>) so there is no Google Sign-In
                  wall.
                </li>
                <li>
                  Set <code>TELEGRAM_BOT_TOKEN</code>, <code>TELEGRAM_ADMIN_IDS</code>, <code>ADMIN_PASSCODE</code>, and{' '}
                  <code>PUBLIC_APP_URL</code> in your host&apos;s environment variables (or paste the public HTTPS URL
                  above).
                </li>
                <li>
                  Click <strong>Verify &amp; Set Mini App Launch Button</strong> above so the bot verifies public
                  accessibility, sets its persistent Menu Button and <code>/start</code> button to your public URL, and
                  registers <code>/start</code>, <code>/balance</code>, <code>/help</code>, and <code>/admin</code>.
                </li>
                <li>
                  For webhook mode in production (<code>TELEGRAM_BOT_POLLING=false</code>), click{' '}
                  <strong>Register Webhook Automatically</strong> after deploying.
                </li>
                <li>
                  <strong>Zero-Budget Architecture:</strong> Uses embedded SQLite (<code>data/novavault.db</code>,
                  configurable via <code>DATA_DIR</code>) + official Telegram Bot API.
                </li>
              </ol>
            </section>

            {/* Server Environment Readiness & Clean Project Export */}
            <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-4">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Server className="h-5 w-5 text-violet-300" />
                  <div>
                    <h3 className="font-display text-base font-bold text-white">
                      Server Environment Readiness &amp; Project ZIP Export
                    </h3>
                    <p className="text-xs text-slate-400">
                      Boolean readiness check only (no secret values exposed). Download a clean deployment ZIP excluding{' '}
                      <code>.env</code> and runtime data.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={exportingZip}
                  onClick={() => void downloadProjectZip()}
                  className="min-h-[40px] inline-flex items-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 px-4 text-xs font-semibold text-white shrink-0 cursor-pointer"
                >
                  <Download className="h-4 w-4" />
                  <span>{exportingZip ? 'Packaging ZIP...' : 'Download Clean Project ZIP'}</span>
                </button>
              </div>

              {envStatus && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
                  {Object.entries(envStatus.env).map(([envKey, configured]) => (
                    <div
                      key={envKey}
                      className="rounded-xl border border-white/10 bg-[#080B18] px-3 py-2 flex items-center justify-between gap-2"
                    >
                      <span className="font-mono text-[11px] text-slate-300 truncate">{envKey}</span>
                      <span
                        className={`font-semibold shrink-0 ${
                          configured ? 'text-emerald-400' : 'text-amber-300'
                        }`}
                      >
                        {configured ? 'Set' : 'Unset'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Recent Referrals Overview */}
            <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
              <h3 className="font-display text-base font-bold text-white mb-3">Referral Network Activity</h3>
              {referralsList.length === 0 ? (
                <p className="text-sm text-slate-400">No referrals tracked yet.</p>
              ) : (
                <div className="divide-y divide-white/8">
                  {referralsList.map((r) => (
                    <div key={r.id} className="py-2.5 flex items-center justify-between text-xs">
                      <span className="text-slate-200">
                        @{r.username} invited by <strong className="text-violet-300">@{r.referrer_username}</strong>
                      </span>
                      <span className={r.referral_qualified ? 'text-emerald-400' : 'text-amber-300'}>
                        {r.referral_qualified ? 'Qualified' : 'Pending Activity'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

interface AdminTransactionRow {
  id: number;
  username: string;
  telegram_id: string;
  type: string;
  amount_points: number;
  balance_after: number;
  description: string;
  reference_id: string;
  created_at: string;
}

function AdminTransactionsSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [transactions, setTransactions] = useState<AdminTransactionRow[]>([]);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [loading, setLoading] = useState(true);

  const load = async (q = query, type = typeFilter) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ transactions: AdminTransactionRow[] }>(
        `/api/admin/transactions?q=${encodeURIComponent(q)}&type=${encodeURIComponent(type)}`,
        {},
        adminToken
      );
      setTransactions(res.transactions);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load transactions', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load('', 'all');
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">Global Transaction Ledger</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(query, typeFilter);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <div className="relative flex-1 sm:w-56">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="User, ID, ref..."
              className="min-h-[40px] w-full rounded-xl border border-white/10 bg-[#080B18] pl-9 pr-3 text-xs text-white"
            />
          </div>
          <select
            value={typeFilter}
            onChange={(e) => {
              const nextType = e.target.value;
              setTypeFilter(nextType);
              void load(query, nextType);
            }}
            className="min-h-[40px] rounded-xl border border-white/10 bg-[#10152B] px-3 text-xs text-white"
          >
            <option value="all">All Types</option>
            <option value="daily_checkin">Daily Check-In</option>
            <option value="task_reward">Task Reward</option>
            <option value="ad_reward">Ad Reward</option>
            <option value="game_reward">Game Reward</option>
            <option value="referral_bonus">Referral Bonus</option>
            <option value="withdrawal_hold">Withdrawal Hold</option>
            <option value="withdrawal_refund">Withdrawal Refund</option>
            <option value="admin_adjustment">Admin Adjustment</option>
          </select>
          <button
            type="submit"
            className="min-h-[40px] rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
          >
            Filter
          </button>
        </form>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#10152B] overflow-x-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-slate-400">Loading transaction ledger...</p>
        ) : transactions.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">No matching transactions found.</p>
        ) : (
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="border-b border-white/10 text-slate-400">
              <tr>
                <th className="py-3 px-4 font-medium">User</th>
                <th className="py-3 px-4 font-medium">Type & Description</th>
                <th className="py-3 px-4 font-medium text-right">Amount</th>
                <th className="py-3 px-4 font-medium text-right hidden sm:table-cell">Balance</th>
                <th className="py-3 px-4 font-medium text-right hidden md:table-cell">Time</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8">
              {transactions.map((tx) => (
                <tr key={tx.id} className="hover:bg-white/[0.02]">
                  <td className="py-3 px-4">
                    <p className="font-medium text-white">@{tx.username}</p>
                    <p className="font-mono text-[11px] text-slate-400">{tx.telegram_id}</p>
                  </td>
                  <td className="py-3 px-4">
                    <p className="text-slate-200">{tx.description}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {tx.type} {tx.reference_id ? `· ${tx.reference_id}` : ''}
                    </p>
                  </td>
                  <td
                    className={`py-3 px-4 text-right font-mono font-semibold tabular-nums ${
                      tx.amount_points >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {tx.amount_points >= 0 ? `+${tx.amount_points}` : tx.amount_points}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-300 tabular-nums hidden sm:table-cell">
                    {tx.balance_after.toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-[11px] text-slate-500 hidden md:table-cell">
                    {new Date(tx.created_at).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

