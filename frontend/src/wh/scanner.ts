// Сканер QR: нативний попап Telegram (showScanQrPopup, Bot API 6.4+).
// Поза Telegram (розробка в браузері) — просте вікно вводу коду.
//
// Лише режим «один скан»: попап перекриває сторінку цілком, тож серія сканів
// у ньому лишала б людину без жодного зворотного звʼязку. Серію робить
// екран сесії пакування: скан → картка результату → знову камера.
import { tg, isInTelegram } from '../telegram';

type ScanQr = {
  showScanQrPopup?: (params: { text?: string }, cb?: (text: string) => boolean | void) => void;
  closeScanQrPopup?: () => void;
  HapticFeedback?: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
  isVersionAtLeast?: (v: string) => boolean;
  showConfirm?: (message: string, cb?: (ok: boolean) => void) => void;
  showAlert?: (message: string, cb?: () => void) => void;
};

const app = tg as unknown as ScanQr | undefined;

export const canScan = (): boolean =>
  Boolean(isInTelegram && app?.showScanQrPopup && (!app.isVersionAtLeast || app.isVersionAtLeast('6.4')));

export const haptic = {
  ok: () => app?.HapticFeedback?.notificationOccurred('success'),
  warn: () => app?.HapticFeedback?.notificationOccurred('warning'),
  err: () => app?.HapticFeedback?.notificationOccurred('error'),
  tap: () => app?.HapticFeedback?.impactOccurred('light'),
};

export function confirmDialog(message: string): Promise<boolean> {
  return new Promise(resolve => {
    const native = isInTelegram && app?.showConfirm && (!app.isVersionAtLeast || app.isVersionAtLeast('6.2'));
    if (native) app!.showConfirm!(message, ok => resolve(Boolean(ok)));
    else resolve(window.confirm(message));
  });
}

/** Закрити попап сканера, якщо він є (клієнт без підтримки — тихо нічого). */
export function closeScan(): void {
  if (!canScan()) return;
  try { app!.closeScanQrPopup?.(); } catch { /* немає попапу або метод не підтримується */ }
}

/** Один скан. null — людина закрила попап. */
export function scanOnce(hint = 'Наведіть на QR стікера або коробки'): Promise<string | null> {
  if (!canScan()) {
    const v = window.prompt(`${hint}\n(поза Telegram — введіть код вручну, напр. bms:p:123:#Ф1 або bms:b:Z9)`);
    return Promise.resolve(v ? v.trim() : null);
  }
  return new Promise(resolve => {
    let done = false;
    const openedAt = Date.now();
    const offClosed = () => { (tg as any).offEvent?.('scanQrPopupClosed', onClosed); };
    const onClosed = () => {
      // Подія «закрито» від ПОПЕРЕДНЬОГО попапу може прилетіти вже після
      // відкриття наступного — людина фізично не закриє новий за 300 мс.
      if (done || Date.now() - openedAt < 300) return;
      done = true; offClosed(); resolve(null);
    };
    (tg as any).onEvent?.('scanQrPopupClosed', onClosed);
    app!.showScanQrPopup!({ text: hint.slice(0, 64) }, (text: string) => {
      if (done) return true;
      done = true;
      offClosed();
      resolve((text || '').trim());
      return true; // закрити попап
    });
  });
}
