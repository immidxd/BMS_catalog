// Інтеграція з Telegram WebApp SDK: тема, кнопка «Назад», вібрація.
// Поза Telegram (звичайний браузер) усе деградує безпечно — застосунок працює.

type TelegramWebApp = {
  ready: () => void;
  expand: () => void;
  platform: string;
  initData: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  BackButton: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void };
  HapticFeedback?: { impactOccurred: (style: 'light' | 'medium' | 'soft') => void; selectionChanged: () => void };
  openTelegramLink: (url: string) => void;
  openLink?: (url: string) => void;
  onEvent: (event: string, cb: () => void) => void;
  initDataUnsafe?: { user?: { id?: number } };
};

declare global {
  interface Window { Telegram?: { WebApp?: TelegramWebApp } }
}

export const tg: TelegramWebApp | undefined = window.Telegram?.WebApp;

// Скрипт telegram-web-app.js визначає WebApp і у звичайному браузері —
// справжній Telegram відрізняємо за platform ('unknown' поза Telegram)
export const isInTelegram = Boolean(tg && tg.platform !== 'unknown');

// Telegram ID поточного користувача (для визначення адміна). null — поза Telegram.
export const telegramUserId: number | null = tg?.initDataUnsafe?.user?.id ?? null;

// Сирий ПІДПИСАНИЙ initData — для автентифікації адмін-записів на бекенді (Фаза 2).
// Поза Telegram порожній → адмін у браузері авторизується через адмін-токен.
export const initDataRaw = (): string => tg?.initData ?? '';

// ── Тема: за замовчуванням слідує за пристроєм/Telegram; ручний вибір
// (якщо є) зберігається у localStorage і має пріоритет ───────────────────────
type Theme = 'light' | 'dark';
const THEME_KEY = 'tg-shop-theme';

const systemTheme = (): Theme => {
  if (isInTelegram) return tg!.colorScheme === 'dark' ? 'dark' : 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

const storedTheme = (): Theme | null => {
  const v = localStorage.getItem(THEME_KEY);
  return v === 'light' || v === 'dark' ? v : null;
};

export const currentTheme = (): Theme => storedTheme() ?? systemTheme();

const applyTheme = (): void => {
  document.documentElement.dataset.theme = currentTheme();
};

// Ручне перемикання: фіксує вибір (override) і запамʼятовує
export const toggleTheme = (): Theme => {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme();
  return next;
};

export const initTelegram = (): void => {
  applyTheme();
  // Авто-оновлення за зміною теми пристрою/Telegram — лише доки немає ручного вибору
  if (isInTelegram) {
    tg!.ready();
    tg!.expand();
    tg!.onEvent('themeChanged', () => { if (!storedTheme()) applyTheme(); });
    return;
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!storedTheme()) applyTheme();
  });
};

export const haptic = (style: 'light' | 'medium' | 'soft' = 'light'): void => {
  tg?.HapticFeedback?.impactOccurred(style);
};

export const hapticSelect = (): void => {
  tg?.HapticFeedback?.selectionChanged();
};

// Кнопка «Назад» Telegram; повертає cleanup для useEffect
export const showBackButton = (onBack: () => void): (() => void) => {
  if (!isInTelegram) return () => {};
  tg!.BackButton.onClick(onBack);
  tg!.BackButton.show();
  return () => {
    tg!.BackButton.offClick(onBack);
    tg!.BackButton.hide();
  };
};

// Відкрити чат з менеджером із підставленою чернеткою замовлення
export const contactSeller = (username: string, productnumber: string): void => {
  const message = encodeURIComponent(`Мене цікавить ${productnumber}`);
  const url = `https://t.me/${username}?text=${message}`;
  if (isInTelegram) tg!.openTelegramLink(url);
  else window.open(url, '_blank');
};

// Зовнішнє посилання (телефон/Instagram) — у Telegram через openLink, інакше нова вкладка
export const openExternal = (url: string): void => {
  if (isInTelegram && tg!.openLink) tg!.openLink(url);
  else window.open(url, '_blank');
};
export const contactPhone = (phone: string): void => openExternal(`tel:${phone.replace(/\s/g, '')}`);
export const contactInstagram = (handle: string): void => openExternal(`https://instagram.com/${handle}`);
