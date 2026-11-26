export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: {
    start_param?: string;
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
  };
  ready: () => void;
  expand: () => void;
  setHeaderColor?: (color: string) => void;
  setBackgroundColor?: (color: string) => void;
  openTelegramLink?: (url: string) => void;
  openLink?: (url: string) => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
  };
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function initTelegramMiniApp(): TelegramWebApp | null {
  const tg = getTelegramWebApp();
  if (!tg) return null;
  try {
    tg.ready();
    tg.expand();
    tg.setHeaderColor?.('#080B18');
    tg.setBackgroundColor?.('#080B18');
  } catch {
    // Ignore when running outside Telegram container
  }
  return tg;
}

export function safeOpenExternalUrl(url: string): void {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
    const tg = getTelegramWebApp();
    if (tg && parsed.hostname === 't.me' && tg.openTelegramLink) {
      tg.openTelegramLink(parsed.toString());
      return;
    }
    if (tg?.openLink) {
      tg.openLink(parsed.toString());
      return;
    }
    const link = document.createElement('a');
    link.href = parsed.toString();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
  } catch {
    // Ignore malformed URLs
  }
}
