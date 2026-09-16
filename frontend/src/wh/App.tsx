// BMS Склад — Mini App для працівників: скан стікера/коробки, запакувати,
// вийняти, перемістити, коробки, пошук «де лежить».
//
// Принцип: кожна дія = 1 скан + 1 великий тап. «Сесія коробки» — відсканував
// коробку раз, далі скануєш товари поспіль (попап не закривається).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, hasAuth, type Box, type Product, type ScanResult, type WhEvent, type WhoAmI } from './api';
import { canScan, confirmDialog, haptic, scanMany, scanOnce } from './scanner';
import { tg, isInTelegram } from '../telegram';

type View =
  | { name: 'home' }
  | { name: 'product'; product: Product }
  | { name: 'choose'; products: Product[]; stale?: boolean }
  | { name: 'box'; box: Box }
  | { name: 'boxes' }
  | { name: 'session'; box: Box }
  | { name: 'newBox'; then?: 'session' | 'pick'; product?: Product; qty?: number };

type Toast = { kind: 'ok' | 'warn' | 'err'; text: string; id: number };

const CATEGORIES: { letter: string; label: string }[] = [
  { letter: 'Z', label: 'Зима' }, { letter: 'D', label: 'Демі' }, { letter: 'L', label: 'Літо' },
  { letter: 'T', label: 'Трекінг' }, { letter: 'V', label: 'Весна' }, { letter: 'O', label: 'Одяг' },
];

const money = (v: number | null | undefined) =>
  v == null ? '' : `${Math.round(v).toLocaleString('uk-UA')} ₴`;
