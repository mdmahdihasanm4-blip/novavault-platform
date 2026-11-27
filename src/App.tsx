import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Coins,
  ExternalLink,
  Gamepad2,
  Home,
  ShieldCheck,
  User,
  Users,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { AdminAuthGate } from './components/admin/AdminAuthGate.tsx';
import { AdminPanel } from './components/admin/AdminPanel.tsx';
import { AccountTab } from './components/miniapp/AccountTab.tsx';
import { EarnTab } from './components/miniapp/EarnTab.tsx';
import { HomeTab } from './components/miniapp/HomeTab.tsx';
import { PlayTab } from './components/miniapp/PlayTab.tsx';
import { ReferTab } from './components/miniapp/ReferTab.tsx';
import { apiFetch } from './lib/api.ts';
import createAdHandler from 'monetag-tg-sdk';
import { initTelegramMiniApp, safeOpenExternalUrl } from './lib/telegram.ts';
import type { BootstrapPayload, MiniTab } from './types/app.ts';

interface ToastState {
  message: string;
  type: 'success' | 'error';
}

export default function App() {
  const [routeMode, setRouteMode] = useState<'miniapp' | 'admin'>(() =>
    window.location.hash === '#admin' ? 'admin' : 'miniapp'
  );
  const [activeTab, setActiveTab] = useState<MiniTab>('home');

  const [userToken, setUserToken] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [adminEmail, setAdminEmail] = useState<string>('');

  const [data, setData] = useState<BootstrapPayload | null>(null);
  const [publicConfig, setPublicConfig] = useState<{ appName: string; logoUrl: string; botUsername: string } | null>(
    null
  );
  const [outsideTelegram, setOutsideTelegram] = useState(false);
  const [bootError, setBootError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [adLoadingSlot, setAdLoadingSlot] = useState<number | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);

  const showToast = useCallback((message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast((curr) => (curr?.message === message ? null : curr));
    }, 3400);
  }, []);

  useEffect(() => {
    const handleHash = () => {
      setRouteMode(window.location.hash === '#admin' ? 'admin' : 'miniapp');
    };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  const navigateRoute = (mode: 'miniapp' | 'admin') => {
    setRouteMode(mode);
    window.location.hash = mode === 'admin' ? '#admin' : '';
  };

  const loadBootstrap = useCallback(async (tokenStr: string, langOverride?: string) => {
    const query = langOverride ? `?lang=${encodeURIComponent(langOverride)}` : '';
    const payload = await apiFetch<BootstrapPayload>(`/api/bootstrap${query}`, {}, tokenStr);
    setData(payload);
    if (payload.settings?.appName) {
      document.title = payload.settings.appName;
    }
  }, []);

  // Authenticate Mini App Session strictly via Telegram initData
  useEffect(() => {
    if (routeMode === 'admin') return;
    if (userToken) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setBootError('');

    void (async () => {
      try {
        const tg = initTelegramMiniApp();

        if (!tg || !tg.initData || tg.initData.trim().length === 0) {
          const cfg = await apiFetch<{ appName: string; logoUrl: string; botUsername: string }>(
            '/api/public/config'
          ).catch(() => ({
            appName: 'NovaVault',
            logoUrl: '/src/assets/images/app_brand_logo_1795540139729.jpg',
            botUsername: '',
          }));
          if (!cancelled) {
            setPublicConfig(cfg);
            setOutsideTelegram(true);
          }
          return;
        }

        const authRes = await apiFetch<{ token: string }>('/api/auth/telegram', {
          method: 'POST',
          body: JSON.stringify({ initData: tg.initData }),
        });

        if (cancelled) return;
        setOutsideTelegram(false);
        setUserToken(authRes.token);
        await loadBootstrap(authRes.token);
      } catch (err) {
        if (!cancelled) {
          setBootError(err instanceof Error ? err.message : 'Unable to verify Telegram session');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [routeMode, userToken, loadBootstrap]);

  // Auto-refresh when returning from Admin Panel or window focus (picks up S2S ad postbacks!)
  useEffect(() => {
    if (!userToken || routeMode !== 'miniapp') return;
    const onFocus = () => {
      void loadBootstrap(userToken).catch(() => {});
    };
    window.addEventListener('focus', onFocus);
    const interval = setInterval(() => {
      void loadBootstrap(userToken).catch(() => {});
    }, 20000);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(interval);
    };
  }, [userToken, routeMode, loadBootstrap]);

  const refreshApp = useCallback(
    async (lang?: string) => {
      if (!userToken) return;
      await loadBootstrap(userToken, lang);
    },
    [userToken, loadBootstrap]
  );

  const t = useCallback(
    (key: string, fallback = key) => {
      return data?.i18n?.[key] || fallback;
    },
    [data?.i18n]
  );

  const handleStartAd = async (providerId: number, slotNumber: number) => {
    if (!userToken) return;
    setAdLoadingSlot(slotNumber);
    try {
      const res = await apiFetch<{
        adUrl: string;
        sessionId: string;
        providerType?: string;
        sdkZoneId?: string;
      }>(
        '/api/ads/start',
        { method: 'POST', body: JSON.stringify({ providerId, slotNumber }) },
        userToken
      );

      if ((res.providerType || '').toLowerCase() === 'monetag') {
        const zoneId = Number(res.sdkZoneId);
        if (!Number.isSafeInteger(zoneId) || zoneId <= 0) {
          throw new Error('Monetag main SDK Zone ID is missing. Ask admin to configure it.');
        }
        const showAd = createAdHandler(zoneId) as unknown as (options?: {
          ymid?: string;
          requestVar?: string;
        }) => Promise<unknown>;
        await showAd({ ymid: res.sessionId, requestVar: `ad_slot_${slotNumber}` });
        showToast(
          t('msg.ad_session_started', 'Ad finished. Reward will be credited after Monetag confirms a valued event.'),
          'success'
        );
      } else {
        if (!res.adUrl) throw new Error('Ad provider URL is not configured.');
        safeOpenExternalUrl(res.adUrl);
        showToast(t('msg.ad_session_started', 'Ad window opened. Reward credits once provider confirms view.'), 'success');
      }
      await refreshApp();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    } finally {
      setAdLoadingSlot(null);
    }
  };

  const handleClaimCheckin = async () => {
    if (!userToken) return;
    setCheckinLoading(true);
    try {
      await apiFetch('/api/checkin', { method: 'POST' }, userToken);
      showToast(t('msg.checkin_success', 'Daily check-in reward credited!'), 'success');
      await refreshApp();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    } finally {
      setCheckinLoading(false);
    }
  };

  const handleSubmitTask = async (taskId: number, payload: { proofText?: string; secretCode?: string }) => {
    if (!userToken) return;
    try {
      const res = await apiFetch<{ status: string }>(
        `/api/tasks/${taskId}/submit`,
        { method: 'POST', body: JSON.stringify(payload) },
        userToken
      );
      if (res.status === 'approved') {
        showToast(t('msg.task_verified', 'Task verified and reward credited!'), 'success');
      } else {
        showToast(t('msg.task_submitted', 'Submission received and queued for review.'), 'success');
      }
      await refreshApp();
    } catch (err) {
      showToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    }
  };

  // Admin Panel Route
  if (routeMode === 'admin') {
    if (!adminToken) {
      return (
        <AdminAuthGate
          onAuthenticated={(tok, email) => {
            setAdminToken(tok);
            setAdminEmail(email);
          }}
          onBackToApp={() => navigateRoute('miniapp')}
        />
      );
    }

    return (
      <>
        <AdminPanel
          adminToken={adminToken}
          adminEmail={adminEmail}
          onLogout={() => {
            setAdminToken(null);
            setAdminEmail('');
          }}
          onBackToApp={() => {
            navigateRoute('miniapp');
            void refreshApp();
          }}
          onToast={showToast}
        />
        {toast && <ToastBanner toast={toast} />}
      </>
    );
  }

  // Loading / Error States
  if (loading) {
    return (
      <div className="min-h-screen bg-[#080B18] text-slate-200 flex items-center justify-center p-6">
        <div className="text-center space-y-3">
          <div className="mx-auto h-10 w-10 rounded-2xl border-2 border-violet-500 border-t-transparent animate-spin" />
          <p className="text-sm text-slate-400">Loading NovaVault...</p>
        </div>
      </div>
    );
  }

  if (outsideTelegram) {
    const botLink = publicConfig?.botUsername ? `https://t.me/${publicConfig.botUsername}` : '';
    return (
      <div className="min-h-screen bg-[#080B18] text-slate-100 flex items-center justify-center p-5">
        <div className="max-w-md w-full rounded-3xl border border-violet-400/25 bg-gradient-to-br from-[#23164B] via-[#121630] to-[#0D1124] p-7 text-center shadow-[0_20px_60px_rgba(12,8,34,0.65)] space-y-5">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/15 overflow-hidden">
            {publicConfig?.logoUrl ? (
              <img
                src={publicConfig.logoUrl}
                alt={publicConfig.appName || 'NovaVault'}
                className="h-full w-full object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            ) : (
              <Bot className="h-8 w-8 text-violet-300" />
            )}
          </div>

          <div className="space-y-2">
            <h1 className="font-display text-xl font-bold text-white">
              {publicConfig?.appName || 'NovaVault'}
            </h1>
            <p className="text-sm text-slate-200 leading-relaxed">
              Please open NovaVault through our official Telegram bot.
            </p>
          </div>

          <div className="space-y-3 pt-1">
            <a
              href={botLink || 'https://t.me'}
              target="_blank"
              rel="noopener noreferrer"
              className="min-h-[46px] w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 px-5 text-sm font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.4)] transition-all"
            >
              <ExternalLink className="h-4 w-4" />
              <span>
                {publicConfig?.botUsername
                  ? `Open Telegram Bot (@${publicConfig.botUsername})`
                  : 'Open Telegram Bot'}
              </span>
            </a>

            <button
              type="button"
              onClick={() => navigateRoute('admin')}
              className="min-h-[40px] w-full inline-flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.04] hover:bg-white/[0.08] px-4 text-xs font-medium text-slate-300 transition-colors cursor-pointer"
            >
              <ShieldCheck className="h-3.5 w-3.5 text-violet-300" />
              <span>Admin Panel</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (bootError || !data || !userToken) {
    return (
      <div className="min-h-screen bg-[#080B18] text-slate-200 flex items-center justify-center p-6">
        <div className="max-w-md w-full rounded-3xl border border-rose-500/30 bg-[#10152B] p-6 text-center space-y-4">
          <AlertTriangle className="mx-auto h-10 w-10 text-rose-400" />
          <p className="text-sm text-slate-200">{bootError || 'Telegram session verification failed.'}</p>
          <button
            type="button"
            onClick={() => navigateRoute('admin')}
            className="min-h-[42px] rounded-xl bg-violet-600 px-5 text-xs font-semibold text-white cursor-pointer"
          >
            Open Admin Panel
          </button>
        </div>
      </div>
    );
  }

  const navTabs: Array<{ id: MiniTab; label: string; Icon: typeof Home }> = [
    { id: 'home', label: t('nav.home', 'Home'), Icon: Home },
    { id: 'earn', label: t('nav.earn', 'Earn'), Icon: Coins },
    { id: 'play', label: t('nav.play', 'Play'), Icon: Gamepad2 },
    { id: 'refer', label: t('nav.refer', 'Refer'), Icon: Users },
    { id: 'account', label: t('nav.account', 'Account'), Icon: User },
  ];

  const { user, settings } = data;
  const initials = (user.firstName || user.username || 'NV').slice(0, 2).toUpperCase();

  return (
    <div
      className="min-h-screen text-slate-100 pb-24 md:pb-12"
      style={{ backgroundColor: settings.bgColor || '#080B18' }}
    >
      {/* Desktop Top Navigation Bar (3-zone contract) */}
      <header className="hidden md:flex items-center justify-between gap-8 max-w-6xl mx-auto px-6 h-16 border-b border-white/8">
        <button
          type="button"
          onClick={() => setActiveTab('home')}
          className="flex items-center gap-3 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <img
            src={settings.logoUrl}
            alt={settings.appName}
            referrerPolicy="no-referrer"
            className="h-8 w-8 rounded-xl object-cover border border-violet-400/30"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <span className="font-display text-lg font-bold tracking-tight text-white">{settings.appName}</span>
        </button>

        <nav className="flex items-center gap-6 text-sm font-medium text-slate-400">
          {navTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                activeTab === tab.id
                  ? 'text-white border-b-2 border-violet-500'
                  : 'hover:text-slate-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center gap-2.5 text-right">
            <div className="leading-tight">
              <p className="text-xs font-semibold text-white">@{user.username}</p>
              <p className="text-[11px] text-emerald-400">{t('status.online', 'Online')}</p>
            </div>
            {user.photoUrl ? (
              <img
                src={user.photoUrl}
                alt={user.username}
                referrerPolicy="no-referrer"
                className="h-9 w-9 rounded-full object-cover border border-white/15"
              />
            ) : (
              <div className="h-9 w-9 rounded-full bg-violet-600/30 border border-violet-400/40 flex items-center justify-center text-xs font-bold text-violet-200">
                {initials}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => navigateRoute('admin')}
            className="min-h-[38px] inline-flex items-center gap-1.5 rounded-xl border border-violet-400/30 bg-violet-500/15 hover:bg-violet-500/25 px-3.5 text-xs font-semibold text-violet-200 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>Admin</span>
          </button>
        </div>
      </header>

      {/* Mobile Compact Top Header */}
      <header className="md:hidden sticky top-0 z-30 flex items-center justify-between px-4 h-[52px] bg-[#080B18]/90 backdrop-blur-md border-b border-white/8">
        <div className="flex items-center gap-2.5 min-w-0">
          <img
            src={settings.logoUrl}
            alt={settings.appName}
            referrerPolicy="no-referrer"
            className="h-7 w-7 rounded-lg object-cover border border-violet-400/30 shrink-0"
            onError={(e) => {
              e.currentTarget.style.display = 'none';
            }}
          />
          <span className="font-display text-base font-bold text-white truncate">{settings.appName}</span>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          <div className="text-right leading-tight">
            <p className="text-xs font-semibold text-white max-w-[110px] truncate">@{user.username}</p>
            <p className="text-[10px] text-emerald-400">{t('status.online', 'Online')}</p>
          </div>
          {user.photoUrl ? (
            <img
              src={user.photoUrl}
              alt={user.username}
              referrerPolicy="no-referrer"
              className="h-8 w-8 rounded-full object-cover border border-white/15"
            />
          ) : (
            <div className="h-8 w-8 rounded-full bg-violet-600/30 border border-violet-400/40 flex items-center justify-center text-[11px] font-bold text-violet-200">
              {initials}
            </div>
          )}
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 sm:px-6 pt-5 sm:pt-7 space-y-5">
        {settings.maintenanceMode === 'true' && (
          <div className="rounded-2xl border border-amber-500/35 bg-amber-950/30 px-4 py-3 flex items-center gap-3 text-xs sm:text-sm text-amber-200">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
            <span>{t('err.maintenance', 'Maintenance in progress. Please check back shortly.')}</span>
          </div>
        )}

        {activeTab === 'home' && (
          <HomeTab
            data={data}
            t={t}
            onNavigate={setActiveTab}
            onStartAd={handleStartAd}
            adLoadingSlot={adLoadingSlot}
          />
        )}

        {activeTab === 'earn' && (
          <EarnTab
            data={data}
            t={t}
            onClaimCheckin={handleClaimCheckin}
            onSubmitTask={handleSubmitTask}
            onStartAd={handleStartAd}
            adLoadingSlot={adLoadingSlot}
            checkinLoading={checkinLoading}
          />
        )}

        {activeTab === 'play' && (
          <PlayTab data={data} token={userToken} t={t} onRefresh={() => refreshApp()} onToast={showToast} />
        )}

        {activeTab === 'refer' && <ReferTab data={data} t={t} onToast={showToast} />}

        {activeTab === 'account' && (
          <AccountTab
            data={data}
            token={userToken}
            t={t}
            onRefresh={refreshApp}
            onToast={showToast}
            onOpenAdmin={() => navigateRoute('admin')}
          />
        )}
      </main>

      {/* Mobile Fixed 5-Tab Bottom Navigation Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-[#0B0F20]/95 backdrop-blur-md border-t border-white/10 grid grid-cols-5 items-center px-1">
        {navTabs.map(({ id, label, Icon }) => {
          const active = activeTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveTab(id)}
              className={`min-h-[48px] flex flex-col items-center justify-center gap-0.5 transition-colors cursor-pointer ${
                active ? 'text-violet-400' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[10px] font-medium tracking-tight truncate max-w-[64px]">{label}</span>
            </button>
          );
        })}
      </nav>

      {toast && <ToastBanner toast={toast} />}
    </div>
  );
}

function ToastBanner({ toast }: { toast: ToastState }) {
  return (
    <div className="fixed bottom-20 md:bottom-6 right-4 left-4 md:left-auto md:max-w-sm z-50 rounded-2xl border border-white/15 bg-[#151B36] px-4 py-3 shadow-2xl flex items-center gap-2.5 text-xs sm:text-sm text-white">
      {toast.type === 'success' ? (
        <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
      ) : (
        <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
      )}
      <span>{toast.message}</span>
    </div>
  );
}
