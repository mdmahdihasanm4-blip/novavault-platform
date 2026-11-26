import { Ban, Check, CheckCircle2, Copy, Edit3, Plus, Search, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';

interface AdminUserRow {
  id: number;
  telegram_id: string;
  username: string;
  first_name: string;
  points_balance: number;
  pending_balance: number;
  total_earned: number;
  total_withdrawn: number;
  referral_code: string;
  is_blocked: number;
  is_preview: number;
  created_at: string;
}

export function AdminUsersSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<AdminUserRow | null>(null);
  const [userTxs, setUserTxs] = useState<Array<{ id: number; description: string; amount_points: number; created_at: string }>>([]);
  const [adjustDelta, setAdjustDelta] = useState('');
  const [adjustReason, setAdjustReason] = useState('');

  const loadUsers = async (q = query) => {
    setLoading(true);
    try {
      const res = await apiFetch<{ users: AdminUserRow[] }>(
        `/api/admin/users?q=${encodeURIComponent(q)}`,
        {},
        adminToken
      );
      setUsers(res.users);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load users', 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers('');
  }, []);

  const openUserDetail = async (u: AdminUserRow) => {
    setSelectedUser(u);
    try {
      const res = await apiFetch<{ transactions: Array<{ id: number; description: string; amount_points: number; created_at: string }> }>(
        `/api/admin/users/${u.id}/transactions`,
        {},
        adminToken
      );
      setUserTxs(res.transactions);
    } catch {
      setUserTxs([]);
    }
  };

  const toggleBlock = async (u: AdminUserRow) => {
    try {
      await apiFetch(
        `/api/admin/users/${u.id}/block`,
        { method: 'POST', body: JSON.stringify({ blocked: !u.is_blocked }) },
        adminToken
      );
      onToast(u.is_blocked ? 'User unblocked' : 'User blocked', 'success');
      await loadUsers();
      if (selectedUser?.id === u.id) {
        setSelectedUser({ ...u, is_blocked: u.is_blocked ? 0 : 1 });
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  };

  const handleAdjust = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedUser) return;
    try {
      const res = await apiFetch<{ newBalance: number }>(
        `/api/admin/users/${selectedUser.id}/adjust-balance`,
        {
          method: 'POST',
          body: JSON.stringify({ deltaPoints: Number(adjustDelta), reason: adjustReason }),
        },
        adminToken
      );
      onToast(`Balance updated to ${res.newBalance} PTS`, 'success');
      setAdjustDelta('');
      setAdjustReason('');
      await loadUsers();
      await openUserDetail({ ...selectedUser, points_balance: res.newBalance });
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Adjustment failed', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">User Management</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void loadUsers(query);
          }}
          className="flex items-center gap-2"
        >
          <div className="relative flex-1 sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Username or Telegram ID"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] pl-9 pr-3 text-xs sm:text-sm text-white placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            className="min-h-[42px] rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
          >
            Search
          </button>
        </form>
      </div>

      <div className="rounded-2xl border border-white/10 bg-[#10152B] overflow-x-auto">
        {loading ? (
          <p className="p-8 text-center text-sm text-slate-400">Loading users...</p>
        ) : users.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-400">No users matched your search.</p>
        ) : (
          <table className="w-full text-left text-xs sm:text-sm">
            <thead className="border-b border-white/10 text-slate-400">
              <tr>
                <th className="py-3 px-4 font-medium">User</th>
                <th className="py-3 px-4 font-medium text-right">Balance</th>
                <th className="py-3 px-4 font-medium text-right hidden sm:table-cell">Earned</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/8">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-white/[0.02]">
                  <td className="py-3 px-4">
                    <p className="font-medium text-white">@{u.username}</p>
                    <p className="font-mono text-[11px] text-slate-400">
                      {u.telegram_id} · {u.referral_code}
                    </p>
                  </td>
                  <td className="py-3 px-4 text-right font-mono font-semibold text-violet-300 tabular-nums">
                    {u.points_balance.toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right font-mono text-slate-300 tabular-nums hidden sm:table-cell">
                    {u.total_earned.toLocaleString()}
                  </td>
                  <td className="py-3 px-4">
                    <span className={u.is_blocked ? 'text-rose-400 font-medium' : 'text-emerald-400 font-medium'}>
                      {u.is_blocked ? 'Blocked' : 'Active'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void openUserDetail(u)}
                        className="rounded-lg border border-white/15 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/10 cursor-pointer"
                      >
                        Manage
                      </button>
                      <button
                        type="button"
                        onClick={() => void toggleBlock(u)}
                        className={`rounded-lg px-2.5 py-1.5 text-xs font-medium cursor-pointer ${
                          u.is_blocked
                            ? 'bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25'
                            : 'bg-rose-500/15 text-rose-300 hover:bg-rose-500/25'
                        }`}
                      >
                        {u.is_blocked ? 'Unblock' : 'Block'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* User Detail & Balance Adjustment Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-5">
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <div>
                <h3 className="font-display text-lg font-bold text-white">@{selectedUser.username}</h3>
                <p className="font-mono text-xs text-slate-400">
                  ID: {selectedUser.telegram_id} · Balance: {selectedUser.points_balance} PTS
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedUser(null)}
                className="p-2 text-slate-400 hover:text-white cursor-pointer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={(e) => void handleAdjust(e)} className="space-y-3 rounded-2xl border border-white/10 bg-[#080B18] p-4">
              <p className="text-xs font-semibold text-white">Adjust Balance (Audit Logged)</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="number"
                  required
                  value={adjustDelta}
                  onChange={(e) => setAdjustDelta(e.target.value)}
                  placeholder="Points (+100 or -50)"
                  className="min-h-[42px] rounded-xl border border-white/10 bg-[#10152B] px-3 text-sm text-white font-mono"
                />
                <input
                  type="text"
                  required
                  value={adjustReason}
                  onChange={(e) => setAdjustReason(e.target.value)}
                  placeholder="Audit reason"
                  className="min-h-[42px] rounded-xl border border-white/10 bg-[#10152B] px-3 text-sm text-white"
                />
              </div>
              <button
                type="submit"
                className="min-h-[40px] rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
              >
                Apply Balance Adjustment
              </button>
            </form>

            <div>
              <h4 className="text-xs font-semibold text-slate-300 mb-2">Recent Transactions</h4>
              <div className="divide-y divide-white/8 max-h-56 overflow-y-auto">
                {userTxs.length === 0 ? (
                  <p className="py-4 text-xs text-slate-500">No transactions yet.</p>
                ) : (
                  userTxs.map((tx) => (
                    <div key={tx.id} className="py-2 flex items-center justify-between text-xs">
                      <span className="text-slate-300 truncate pr-3">{tx.description}</span>
                      <span className={`font-mono font-semibold tabular-nums ${tx.amount_points >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {tx.amount_points >= 0 ? `+${tx.amount_points}` : tx.amount_points}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AdminTaskRow {
  id: number;
  title: string;
  description: string;
  category: string;
  icon_url: string;
  target_url: string;
  reward_points: number;
  verification_type: string;
  daily_limit: number;
  expires_at: string;
  is_active: number;
}

interface AdminSubmissionRow {
  id: number;
  username: string;
  task_title: string;
  reward_points: number;
  proof_text: string;
  status: string;
  created_at: string;
}

export function AdminTasksSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [tasks, setTasks] = useState<AdminTaskRow[]>([]);
  const [submissions, setSubmissions] = useState<AdminSubmissionRow[]>([]);
  const [editing, setEditing] = useState<Partial<AdminTaskRow> & { secretCode?: string } | null>(null);

  const load = async () => {
    try {
      const res = await apiFetch<{ tasks: AdminTaskRow[]; submissions: AdminSubmissionRow[] }>(
        '/api/admin/tasks',
        {},
        adminToken
      );
      setTasks(res.tasks);
      setSubmissions(res.submissions);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load tasks', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const saveTask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const payload = {
        title: editing.title,
        description: editing.description,
        category: editing.category || 'custom',
        iconUrl: editing.icon_url || '',
        targetUrl: editing.target_url || '',
        rewardPoints: Number(editing.reward_points || 20),
        verificationType: editing.verification_type || 'admin_approval',
        secretCode: editing.secretCode || '',
        dailyLimit: Number(editing.daily_limit || 1),
        expiresAt: editing.expires_at || '',
        isActive: editing.is_active !== 0,
      };
      if (editing.id) {
        await apiFetch(`/api/admin/tasks/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) }, adminToken);
      } else {
        await apiFetch('/api/admin/tasks', { method: 'POST', body: JSON.stringify(payload) }, adminToken);
      }
      setEditing(null);
      onToast('Task saved', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
  };

  const deleteTask = async (id: number) => {
    try {
      await apiFetch(`/api/admin/tasks/${id}`, { method: 'DELETE' }, adminToken);
      onToast('Task deleted', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
  };

  const reviewSub = async (id: number, decision: 'approved' | 'rejected') => {
    try {
      await apiFetch(
        `/api/admin/submissions/${id}/review`,
        { method: 'POST', body: JSON.stringify({ decision }) },
        adminToken
      );
      onToast(`Submission ${decision}`, 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Review failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">Task Management & Reviews</h2>
        <button
          type="button"
          onClick={() =>
            setEditing({
              title: '',
              description: '',
              category: 'youtube',
              target_url: '',
              reward_points: 50,
              verification_type: 'code_verify',
              daily_limit: 1,
              is_active: 1,
            })
          }
          className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>New Task</span>
        </button>
      </div>

      {/* Pending Review Queue */}
      <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
        <h3 className="font-display text-base font-semibold text-white mb-3">Submission Review Queue</h3>
        {submissions.length === 0 ? (
          <p className="text-sm text-slate-400">No task submissions yet.</p>
        ) : (
          <div className="divide-y divide-white/8">
            {submissions.map((s) => (
              <div key={s.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-white">
                    @{s.username} · <span className="text-violet-300">{s.task_title}</span> (+{s.reward_points} PTS)
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400 break-all">Proof: {s.proof_text}</p>
                </div>
                {s.status === 'pending' ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => void reviewSub(s.id, 'approved')}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-emerald-600 hover:bg-emerald-500 px-3.5 text-xs font-semibold text-white cursor-pointer"
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => void reviewSub(s.id, 'rejected')}
                      className="min-h-[38px] inline-flex items-center gap-1 rounded-xl bg-rose-600/80 hover:bg-rose-600 px-3.5 text-xs font-semibold text-white cursor-pointer"
                    >
                      <XCircle className="h-3.5 w-3.5" />
                      <span>Reject</span>
                    </button>
                  </div>
                ) : (
                  <span className={`text-xs font-semibold capitalize ${s.status === 'approved' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {s.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Task Catalog */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tasks.map((tItem) => (
          <div key={tItem.id} className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs text-violet-300 capitalize">
                  {tItem.category} · {tItem.verification_type.replace('_', ' ')} · {tItem.is_active ? 'Active' : 'Disabled'}
                </p>
                <h4 className="font-display text-base font-bold text-white mt-0.5">{tItem.title}</h4>
              </div>
              <span className="font-mono text-sm font-bold text-emerald-300 tabular-nums">+{tItem.reward_points}</span>
            </div>
            <p className="text-xs text-slate-400">{tItem.description}</p>
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-white/8">
              <button
                type="button"
                onClick={() => setEditing(tItem)}
                className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 cursor-pointer"
              >
                <Edit3 className="h-3.5 w-3.5" />
                <span>Edit</span>
              </button>
              <button
                type="button"
                onClick={() => void deleteTask(tItem.id)}
                className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/25 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Delete</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Create / Edit Task Modal */}
      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => void saveTask(e)}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="font-display text-lg font-bold text-white">{editing.id ? 'Edit Task' : 'Create Task'}</h3>
              <button type="button" onClick={() => setEditing(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>

            <input
              type="text"
              required
              value={editing.title || ''}
              onChange={(e) => setEditing({ ...editing, title: e.target.value })}
              placeholder="Task title"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <textarea
              required
              rows={3}
              value={editing.description || ''}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
              placeholder="Task description"
              className="w-full rounded-xl border border-white/10 bg-[#080B18] p-3 text-sm text-white"
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={editing.category || 'youtube'}
                onChange={(e) => setEditing({ ...editing, category: e.target.value })}
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              >
                <option value="youtube">YouTube</option>
                <option value="social">Social</option>
                <option value="special_offer">Special Offer</option>
                <option value="custom">Custom Mission</option>
                <option value="partner">Partner Offer</option>
              </select>
              <select
                value={editing.verification_type || 'admin_approval'}
                onChange={(e) => setEditing({ ...editing, verification_type: e.target.value })}
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              >
                <option value="admin_approval">Admin Approval</option>
                <option value="code_verify">Secret Video Code</option>
              </select>
            </div>
            {editing.verification_type === 'code_verify' && (
              <input
                type="text"
                value={editing.secretCode || ''}
                onChange={(e) => setEditing({ ...editing, secretCode: e.target.value })}
                placeholder={editing.id ? 'New secret code (leave blank to keep existing)' : 'Secret code from video'}
                className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              />
            )}
            <input
              type="url"
              value={editing.target_url || ''}
              onChange={(e) => setEditing({ ...editing, target_url: e.target.value })}
              placeholder="https://youtube.com/... or https://t.me/..."
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Reward Points</label>
                <input
                  type="number"
                  min={1}
                  value={editing.reward_points || 20}
                  onChange={(e) => setEditing({ ...editing, reward_points: Number(e.target.value) })}
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Daily Limit</label>
                <input
                  type="number"
                  min={1}
                  value={editing.daily_limit || 1}
                  onChange={(e) => setEditing({ ...editing, daily_limit: Number(e.target.value) })}
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Icon / Image URL (optional)</label>
                <input
                  type="text"
                  value={editing.icon_url || ''}
                  onChange={(e) => setEditing({ ...editing, icon_url: e.target.value })}
                  placeholder="/src/assets/images/..."
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Expiration Date (optional)</label>
                <input
                  type="date"
                  value={editing.expires_at ? editing.expires_at.slice(0, 10) : ''}
                  onChange={(e) =>
                    setEditing({
                      ...editing,
                      expires_at: e.target.value ? new Date(e.target.value + 'T23:59:59Z').toISOString() : '',
                    })
                  }
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={editing.is_active !== 0}
                onChange={(e) => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })}
              />
              <span>Task Active</span>
            </label>
            <button
              type="submit"
              className="min-h-[44px] w-full rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white cursor-pointer"
            >
              Save Task
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

interface AdProviderRow {
  id: number;
  name: string;
  provider_type: string;
  sdk_zone_id: string;
  placement_id: string;
  has_api_key?: boolean;
  api_key_masked?: string;
  ad_url_template: string;
  reward_points: number;
  payout_per_conversion_bdt: number;
  daily_limit: number;
  reset_hour_utc: number;
  is_active: number;
  impressions?: number;
  verifiedConversions?: number;
  duplicateCount?: number;
  errorCount?: number;
  userRewardPointsCost?: number;
  userRewardBdtCost?: number;
  estimatedRevenueBdt?: number;
}

interface AdSessionRow {
  id: string;
  username: string;
  provider_name: string;
  slot_number: number;
  status: string;
  reward_points: number;
  provider_tx_id?: string;
  created_at: string;
}

interface AdPostbackRow {
  id: number;
  provider_id: number | null;
  provider_name: string;
  session_id: string;
  provider_tx_id: string;
  status: string;
  error_message: string;
  raw_reward: string;
  ip_address: string;
  created_at: string;
}

interface AdSummary {
  impressions: number;
  verifiedConversions: number;
  duplicateOrErrors: number;
  userRewardPointsCost: number;
  userRewardBdtCost: number;
  estimatedRevenueBdt: number;
}

export function AdminAdsSection({
  adminToken,
  onToast,
}: {
  adminToken: string;
  onToast: (m: string, t?: 'success' | 'error') => void;
}) {
  const [providers, setProviders] = useState<AdProviderRow[]>([]);
  const [sessions, setSessions] = useState<AdSessionRow[]>([]);
  const [postbacks, setPostbacks] = useState<AdPostbackRow[]>([]);
  const [summary, setSummary] = useState<AdSummary | null>(null);
  const [editing, setEditing] = useState<(Partial<AdProviderRow> & { postbackSecret?: string; apiKey?: string }) | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  const load = async () => {
    try {
      const res = await apiFetch<{
        providers: AdProviderRow[];
        sessions: AdSessionRow[];
        postbacks?: AdPostbackRow[];
        summary?: AdSummary;
      }>('/api/admin/ads', {}, adminToken);
      setProviders(res.providers);
      setSessions(res.sessions);
      setPostbacks(res.postbacks || []);
      setSummary(res.summary || null);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to load ad providers', 'error');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const postbackTemplate = `${window.location.origin}/api/ads/postback?click_id={click_id}&tx_id={tx_id}&token=YOUR_POSTBACK_SECRET`;

  const saveProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    try {
      const payload = {
        name: editing.name,
        providerType: editing.provider_type || 'monetag',
        sdkZoneId: editing.sdk_zone_id || '',
        placementId: editing.placement_id || '',
        apiKey: editing.apiKey || '',
        adUrlTemplate: editing.ad_url_template || '',
        postbackSecret: editing.postbackSecret || '',
        rewardPoints: Number(editing.reward_points || 10),
        payoutPerConversionBdt: Number(editing.payout_per_conversion_bdt || 0),
        dailyLimit: Number(editing.daily_limit || 6),
        resetHourUtc: Number(editing.reset_hour_utc || 0),
        isActive: editing.is_active !== 0,
      };
      if (editing.id) {
        await apiFetch(`/api/admin/ads/providers/${editing.id}`, { method: 'PUT', body: JSON.stringify(payload) }, adminToken);
      } else {
        await apiFetch('/api/admin/ads/providers', { method: 'POST', body: JSON.stringify(payload) }, adminToken);
      }
      setEditing(null);
      onToast('Ad provider saved', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Failed to save provider', 'error');
    }
  };

  const verifySessionAsAdmin = async (id: string) => {
    try {
      await apiFetch(`/api/admin/ads/sessions/${id}/verify`, { method: 'POST' }, adminToken);
      onToast('Ad session verified and points credited', 'success');
      await load();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Verification failed', 'error');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-bold text-white">Advertisement & Postback Verification</h2>
        <button
          type="button"
          onClick={() =>
            setEditing({
              name: '',
              provider_type: 'monetag',
              sdk_zone_id: '',
              placement_id: '',
              apiKey: '',
              ad_url_template: '',
              postbackSecret: '',
              reward_points: 10,
              payout_per_conversion_bdt: 0,
              daily_limit: 6,
              reset_hour_utc: 0,
              is_active: 1,
            })
          }
          className="min-h-[42px] inline-flex items-center gap-1.5 rounded-xl bg-violet-600 hover:bg-violet-500 px-4 text-xs font-semibold text-white cursor-pointer"
        >
          <Plus className="h-4 w-4" />
          <span>Add Provider</span>
        </button>
      </div>

      {/* Ad Economics & Postback Summary KPIs */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="rounded-2xl border border-white/10 bg-[#10152B] p-3.5">
            <span className="text-[11px] text-slate-400">Impressions</span>
            <p className="mt-1 font-mono text-lg font-bold text-white tabular-nums">{summary.impressions.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#10152B] p-3.5">
            <span className="text-[11px] text-slate-400">Verified Conversions</span>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-300 tabular-nums">{summary.verifiedConversions.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#10152B] p-3.5">
            <span className="text-[11px] text-slate-400">Duplicates / Errors</span>
            <p className="mt-1 font-mono text-lg font-bold text-amber-300 tabular-nums">{summary.duplicateOrErrors.toLocaleString()}</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#10152B] p-3.5">
            <span className="text-[11px] text-slate-400">User Reward Cost</span>
            <p className="mt-1 font-mono text-lg font-bold text-violet-300 tabular-nums">
              ৳{summary.userRewardBdtCost.toFixed(2)}
            </p>
            <p className="font-mono text-[10px] text-slate-500">{summary.userRewardPointsCost.toLocaleString()} PTS</p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-[#10152B] p-3.5">
            <span className="text-[11px] text-slate-400">Est. Provider Revenue</span>
            <p className="mt-1 font-mono text-lg font-bold text-emerald-400 tabular-nums">
              ৳{summary.estimatedRevenueBdt.toFixed(2)}
            </p>
          </div>
        </div>
      )}

      {/* S2S Postback Endpoint Reference */}
      <div className="rounded-2xl border border-violet-400/25 bg-[#151B36] p-4 space-y-2">
        <p className="text-xs font-semibold text-violet-200">Verified S2S Postback Webhook URL</p>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <code className="font-mono text-xs text-slate-200 break-all">{postbackTemplate}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(postbackTemplate);
              setCopiedUrl(true);
              setTimeout(() => setCopiedUrl(false), 1500);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white shrink-0 cursor-pointer"
          >
            {copiedUrl ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span>{copiedUrl ? 'Copied' : 'Copy URL'}</span>
          </button>
        </div>
        <p className="text-[11px] text-slate-400">
          Duplicate <code className="font-mono text-slate-200">tx_id</code> postbacks and mismatched tokens are rejected automatically. When no active provider is configured, users see &ldquo;Advertisements are temporarily unavailable.&rdquo;
        </p>
      </div>

      {/* Providers List */}
      {providers.length === 0 ? (
        <div className="rounded-2xl border border-white/10 bg-[#10152B] p-6 text-center space-y-1.5">
          <p className="text-sm font-semibold text-white">No ad providers configured</p>
          <p className="text-xs text-slate-400">
            Users currently see &ldquo;Advertisements are temporarily unavailable.&rdquo; Add a real ad network above to enable ad rewards.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {providers.map((p) => (
            <div key={p.id} className="rounded-2xl border border-white/10 bg-[#10152B] p-5 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs text-violet-300 uppercase">{p.provider_type} · {p.is_active ? 'Active' : 'Paused'}</p>
                  <h3 className="font-display text-base font-bold text-white mt-0.5">{p.name}</h3>
                  {p.has_api_key && (
                    <p className="font-mono text-[11px] text-slate-400 mt-0.5">API Key: {p.api_key_masked}</p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setEditing({ ...p, apiKey: '', postbackSecret: '' })}
                    className="rounded-lg border border-white/15 px-3 py-1.5 text-xs text-slate-200 hover:bg-white/10 cursor-pointer"
                  >
                    Configure
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void (async () => {
                        try {
                          await apiFetch(`/api/admin/ads/providers/${p.id}`, { method: 'DELETE' }, adminToken);
                          onToast('Ad provider deleted', 'success');
                          await load();
                        } catch (err) {
                          onToast(err instanceof Error ? err.message : 'Delete failed', 'error');
                        }
                      })();
                    }}
                    className="rounded-lg bg-rose-500/15 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/25 cursor-pointer"
                    aria-label="Delete provider"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs text-slate-300 pt-2 border-t border-white/8">
                <div>
                  <span className="text-slate-500">Reward</span>
                  <p className="font-mono font-semibold text-emerald-300 tabular-nums">{p.reward_points} PTS</p>
                </div>
                <div>
                  <span className="text-slate-500">Daily Limit</span>
                  <p className="font-mono font-semibold tabular-nums">{p.daily_limit} ads</p>
                </div>
                <div>
                  <span className="text-slate-500">Reset UTC</span>
                  <p className="font-mono font-semibold tabular-nums">{String(p.reset_hour_utc).padStart(2, '0')}:00</p>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[11px] text-slate-400 pt-2 border-t border-white/8">
                <div>
                  Impressions: <strong className="font-mono text-white">{p.impressions || 0}</strong>
                </div>
                <div>
                  Verified: <strong className="font-mono text-emerald-300">{p.verifiedConversions || 0}</strong>
                </div>
                <div>
                  Errors/Dup: <strong className="font-mono text-amber-300">{(p.duplicateCount || 0) + (p.errorCount || 0)}</strong>
                </div>
              </div>
              {p.placement_id && (
                <p className="font-mono text-[11px] text-slate-400">
                  Zone: {p.sdk_zone_id || '—'} · Placement: {p.placement_id} · Payout: ৳{Number(p.payout_per_conversion_bdt || 0).toFixed(2)}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Postback Records & Error Monitoring */}
      <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
        <h3 className="font-display text-base font-semibold text-white mb-3">S2S Postback Audit & Error Log</h3>
        {postbacks.length === 0 ? (
          <p className="text-sm text-slate-400">No incoming postback calls logged yet.</p>
        ) : (
          <div className="divide-y divide-white/8 max-h-72 overflow-y-auto pr-1">
            {postbacks.map((pb) => {
              const isOk = pb.status === 'verified' || pb.status === 'already_verified';
              return (
                <div key={pb.id} className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                  <div className="min-w-0">
                    <p className="text-slate-200 font-medium truncate">
                      {pb.provider_name} · session:{pb.session_id || '—'}
                      {pb.provider_tx_id ? ` · tx:${pb.provider_tx_id}` : ''}
                    </p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {new Date(pb.created_at).toLocaleString()} {pb.error_message ? `· ${pb.error_message}` : ''}
                    </p>
                  </div>
                  <span
                    className={`font-mono font-semibold uppercase shrink-0 ${
                      isOk ? 'text-emerald-400' : pb.status === 'duplicate_tx' ? 'text-amber-300' : 'text-rose-400'
                    }`}
                  >
                    {pb.status}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Live Ad Sessions */}
      <section className="rounded-2xl border border-white/10 bg-[#10152B] p-5">
        <h3 className="font-display text-base font-semibold text-white mb-3">Recent Ad Sessions</h3>
        {sessions.length === 0 ? (
          <p className="text-sm text-slate-400">No ad sessions recorded yet.</p>
        ) : (
          <div className="divide-y divide-white/8">
            {sessions.map((s) => (
              <div key={s.id} className="py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
                <div>
                  <p className="text-sm font-medium text-white">
                    @{s.username} · Ad #{s.slot_number} ({s.provider_name})
                  </p>
                  <p className="font-mono text-slate-400">
                    {s.id} · +{s.reward_points} PTS{s.provider_tx_id ? ` · tx:${s.provider_tx_id}` : ''}
                  </p>
                </div>
                {s.status === 'verified' ? (
                  <span className="font-semibold text-emerald-400">Verified via Postback</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void verifySessionAsAdmin(s.id)}
                    className="rounded-lg border border-amber-400/35 bg-amber-500/15 hover:bg-amber-500/25 px-3 py-1.5 text-xs font-semibold text-amber-200 cursor-pointer"
                  >
                    Admin Verify Session
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {editing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <form
            onSubmit={(e) => void saveProvider(e)}
            className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-3xl border border-white/15 bg-[#10152B] p-6 space-y-4"
          >
            <div className="flex items-center justify-between pb-3 border-b border-white/10">
              <h3 className="font-display text-lg font-bold text-white">Configure Ad Provider</h3>
              <button type="button" onClick={() => setEditing(null)} className="text-slate-400 hover:text-white cursor-pointer">
                <X className="h-5 w-5" />
              </button>
            </div>
            <input
              type="text"
              required
              value={editing.name || ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Provider name (e.g. Monetag)"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <div className="grid grid-cols-2 gap-3">
              <select
                value={editing.provider_type || 'monetag'}
                onChange={(e) => setEditing({ ...editing, provider_type: e.target.value })}
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              >
                <option value="monetag">Monetag</option>
                <option value="adsgram">Adsgram</option>
                <option value="richads">RichAds</option>
                <option value="custom_postback">Custom S2S Postback</option>
              </select>
              <input
                type="text"
                value={editing.sdk_zone_id || ''}
                onChange={(e) => setEditing({ ...editing, sdk_zone_id: e.target.value })}
                placeholder="Zone / Block ID"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                value={editing.placement_id || ''}
                onChange={(e) => setEditing({ ...editing, placement_id: e.target.value })}
                placeholder="Placement ID (optional)"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
              />
              <input
                type="number"
                step="0.01"
                min={0}
                value={editing.payout_per_conversion_bdt ?? 0}
                onChange={(e) => setEditing({ ...editing, payout_per_conversion_bdt: Number(e.target.value) })}
                placeholder="Payout / Conversion (BDT)"
                className="min-h-[42px] rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
              />
            </div>
            <input
              type="password"
              value={editing.apiKey || ''}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder={editing.has_api_key ? 'New API Key (blank = keep existing)' : 'Provider API Key (optional)'}
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
            />
            <input
              type="url"
              required
              value={editing.ad_url_template || ''}
              onChange={(e) => setEditing({ ...editing, ad_url_template: e.target.value })}
              placeholder="https://your-ad-network.com/offer?click_id={click_id}&user_id={user_id}"
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <input
              type="text"
              required={!editing.id}
              value={editing.postbackSecret || ''}
              onChange={(e) => setEditing({ ...editing, postbackSecret: e.target.value })}
              placeholder={editing.id ? 'New postback secret (blank = keep existing)' : 'Postback secret token'}
              className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white"
            />
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">Reward PTS</label>
                <input
                  type="number"
                  min={1}
                  value={editing.reward_points || 10}
                  onChange={(e) => setEditing({ ...editing, reward_points: Number(e.target.value) })}
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Daily Limit</label>
                <input
                  type="number"
                  min={1}
                  value={editing.daily_limit || 6}
                  onChange={(e) => setEditing({ ...editing, daily_limit: Number(e.target.value) })}
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Reset UTC Hr</label>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={editing.reset_hour_utc ?? 0}
                  onChange={(e) => setEditing({ ...editing, reset_hour_utc: Number(e.target.value) })}
                  className="min-h-[42px] w-full rounded-xl border border-white/10 bg-[#080B18] px-3 text-sm text-white font-mono"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={editing.is_active !== 0}
                onChange={(e) => setEditing({ ...editing, is_active: e.target.checked ? 1 : 0 })}
              />
              <span>Provider Active</span>
            </label>
            <button
              type="submit"
              className="min-h-[44px] w-full rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-semibold text-white cursor-pointer"
            >
              Save Provider
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