const when = (iso: string) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString('uk-UA')} ${d.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`;
};
const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (typeof e.detail === 'string' ? e.detail : (e.detail as any)?.message || e.message) : (e as any)?.message || fallback;

export function App() {
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  const view = stack[stack.length - 1];
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const toastId = useRef(0);

  // Самодіагностика доступу: замість глухого «Немає доступу» — хто ти і чого
  // бракує на сервері (id для білого списку, токен бота).
  useEffect(() => { api.whoami().then(setWho).catch(() => setWho(null)); }, []);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { kind, text, id }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 4500 : 2500);
    if (kind === 'ok') haptic.ok(); else if (kind === 'warn') haptic.warn(); else haptic.err();
  }, []);

  const push = useCallback((v: View) => setStack(s => [...s, v]), []);
  const replace = useCallback((v: View) => setStack(s => [...s.slice(0, -1), v]), []);
  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack([{ name: 'home' }]), []);

  // Кнопка «Назад» Telegram = наш стек.
  useEffect(() => {
    const app = tg;
    if (!app) return;
    if (stack.length > 1) app.BackButton.show(); else app.BackButton.hide();
    app.BackButton.onClick(back);
    return () => app.BackButton.offClick(back);
  }, [stack.length, back]);

  // ── Маршрутизація результату скану ──────────────────────────────────────
  const openScan = useCallback((r: ScanResult) => {
    if (r.kind === 'product') push({ name: 'product', product: r.product });
    else if (r.kind === 'box') push({ name: 'box', box: r.box });
    else if (r.products.length === 1) push({ name: 'product', product: r.products[0] });
    else push({ name: 'choose', products: r.products, stale: r.stale_sticker });
  }, [push]);

  const doScan = useCallback(async () => {
    const code = await scanOnce();
    if (!code) return;
    setBusy(true);
    try { openScan(await api.scan(code)); haptic.tap(); }
    catch (e) { toast('err', errText(e, 'Не впізнав код')); }
    finally { setBusy(false); }
  }, [openScan, toast]);

  const doSearch = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const r = await api.search(text);
      if (r.products.length === 0) toast('warn', `Номер «${text}» не знайдено`);
      else openScan({ kind: 'products', products: r.products });
    } catch (e) { toast('err', errText(e, 'Пошук не вдався')); }
    finally { setBusy(false); }
  }, [openScan, toast]);

  // ── Пакування ───────────────────────────────────────────────────────────
  const packInto = useCallback(async (box: Box | string, product: Product, qty: number): Promise<Product | null> => {
    const code = typeof box === 'string' ? box : box.code;
    try {
      const r = await api.pack(code, product.id, qty);
      toast('ok', r.moved_from.length ? `${product.number} → ${code} (з ${r.moved_from.join(', ')})` : `${product.number} → ${code}`);
      if (r.warning) toast('warn', r.warning);
      return r.product;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.detail as any)?.code === 'elsewhere') {
        const d = e.detail as { message: string; locations: { box_code: string; qty: number }[] };
        haptic.warn();
        const ok = await confirmDialog(`${d.message}. Перенести в ${code}?`);
        if (!ok) return null;
        try {
          const r = await api.pack(code, product.id, qty, true);
          toast('ok', `${product.number}: ${r.moved_from.join(', ')} → ${code}`);
          return r.product;
        } catch (e2) { toast('err', errText(e2, 'Не вдалося перенести')); return null; }
      }
      toast('err', errText(e, 'Не вдалося запакувати'));
      return null;
    }
  }, [toast]);

  const refreshBox = useCallback(async (code: string) => {
    try { const b = await api.box(code); replace({ name: 'box', box: b }); } catch { /* ignore */ }
  }, [replace]);

  // ── Екрани ──────────────────────────────────────────────────────────────
  return (
    <div className="wh">
      {!hasAuth() && (
        <div className="wh-banner err">Немає доступу: відкрийте застосунок із Telegram (бот «BMS Склад»).</div>
      )}
      {who && !who.access && (
        <div className="wh-banner warn" style={{ display: 'block' }}>
          <div><b>Немає доступу до складу.</b>{who.user_id ? ` Ваш Telegram id: ${who.user_id}${who.name ? ` (${who.name})` : ''}.` : ''}</div>
          {who.problems.map((p, i) => <div key={i} style={{ fontWeight: 400, marginTop: 4 }}>• {p}</div>)}
        </div>
      )}
      {view.name === 'home' && (
        <Home busy={busy} onScan={doScan} onSearch={doSearch} onBoxes={() => push({ name: 'boxes' })} />
      )}
      {view.name === 'choose' && (
        <Choose products={view.products} stale={view.stale} onPick={p => push({ name: 'product', product: p })} />
      )}
      {view.name === 'product' && (
        <ProductScreen
          product={view.product}
          busy={busy}
          onRefresh={async () => { try { replace({ name: 'product', product: await api.product(view.product.id) }); } catch { /* ignore */ } }}
          onPack={async (qty) => {
            // Куди: сканувати коробку, або вибрати зі списку, або нова.
            const code = await scanOnce('Наведіть на QR коробки');
            if (code === null) return;
            const parsed = code.startsWith('bms:b:') ? code.slice(6).toUpperCase() : code.toUpperCase();
            setBusy(true);
            const p = await packInto(parsed, view.product, qty);
            setBusy(false);
            if (p) replace({ name: 'product', product: p });
          }}
          onNewBox={(qty) => push({ name: 'newBox', then: 'pick', product: view.product, qty })}
          onUnpack={async (boxCode, qty) => {
            setBusy(true);
            try { await api.unpackFrom(boxCode, view.product.id, qty); toast('ok', `${view.product.number} вийнято з ${boxCode}`);
              replace({ name: 'product', product: await api.product(view.product.id) }); }
            catch (e) { toast('err', errText(e, 'Не вдалося вийняти')); }
            finally { setBusy(false); }
          }}
          pickBox={async () => (await api.boxes()).boxes.filter(b => b.status !== 'archived')}
          packTo={async (code, qty) => {
            setBusy(true);
            const p = await packInto(code, view.product, qty);
            setBusy(false);
            if (p) replace({ name: 'product', product: p });
          }}
        />
      )}
      {view.name === 'box' && (
        <BoxScreen
          box={view.box}
          busy={busy}
          setBusy={setBusy}
          toast={toast}
          onRefresh={() => refreshBox(view.box.code)}
          onSession={() => push({ name: 'session', box: view.box })}
          onDeleted={() => home()}
          onOpenProduct={p => push({ name: 'product', product: p })}
        />
      )}
      {view.name === 'boxes' && (
        <BoxesScreen onOpen={b => push({ name: 'box', box: b })} onNew={() => push({ name: 'newBox', then: 'session' })} />
      )}
      {view.name === 'newBox' && (
        <NewBoxScreen
          onCreated={async (b) => {
            if (view.then === 'pick' && view.product) {
              const p = await packInto(b, view.product, view.qty || 1);
              setStack(s => {
                const base = s.slice(0, -1);
                // повертаємось на картку товару з оновленими даними
                const i = base.map(v => v.name).lastIndexOf('product');
                if (i >= 0 && p) base[i] = { name: 'product', product: p };
                return base;
              });
            } else {
              replace({ name: 'box', box: b });
            }
          }}
          toast={toast}
        />
      )}
      {view.name === 'session' && (
        <SessionScreen box={view.box} packInto={packInto} toast={toast} onDone={async () => { back(); await refreshBox(view.box.code); }} />
      )}

      <div className="wh-toasts">
        {toasts.map(t => <div key={t.id} className={`wh-toast ${t.kind}`}>{t.text}</div>)}
      </div>
      {busy && <div className="wh-busy" />}
    </div>
  );
}

/* ───────────────────────────── Головна ───────────────────────────────────── */

function Home({ busy, onScan, onSearch, onBoxes }: {
  busy: boolean; onScan: () => void; onSearch: (t: string) => void; onBoxes: () => void;
}) {
  const [q, setQ] = useState('');
  const [events, setEvents] = useState<WhEvent[]>([]);
  useEffect(() => { api.events({ limit: 12 }).then(r => setEvents(r.events)).catch(() => {}); }, []);
  return (
    <div className="wh-screen">
      <h1 className="wh-title">BMS Склад</h1>
      <button className="wh-btn primary huge" onClick={onScan} disabled={busy}>
        <span className="wh-ico">▣</span> Сканувати
      </button>
      {!canScan() && isInTelegram && <div className="wh-hint">Оновіть Telegram — сканер потребує версії 6.4+</div>}
      <form className="wh-search" onSubmit={e => { e.preventDefault(); onSearch(q); }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Номер товару, напр. Ф3153" inputMode="text" autoCapitalize="characters" />
        <button type="submit" className="wh-btn" disabled={busy || !q.trim()}>Знайти</button>
      </form>
      <button className="wh-btn wide" onClick={onBoxes}>Коробки</button>
      {events.length > 0 && (
        <div className="wh-section">
          <div className="wh-label">Останні дії</div>
          {events.map(e => <EventRow key={e.id} e={e} />)}
        </div>
      )}
    </div>
  );
}

const KIND_UA: Record<string, string> = {
  pack: 'запаковано', unpack: 'вийнято', move: 'перенесено', seal: 'запечатано', open: 'відкрито',
  check: 'звірено', box_create: 'коробку створено', box_delete: 'коробку видалено', box_edit: 'змінено',
};

function EventRow({ e }: { e: WhEvent }) {
  return (
    <div className="wh-event">
      <span className="wh-event-kind">{KIND_UA[e.kind] || e.kind}</span>
      <span className="wh-event-what">{e.productnumber ? e.productnumber.replace(/^#/, '') : ''}{e.qty && e.qty > 1 ? ` ×${e.qty}` : ''}{e.box_code ? ` · ${e.box_code}` : ''}</span>
      <span className="wh-event-when">{when(e.at)}{e.actor && !e.actor.startsWith('bms') ? ` · ${e.actor.replace(/^tg:\d+\s*/, '')}` : ''}</span>
    </div>
  );
}

/* ───────────────────────────── Вибір із ростовки ─────────────────────────── */

function Choose({ products, stale, onPick }: { products: Product[]; stale?: boolean; onPick: (p: Product) => void }) {
  return (
    <div className="wh-screen">
      {stale && <div className="wh-banner warn">Стікер посилається на зниклий запис — знайдено за номером. Оберіть потрібний розмір.</div>}
      <div className="wh-label">Який саме?</div>
      {products.map(p => (
        <button key={p.id} className="wh-row" onClick={() => onPick(p)}>
          {p.image ? <img src={p.image} alt="" className="wh-thumb" /> : <div className="wh-thumb empty" />}
          <div className="wh-row-main">
            <div className="wh-row-title">{p.number} <b>{p.size}</b></div>
            <div className="wh-row-sub">{[p.brand, p.model, p.color].filter(Boolean).join(' · ')}</div>
            <div className="wh-row-sub">{p.locations.length ? `У ${p.locations.map(l => l.box_code).join(', ')}` : 'не в коробці'}{p.available_qty <= 0 ? ' · ПРОДАНО' : ''}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

/* ───────────────────────────── Товар ─────────────────────────────────────── */

function ProductScreen({ product: p, busy, onPack, onUnpack, onNewBox, onRefresh, pickBox, packTo }: {
  product: Product; busy: boolean;
  onPack: (qty: number) => void;
  onNewBox: (qty: number) => void;
  onUnpack: (boxCode: string, qty?: number) => void;
  onRefresh: () => void;
  pickBox: () => Promise<Box[]>;
  packTo: (code: string, qty: number) => void;
}) {
  const sold = p.available_qty <= 0;
  const maxQty = Math.max(1, p.available_qty || p.quantity || 1);
  const [qty, setQty] = useState(1);
  const [picker, setPicker] = useState<Box[] | null>(null);
  useEffect(() => { setQty(1); setPicker(null); }, [p.id]);

  return (
    <div className="wh-screen">
      <div className="wh-product-head">
        {p.image ? <img src={p.image} alt="" className="wh-photo" /> : <div className="wh-photo empty">без фото</div>}
        <div className="wh-product-info">
          <div className="wh-number">{p.number}</div>
          <div className="wh-size">{p.size}{p.insole ? <span className="wh-insole"> · {p.insole} см</span> : null}</div>
          <div className="wh-sub">{[p.brand, p.model].filter(Boolean).join(' · ')}</div>
          <div className="wh-sub">{[p.type, p.color, p.season].filter(Boolean).join(' · ')}</div>
          <div className="wh-chips">
            {p.condition && <span className="wh-chip">{p.condition}</span>}
            {p.price != null && <span className="wh-chip">{money(p.price)}</span>}
            {p.quantity > 1 && <span className="wh-chip">наявно {p.available_qty} з {p.quantity}</span>}
          </div>
        </div>
      </div>

      {sold && <div className="wh-banner err">ПРОДАНО — не пакувати. Якщо пара в коробці — вийняти для відправки.</div>}

      <div className="wh-section">
        <div className="wh-label">Де лежить</div>
        {p.locations.length === 0 ? (
          <div className="wh-muted">Не в коробці</div>
        ) : p.locations.map(l => (
          <div key={l.box_code} className="wh-loc">
            <div className="wh-loc-main">
              <div className="wh-loc-code">{l.box_code}{l.qty > 1 ? <span className="wh-qty"> ×{l.qty}</span> : null}{l.needs_check ? <span className="wh-tag warn">перевірити</span> : null}{l.box_status === 'sealed' ? <span className="wh-tag">запечатана</span> : null}</div>
              <div className="wh-row-sub">{[l.box_title, l.box_location].filter(Boolean).join(' · ') || '—'}</div>
            </div>
            <button className="wh-btn small" disabled={busy} onClick={() => onUnpack(l.box_code, l.qty > 1 ? 1 : undefined)}>Вийняти{l.qty > 1 ? ' 1' : ''}</button>
          </div>
        ))}
      </div>

      {maxQty > 1 && (
        <div className="wh-section">
          <div className="wh-label">Скільки пар кладу</div>
          <div className="wh-qty-row">
            {Array.from({ length: Math.min(maxQty, 9) }, (_, i) => i + 1).map(n => (
              <button key={n} className={`wh-btn small ${qty === n ? 'primary' : ''}`} onClick={() => setQty(n)}>{n}</button>
            ))}
          </div>
        </div>
      )}

      {picker === null ? (
        <div className="wh-actions">
          <button className="wh-btn primary big" disabled={busy} onClick={() => onPack(qty)}>
            <span className="wh-ico">▣</span> Запакувати — сканувати коробку
          </button>
          <div className="wh-actions-row">
            <button className="wh-btn" disabled={busy} onClick={async () => setPicker(await pickBox())}>Вибрати коробку</button>
            <button className="wh-btn" disabled={busy} onClick={() => onNewBox(qty)}>Нова коробка</button>
          </div>
          <button className="wh-btn ghost" onClick={onRefresh}>Оновити</button>
        </div>
      ) : (
        <div className="wh-section">
          <div className="wh-label">У яку коробку</div>
          {picker.length === 0 && <div className="wh-muted">Коробок ще нема</div>}
          {picker.map(b => (
            <button key={b.id} className="wh-row" onClick={() => { setPicker(null); packTo(b.code, qty); }}>
              <div className="wh-row-main">
                <div className="wh-row-title">{b.code} {b.status === 'sealed' ? <span className="wh-tag">запечатана</span> : null}</div>
                <div className="wh-row-sub">{[b.title, b.location].filter(Boolean).join(' · ') || '—'} · {b.units} шт</div>
              </div>
            </button>
          ))}
          <button className="wh-btn ghost" onClick={() => setPicker(null)}>Скасувати</button>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Коробка ───────────────────────────────────── */

function BoxScreen({ box, busy, setBusy, toast, onRefresh, onSession, onDeleted, onOpenProduct }: {
  box: Box; busy: boolean; setBusy: (b: boolean) => void;
  toast: (k: Toast['kind'], t: string) => void;
  onRefresh: () => Promise<void>; onSession: () => void; onDeleted: () => void;
  onOpenProduct: (p: Product) => void;
}) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(box.title || '');
  const [loc, setLoc] = useState(box.location || '');
  useEffect(() => { setTitle(box.title || ''); setLoc(box.location || ''); setEdit(false); }, [box.code, box.title, box.location]);
  const contents = box.contents || [];

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast('ok', okMsg); await onRefresh(); }
    catch (e) { toast('err', errText(e, 'Не вдалося')); }
    finally { setBusy(false); }
  };

  return (
    <div className="wh-screen">
      <div className="wh-box-head">
        <div className="wh-number">{box.code}</div>
        <div className="wh-chips">
          <span className={`wh-chip ${box.status === 'sealed' ? 'dark' : ''}`}>{box.status === 'sealed' ? 'запечатана' : box.status === 'archived' ? 'видалена' : 'відкрита'}</span>
          <span className="wh-chip">{box.items} поз. · {box.units} шт</span>
          {box.value > 0 && <span className="wh-chip">{money(box.value)}</span>}
        </div>
        {!edit ? (
          <div className="wh-sub wh-tap" onClick={() => setEdit(true)}>{[box.title, box.location].filter(Boolean).join(' · ') || 'Без назви · натисніть, щоб додати'}</div>
        ) : (
          <div className="wh-form">
            <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Назва (що всередині)" />
            <input value={loc} onChange={e => setLoc(e.target.value)} placeholder="Де стоїть (стелаж, полиця)" />
            <div className="wh-actions-row">
              <button className="wh-btn primary" disabled={busy} onClick={() => run(() => api.patchBox(box.code, { title, location: loc }), 'Збережено')}>Зберегти</button>
              <button className="wh-btn" onClick={() => setEdit(false)}>Скасувати</button>
            </div>
          </div>
        )}
      </div>

      {box.needs_check && (
        <div className="wh-banner warn">
          Коробку треба перевірити (її відкривали або вміст імпортовано). Проскануйте вміст і натисніть «Звірено».
          <button className="wh-btn small" disabled={busy} onClick={() => run(() => api.check(box.code), 'Коробку звірено')}>Звірено</button>
        </div>
      )}

      <div className="wh-actions">
        <button className="wh-btn primary big" disabled={busy || box.status === 'archived'} onClick={onSession}>
          <span className="wh-ico">▣</span> Пакувати сюди (серія сканів)
        </button>
      </div>

      <div className="wh-section">
        <div className="wh-label">Вміст · {contents.length}</div>
        {contents.length === 0 && <div className="wh-muted">Порожня</div>}
        {contents.map(it => (
          <div key={it.item_id} className="wh-loc">
            <button className="wh-row-main wh-tap" onClick={() => onOpenProduct(it.product)}>
              <div className="wh-row-title">{it.product.number} <b>{it.product.size}</b>{it.qty > 1 ? <span className="wh-qty"> ×{it.qty}</span> : null}{it.product.missing ? <span className="wh-tag warn">запис зник</span> : null}{it.product.available_qty <= 0 && !it.product.missing ? <span className="wh-tag err">продано</span> : null}</div>
              <div className="wh-row-sub">{[it.product.brand, it.product.model, it.product.color].filter(Boolean).join(' · ')}</div>
            </button>
            <button className="wh-btn small" disabled={busy} onClick={() => run(() => api.unpackFrom(box.code, it.product_id, it.qty > 1 ? 1 : undefined), `${it.product.number} вийнято`)}>Вийняти{it.qty > 1 ? ' 1' : ''}</button>
          </div>
        ))}
      </div>

      <div className="wh-section wh-actions-row wrap">
        {box.status === 'sealed'
          ? <button className="wh-btn" disabled={busy} onClick={() => run(() => api.open(box.code), 'Коробку відкрито')}>Відкрити</button>
          : <button className="wh-btn" disabled={busy || box.status === 'archived'} onClick={() => run(() => api.seal(box.code), 'Запечатано')}>Запечатати</button>}
        <button className="wh-btn" disabled={busy || contents.length === 0} onClick={async () => {
          if (await confirmDialog(`Розпакувати всю коробку ${box.code} (${box.units} шт)?`)) await run(() => api.unpackAll(box.code), 'Коробку розпаковано');
        }}>Розпакувати все</button>
        <button className="wh-btn danger" disabled={busy || box.status === 'archived'} onClick={async () => {
          const withItems = contents.length > 0;
          const ok = await confirmDialog(withItems ? `У ${box.code} ще ${box.units} шт. Видалити коробку разом із вмістом (усе стане «без коробки»)?` : `Видалити коробку ${box.code}?`);
          if (!ok) return;
          setBusy(true);
          try { await api.deleteBox(box.code, withItems); toast('ok', `Коробку ${box.code} видалено`); onDeleted(); }
          catch (e) { toast('err', errText(e, 'Не вдалося видалити')); }
          finally { setBusy(false); }
        }}>Видалити</button>
      </div>
    </div>
  );
}

/* ───────────────────────────── Сесія пакування ───────────────────────────── */

function SessionScreen({ box, packInto, toast, onDone }: {
  box: Box; packInto: (box: Box, p: Product, qty: number) => Promise<Product | null>;
  toast: (k: Toast['kind'], t: string) => void; onDone: () => void;
}) {
  const [log, setLog] = useState<{ number: string; size: string; qty: number }[]>([]);
  const [scanning, setScanning] = useState(false);
  const stopRef = useRef<() => void>(() => {});
  const total = useMemo(() => log.reduce((s, l) => s + l.qty, 0), [log]);

  const start = () => {
    setScanning(true);
    stopRef.current = scanMany(`Пакую в ${box.code} · скануйте товари поспіль`, async (code) => {
      try {
        const r = await api.scan(code);
        if (r.kind === 'box') { toast('warn', `Це коробка ${r.box.code}, а не товар`); return false; }
        const p = r.kind === 'product' ? r.product : (r.products.length === 1 ? r.products[0] : null);
        if (!p) { toast('warn', 'Кілька товарів з таким номером — відкрийте його окремо'); return false; }
        if (p.available_qty <= 0) { toast('warn', `${p.number} ПРОДАНО — не кладу`); return false; }
        const done = await packInto(box, p, 1);
        if (done) setLog(l => [{ number: p.number, size: p.size, qty: 1 }, ...l]);
      } catch (e) { toast('err', errText(e, 'Не впізнав код')); }
      return false;
    }, () => setScanning(false));
  };
  useEffect(() => () => stopRef.current(), []);

  return (
    <div className="wh-screen">
      <div className="wh-session-head">
        <div className="wh-label">Пакую в</div>
        <div className="wh-number">{box.code}</div>
        <div className="wh-sub">{box.title || ''}</div>
        <div className="wh-counter">{total}</div>
        <div className="wh-label">за цю сесію</div>
      </div>
      <div className="wh-actions">
        <button className="wh-btn primary huge" onClick={start} disabled={scanning}>
          <span className="wh-ico">▣</span> {scanning ? 'Сканую…' : log.length ? 'Сканувати ще' : 'Сканувати товари'}
        </button>
        <button className="wh-btn wide" onClick={() => { stopRef.current(); onDone(); }}>Завершити</button>
      </div>
      {log.length > 0 && (
        <div className="wh-section">
          {log.map((l, i) => <div key={i} className="wh-event"><span className="wh-event-what">{l.number} {l.size}</span><span className="wh-event-when">✓</span></div>)}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────────── Коробки ───────────────────────────────────── */

function BoxesScreen({ onOpen, onNew }: { onOpen: (b: Box) => void; onNew: () => void }) {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { api.boxes().then(r => setBoxes(r.boxes)).catch(e => setErr(errText(e, 'Не вдалося завантажити'))); }, []);
  const open = async (b: Box) => { try { onOpen(await api.box(b.code)); } catch { onOpen(b); } };
  return (
    <div className="wh-screen">
      <button className="wh-btn primary wide" onClick={onNew}>＋ Нова коробка</button>
      {err && <div className="wh-banner err">{err}</div>}
      {boxes === null && !err && <div className="wh-muted">Завантаження…</div>}
      {boxes && boxes.length === 0 && <div className="wh-muted">Коробок ще нема</div>}
      {boxes && boxes.map(b => (
        <button key={b.id} className="wh-row" onClick={() => open(b)}>
          <div className="wh-box-code">{b.code}</div>
          <div className="wh-row-main">
            <div className="wh-row-title">{b.title || '—'}{b.needs_check ? <span className="wh-tag warn">перевірити</span> : null}{b.status === 'sealed' ? <span className="wh-tag">запечатана</span> : null}</div>
            <div className="wh-row-sub">{b.units} шт{b.location ? ` · ${b.location}` : ''}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function NewBoxScreen({ onCreated, toast }: { onCreated: (b: Box) => void; toast: (k: Toast['kind'], t: string) => void }) {
  const [cat, setCat] = useState('Z');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.nextCode(cat).then(r => setCode(r.code)).catch(() => {}); }, [cat]);
  return (
    <div className="wh-screen">
      <div className="wh-label">Категорія</div>
      <div className="wh-qty-row">
        {CATEGORIES.map(c => (
          <button key={c.letter} className={`wh-btn small ${cat === c.letter ? 'primary' : ''}`} onClick={() => setCat(c.letter)}>{c.letter} · {c.label}</button>
        ))}
      </div>
      <div className="wh-form">
        <label className="wh-label">Код коробки (можна змінити)</label>
        <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Z9" autoCapitalize="characters" />
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder="Назва (що всередині)" />
        <input value={loc} onChange={e => setLoc(e.target.value)} placeholder="Де стоїть (стелаж, полиця)" />
        <button className="wh-btn primary big" disabled={busy || !code.trim()} onClick={async () => {
          setBusy(true);
          try { const b = await api.createBox({ code: code.trim(), category: cat, title: title.trim() || undefined, location: loc.trim() || undefined }); toast('ok', `Коробку ${b.code} створено`); onCreated(b); }
          catch (e) { toast('err', errText(e, 'Не вдалося створити')); }
          finally { setBusy(false); }
        }}>Створити {code}</button>
      </div>
      <div className="wh-hint">Етикетку коробки (QR <code>bms:b:{code || '…'}</code>) друкує BMS — «Склад → Коробка → Етикетка».</div>
    </div>
  );
}
