import { Compass, Diamond, ExternalLink, Flame, Gem, Hexagon, Layers, Sparkles, Star, Trophy, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api.ts';
import { safeOpenExternalUrl } from '../../lib/telegram.ts';
import type { BootstrapPayload, GameItem } from '../../types/app.ts';

interface PlayTabProps {
  data: BootstrapPayload;
  token: string;
  t: (key: string, fallback?: string) => string;
  onRefresh: () => Promise<void>;
  onToast: (msg: string, type?: 'success' | 'error') => void;
}

const MEMORY_SYMBOLS = [
  { id: 'diamond', Icon: Diamond, color: 'text-violet-300' },
  { id: 'star', Icon: Star, color: 'text-amber-300' },
  { id: 'flame', Icon: Flame, color: 'text-rose-300' },
  { id: 'gem', Icon: Gem, color: 'text-cyan-300' },
  { id: 'hexagon', Icon: Hexagon, color: 'text-emerald-300' },
  { id: 'compass', Icon: Compass, color: 'text-indigo-300' },
];

interface MemoryCard {
  uid: number;
  symbolId: string;
  flipped: boolean;
  matched: boolean;
}

export function PlayTab({ data, token, t, onRefresh, onToast }: PlayTabProps) {
  const [activeSpinGame, setActiveSpinGame] = useState<GameItem | null>(null);
  const [wheelRotation, setWheelRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);

  const [activeMemoryGame, setActiveMemoryGame] = useState<GameItem | null>(null);
  const [memoryNonce, setMemoryNonce] = useState<string | null>(null);
  const [cards, setCards] = useState<MemoryCard[]>([]);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [moves, setMoves] = useState(0);
  const [claimingMemory, setClaimingMemory] = useState(false);

  const [activeTapGame, setActiveTapGame] = useState<GameItem | null>(null);
  const [tapNonce, setTapNonce] = useState<string | null>(null);
  const [taps, setTaps] = useState(0);
  const [tapTimeLeft, setTapTimeLeft] = useState(0);
  const [claimingTap, setClaimingTap] = useState(false);

  const resolveGameType = (game: GameItem): string => {
    if (game.game_type) return game.game_type;
    if (game.slug === 'spin-wheel') return 'spin_wheel';
    if (game.slug === 'prism-memory') return 'prism_memory';
    return 'vault_tap';
  };

  // Spin Wheel Handler (Server-authoritative nonce + server-computed prize)
  const handleSpin = async (game: GameItem) => {
    if (spinning || game.playsLeft <= 0 || game.cooldownRemaining > 0) return;
    setSpinning(true);
    setActiveSpinGame(game);
    try {
      const startRes = await apiFetch<{ nonce: string }>(`/api/games/${game.id}/start`, { method: 'POST' }, token);
      setWheelRotation((prev) => prev + 1080 + Math.floor(Math.random() * 360));
      await new Promise((r) => setTimeout(r, 1500));
      const claimRes = await apiFetch<{ reward: number }>(
        `/api/games/${game.id}/claim`,
        { method: 'POST', body: JSON.stringify({ nonce: startRes.nonce, score: 100 }) },
        token
      );
      onToast(
        `${t('msg.game_reward', 'Game completed! Reward added to balance.')} (+${claimRes.reward} ${t('home.points_unit', 'PTS')})`,
        'success'
      );
      await onRefresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    } finally {
      setSpinning(false);
    }
  };

  // Start Prism Memory Match
  const handleStartMemory = async (game: GameItem) => {
    try {
      const startRes = await apiFetch<{ nonce: string }>(`/api/games/${game.id}/start`, { method: 'POST' }, token);
      const deck: MemoryCard[] = [...MEMORY_SYMBOLS, ...MEMORY_SYMBOLS]
        .map((s, idx) => ({ uid: idx, symbolId: s.id, flipped: false, matched: false }))
        .sort(() => Math.random() - 0.5);
      setActiveMemoryGame(game);
      setMemoryNonce(startRes.nonce);
      setCards(deck);
      setSelectedIndices([]);
      setMoves(0);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    }
  };

  // Start Vault Tap Challenge or External Offer
  const handleStartTapOrOffer = async (game: GameItem) => {
    const gType = resolveGameType(game);
    if (gType === 'external_offer' && game.target_url) {
      try {
        const startRes = await apiFetch<{ nonce: string }>(`/api/games/${game.id}/start`, { method: 'POST' }, token);
        safeOpenExternalUrl(game.target_url);
        await new Promise((r) => setTimeout(r, 2500));
        const claimRes = await apiFetch<{ reward: number }>(
          `/api/games/${game.id}/claim`,
          { method: 'POST', body: JSON.stringify({ nonce: startRes.nonce, score: 80 }) },
          token
        );
        onToast(
          `${t('msg.game_reward', 'Game completed! Reward added to balance.')} (+${claimRes.reward} ${t('home.points_unit', 'PTS')})`,
          'success'
        );
        await onRefresh();
      } catch (err) {
        onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
      }
      return;
    }

    try {
      const startRes = await apiFetch<{ nonce: string }>(`/api/games/${game.id}/start`, { method: 'POST' }, token);
      setActiveTapGame(game);
      setTapNonce(startRes.nonce);
      setTaps(0);
      setTapTimeLeft(6);
    } catch (err) {
      onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
    }
  };

  useEffect(() => {
    if (!activeTapGame || !tapNonce || tapTimeLeft <= 0) return;
    const timer = setTimeout(() => setTapTimeLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [activeTapGame, tapNonce, tapTimeLeft]);

  useEffect(() => {
    if (!activeTapGame || !tapNonce || tapTimeLeft > 0 || claimingTap) return;
    setClaimingTap(true);
    const score = Math.min(100, Math.max(25, taps * 5));
    void (async () => {
      try {
        const res = await apiFetch<{ reward: number }>(
          `/api/games/${activeTapGame.id}/claim`,
          { method: 'POST', body: JSON.stringify({ nonce: tapNonce, score }) },
          token
        );
        onToast(
          `${t('msg.game_reward', 'Game completed! Reward added to balance.')} (+${res.reward} ${t('home.points_unit', 'PTS')})`,
          'success'
        );
        setActiveTapGame(null);
        setTapNonce(null);
        await onRefresh();
      } catch (err) {
        onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
      } finally {
        setClaimingTap(false);
      }
    })();
  }, [activeTapGame, tapNonce, tapTimeLeft, taps, claimingTap, token, onRefresh, onToast, t]);

  const handleCardFlip = (idx: number) => {
    if (claimingMemory || selectedIndices.length >= 2) return;
    const card = cards[idx];
    if (!card || card.flipped || card.matched) return;

    const nextCards = cards.map((c, i) => (i === idx ? { ...c, flipped: true } : c));
    setCards(nextCards);
    const nextSel = [...selectedIndices, idx];
    setSelectedIndices(nextSel);

    if (nextSel.length === 2) {
      setMoves((m) => m + 1);
      const [a, b] = nextSel;
      if (nextCards[a].symbolId === nextCards[b].symbolId) {
        setTimeout(() => {
          setCards((prev) =>
            prev.map((c, i) => (i === a || i === b ? { ...c, matched: true } : c))
          );
          setSelectedIndices([]);
        }, 250);
      } else {
        setTimeout(() => {
          setCards((prev) =>
            prev.map((c, i) => (i === a || i === b ? { ...c, flipped: false } : c))
          );
          setSelectedIndices([]);
        }, 650);
      }
    }
  };

  useEffect(() => {
    if (!activeMemoryGame || !memoryNonce || cards.length === 0 || claimingMemory) return;
    const allMatched = cards.every((c) => c.matched);
    if (!allMatched) return;

    setClaimingMemory(true);
    const score = Math.max(40, 100 - Math.max(0, moves - 6) * 6);
    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 400));
        const res = await apiFetch<{ reward: number }>(
          `/api/games/${activeMemoryGame.id}/claim`,
          { method: 'POST', body: JSON.stringify({ nonce: memoryNonce, score }) },
          token
        );
        onToast(
          `${t('msg.game_reward', 'Game completed! Reward added to balance.')} (+${res.reward} ${t('home.points_unit', 'PTS')})`,
          'success'
        );
        setActiveMemoryGame(null);
        setMemoryNonce(null);
        await onRefresh();
      } catch (err) {
        onToast(err instanceof Error ? err.message : t('err.generic', 'Something went wrong.'), 'error');
      } finally {
        setClaimingMemory(false);
      }
    })();
  }, [cards, activeMemoryGame, memoryNonce, moves, claimingMemory, token, onRefresh, onToast, t]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-white">{t('play.title', 'Play & Win')}</h1>
        <p className="mt-1 text-sm text-slate-400">
          {t('play.subtitle', 'Server-verified mini-games with daily reward caps')}
        </p>
      </div>

      {data.settings.gamesEnabled === 'false' || data.games.length === 0 ? (
        <div className="rounded-3xl border border-white/10 bg-[#10152B] p-10 text-center text-sm text-slate-400">
          {t('play.no_games', 'Mini-games are currently paused by admin.')}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {data.games.map((game) => {
            const gType = resolveGameType(game);
            const isSpin = gType === 'spin_wheel';
            const isMemory = gType === 'prism_memory';
            const isOffer = gType === 'external_offer';
            const disabled = game.playsLeft <= 0 || game.cooldownRemaining > 0 || (isSpin && spinning);

            return (
              <div
                key={game.id}
                className="rounded-3xl border border-white/10 bg-[#10152B] p-6 flex flex-col justify-between gap-5"
              >
                <div className="flex items-start gap-4">
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-2xl border border-violet-400/25 bg-[#161C38] flex items-center justify-center">
                    {isSpin ? (
                      <img
                        src={game.icon_url || '/src/assets/images/game_spin_wheel_1795540141322.jpg'}
                        alt={game.title}
                        referrerPolicy="no-referrer"
                        style={{ transform: `rotate(${activeSpinGame?.id === game.id ? wheelRotation : 0}deg)` }}
                        className="h-full w-full object-cover transition-transform duration-[1500ms] ease-out"
                      />
                    ) : game.icon_url ? (
                      <img
                        src={game.icon_url}
                        alt={game.title}
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : isMemory ? (
                      <Layers className="h-7 w-7 text-violet-300" />
                    ) : (
                      <Zap className="h-7 w-7 text-violet-300" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="font-display text-lg font-bold text-white">{game.title}</h2>
                    <p className="mt-1 text-xs sm:text-sm text-slate-400">{game.description}</p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 rounded-2xl border border-white/8 bg-[#0B0F20] p-3.5 text-xs">
                  <div>
                    <span className="text-slate-400">{t('play.reward_range', 'Reward Range')}</span>
                    <p className="mt-0.5 font-mono font-semibold text-violet-300 tabular-nums">
                      {game.reward_min}–{game.reward_max} {t('home.points_unit', 'PTS')}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">{t('play.plays_left', 'Plays Left Today')}</span>
                    <p className="mt-0.5 font-mono font-semibold text-white tabular-nums">
                      {game.playsLeft} / {game.daily_limit}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    if (isSpin) void handleSpin(game);
                    else if (isMemory) void handleStartMemory(game);
                    else void handleStartTapOrOffer(game);
                  }}
                  className="min-h-[46px] w-full inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:bg-slate-800 disabled:text-slate-500 text-sm font-semibold text-white shadow-[0_0_20px_rgba(124,58,237,0.35)] disabled:shadow-none transition-all cursor-pointer"
                >
                  {isSpin ? (
                    <Sparkles className="h-4 w-4" />
                  ) : isOffer ? (
                    <ExternalLink className="h-4 w-4" />
                  ) : (
                    <Trophy className="h-4 w-4" />
                  )}
                  <span>
                    {isSpin && spinning && activeSpinGame?.id === game.id
                      ? t('play.spinning', 'Spinning...')
                      : game.cooldownRemaining > 0
                        ? `${t('play.cooldown_wait', 'Cooldown active')} (${game.cooldownRemaining}s)`
                        : isSpin
                          ? t('play.spin_now', 'Spin Wheel')
                          : t('play.start_game', 'Start Game')}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Interactive Vault Tap Challenge */}
      {activeTapGame && (
        <section className="rounded-3xl border border-violet-400/30 bg-[#10152B] p-6 text-center space-y-4">
          <div className="flex items-center justify-between text-xs">
            <h3 className="font-display text-base font-bold text-white">{activeTapGame.title}</h3>
            <span className="font-mono text-amber-300 font-semibold tabular-nums">{tapTimeLeft}s left</span>
          </div>
          <p className="text-xs text-slate-400">Tap the Vault Crystal rapidly before the timer ends to boost your reward!</p>
          <button
            type="button"
            disabled={tapTimeLeft <= 0 || claimingTap}
            onClick={() => setTaps((n) => n + 1)}
            className="mx-auto flex h-28 w-28 items-center justify-center rounded-full border-2 border-violet-400/50 bg-gradient-to-br from-violet-600 to-indigo-700 text-white shadow-[0_0_32px_rgba(124,58,237,0.55)] active:scale-95 transition-transform cursor-pointer"
          >
            <div className="text-center">
              <Gem className="mx-auto h-7 w-7 mb-1" />
              <span className="font-mono text-sm font-bold tabular-nums">{taps}</span>
            </div>
          </button>
        </section>
      )}

      {/* Interactive Prism Memory Match Board */}
      {activeMemoryGame && (
        <section className="rounded-3xl border border-violet-400/30 bg-[#10152B] p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h3 className="font-display text-base font-bold text-white">{activeMemoryGame.title}</h3>
              <p className="text-xs text-slate-400">{t('play.memory_title', 'Match all crystal pairs to claim your reward')}</p>
            </div>
            <span className="font-mono text-xs font-semibold text-violet-300 tabular-nums">
              {t('play.moves_label', 'Moves')}: {moves}
            </span>
          </div>

          <div className="grid grid-cols-3 sm:grid-cols-4 gap-3 max-w-lg mx-auto">
            {cards.map((card, idx) => {
              const sym = MEMORY_SYMBOLS.find((s) => s.id === card.symbolId);
              const Icon = sym?.Icon || Diamond;
              const revealed = card.flipped || card.matched;
              return (
                <button
                  key={card.uid}
                  type="button"
                  onClick={() => handleCardFlip(idx)}
                  className={`aspect-square rounded-2xl border flex items-center justify-center transition-all cursor-pointer ${
                    card.matched
                      ? 'border-emerald-400/50 bg-emerald-950/30'
                      : revealed
                        ? 'border-violet-400/50 bg-[#1E1945]'
                        : 'border-white/10 bg-[#151B36] hover:border-violet-400/35'
                  }`}
                >
                  {revealed ? (
                    <Icon className={`h-7 w-7 ${sym?.color || 'text-violet-300'}`} />
                  ) : (
                    <span className="h-2.5 w-2.5 rounded-full bg-white/15" />
                  )}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
