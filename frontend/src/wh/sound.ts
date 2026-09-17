// Звук і вібрація — щоб на складі орієнтуватись не лише очима.
//
// Звуки короткі й різні за змістом (WebAudio, без файлів):
//   scan  — «пік» сканера: код упізнано;
//   ok    — дві висхідні ноти: покладено / створено / збережено;
//   out   — спадна нота: вийнято / відкрито (щось «вийшло» з коробки);
//   warn  — дві середні ноти: увага, дію відкладено (офлайн) або продано;
//   err   — низький довший гул: не вдалося.
// Вібрація — через Telegram HapticFeedback: легка на скан, «success/warning/
// error» на результат, ВАЖКИЙ удар на необоротне (розформувати, видалити,
// відкрити запечатану).
//
// iOS дозволяє звук лише після жесту користувача — контекст створюється на
// першому тапі й далі живе. Вимикач — у шапці головного екрана, зберігається.
import { tg } from '../telegram';

const KEY = 'bmswh-sound';
let enabled = (() => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } })();
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  try {
    const AC = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    if (!ctx) ctx = new AC();
    if (ctx!.state === 'suspended') void ctx!.resume();
    return ctx;
  } catch { return null; }
}
// Розбудити контекст першим жестом — інакше iOS мовчить.
if (typeof document !== 'undefined') {
  const wake = () => { context(); };
  document.addEventListener('touchstart', wake, { passive: true, capture: true });
  document.addEventListener('click', wake, { capture: true });
}

type Note = { f: number; t: number; d: number; type?: OscillatorType; g?: number };
function play(notes: Note[]) {
  if (!enabled) return;
  const c = context();
  if (!c) return;
  const now = c.currentTime;
  for (const n of notes) {
    const o = c.createOscillator(); const g = c.createGain();
    o.type = n.type || 'sine'; o.frequency.value = n.f;
    const start = now + n.t, end = start + n.d, vol = n.g ?? 0.18;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    o.connect(g); g.connect(c.destination);
    o.start(start); o.stop(end + 0.02);
  }
}

const h = () => (tg as any)?.HapticFeedback as
  | { impactOccurred: (s: string) => void; notificationOccurred: (t: string) => void } | undefined;

export const sound = {
  enabled: () => enabled,
  setEnabled(v: boolean) { enabled = v; try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* ignore */ } if (v) sound.scan(); },
  scan:  () => play([{ f: 1760, t: 0, d: 0.07, type: 'square', g: 0.08 }]),
  ok:    () => play([{ f: 880, t: 0, d: 0.08 }, { f: 1320, t: 0.09, d: 0.12 }]),
  out:   () => play([{ f: 660, t: 0, d: 0.16 }, { f: 440, t: 0.14, d: 0.16 }]),
  warn:  () => play([{ f: 620, t: 0, d: 0.1 }, { f: 620, t: 0.16, d: 0.1 }]),
  err:   () => play([{ f: 180, t: 0, d: 0.3, type: 'sawtooth', g: 0.1 }]),
};

export const buzz = {
  scan:  () => h()?.impactOccurred('light'),
  ok:    () => h()?.notificationOccurred('success'),
  warn:  () => h()?.notificationOccurred('warning'),
  err:   () => h()?.notificationOccurred('error'),
  /** Необоротне: розформувати, видалити, вийняти, відкрити запечатану. */
  heavy: () => { h()?.impactOccurred('heavy'); setTimeout(() => h()?.impactOccurred('heavy'), 120); },
};
