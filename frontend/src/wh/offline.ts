// Робота без мережі: локальна копія складу + черга дій.
//
// Що це дає. Поки застосунок відкритий, обрив мережі (підвал, край
// покриття) його не зупиняє: «де лежить», картки товарів і вміст коробок
// читаються з копії, а запакувати / вийняти / нова коробка / запечатати
// лягають у чергу й виконуються, щойно мережа зʼявиться — по порядку, з тим
// самим op_id (сервер не застосовує повтор двічі).
//
// Чого це НЕ дає, свідомо: друк, правка ціни/стану, видалення коробки і
// «розпакувати все» — лише онлайн. Перше виконує BMS на компʼютері, решта
// надто необоротні, щоб робити їх «наосліп».
//
// Запобіжники:
//  • у чергу потрапляє лише те, що впало через МЕРЕЖУ (isNetworkError), а не
//    відмова сервера;
//  • після ВІДМОВИ сервера на синхронізації черга ЗУПИНЯЄТЬСЯ — людина бачить
//    «розібрати» і вирішує (повторити / перенести / прибрати); далі нічого не
//    йде «наосліп», бо наступні дії могли залежати від цієї;
//  • копія і черга — у localStorage телефона; черга переживає закриття
//    застосунку.
import { useSyncExternalStore } from 'react';
import { api, isNetworkError, type Box, type BoxItem, type Location, type Product } from './api';

export type OpKind = 'pack' | 'unpackFrom' | 'unpack' | 'createBox' | 'seal' | 'open' | 'check' | 'patchBox';
export type Op = {
  id: string; kind: OpKind; at: number; label: string; status: 'pending' | 'failed';
  args: Record<string, any>; error?: string; errorCode?: string;
};
type Cache = {
  boxes: Box[];                                   // без вмісту (список)
  contents: Record<string, BoxItem[]>;            // код → вміст (що бачили)
  products: Record<number, Product>;              // id → картка (що бачили)
  savedAt: number;
};

const QUEUE_KEY = 'bmswh-queue';
const CACHE_KEY = 'bmswh-cache';
const MAX_PRODUCTS = 600;

const load = <T,>(key: string, fallback: T): T => {
  try { const raw = localStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
};
const save = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* повно/приватний режим */ } };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

let cache: Cache = load<Cache>(CACHE_KEY, { boxes: [], contents: {}, products: {}, savedAt: 0 });
let queue: Op[] = load<Op[]>(QUEUE_KEY, []);
let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
let syncing = false;
const listeners = new Set<() => void>();
let syncedListeners: Array<(done: Op[]) => void> = [];
const emit = () => listeners.forEach(fn => { try { fn(); } catch { /* ignore */ } });
const persist = () => { save(CACHE_KEY, cache); save(QUEUE_KEY, queue); emit(); };

/* ───────────────────────────── Копія ─────────────────────────────────────── */

const touch = () => { cache = { ...cache, savedAt: Date.now() }; };

export const remember = {
  boxes(list: Box[]) {
    const known = new Map(cache.boxes.map(b => [b.code, b]));
    for (const b of list) known.set(b.code, { ...known.get(b.code), ...b, contents: undefined });
    cache.boxes = Array.from(known.values()).filter(b => list.some(x => x.code === b.code) || b.id < 0);
    touch(); persist();
  },
  box(b: Box) {
    const i = cache.boxes.findIndex(x => x.code === b.code);
    const summary = { ...b, contents: undefined };
    if (i >= 0) cache.boxes[i] = summary; else cache.boxes.unshift(summary);
    if (b.contents) { cache.contents[b.code] = b.contents; for (const it of b.contents) remember.product(it.product, false); }
    touch(); persist();
  },
  product(p: Product, doPersist = true) {
    if (!p || typeof p.id !== 'number') return;
    cache.products[p.id] = p;
    const ids = Object.keys(cache.products);
    if (ids.length > MAX_PRODUCTS) for (const id of ids.slice(0, ids.length - MAX_PRODUCTS)) delete cache.products[Number(id)];
    if (doPersist) { touch(); persist(); }
  },
  products(list: Product[]) { for (const p of list) remember.product(p, false); touch(); persist(); },
};

