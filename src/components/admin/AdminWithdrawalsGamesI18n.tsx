import { Check, CheckCircle2, Globe, Plus, Save, Search, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';

interface AdminWithdrawalRow {
  id: number;
  username: string;
  telegram_id: string;
  method_name: string;
  network: string;
  account_address: string;
  points_amount: number;
  fee_points: number;
  net_points: number;
  bdt_amount: number;
  fee_bdt: number;
  net_bdt: number;
  status: 'pending' | 'approved' | 'rejected' | 'paid';
  admin_note: string;
  tx_hash: string;
  created_at: string;
}

interface AdminMethodRow {
  id: number;
  name: string;
  code: string;
  networks: string[];
  min_points: number;
  max_points: number;
  fee_percent: number;
  is_active: number;
}

export function AdminWithdrawalsSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawalRow[]>([]);
  const [methods, setMethods] = useState<AdminMethodRow[]>([]);
  const [filter, setFilter] = useState<'all' | 'pending' | 'approved' | 'paid' | 'rejected'>('all');
  const [txModal, setTxModal] = useState<AdminWithdrawalRow | null>(null);
  const [txHash, setTxHash] = useState('');
  const [adminNote, setAdminNote] = useState('');

  const [editingMethod, setEditingMethod] = useState<{
    id?: number;
    name: string;
    code: string;
    networksStr: string;
    minPoints: number;
    maxPoints: number;
    feePercent: number;
    isActive: boolean;
  } | null>(null);

  const load = async () => {
    try {
      const res = await apiFetch<{ withdrawals: AdminWithdrawalRow[]; methods: AdminMethodRow[] }>(
        '/api/admin/withdrawals',
        {},
        adminToken
      );
      setWithdrawals(res.withdrawals);
      setMethods(res.methods);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load withdrawals', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const updateStatus = async (id: number, status: 'approved' | 'rejected' | 'paid', note = '', hash = '') => {
    try {
      await apiFetch(
        `/api/admin/withdrawals/${id}/status`,
        { method: 'POST', body: JSON.stringify({ status, adminNote: note, txHash: hash }) },
        adminToken
      );
      onToast(`Withdrawal marked ${status}`, 'success');
      setTxModal(null);
      setTxHash('');
      setAdminNote('');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  };

  const saveMethod = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMethod) return;
    try {
      await apiFetch(
        '/api/admin/withdrawal-methods',
        {
          method: 'POST',
          body: JSON.stringify({
            id: editingMethod.id,
            name: editingMethod.name,
            code: editingMethod.code,
            networks: editingMethod.networksStr
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            minPoints: editingMethod.minPoints,
            maxPoints: editingMethod.maxPoints,
            feePercent: editingMethod.feePercent,
            isActive: editingMethod.isActive,
          }),
        },
        adminToken
      );
      setEditingMethod(null);
      onToast('Payment method saved', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save method', 'error');
    }
  };

  const filtered = withdrawals.filter((w) => (filter === 'all' ? true : w.status === filter));

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">Withdrawal Management</h2>
        <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-white/10 bg-[#10152B] p-1">
          {(['all', 'pending', 'approved', 'paid', 'rejected'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold capitalize cursor-pointer ${
                filter === s ? 'bg-violet-600 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Withdrawal Requests */}
      <div className="rounded-2xl border border-white/10 bg-[#10152B] divide-y divide-white/8">
        {filtered.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">No withdrawal requests in this view.</p>
        ) : (
          filtered.map((w) => (
            <div key={w.id} className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-white">
                  @{w.username} · {w.method_name} ({w.network})
                </p>
                <p className="mt-0.5 font-mono text-xs text-slate-300 break-all">{w.account_address}</p>
                <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
                  {w.points_amount.toLocaleString()} PTS → Net ৳{Number(w.net_bdt || 0).toFixed(2)} BDT ·{' '}
                  {new Date(w.created_at).toLocaleString()}
                </p>
                {w.tx_hash && <p className="mt-0.5 font-mono text-xs text-emerald-300">TX: {w.tx_hash}</p>}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {w.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => void updateStatus(w.id, 'approved')}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-indigo-600 hover:bg-indigo-500 px-3 text-xs font-semibold text-white cursor-pointer"
                    >
                      <Check className="h-3.5 w-3.5" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTxModal(w);
                        setAdminNote('');
                        setTxHash('');
                      }}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3 text-xs font-semibold text-white cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Mark Paid</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateStatus(w.id, 'rejected', 'Rejected by admin')}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-rose-600/80 hover:bg-rose-600 px-3 text-xs font-semibold text-white cursor-pointer"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Reject & Refund</span>
                    </button>
                  </>
                )}
                {w.status === 'approved' && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        setTxModal(w);
                        setAdminNote('');
                        setTxHash('');
                      }}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3 text-xs font-semibold text-white cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Mark Paid</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void updateStatus(w.id, 'rejected', 'Cancelled after approval')}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-rose-600/80 hover:bg-rose-600 px-3 text-xs font-semibold text-white cursor-pointer"
                    >
                      <span>Reject & Refund</span>
                    </button>
                  </>
                )}
                {(w.status === 'paid' || w.status === 'rejected') && (
                  <span
                    className={`text-xs font-semibold capitalize ${
                      w.status === 'paid' ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {w.status}
                  </span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Configurable Payment Methods (bKash & Nagad only) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-base font-bold text-white">Supported Payment Methods (bKash &amp; Nagad)</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {methods.map((m) => (
            <div key={m.id} className="rounded-2xl border border-white/10 bg-[#10152B] p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="font-display text-sm font-bold text-white">{m.name}</h4>
                <button
                  type="button"
                  onClick={() =>
                    setEditingMethod({
                      id: m.id,
                      name: m.name,
                      code: m.code,
                      networksStr: m.networks.join(', '),
                      minPoints: m.min_points,
                      maxPoints: m.max_points,
                      feePercent: m.fee_percent,
                      isActive: Boolean(m.is_active),
                    })
                  }
                  className="text-xs text-violet-300 hover:text-violet-200 cursor-pointer"
                >
                  Edit
                </button>
              </div>
              <p className="text-xs text-slate-400">Account Types: {m.networks.join(' · ')}</p>
              <p className="font-mono text-xs text-slate-300 tabular-nums">
                {m.min_points}–{m.max_points} PTS · Fee {m.fee_percent}% · {m.is_active ? 'Active' : 'Off'}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Mark Paid Modal */}
      {txModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">Complete Payout #{txModal.id}</h3>
              <button type="button" onClick={() => setTxModal(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="text-xs text-slate-300">
              Send <strong>৳{Number(txModal.net_bdt || 0).toFixed(2)} BDT</strong> via {txModal.method_name} ({txModal.network}) to{' '}
              <span className="font-mono">{txModal.account_address}</span>, then record the transaction reference below.
            </p>
            <input
              type="text"
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="Transaction ID / TX Hash"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
            />
            <input
              type="text"
              value={adminNote}
              onChange={(e) => setAdminNote(e.target.value)}
              placeholder="Optional note for user"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <button
              type="button"
              onClick={() => void updateStatus(txModal.id, 'paid', adminNote, txHash)}
              className="min-h-[44px] w-full rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm font-semibold text-white cursor-pointer"
            >
              Confirm Payment Completed
            </button>
          </div>
        </div>
      )}

      {/* Edit Method Modal */}
      {editingMethod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => void saveMethod(e)}
            className="w-full max-w-md rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">Configure Payment Method</h3>
              <button type="button" onClick={() => setEditingMethod(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                required
                value={editingMethod.name}
                onChange={(e) => setEditingMethod({ ...editingMethod, name: e.target.value })}
                placeholder="Display Name (bKash or Nagad)"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              />
              <input
                type="text"
                readOnly
                value={editingMethod.code}
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-slate-400 font-mono"
              />
            </div>
            <input
              type="text"
              value={editingMethod.networksStr}
              onChange={(e) => setEditingMethod({ ...editingMethod, networksStr: e.target.value })}
              placeholder="Comma-separated account types (Personal, Agent)"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <div className="grid grid-cols-3 gap-3">
              <input
                type="number"
                value={editingMethod.minPoints}
                onChange={(e) => setEditingMethod({ ...editingMethod, minPoints: Number(e.target.value) })}
                placeholder="Min PTS"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
              />
              <input
                type="number"
                value={editingMethod.maxPoints}
                onChange={(e) => setEditingMethod({ ...editingMethod, maxPoints: Number(e.target.value) })}
                placeholder="Max PTS"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
              />
              <input
                type="number"
                step="0.1"
                value={editingMethod.feePercent}
                onChange={(e) => setEditingMethod({ ...editingMethod, feePercent: Number(e.target.value) })}
                placeholder="Fee %"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
              />
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={editingMethod.isActive}
                onChange={(e) => setEditingMethod({ ...editingMethod, isActive: e.target.checked })}
              />
              <span>Method Active</span>
            </label>
            <button type="submit" className="min-h-[44px] w-full rounded-xl bg-violet-600 text-sm font-semibold text-white cursor-pointer">
              Save Payment Method
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

interface AdminGameRow {
  id: number;
  slug: string;
  game_type: string;
  title: string;
  description: string;
  icon_url: string;
  target_url: string;
  reward_min: number;
  reward_max: number;
  daily_limit: number;
  cooldown_seconds: number;
  is_active: number;
}

export function AdminGamesSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [games, setGames] = useState<AdminGameRow[]>([]);
  const [plays, setPlays] = useState<Array<{ id: number; username: string; game_title: string; reward_points: number; created_at: string }>>([]);
  const [creatingGame, setCreatingGame] = useState<{
    title: string;
    description: string;
    gameType: string;
    targetUrl: string;
    iconUrl: string;
    rewardMin: number;
    rewardMax: number;
    dailyLimit: number;
    cooldownSeconds: number;
    isActive: boolean;
  } | null>(null);

  const load = async () => {
    try {
      const res = await apiFetch<{ games: AdminGameRow[]; recentPlays: typeof plays }>('/api/admin/games', {}, adminToken);
      setGames(res.games);
      setPlays(res.recentPlays);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load games', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createGame = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creatingGame) return;
    try {
      await apiFetch('/api/admin/games', { method: 'POST', body: JSON.stringify(creatingGame) }, adminToken);
      setCreatingGame(null);
      onToast('Game offer created', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Create failed', 'error');
    }
  };

  const saveGame = async (g: AdminGameRow) => {
    try {
      await apiFetch(
        `/api/admin/games/${g.id}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            title: g.title,
            description: g.description,
            gameType: g.game_type,
            iconUrl: g.icon_url,
            targetUrl: g.target_url,
            rewardMin: g.reward_min,
            rewardMax: g.reward_max,
            dailyLimit: g.daily_limit,
            cooldownSeconds: g.cooldown_seconds,
            isActive: g.is_active === 1,
          }),
        },
        adminToken
      );
      onToast(`${g.title} updated`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  };

  const deleteGame = async (id: number, title: string) => {
    try {
      await apiFetch(`/api/admin/games/${id}`, { method: 'DELETE' }, adminToken);
      onToast(`Removed ${title}`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">Mini-Game & Offer Management</h2>
        <button
          type="button"
          onClick={() =>
            setCreatingGame({
              title: '',
              description: '',
              gameType: 'vault_tap',
              targetUrl: '',
              iconUrl: '',
              rewardMin: 10,
              rewardMax: 45,
              dailyLimit: 3,
              cooldownSeconds: 20,
              isActive: true,
            })
          }
          className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Add Game Offer</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {games.map((g, idx) => (
          <div key={g.id} className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <input
                type="text"
                value={g.title}
                onChange={(e) => {
                  const next = [...games];
                  next[idx] = { ...g, title: e.target.value };
                  setGames(next);
                }}
                className="flex-1 min-w-0 font-display text-base font-bold text-white bg-transparent border-b border-white/15 focus:border-violet-500 focus:outline-none"
              />
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={g.is_active === 1}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, is_active: e.target.checked ? 1 : 0 };
                    setGames(next);
                  }}
                />
                <span>Active</span>
              </label>
            </div>

            <input
              type="text"
              value={g.description}
              onChange={(e) => {
                const next = [...games];
                next[idx] = { ...g, description: e.target.value };
                setGames(next);
              }}
              placeholder="Description"
              className="min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-xs text-slate-200"
            />

            <div className="grid grid-cols-2 gap-2.5 text-xs">
              <div>
                <label className="text-slate-400">Game Mode</label>
                <select
                  value={g.game_type || 'spin_wheel'}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, game_type: e.target.value };
                    setGames(next);
                  }}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white"
                >
                  <option value="spin_wheel">Spin Wheel</option>
                  <option value="prism_memory">Prism Memory</option>
                  <option value="vault_tap">Vault Tap Challenge</option>
                  <option value="external_offer">External Game Offer</option>
                </select>
              </div>
              <div>
                <label className="text-slate-400">External URL (optional)</label>
                <input
                  type="url"
                  value={g.target_url || ''}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, target_url: e.target.value };
                    setGames(next);
                  }}
                  placeholder="https://..."
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div>
                <label className="text-slate-400">Min PTS</label>
                <input
                  type="number"
                  value={g.reward_min}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, reward_min: Number(e.target.value) };
                    setGames(next);
                  }}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Max PTS</label>
                <input
                  type="number"
                  value={g.reward_max}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, reward_max: Number(e.target.value) };
                    setGames(next);
                  }}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Daily Limit</label>
                <input
                  type="number"
                  value={g.daily_limit}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, daily_limit: Number(e.target.value) };
                    setGames(next);
                  }}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Cooldown (s)</label>
                <input
                  type="number"
                  value={g.cooldown_seconds}
                  onChange={(e) => {
                    const next = [...games];
                    next[idx] = { ...g, cooldown_seconds: Number(e.target.value) };
                    setGames(next);
                  }}
                  className="mt-1 min-h-[38px] w-full rounded-lg border border-white/10 bg-[#080B18] px-3 text-white font-mono"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 pt-1">
              <button
                type="button"
                onClick={() => void saveGame(g)}
                className="min-h-[40px] rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
              >
                Save Game Settings
              </button>
              <button
                type="button"
                onClick={() => void deleteGame(g.id, g.title)}
                className="min-h-[40px] inline-flex items-center gap-1 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 px-3 text-xs font-semibold text-rose-300 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Remove</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {creatingGame && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => void createGame(e)}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="font-display text-lg font-bold text-white">Add Mini-Game Offer</h3>
              <button type="button" onClick={() => setCreatingGame(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <input
              type="text"
              required
              value={creatingGame.title}
              onChange={(e) => setCreatingGame({ ...creatingGame, title: e.target.value })}
              placeholder="Game / Offer title"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <textarea
              required
              rows={2}
              value={creatingGame.description}
              onChange={(e) => setCreatingGame({ ...creatingGame, description: e.target.value })}
              placeholder="Short description"
              className="w-full rounded-xl border border-white/10 bg-[#080B18] p-3 text-sm text-white"
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={creatingGame.gameType}
                onChange={(e) => setCreatingGame({ ...creatingGame, gameType: e.target.value })}
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              >
                <option value="vault_tap">Vault Tap Challenge</option>
                <option value="spin_wheel">Spin Wheel</option>
                <option value="prism_memory">Prism Memory</option>
                <option value="external_offer">External Game Offer</option>
              </select>
              <input
                type="url"
                value={creatingGame.targetUrl}
                onChange={(e) => setCreatingGame({ ...creatingGame, targetUrl: e.target.value })}
                placeholder="Offer URL (for external offers)"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              />
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs">
              <div>
                <label className="text-slate-400">Min PTS</label>
                <input
                  type="number"
                  min={1}
                  value={creatingGame.rewardMin}
                  onChange={(e) => setCreatingGame({ ...creatingGame, rewardMin: Number(e.target.value) })}
                  className="mt-1 min-h-[40px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Max PTS</label>
                <input
                  type="number"
                  min={1}
                  value={creatingGame.rewardMax}
                  onChange={(e) => setCreatingGame({ ...creatingGame, rewardMax: Number(e.target.value) })}
                  className="mt-1 min-h-[40px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Daily Limit</label>
                <input
                  type="number"
                  min={1}
                  value={creatingGame.dailyLimit}
                  onChange={(e) => setCreatingGame({ ...creatingGame, dailyLimit: Number(e.target.value) })}
                  className="mt-1 min-h-[40px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
              <div>
                <label className="text-slate-400">Cooldown (s)</label>
                <input
                  type="number"
                  min={0}
                  value={creatingGame.cooldownSeconds}
                  onChange={(e) => setCreatingGame({ ...creatingGame, cooldownSeconds: Number(e.target.value) })}
                  className="mt-1 min-h-[40px] w-full rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white font-mono"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={creatingGame.isActive}
                onChange={(e) => setCreatingGame({ ...creatingGame, isActive: e.target.checked })}
              />
              <span>Active</span>
            </label>
            <button
              type="submit"
              className="min-h-[44px] w-full rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white cursor-pointer"
            >
              Create Game Offer
            </button>
          </form>
        </div>
      )}

      <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
        <h3 className="font-display text-base font-semibold text-white mb-3">Recent Game Activity</h3>
        {plays.length === 0 ? (
          <p className="text-sm text-slate-400">No game plays recorded yet.</p>
        ) : (
          <div className="divide-y divide-white/8">
            {plays.map((p) => (
              <div key={p.id} className="py-2.5 flex items-center justify-between text-xs">
                <span className="text-slate-200">
                  @{p.username} · {p.game_title}
                </span>
                <span className="font-mono text-emerald-300 tabular-nums">+{p.reward_points} PTS</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface AdminLangRow {
  code: string;
  name: string;
  native_name: string;
  is_enabled: number;
}

interface AdminTranslationRow {
  lang_code: string;
  key: string;
  value: string;
  category: string;
}

export function AdminI18nSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [languages, setLanguages] = useState<AdminLangRow[]>([]);
  const [selectedLang, setSelectedLang] = useState('en');
  const [defaultLang, setDefaultLang] = useState('en');
  const [allTranslations, setAllTranslations] = useState<AdminTranslationRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [newLangModal, setNewLangModal] = useState(false);
  const [newLang, setNewLang] = useState({ code: '', name: '', nativeName: '' });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const res = await apiFetch<{
        languages: AdminLangRow[];
        translations: AdminTranslationRow[];
        defaultLanguage: string;
      }>('/api/admin/i18n', {}, adminToken);
      setLanguages(res.languages);
      setAllTranslations(res.translations);
      setDefaultLang(res.defaultLanguage || 'en');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load translations', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of allTranslations) {
      if (row.lang_code === selectedLang) {
        next[row.key] = row.value;
      }
    }
    setDrafts(next);
  }, [selectedLang, allTranslations]);

  const categories = ['All', ...Array.from(new Set(allTranslations.map((t) => t.category)))];
  const enReference = allTranslations.filter((t) => t.lang_code === 'en');
  const visibleKeys = enReference.filter((item) => {
    const matchesCat = categoryFilter === 'All' || item.category === categoryFilter;
    const q = search.toLowerCase();
    const val = (drafts[item.key] || '').toLowerCase();
    const matchesQuery = !q || item.key.toLowerCase().includes(q) || val.includes(q) || item.value.toLowerCase().includes(q);
    return matchesCat && matchesQuery;
  });

  const publishChanges = async () => {
    setSaving(true);
    try {
      const updates = Object.entries(drafts).map(([key, value]) => ({ key, value }));
      await apiFetch(
        '/api/admin/i18n/translations',
        {
          method: 'POST',
          body: JSON.stringify({
            langCode: selectedLang,
            updates,
            defaultLanguage: defaultLang,
          }),
        },
        adminToken
      );
      onToast(`Published ${updates.length} strings for ${selectedLang.toUpperCase()}`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Publish failed', 'error');
    } finally {
      setSaving(false);
    }
  };

  const addLanguage = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiFetch(
        '/api/admin/i18n/languages',
        {
          method: 'POST',
          body: JSON.stringify({ ...newLang, isEnabled: true }),
        },
        adminToken
      );
      setNewLangModal(false);
      setNewLang({ code: '', name: '', nativeName: '' });
      onToast('Language added from English template', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to add language', 'error');
    }
  };

  const toggleLanguage = async (lang: AdminLangRow) => {
    try {
      await apiFetch(
        '/api/admin/i18n/languages',
        {
          method: 'POST',
          body: JSON.stringify({
            code: lang.code,
            name: lang.name,
            nativeName: lang.native_name,
            isEnabled: lang.is_enabled === 0,
          }),
        },
        adminToken
      );
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to update language', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-white">Language & Full Text Editor</h2>
          <p className="text-xs text-slate-400">
            Edit every label, button, notification, and error across the app without touching code.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setNewLangModal(true)}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 hover:bg-white/10 px-3.5 text-xs font-semibold text-white cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Language</span>
          </button>
          <button
            type="button"
            disabled={saving}
            onClick={() => void publishChanges()}
            className="min-h-[40px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
          >
            <Save className="h-3.5 w-3.5" />
            <span>{saving ? 'Publishing...' : 'Save & Publish Live'}</span>
          </button>
        </div>
      </div>

      {/* Language Selector & Default Language Control */}
      <div className="rounded-2xl border border-white/10 bg-[#10152B] p-4 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {languages.map((l) => (
            <div key={l.code} className="inline-flex items-center rounded-xl border border-white/10 bg-[#080B18] overflow-hidden">
              <button
                type="button"
                onClick={() => setSelectedLang(l.code)}
                className={`px-3.5 py-2 text-xs font-semibold cursor-pointer ${
                  selectedLang === l.code ? 'bg-violet-600 text-white' : 'text-slate-300 hover:text-white'
                }`}
              >
                {l.native_name} ({l.code.toUpperCase()})
              </button>
              <button
                type="button"
                title="Toggle language availability for users"
                onClick={() => void toggleLanguage(l)}
                className={`px-2.5 py-2 text-[11px] border-l border-white/10 cursor-pointer ${
                  l.is_enabled ? 'text-emerald-400' : 'text-slate-500'
                }`}
              >
                {l.is_enabled ? 'On' : 'Off'}
              </button>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Globe className="h-4 w-4 text-violet-400" />
          <span className="text-slate-400">Default Language:</span>
          <select
            value={defaultLang}
            onChange={(e) => setDefaultLang(e.target.value)}
            className="min-h-[36px] rounded-lg border border-white/10 bg-[#080B18] px-2.5 text-white"
          >
            {languages.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name} ({l.code})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Search & Category Filter */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search text key or phrase..."
            className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] pl-9 pr-3 text-sm text-white"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="min-h-[42px] rounded-xl border border-white/10 bg-[#10152B] px-3 text-sm text-white"
        >
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      {/* Key-by-Key Editor */}
      <div className="rounded-2xl border border-white/10 bg-[#10152B] divide-y divide-white/8">
        {visibleKeys.map((item) => (
          <div key={item.key} className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-3 items-center">
            <div className="lg:col-span-5 min-w-0">
              <p className="font-mono text-xs text-violet-300 truncate">{item.key}</p>
              <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                {item.category} · EN: {item.value}
              </p>
            </div>
            <div className="lg:col-span-7">
              <input
                type="text"
                value={drafts[item.key] ?? ''}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [item.key]: e.target.value }))}
                className="min-h-[40px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white focus:border-violet-500 focus:outline-none"
              />
            </div>
          </div>
        ))}
      </div>

      {newLangModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => void addLanguage(e)}
            className="w-full max-w-md rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="font-display text-lg font-bold text-white">Add Language</h3>
              <button type="button" onClick={() => setNewLangModal(false)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <input
              type="text"
              required
              value={newLang.code}
              onChange={(e) => setNewLang({ ...newLang, code: e.target.value })}
              placeholder="ISO code (e.g. hi, es, ar)"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
            />
            <input
              type="text"
              required
              value={newLang.name}
              onChange={(e) => setNewLang({ ...newLang, name: e.target.value })}
              placeholder="English Name (e.g. Hindi)"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <input
              type="text"
              required
              value={newLang.nativeName}
              onChange={(e) => setNewLang({ ...newLang, nativeName: e.target.value })}
              placeholder="Native Name (e.g. हिन्दी)"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <button type="submit" className="min-h-[44px] w-full rounded-xl bg-violet-600 text-sm font-semibold text-white cursor-pointer">
              Create Language
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
