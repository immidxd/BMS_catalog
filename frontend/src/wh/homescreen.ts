// Швидкий доступ до Mini App без чату з ботом: ярлик на екрані «Домівка»
// (Bot API 8.0: addToHomeScreen — Telegram сам робить іконку, що відкриває
// t.me/<бот>?startapp) і пряме посилання для працівників.
// Працює лише коли в BotFather для бота увімкнено «Main Mini App» з URL /wh.
import { isInTelegram, tg } from '../telegram';

type HomeStatus = 'unsupported' | 'unknown' | 'added' | 'missed';
const app = tg as unknown as {
  isVersionAtLeast?: (v: string) => boolean;
  addToHomeScreen?: () => void;
  checkHomeScreenStatus?: (cb: (status: HomeStatus) => void) => void;
  onEvent?: (event: string, cb: () => void) => void;
} | undefined;

export const canAddToHome = (): boolean =>
  Boolean(isInTelegram && typeof app?.addToHomeScreen === 'function'
    && (!app?.isVersionAtLeast || app.isVersionAtLeast('8.0')));

export function homeScreenStatus(cb: (s: HomeStatus) => void): void {
  if (!canAddToHome() || typeof app?.checkHomeScreenStatus !== 'function') { cb('unsupported'); return; }
  try { app.checkHomeScreenStatus(cb); } catch { cb('unknown'); }
}

export function addToHome(onAdded: () => void): void {
  app?.onEvent?.('homeScreenAdded', onAdded);
  app?.addToHomeScreen?.();
}

// Пряме посилання: відкриває застосунок одразу, без кнопки меню в чаті.
export const appLink = (botUsername: string): string => `https://t.me/${botUsername}?startapp`;

export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch { return false; }
  }
}