export const cached = {
  boxes: (): Box[] => cache.boxes,
  box: (code: string): Box | null => {
    const b = cache.boxes.find(x => x.code === code.toUpperCase());
    return b ? { ...b, contents: cache.contents[b.code] || [] } : null;
  },
  product: (id: number): Product | null => cache.products[id] || null,
  byNumber: (number: string): Product[] => {
    const n = number.trim().replace(/^#/, '').toUpperCase();
    return Object.values(cache.products).filter(p => (p.number || '').toUpperCase() === n || (p.productnumber || '').replace(/^#/, '').toUpperCase() === n);
  },
  savedAt: () => cache.savedAt,
  hasAnything: () => cache.boxes.length > 0 || Object.keys(cache.products).length > 0,
};

/** Розібрати QR без сервера: bms:p:<id>:<номер> → товар з копії (або
 *  мінімальна картка з номером), bms:b:<код> → коробка з копії. */
export function parseCodeOffline(raw: string): { kind: 'product'; product: Product } | { kind: 'box'; box: Box } | null {
  const s = (raw || '').trim();
  if (s.startsWith('bms:p:')) {
    const [idStr, ...rest] = s.slice(6).split(':');
    const id = Number(idStr); const number = rest.join(':');
    if (!Number.isFinite(id)) return null;
    const p = cache.products[id] || {
      id, productnumber: number ? `#${number}` : '', number, size: '', insole: '', brand: null, model: null, type: null,
      color: null, gender: null, season: null, condition: null, price: null, oldprice: null, quantity: 1, sold_count: 0,
      available_qty: 1, image: null, locations: [], missing: false,
    };
    return { kind: 'product', product: p };
  }
  if (s.startsWith('bms:b:')) {
    const b = cached.box(s.slice(6));
    return b ? { kind: 'box', box: b } : null;
  }
  return null;
}

/* ───────────────────────────── Локальне застосування ─────────────────────── */

const locOf = (b: Box, qty: number): Location => ({
  box_code: b.code, box_title: b.title, box_location: b.location, box_status: b.status,
  needs_check: b.needs_check, qty, packed_at: new Date().toISOString(),
});
const bumpBox = (code: string, dItems: number, dUnits: number, dValue: number) => {
  const b = cache.boxes.find(x => x.code === code);
  if (!b) return;
  b.items = Math.max(0, b.items + dItems); b.units = Math.max(0, b.units + dUnits); b.value = Math.max(0, b.value + dValue);
  if (b.status === 'sealed' && (dItems !== 0 || dUnits !== 0)) b.status = 'open';   // клали/виймали — відкрили
};

function removeFromBox(code: string, productId: number, qty: number | null): number {
  const items = cache.contents[code] || [];
  const it = items.find(x => x.product_id === productId);
  if (!it) return 0;
  const take = qty == null ? it.qty : Math.min(qty, it.qty);
  if (take >= it.qty) cache.contents[code] = items.filter(x => x !== it); else it.qty -= take;
  bumpBox(code, take >= it.qty ? -1 : 0, -take, -take * (it.product.price || 0));
  const p = cache.products[productId];
  if (p) {
    p.locations = (p.locations || []).map(l => (l.box_code === code ? { ...l, qty: l.qty - take } : l)).filter(l => l.qty > 0);
  }
  return take;
}

function applyLocal(op: Op): void {
  const a = op.args;
  if (op.kind === 'pack') {
    const product: Product = a.product;
    const box = cache.boxes.find(b => b.code === a.code);
    if (!box) return;
    if (a.move) for (const l of product.locations || []) if (l.box_code !== a.code) removeFromBox(l.box_code, product.id, null);
    const items = cache.contents[a.code] || (cache.contents[a.code] = []);
    const it = items.find(x => x.product_id === product.id);
    if (it) it.qty += a.qty;
    else items.unshift({ item_id: -Date.now(), product_id: product.id, qty: a.qty, packed_at: new Date().toISOString(), packed_by: null, product });
    bumpBox(a.code, it ? 0 : 1, a.qty, a.qty * (product.price || 0));
    const p = cache.products[product.id] || (cache.products[product.id] = product);
    const cur = (p.locations || []).find(l => l.box_code === a.code);
    if (cur) cur.qty += a.qty; else p.locations = [...(a.move ? [] : p.locations || []), locOf(box, a.qty)];
  } else if (op.kind === 'unpackFrom') {
    removeFromBox(a.code, a.product_id, a.qty ?? null);
  } else if (op.kind === 'unpack') {
    const p = cache.products[a.product_id];
    for (const l of p?.locations || []) removeFromBox(l.box_code, a.product_id, a.qty ?? null);
  } else if (op.kind === 'createBox') {
    if (!cache.boxes.some(b => b.code === a.code)) {
      cache.boxes.unshift({
        id: -Date.now(), code: a.code, category: a.category || null, title: a.title || null, location: a.location || null,
        status: 'open', needs_check: false, note: null, items: 0, units: 0, value: 0,
        created_at: new Date().toISOString(), sealed_at: null, checked_at: null,
      });
      cache.contents[a.code] = [];
    }
  } else if (op.kind === 'seal' || op.kind === 'open' || op.kind === 'check' || op.kind === 'patchBox') {
    const b = cache.boxes.find(x => x.code === a.code);
    if (!b) return;
    if (op.kind === 'seal') { b.status = 'sealed'; b.sealed_at = new Date().toISOString(); }
    if (op.kind === 'open') b.status = 'open';
    if (op.kind === 'check') { b.needs_check = false; b.checked_at = new Date().toISOString(); }
    if (op.kind === 'patchBox') Object.assign(b, a.patch);
  }
  touch();
}

/* ───────────────────────────── Черга ─────────────────────────────────────── */

export function enqueue(kind: OpKind, args: Record<string, any>, label: string): Op {
  const op: Op = { id: uuid(), kind, at: Date.now(), label, status: 'pending', args };
  queue = [...queue, op];
  applyLocal(op);
  persist();
  void sync();
  return op;
}

async function execute(op: Op): Promise<void> {
  const a = op.args;
  switch (op.kind) {
    case 'pack': await api.pack(a.code, a.product.id, a.qty, !!a.move, op.id); return;
    case 'unpackFrom': await api.unpackFrom(a.code, a.product_id, a.qty ?? undefined, op.id); return;
    case 'unpack': await api.unpack(a.product_id, a.qty ?? undefined, op.id); return;
    case 'createBox': await api.createBox({ code: a.code, category: a.category, title: a.title, location: a.location }, op.id); return;
    case 'seal': await api.seal(a.code, op.id); return;
    case 'open': await api.open(a.code, op.id); return;
    case 'check': await api.check(a.code, op.id); return;
    case 'patchBox': await api.patchBox(a.code, a.patch, op.id); return;
  }
}

/** Пройти чергу по порядку. Мережа впала — зупиняємось тихо (спробуємо ще);
 *  сервер відмовив — дія стає failed і черга СТОЇТЬ, поки людина не вирішить. */
export async function sync(): Promise<void> {
  if (syncing || !online) return;
  const first = queue.find(o => o.status === 'pending');
  if (!first || queue.some(o => o.status === 'failed')) return;
  syncing = true; emit();
  const done: Op[] = [];
  try {
    while (true) {
      const op = queue.find(o => o.status === 'pending');
      if (!op || queue.some(o => o.status === 'failed')) break;
      try {
        await execute(op);
        queue = queue.filter(o => o.id !== op.id);
        done.push(op);
        persist();
      } catch (e) {
        if (isNetworkError(e)) { setOnline(false); break; }
        const detail = (e as any)?.detail;
        op.status = 'failed';
        op.error = typeof detail === 'string' ? detail : detail?.message || (e as any)?.message || 'Сервер відмовив';
        op.errorCode = detail?.code;
        persist();
        break;
      }
    }
  } finally {
    syncing = false; emit();
    if (done.length) for (const fn of syncedListeners) { try { fn(done); } catch { /* ignore */ } }
  }
}

export function retry(id: string, patchArgs?: Record<string, any>): void {
  const op = queue.find(o => o.id === id);
  if (!op) return;
  op.status = 'pending'; op.error = undefined; op.errorCode = undefined;
  if (patchArgs) op.args = { ...op.args, ...patchArgs };
  persist(); void sync();
}
export function discard(id: string): void {
  queue = queue.filter(o => o.id !== id);
  persist(); void sync();
}
export function onSynced(fn: (done: Op[]) => void): () => void {
  syncedListeners.push(fn);
  return () => { syncedListeners = syncedListeners.filter(f => f !== fn); };
}

/* ───────────────────────────── Стан мережі ───────────────────────────────── */

export function setOnline(v: boolean): void {
  if (online === v) return;
  online = v; emit();
  if (v) void sync();
}
/** Успішна відповідь сервера — значить мережа є, навіть якщо navigator.onLine бреше. */
export function noteOnline(): void { setOnline(true); }

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync(); });
  // Поки в черзі щось є — пробуємо кожні 15 с (navigator.onLine у вебвʼю ненадійний).
  setInterval(() => { if (queue.some(o => o.status === 'pending')) { if (!online && navigator.onLine !== false) setOnline(true); void sync(); } }, 15000);
  // Застосунок відкрили знову з непорожньою чергою — досилаємо одразу.
  setTimeout(() => { void sync(); }, 500);
}

