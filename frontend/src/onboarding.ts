// Підказки для новачків (і тих, хто давно не заходив). Кожна показується ОДИН раз на
// пристрої — коли людина вперше потрапляє в ту частину каталогу; знову — лише якщо
// вона не заходила понад LONG_ABSENCE_DAYS. Лише localStorage: жодних запитів на
// сервер, тож бюджет хмари не зачіпається. Немає сховища (приватний режим) —
// підказка просто може показатися ще раз, нічого не ламається.

const KEY = 'bms-catalog-onboarding-v1';
const LONG_ABSENCE_DAYS = 30;

type State = { lastVisit?: number; seen?: Record<string, number> };

const read = (): State => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}') as State; } catch { return {}; }
};
const write = (s: State): void => {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* сховище недоступне */ }
};

// Один раз на відкриття застосунку: давно не заходив — усі підказки знову «нові».
// ?hints у адресі — показати підказки ще раз (для перевірки власником).
const state = read();
const now = Date.now();
if (state.lastVisit && now - state.lastVisit > LONG_ABSENCE_DAYS * 86_400_000) state.seen = {};
if (new URLSearchParams(window.location.search).has('hints')) state.seen = {};
state.lastVisit = now;
write(state);

export const hintSeen = (key: string): boolean => !!state.seen?.[key];

export const markHintSeen = (key: string): void => {
  if (hintSeen(key)) return;
  state.seen = { ...state.seen, [key]: Date.now() };
  write(state);
};

// Жестові підказки — лише для сенсорних екранів: на комп'ютері гортають стрілками
export const touchUi = (): boolean => window.matchMedia?.('(hover: none) and (pointer: coarse)').matches ?? false;
