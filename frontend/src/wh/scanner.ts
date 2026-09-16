// Сканер QR: нативний попап Telegram (showScanQrPopup, Bot API 6.4+).
// Поза Telegram (розробка в браузері) — просте вікно вводу коду.
//
// Режими:
//   scanOnce()          — один код, попап закривається сам;
//   scanMany(onCode)    — попап лишається відкритим, кожен новий код → onCode;
//                         той самий код у межах 2.5 с ігнорується (Telegram
//                         сипле подіями, доки камера дивиться на QR).
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
    if (app?.showConfirm) app.showConfirm(message, ok => resolve(Boolean(ok)));
    else resolve(window.confirm(message));
  });
}

/** Один скан. null — людина закрила попап. */
export function scanOnce(hint = 'Наведіть на QR стікера або коробки'): Promise<string | null> {
  if (!canScan()) {
    const v = window.prompt(`${hint}\n(поза Telegram — введіть код вручну, напр. bms:p:123:#Ф1 або bms:b:Z9)`);
    return Promise.resolve(v ? v.trim() : null);
  }
  return new Promise(resolve => {
    let done = false;
    const onClosed = () => { if (!done) { done = true; resolve(null); } tg?.onEvent && offClosed(); };
    const offClosed = () => { (tg as any).offEvent?.('scanQrPopupClosed', onClosed); };
    (tg as any).onEvent?.('scanQrPopupClosed', onClosed);
    app!.showScanQrPopup!({ text: hint }, (text: string) => {
      if (done) return true;
      done = true;
      offClosed();
      resolve((text || '').trim());
      return true; // закрити попап
    });
  });
}

/**
 * Серія сканів (сесія коробки). onCode повертає true, щоб зупинити серію.
 * Повертає функцію примусової зупинки.
 */
export function scanMany(hint: string, onCode: (code: string) => Promise<boolean | void> | boolean | void,
                         onClosed?: () => void): () => void {
  if (!canScan()) {
    // Розробка: цикл prompt-ів, порожній ввід = стоп.
    void (async () => {
      for (;;) {
        const v = window.prompt(`${hint}\n(порожньо — завершити)`);
        if (!v) break;
        if (await onCode(v.trim())) break;
      }
      onClosed?.();
    })();
    return () => {};
  }
  let last = '';
  let lastAt = 0;
  let stopped = false;
  let busy = false;
  const closed = () => { if (!stopped) { stopped = true; onClosed?.(); } (tg as any).offEvent?.('scanQrPopupClosed', closed); };
  (tg as any).onEvent?.('scanQrPopupClosed', closed);
  app!.showScanQrPopup!({ text: hint }, (text: string) => {
    if (stopped) return true;
    const code = (text || '').trim();
    const now = Date.now();
    if (!code || busy || (code === last && now - lastAt < 2500)) return false;
    last = code; lastAt = now; busy = true;
    Promise.resolve(onCode(code)).then(stop => {
      busy = false;
      if (stop) { stopped = true; app!.closeScanQrPopup?.(); }
    }).catch(() => { busy = false; });
    return false; // не закривати — наступний скан
  });
  return () => { stopped = true; app!.closeScanQrPopup?.(); };
}
