import { ArrowLeft, KeyRound, Lock, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';

interface AdminAuthGateProps {
  onAuthenticated: (token: string, email: string) => void;
  onBackToApp: () => void;
}

export function AdminAuthGate({ onAuthenticated, onBackToApp }: AdminAuthGateProps) {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [envOverride, setEnvOverride] = useState(false);
  const [tgAdminIdsConfigured, setTgAdminIdsConfigured] = useState(false);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch<{
          needsInitialSetup: boolean;
          envOverrideActive: boolean;
          telegramAdminIdsConfigured?: boolean;
        }>('/api/admin/auth/status');
        setNeedsSetup(res.needsInitialSetup);
        setEnvOverride(res.envOverrideActive);
        setTgAdminIdsConfigured(Boolean(res.telegramAdminIdsConfigured));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to check admin status');
      } finally {
        setLoadingStatus(false);
      }
    })();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (needsSetup && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = needsSetup ? '/api/admin/auth/claim' : '/api/admin/auth/login';
      const initData = window.Telegram?.WebApp?.initData || '';
      const res = await apiFetch<{ token: string; email: string }>(endpoint, {
        method: 'POST',
        body: JSON.stringify({ email, password, initData }),
      });
      onAuthenticated(res.token, res.email);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080B18] text-slate-100 flex flex-col justify-center p-4">
      <div className="mx-auto w-full max-w-md rounded-3xl border border-white/12 bg-[#10152B] p-6 sm:p-8 shadow-2xl">
        <button
          type="button"
          onClick={onBackToApp}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white mb-6 cursor-pointer"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Mini App</span>
        </button>

        <div className="flex items-center gap-3 mb-2">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600/20 border border-violet-400/30 text-violet-300">
            {needsSetup ? <KeyRound className="h-5 w-5" /> : <ShieldCheck className="h-5 w-5" />}
          </div>
          <div>
            <h1 className="font-display text-xl font-bold text-white">
              {needsSetup ? 'Claim Admin Access' : 'Admin Panel Sign In'}
            </h1>
            <p className="text-xs text-slate-400">
              {needsSetup
                ? 'First-run setup: create the administrator account.'
                : envOverride
                  ? 'Authenticated via server ADMIN_PASSCODE secret.'
                  : 'Enter your administrator credentials.'}
              {tgAdminIdsConfigured ? ' Telegram ID allowlist active inside Telegram.' : ''}
            </p>
          </div>
        </div>

        {loadingStatus ? (
          <div className="py-10 text-center text-sm text-slate-400">Checking security status...</div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="mt-6 space-y-4">
            {!envOverride && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Admin Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="admin@yourdomain.com"
                  className="min-h-[44px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                {envOverride ? 'Admin Passcode' : 'Password (min 8 chars)'}
              </label>
              <input
                type="password"
                required
                minLength={needsSetup ? 8 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="min-h-[44px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
              />
            </div>

            {needsSetup && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">Confirm Password</label>
                <input
                  type="password"
                  required
                  minLength={8}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••"
                  className="min-h-[44px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3.5 text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
                />
              </div>
            )}

            {error && <p className="text-xs font-medium text-rose-400">{error}</p>}

            <button
              type="submit"
              disabled={submitting}
              className="min-h-[46px] w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white shadow-[0_0_24px_rgba(124,58,237,0.38)] transition-all cursor-pointer"
            >
              <Lock className="h-4 w-4" />
              <span>{submitting ? 'Verifying...' : needsSetup ? 'Create Admin Account' : 'Unlock Admin Panel'}</span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