/* ───────────────────────────── React ─────────────────────────────────────── */

type Snapshot = { online: boolean; syncing: boolean; pending: number; failed: Op[]; queue: Op[]; savedAt: number };
let snap: Snapshot = { online, syncing, pending: 0, failed: [], queue, savedAt: cache.savedAt };
const compute = (): Snapshot => {
  const next = { online, syncing, pending: queue.filter(o => o.status === 'pending').length, failed: queue.filter(o => o.status === 'failed'), queue, savedAt: cache.savedAt };
  if (next.online !== snap.online || next.syncing !== snap.syncing || next.pending !== snap.pending || next.queue !== snap.queue || next.savedAt !== snap.savedAt) snap = next;
  return snap;
};
export function useOffline(): Snapshot {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, compute, compute);
}

/** Виконати онлайн, а без мережі — покласти в чергу (для дій, що це дозволяють). */
export async function runOrQueue<T>(
  online_: () => Promise<T>, fallback: { kind: OpKind; args: Record<string, any>; label: string },
): Promise<{ result: T | null; queued: Op | null }> {
  try {
    const result = await online_();
    noteOnline();
    return { result, queued: null };
  } catch (e) {
    if (!isNetworkError(e)) throw e;
    setOnline(false);
    return { result: null, queued: enqueue(fallback.kind, fallback.args, fallback.label) };
  }
}
