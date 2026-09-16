// BMS Склад — Mini App для працівників: скан стікера/коробки, запакувати,
// вийняти, перемістити, коробки, пошук «де лежить».
//
// Принципи: кожна дія = 1 скан + 1 великий тап; усе ВЕЛИКЕ (номер 44 px,
// кнопки ≥ 60 px) — на складі дивляться мигцем і не в окулярах. «Сесія
// коробки» — відсканував коробку раз, далі скануєш товари поспіль.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, hasAuth, type Box, type Product, type ScanResult, type WhEvent, type WhoAmI } from './api';
import { canScan, confirmDialog, haptic, scanMany, scanOnce } from './scanner';
import { tg, isInTelegram } from '../telegram';
import {
  IAlert, IBox, IBoxes, ICheck, IChevron, IEdit, ILock, IMore, IMove, IPackIn, IPackOut,
  IPhoto, IPlus, IPrinter, IRefresh, IScan, ISearch, ITrash, IUnlock, IX,
} from './icons';

type View =
  | { name: 'home' }
  | { name: 'product'; product: Product }
  | { name: 'choose'; products: Product[]; stale?: boolean }
  | { name: 'box'; box: Box }
  | { name: 'boxes'; pickFor?: { product: Product; qty: number } }
  | { name: 'session'; box: Box }
  | { name: 'newBox'; pickFor?: { product: Product; qty: number } };

type Toast = { kind: 'ok' | 'warn' | 'err'; text: string; id: number };

const CATEGORIES: { letter: string; label: string }[] = [
  { letter: 'Z', label: 'Зима' }, { letter: 'D', label: 'Демі' }, { letter: 'L', label: 'Літо' },
  { letter: 'T', label: 'Трекінг' }, { letter: 'V', label: 'Весна' }, { letter: 'O', label: 'Одяг' },
];

const money = (v: number | null | undefined) => (v == null ? '' : `${Math.round(v).toLocaleString('uk-UA')} ₴`);
const ago = (iso: string) => {
  const d = new Date(iso); const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'щойно';
  if (s < 3600) return `${Math.floor(s / 60)} хв тому`;
  if (s < 86400) return `${Math.floor(s / 3600)} год тому`;
  return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' });
};
const errText = (e: unknown, fallback: string) =>
  e instanceof ApiError ? (typeof e.detail === 'string' ? e.detail : (e.detail as any)?.message || e.message) : (e as any)?.message || fallback;

const KIND_UA: Record<string, string> = {
  pack: 'Запаковано', unpack: 'Вийнято', move: 'Перенесено', seal: 'Запечатано', open: 'Відкрито',
  check: 'Звірено', box_create: 'Нова коробка', box_delete: 'Коробку видалено', box_edit: 'Змінено',
};
const kindIcon = (k: string) => (
  k === 'pack' ? <IPackIn size={20} /> : k === 'unpack' ? <IPackOut size={20} /> : k === 'move' ? <IMove size={20} />
  : k === 'seal' ? <ILock size={20} /> : k === 'open' ? <IUnlock size={20} /> : k === 'check' ? <ICheck size={20} />
  : k === 'box_delete' ? <ITrash size={20} /> : k === 'box_edit' ? <IEdit size={20} /> : <IBox size={20} />
);

/* ───────────────────────────── Дрібні компоненти ─────────────────────────── */

function Photo({ src, cls }: { src: string | null; cls: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (!src || broken) return <div className={`${cls} empty`}><IPhoto size={cls === 'wh-photo' ? 40 : 24} /></div>;
  return <img src={src} alt="" className={cls} onError={() => setBroken(true)} />;
}

function Header({ title, sub, right }: { title: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="wh-header">
      <div className="grow">
        <div className="wh-header-title">{title}</div>
        {sub && <div className="wh-header-sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}

function Bar({ children }: { children: ReactNode }) {
  return <div className="wh-bar"><div className="wh-bar-inner">{children}</div></div>;
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="wh-sheet-backdrop" onClick={onClose} />
      <div className="wh-sheet">
        <div className="wh-sheet-grip" />
        <div className="wh-sheet-title">{title}</div>
        <div className="wh-stack">{children}</div>
        <button className="wh-btn ghost wide" style={{ marginTop: 6 }} onClick={onClose}>Скасувати</button>
      </div>
    </>
  );
}

/* ───────────────────────────── Застосунок ────────────────────────────────── */

export function App() {
  const [stack, setStack] = useState<View[]>([{ name: 'home' }]);
  const view = stack[stack.length - 1];
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<WhoAmI | null>(null);
  const toastId = useRef(0);

  useEffect(() => { api.whoami().then(setWho).catch(() => setWho(null)); }, []);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++toastId.current;
    setToasts(t => [...t, { kind, text, id }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), kind === 'err' ? 4500 : 2200);
    if (kind === 'ok') haptic.ok(); else if (kind === 'warn') haptic.warn(); else haptic.err();
  }, []);

  const push = useCallback((v: View) => setStack(s => [...s, v]), []);
  const replace = useCallback((v: View) => setStack(s => [...s.slice(0, -1), v]), []);
  const back = useCallback(() => setStack(s => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const home = useCallback(() => setStack([{ name: 'home' }]), []);

  useEffect(() => {
    const app = tg;
    if (!app) return;
    if (stack.length > 1) app.BackButton.show(); else app.BackButton.hide();
    app.BackButton.onClick(back);
    return () => app.BackButton.offClick(back);
  }, [stack.length, back]);

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
      if (r.products.length === 0) toast('warn', `«${text}» не знайдено`);
      else openScan({ kind: 'products', products: r.products });
    } catch (e) { toast('err', errText(e, 'Пошук не вдався')); }
    finally { setBusy(false); }
  }, [openScan, toast]);

  const packInto = useCallback(async (box: Box | string, product: Product, qty: number): Promise<Product | null> => {
    const code = typeof box === 'string' ? box : box.code;
    try {
      const r = await api.pack(code, product.id, qty);
      toast('ok', r.moved_from.length ? `${product.number} → ${code} (з ${r.moved_from.join(', ')})` : `${product.number} → ${code}`);
      if (r.warning) toast('warn', r.warning);
      return r.product;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.detail as any)?.code === 'elsewhere') {
        const d = e.detail as { message: string };
        haptic.warn();
        if (!(await confirmDialog(`${d.message}. Перенести в ${code}?`))) return null;
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

  // Друк з телефона: завдання в хмару → агент BMS у крамниці друкує на Xprinter.
  const printViaAgent = useCallback(async (fn: () => Promise<{ id: number; agent_seen_at?: string | null }>, what: string) => {
    setBusy(true);
    try {
      const [job, agent] = await Promise.all([fn(), api.printAgent().catch(() => null)]);
      if (agent && agent.online) toast('ok', `${what} — друкується (${agent.printer ? 'принтер у мережі' : 'BMS'})`);
      else toast('warn', `${what} — у черзі. Надрукується, щойно BMS на компʼютері буде запущена.`);
      return job;
    } catch (e) { toast('err', errText(e, 'Не вдалося поставити на друк')); return null; }
    finally { setBusy(false); }
  }, [toast]);

  const refreshBox = useCallback(async (code: string) => {
    try { replace({ name: 'box', box: await api.box(code) }); } catch { /* ignore */ }
  }, [replace]);

  // Зі списків приходить коробка без вмісту — довантажуємо картку цілком.
  const openBox = useCallback(async (b: Box) => {
    setBusy(true);
    try { push({ name: 'box', box: b.contents ? b : await api.box(b.code) }); }
    catch (e) { toast('err', errText(e, 'Не вдалося відкрити коробку')); }
    finally { setBusy(false); }
  }, [push, toast]);

  // Після вибору коробки зі списку / створення нової для конкретного товару —
  // пакуємо і повертаємось на картку товару з оновленими даними.
  const packFromPicker = useCallback(async (box: Box, pick: { product: Product; qty: number }) => {
    setBusy(true);
    const p = await packInto(box, pick.product, pick.qty);
    setBusy(false);
    setStack(s => {
      const i = s.map(v => v.name).lastIndexOf('product');
      const base = i >= 0 ? s.slice(0, i + 1) : s.slice(0, 1);
      if (i >= 0 && p) base[i] = { name: 'product', product: p };
      return base;
    });
  }, [packInto]);

  return (
    <div className="wh">
      {view.name === 'home' && (
        <Home busy={busy} who={who} onScan={doScan} onSearch={doSearch}
          onBoxes={() => push({ name: 'boxes' })} onOpenBox={b => void openBox(b)} onNewBox={() => push({ name: 'newBox' })} />
      )}
      {view.name === 'choose' && (
        <Choose products={view.products} stale={view.stale} onPick={p => push({ name: 'product', product: p })} />
      )}
      {view.name === 'product' && (
        <ProductScreen product={view.product} busy={busy}
          onRefresh={async () => { try { replace({ name: 'product', product: await api.product(view.product.id) }); } catch { /* ignore */ } }}
          onScanBox={async (qty) => {
            const code = await scanOnce('Наведіть на QR коробки');
            if (code === null) return;
            const parsed = code.startsWith('bms:b:') ? code.slice(6).toUpperCase() : code.toUpperCase();
            setBusy(true);
            const p = await packInto(parsed, view.product, qty);
            setBusy(false);
            if (p) replace({ name: 'product', product: p });
          }}
          onPickBox={(qty) => push({ name: 'boxes', pickFor: { product: view.product, qty } })}
          onNewBox={(qty) => push({ name: 'newBox', pickFor: { product: view.product, qty } })}
          onPrintSticker={() => void printViaAgent(() => api.printStickers([view.product.id], 1), `Стікер ${view.product.number}`)}
          onUnpack={async (boxCode, qty) => {
            setBusy(true);
            try {
              await api.unpackFrom(boxCode, view.product.id, qty);
              toast('ok', `${view.product.number} вийнято з ${boxCode}`);
              replace({ name: 'product', product: await api.product(view.product.id) });
            } catch (e) { toast('err', errText(e, 'Не вдалося вийняти')); }
            finally { setBusy(false); }
          }}
        />
      )}
      {view.name === 'box' && (
        <BoxScreen box={view.box} busy={busy} setBusy={setBusy} toast={toast}
          onRefresh={() => refreshBox(view.box.code)}
          onSession={() => push({ name: 'session', box: view.box })}
          onPrintLabel={() => void printViaAgent(() => api.printBoxLabel(view.box.code, 1), `Етикетка ${view.box.code}`)}
          onDeleted={() => home()}
          onOpenProduct={p => push({ name: 'product', product: p })} />
      )}
      {view.name === 'boxes' && (
        <BoxesScreen pickFor={view.pickFor}
          onOpen={b => (view.pickFor ? void packFromPicker(b, view.pickFor) : void openBox(b))}
          onNew={() => push({ name: 'newBox', pickFor: view.pickFor })} />
      )}
      {view.name === 'newBox' && (
        <NewBoxScreen toast={toast}
          onCreated={async (b) => { if (view.pickFor) await packFromPicker(b, view.pickFor); else replace({ name: 'box', box: b }); }} />
      )}
      {view.name === 'session' && (
        <SessionScreen box={view.box} packInto={packInto} toast={toast}
          onDone={async () => { back(); await refreshBox(view.box.code); }} />
      )}

      <div className="wh-toasts">
        {toasts.map(t => (
          <div key={t.id} className={`wh-toast ${t.kind}`}>
            {t.kind === 'ok' ? <ICheck size={22} /> : <IAlert size={22} />}{t.text}
          </div>
        ))}
      </div>
      {busy && <div className="wh-busy" />}
    </div>
  );
}

/* ───────────────────────────── Головна ───────────────────────────────────── */

function Home({ busy, who, onScan, onSearch, onBoxes, onOpenBox, onNewBox }: {
  busy: boolean; who: WhoAmI | null;
  onScan: () => void; onSearch: (t: string) => void; onBoxes: () => void; onOpenBox: (b: Box) => void; onNewBox: () => void;
}) {
  const [q, setQ] = useState('');
  const [events, setEvents] = useState<WhEvent[]>([]);
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const load = useCallback(() => {
    api.events({ limit: 8 }).then(r => setEvents(r.events)).catch(() => {});
    api.boxes().then(r => setBoxes(r.boxes.filter(b => b.status !== 'archived'))).catch(() => setBoxes([]));
  }, []);
  useEffect(load, [load]);
  const stats = useMemo(() => ({
    boxes: boxes?.length ?? 0,
    units: boxes?.reduce((s, b) => s + b.units, 0) ?? 0,
    check: boxes?.filter(b => b.needs_check).length ?? 0,
  }), [boxes]);
  const noAccess = !hasAuth() || (who && !who.access);

  return (
    <>
      <Header title="Склад" sub={who?.name ? `Привіт, ${who.name.split(' ')[0]}` : 'BMS'}
        right={<button className="wh-iconbtn" onClick={load} title="Оновити"><IRefresh size={22} /></button>} />
      <div className="wh-body no-bar">
        {noAccess && (
          <div className="wh-banner err">
            <IAlert size={24} />
            <div>
              Немає доступу до складу.
              {who?.user_id ? <div className="sub">Ваш Telegram id: {who.user_id}{who.name ? ` (${who.name})` : ''}</div> : null}
              {(who?.problems || []).map((p, i) => <div key={i} className="sub">• {p}</div>)}
              {!hasAuth() && <div className="sub">Відкрийте застосунок із Telegram через бота «BMS Склад».</div>}
            </div>
          </div>
        )}

        <button className="wh-hero" onClick={onScan} disabled={busy}>
          <span className="wh-hero-ico"><IScan size={36} /></span>
          <span>
            <div className="wh-hero-title">Сканувати</div>
            <div className="wh-hero-sub">стікер товару або етикетку коробки</div>
          </span>
        </button>
        {!canScan() && isInTelegram && <div className="wh-hint">Сканер потребує Telegram 6.4+ — оновіть застосунок.</div>}

        <form className="wh-search" onSubmit={e => { e.preventDefault(); onSearch(q); }}>
          <ISearch size={24} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Номер товару" inputMode="text" autoCapitalize="characters" autoCorrect="off" />
          <button type="submit" disabled={busy || !q.trim()}>Знайти</button>
        </form>

        <div className="wh-stats">
          <button className="wh-stat" onClick={onBoxes}><b>{stats.boxes}</b><span>коробок</span></button>
          <button className="wh-stat" onClick={onBoxes}><b>{stats.units}</b><span>речей у коробках</span></button>
          <button className={`wh-stat ${stats.check ? 'warn' : ''}`} onClick={onBoxes}><b>{stats.check}</b><span>перевірити</span></button>
        </div>

        <div className="wh-card flush">
          <div className="wh-card-head" style={{ padding: '14px 16px 6px' }}>
            <span className="wh-label">Коробки</span>
            <button className="wh-link" onClick={onBoxes}>Усі <IChevron size={18} /></button>
          </div>
          <div className="wh-list">
            {boxes === null && <div className="wh-empty">Завантаження…</div>}
            {boxes && boxes.length === 0 && (
              <div className="wh-empty">Коробок ще нема.<br />
                <button className="wh-btn sm" style={{ marginTop: 12 }} onClick={onNewBox}><IPlus size={20} /> Створити першу</button>
              </div>
            )}
            {boxes && boxes.slice(0, 5).map(b => (
              <button key={b.id} className="wh-item" onClick={() => onOpenBox(b)}>
                <span className="wh-code">{b.code}</span>
                <span className="wh-item-main">
                  <span className="wh-item-title">{b.title || 'Без назви'}</span>
                  <span className="wh-item-sub">{b.units} шт{b.location ? ` · ${b.location}` : ''}{b.needs_check ? ' · перевірити' : ''}</span>
                </span>
                <span className="wh-item-right"><IChevron size={22} color="var(--fg-faint)" /></span>
              </button>
            ))}
          </div>
        </div>

        {events.length > 0 && (
          <div className="wh-card flush">
            <div className="wh-card-head" style={{ padding: '14px 16px 6px' }}><span className="wh-label">Останні дії</span></div>
            <div className="wh-list">{events.map(e => <EventRow key={e.id} e={e} />)}</div>
          </div>
        )}
      </div>
    </>
  );
}

function EventRow({ e }: { e: WhEvent }) {
  const what = [e.productnumber ? e.productnumber.replace(/^#/, '') : '', e.qty && e.qty > 1 ? `×${e.qty}` : ''].filter(Boolean).join(' ');
  return (
    <div className="wh-event">
      <span className="wh-event-ico">{kindIcon(e.kind)}</span>
      <span className="wh-event-main">
        <span className="wh-event-title">{KIND_UA[e.kind] || e.kind}{what ? ` · ${what}` : ''}{e.box_code ? ` → ${e.box_code}` : ''}</span>
        <span className="wh-event-sub">{e.actor && !e.actor.startsWith('bms') ? e.actor.replace(/^tg:\d+\s*/, '') || 'Telegram' : 'BMS'}</span>
      </span>
      <span className="wh-event-when">{ago(e.at)}</span>
    </div>
  );
}

/* ───────────────────────────── Вибір із ростовки ─────────────────────────── */

function Choose({ products, stale, onPick }: { products: Product[]; stale?: boolean; onPick: (p: Product) => void }) {
  return (
    <>
      <Header title="Який саме?" sub={`${products[0]?.number || ''} · ${products.length} розмір${products.length < 5 ? 'и' : 'ів'}`} />
      <div className="wh-body no-bar">
        {stale && <div className="wh-banner warn"><IAlert size={24} /><div>Стікер посилається на зниклий запис — знайдено за номером.</div></div>}
        <div className="wh-card flush"><div className="wh-list">
          {products.map(p => (
            <button key={p.id} className="wh-item" onClick={() => onPick(p)}>
              <Photo src={p.image} cls="wh-thumb" />
              <span className="wh-item-main">
                <span className="wh-item-title">{p.size || '—'}{p.available_qty <= 0 && <span className="wh-chip err sm">продано</span>}</span>
                <span className="wh-item-sub">{[p.brand, p.model, p.color].filter(Boolean).join(' · ')}</span>
                <span className="wh-item-sub">{p.locations.length ? `У ${p.locations.map(l => l.box_code).join(', ')}` : 'не в коробці'}</span>
              </span>
              <span className="wh-item-right"><IChevron size={22} color="var(--fg-faint)" /></span>
            </button>
          ))}
        </div></div>
      </div>
    </>
  );
}

/* ───────────────────────────── Товар ─────────────────────────────────────── */

function ProductScreen({ product: p, busy, onScanBox, onPickBox, onNewBox, onUnpack, onRefresh, onPrintSticker }: {
  product: Product; busy: boolean;
  onScanBox: (qty: number) => void; onPickBox: (qty: number) => void; onNewBox: (qty: number) => void;
  onUnpack: (boxCode: string, qty?: number) => void; onRefresh: () => void; onPrintSticker: () => void;
}) {
  const sold = p.available_qty <= 0;
  const maxQty = Math.max(1, p.available_qty || p.quantity || 1);
  const [qty, setQty] = useState(1);
  const [sheet, setSheet] = useState(false);
  useEffect(() => { setQty(1); setSheet(false); }, [p.id]);
  const inBox = p.locations.length > 0;

  return (
    <>
      <Header title="Товар" sub={[p.brand, p.type].filter(Boolean).join(' · ') || undefined}
        right={<>
          <button className="wh-iconbtn" onClick={onPrintSticker} disabled={busy} title="Надрукувати стікер (аркуш 4 шт) на принтері у крамниці"><IPrinter size={22} /></button>
          <button className="wh-iconbtn" onClick={onRefresh} title="Оновити"><IRefresh size={22} /></button>
        </>} />
      <div className="wh-body">
        <div className="wh-card wh-product">
          <div className="wh-product-top">
            <Photo src={p.image} cls="wh-photo" />
            <div className="wh-product-info">
              <div className="wh-number">{p.number}</div>
              <div className="wh-size">{p.size || '—'}{p.insole ? <small> · {p.insole} см</small> : null}</div>
            </div>
          </div>
          <div className="wh-attr">{[p.brand, p.model].filter(Boolean).join(' · ') || '—'}</div>
          <div className="wh-attr">{[p.type, p.color, p.season].filter(Boolean).join(' · ')}</div>
          <div className="wh-chips">
            {p.condition && <span className="wh-chip">{p.condition}</span>}
            {p.price != null && <span className="wh-chip">{money(p.price)}</span>}
            {p.quantity > 1 && <span className="wh-chip">{p.available_qty} з {p.quantity} шт</span>}
            {sold && <span className="wh-chip err">ПРОДАНО</span>}
          </div>
        </div>

        {sold && <div className="wh-banner err"><IAlert size={24} /><div>Продано — не пакувати.<div className="sub">Якщо пара в коробці — вийняти для відправки.</div></div></div>}

        <div className="wh-card">
          <div className="wh-label">Де лежить</div>
          {!inBox ? (
            <div className="wh-muted">Не в коробці</div>
          ) : p.locations.map(l => (
            <div key={l.box_code} className="wh-loc">
              <div className="wh-loc-row">
                <span className="wh-code">{l.box_code}</span>
                <div className="wh-chips">
                  {l.qty > 1 && <span className="wh-chip sm">×{l.qty}</span>}
                  {l.box_status === 'sealed' && <span className="wh-chip sm">запечатана</span>}
                  {l.needs_check && <span className="wh-chip warn sm">перевірити</span>}
                </div>
                <span style={{ flex: 1 }} />
                <button className="wh-btn sm" disabled={busy} onClick={() => onUnpack(l.box_code, l.qty > 1 ? 1 : undefined)}><IPackOut size={22} />Вийняти</button>
              </div>
              <div className="wh-loc-sub">{[l.box_title, l.box_location].filter(Boolean).join(' · ') || '—'}</div>
            </div>
          ))}
        </div>

        {maxQty > 1 && (
          <div className="wh-card">
            <div className="wh-label">Скільки пар кладу</div>
            <div className="wh-seg">
              {Array.from({ length: Math.min(maxQty, 9) }, (_, i) => i + 1).map(n => (
                <button key={n} className={qty === n ? 'on' : ''} onClick={() => setQty(n)}>{n}</button>
              ))}
            </div>
          </div>
        )}
      </div>

      <Bar>
        <button className="wh-btn primary huge" disabled={busy} onClick={() => setSheet(true)}>
          <IPackIn size={28} /> Запакувати
        </button>
      </Bar>

      {sheet && (
        <Sheet title={`${p.number} — у яку коробку?`} onClose={() => setSheet(false)}>
          <button className="wh-btn primary" onClick={() => { setSheet(false); onScanBox(qty); }}><IScan size={26} /> Сканувати QR коробки</button>
          <button className="wh-btn" onClick={() => { setSheet(false); onPickBox(qty); }}><IBoxes size={26} /> Вибрати зі списку</button>
          <button className="wh-btn" onClick={() => { setSheet(false); onNewBox(qty); }}><IPlus size={26} /> Нова коробка</button>
        </Sheet>
      )}
    </>
  );
}

/* ───────────────────────────── Коробка ───────────────────────────────────── */

function BoxScreen({ box, busy, setBusy, toast, onRefresh, onSession, onDeleted, onOpenProduct, onPrintLabel }: {
  box: Box; busy: boolean; setBusy: (b: boolean) => void;
  toast: (k: Toast['kind'], t: string) => void;
  onRefresh: () => Promise<void>; onSession: () => void; onDeleted: () => void;
  onOpenProduct: (p: Product) => void; onPrintLabel: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(box.title || '');
  const [loc, setLoc] = useState(box.location || '');
  const [more, setMore] = useState(false);
  useEffect(() => { setTitle(box.title || ''); setLoc(box.location || ''); setEdit(false); setMore(false); }, [box.code, box.title, box.location]);
  const contents = box.contents || [];

  const run = async (fn: () => Promise<unknown>, okMsg?: string) => {
    setBusy(true);
    try { await fn(); if (okMsg) toast('ok', okMsg); await onRefresh(); }
    catch (e) { toast('err', errText(e, 'Не вдалося')); }
    finally { setBusy(false); }
  };

  return (
    <>
      <Header title="Коробка" sub={box.status === 'sealed' ? 'запечатана' : box.status === 'archived' ? 'видалена' : 'відкрита'}
        right={<button className="wh-iconbtn" onClick={() => setMore(true)} title="Ще"><IMore size={24} /></button>} />
      <div className="wh-body">
        <div className="wh-card">
          <div className="wh-boxhead">
            <span className="wh-code">{box.code}</span>
            <div className="wh-boxhead-main">
              {!edit ? (
                <button className="wh-boxhead-main" style={{ textAlign: 'left' }} onClick={() => setEdit(true)}>
                  <div className="wh-boxhead-title">{box.title || <span style={{ color: 'var(--fg-faint)' }}>Без назви</span>}</div>
                  <div className="wh-boxhead-sub">{box.location || 'місце не вказано'} · <IEdit size={14} /> змінити</div>
                </button>
              ) : (
                <div className="wh-form">
                  <input className="wh-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Назва (що всередині)" />
                  <input className="wh-input" value={loc} onChange={e => setLoc(e.target.value)} placeholder="Де стоїть" />
                  <div className="wh-row-btns">
                    <button className="wh-btn sm primary" disabled={busy} onClick={() => run(() => api.patchBox(box.code, { title, location: loc }), 'Збережено')}>Зберегти</button>
                    <button className="wh-btn sm" onClick={() => setEdit(false)}>Скасувати</button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="wh-chips">
            {box.status === 'sealed' && <span className="wh-chip dark"><ILock size={16} /> запечатана</span>}
            <span className="wh-chip">{box.items} поз. · {box.units} шт</span>
            {box.value > 0 && <span className="wh-chip">{money(box.value)}</span>}
            {box.needs_check && <span className="wh-chip warn">перевірити</span>}
          </div>
        </div>

        {box.needs_check && (
          <div className="wh-banner warn">
            <IAlert size={24} />
            <div>Коробку треба перевірити<div className="sub">Її відкривали або вміст імпортовано. Проскануйте вміст і підтвердьте.</div></div>
            <button className="wh-btn sm" disabled={busy} onClick={() => run(() => api.check(box.code), 'Коробку звірено')}><ICheck size={22} />Звірено</button>
          </div>
        )}

        <div className="wh-card flush">
          <div className="wh-card-head" style={{ padding: '14px 16px 6px' }}><span className="wh-label">Вміст · {contents.length}</span></div>
          <div className="wh-list">
            {contents.length === 0 && <div className="wh-empty">Порожня</div>}
            {contents.map(it => (
              <div key={it.item_id} className="wh-item" style={{ paddingRight: 12 }}>
                <Photo src={it.product.image} cls="wh-thumb" />
                <button className="wh-item-main" onClick={() => onOpenProduct(it.product)}>
                  <span className="wh-item-title">{it.product.number} <span style={{ fontWeight: 600, color: 'var(--fg-muted)' }}>{it.product.size}</span>
                    {it.qty > 1 && <span className="wh-chip sm">×{it.qty}</span>}
                    {it.product.missing && <span className="wh-chip warn sm">запис зник</span>}
                    {!it.product.missing && it.product.available_qty <= 0 && <span className="wh-chip err sm">продано</span>}
                  </span>
                  <span className="wh-item-sub">{[it.product.brand, it.product.model, it.product.color].filter(Boolean).join(' · ')}</span>
                </button>
                <button className="wh-btn sm" disabled={busy} title="Вийняти" onClick={() => run(() => api.unpackFrom(box.code, it.product_id, it.qty > 1 ? 1 : undefined), `${it.product.number} вийнято`)}><IPackOut size={24} /></button>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Bar>
        <button className="wh-btn primary huge" disabled={busy || box.status === 'archived'} onClick={onSession}><IScan size={28} /> Пакувати сюди</button>
      </Bar>

      {more && (
        <Sheet title={`Коробка ${box.code}`} onClose={() => setMore(false)}>
          <button className="wh-btn primary" disabled={busy} onClick={() => { setMore(false); onPrintLabel(); }}><IPrinter size={26} /> Надрукувати етикетку</button>
          {box.status === 'sealed'
            ? <button className="wh-btn" disabled={busy} onClick={() => { setMore(false); void run(() => api.open(box.code), 'Коробку відкрито'); }}><IUnlock size={26} /> Відкрити</button>
            : <button className="wh-btn" disabled={busy || box.status === 'archived'} onClick={() => { setMore(false); void run(() => api.seal(box.code), 'Запечатано'); }}><ILock size={26} /> Запечатати</button>}
          {box.needs_check && <button className="wh-btn" disabled={busy} onClick={() => { setMore(false); void run(() => api.check(box.code), 'Коробку звірено'); }}><ICheck size={26} /> Звірено</button>}
          <button className="wh-btn" onClick={() => { setMore(false); setEdit(true); }}><IEdit size={26} /> Назва / місце</button>
          <button className="wh-btn" disabled={busy || contents.length === 0} onClick={async () => {
            setMore(false);
            if (await confirmDialog(`Розпакувати всю коробку ${box.code} (${box.units} шт)?`)) await run(() => api.unpackAll(box.code), 'Коробку розпаковано');
          }}><IPackOut size={26} /> Розпакувати все</button>
          <button className="wh-btn danger" disabled={busy || box.status === 'archived'} onClick={async () => {
            setMore(false);
            const withItems = contents.length > 0;
            const ok = await confirmDialog(withItems ? `У ${box.code} ще ${box.units} шт. Видалити коробку разом із вмістом (усе стане «без коробки»)?` : `Видалити коробку ${box.code}?`);
            if (!ok) return;
            setBusy(true);
            try { await api.deleteBox(box.code, withItems); toast('ok', `Коробку ${box.code} видалено`); onDeleted(); }
            catch (e) { toast('err', errText(e, 'Не вдалося видалити')); }
            finally { setBusy(false); }
          }}><ITrash size={26} /> Видалити коробку</button>
        </Sheet>
      )}
    </>
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
  // Без стікера (лише бірка з номером): пошук за номером → вибір розміру → у коробку.
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Product[] | null>(null);
  const [searching, setSearching] = useState(false);

  const packProduct = async (p: Product) => {
    if (p.available_qty <= 0) { toast('warn', `${p.number} ПРОДАНО — не кладу`); return; }
    const done = await packInto(box, p, 1);
    if (done) { setLog(l => [{ number: p.number, size: p.size, qty: 1 }, ...l]); setHits(null); setQ(''); }
  };

  const searchByNumber = async () => {
    const text = q.trim();
    if (!text) return;
    setSearching(true);
    try {
      const r = await api.search(text);
      if (r.products.length === 0) { toast('warn', `«${text}» не знайдено`); setHits(null); }
      else if (r.products.length === 1) await packProduct(r.products[0]);
      else setHits(r.products);
    } catch (e) { toast('err', errText(e, 'Пошук не вдався')); }
    finally { setSearching(false); }
  };

  const start = () => {
    setScanning(true);
    stopRef.current = scanMany(`Пакую в ${box.code} · скануйте товари поспіль`, async (code) => {
      try {
        const r = await api.scan(code);
        if (r.kind === 'box') { toast('warn', `Це коробка ${r.box.code}, а не товар`); return false; }
        const p = r.kind === 'product' ? r.product : (r.products.length === 1 ? r.products[0] : null);
        if (!p) { toast('warn', 'Кілька розмірів з таким номером — відкрийте товар окремо'); return false; }
        if (p.available_qty <= 0) { toast('warn', `${p.number} ПРОДАНО — не кладу`); return false; }
        const done = await packInto(box, p, 1);
        if (done) setLog(l => [{ number: p.number, size: p.size, qty: 1 }, ...l]);
      } catch (e) { toast('err', errText(e, 'Не впізнав код')); }
      return false;
    }, () => setScanning(false));
  };
  useEffect(() => () => stopRef.current(), []);

  return (
    <>
      <Header title={`Пакую в ${box.code}`} sub={box.title || undefined} />
      <div className="wh-body">
        <div className="wh-card wh-session">
          <div className="wh-label">Покладено за цю сесію</div>
          <div className="wh-counter">{total}</div>
        </div>
        <form className="wh-search" onSubmit={e => { e.preventDefault(); void searchByNumber(); }}>
          <ISearch size={24} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Без стікера: номер з бірки" inputMode="text" autoCapitalize="characters" autoCorrect="off" />
          <button type="submit" disabled={searching || !q.trim()}>{searching ? '…' : 'Покласти'}</button>
        </form>
        {hits && (
          <div className="wh-card flush">
            <div className="wh-card-head" style={{ padding: '12px 16px 4px' }}><span className="wh-label">{hits[0].number} · який розмір кладу?</span><button className="wh-link" onClick={() => setHits(null)}>закрити</button></div>
            <div className="wh-list">
              {hits.map(p => (
                <button key={p.id} className="wh-item" onClick={() => void packProduct(p)} disabled={p.available_qty <= 0}>
                  <Photo src={p.image} cls="wh-thumb" />
                  <span className="wh-item-main">
                    <span className="wh-item-title">{p.size || '—'}{p.available_qty <= 0 && <span className="wh-chip err sm">продано</span>}{p.locations.length > 0 && <span className="wh-chip sm">у {p.locations.map(l => l.box_code).join(', ')}</span>}</span>
                    <span className="wh-item-sub">{[p.brand, p.model, p.color].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="wh-item-right"><IPackIn size={24} /></span>
                </button>
              ))}
            </div>
          </div>
        )}
        {log.length > 0 && (
          <div className="wh-card flush"><div className="wh-list">
            {log.map((l, i) => (
              <div key={i} className="wh-event">
                <span className="wh-event-ico"><ICheck size={20} /></span>
                <span className="wh-event-main"><span className="wh-event-title">{l.number} · {l.size}</span></span>
              </div>
            ))}
          </div></div>
        )}
        {log.length === 0 && !hits && <div className="wh-hint">«Сканувати» — наводьте камеру на стікери по черзі, камера не закривається між сканами. Без стікера — введіть номер з бірки вище.</div>}
      </div>
      <Bar>
        <button className="wh-btn narrow" onClick={() => { stopRef.current(); onDone(); }} title="Завершити"><IX size={28} /></button>
        <button className="wh-btn primary huge" onClick={start} disabled={scanning}><IScan size={28} /> {scanning ? 'Сканую…' : log.length ? 'Сканувати ще' : 'Сканувати'}</button>
      </Bar>
    </>
  );
}

/* ───────────────────────────── Коробки ───────────────────────────────────── */

function BoxesScreen({ pickFor, onOpen, onNew }: { pickFor?: { product: Product; qty: number }; onOpen: (b: Box) => void; onNew: () => void }) {
  const [boxes, setBoxes] = useState<Box[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { api.boxes().then(r => setBoxes(r.boxes.filter(b => b.status !== 'archived'))).catch(e => setErr(errText(e, 'Не вдалося завантажити'))); }, []);
  const open = (b: Box) => onOpen(b);
  const list = useMemo(() => {
    const f = q.trim().toLowerCase();
    return (boxes || []).filter(b => !f || `${b.code} ${b.title || ''} ${b.location || ''}`.toLowerCase().includes(f));
  }, [boxes, q]);
  return (
    <>
      <Header title={pickFor ? 'У яку коробку?' : 'Коробки'} sub={pickFor ? `${pickFor.product.number} · ${pickFor.product.size}${pickFor.qty > 1 ? ` · ${pickFor.qty} шт` : ''}` : (boxes ? `${boxes.length} · ${boxes.reduce((s, b) => s + b.units, 0)} шт` : undefined)} />
      <div className="wh-body">
        <div className="wh-search">
          <ISearch size={24} />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Код, назва, місце" autoCapitalize="characters" autoCorrect="off" />
        </div>
        {err && <div className="wh-banner err"><IAlert size={24} /><div>{err}</div></div>}
        <div className="wh-card flush"><div className="wh-list">
          {boxes === null && !err && <div className="wh-empty">Завантаження…</div>}
          {boxes && list.length === 0 && <div className="wh-empty">{q ? 'Нічого не знайдено' : 'Коробок ще нема'}</div>}
          {list.map(b => (
            <button key={b.id} className="wh-item" onClick={() => open(b)}>
              <span className="wh-code">{b.code}</span>
              <span className="wh-item-main">
                <span className="wh-item-title">{b.title || 'Без назви'}</span>
                <span className="wh-item-sub">{b.units} шт{b.location ? ` · ${b.location}` : ''}</span>
                {(b.needs_check || b.status === 'sealed') && (
                  <span className="wh-chips" style={{ marginTop: 6 }}>
                    {b.status === 'sealed' && <span className="wh-chip sm"><ILock size={14} /> запечатана</span>}
                    {b.needs_check && <span className="wh-chip warn sm">перевірити</span>}
                  </span>
                )}
              </span>
              <span className="wh-item-right"><IChevron size={22} color="var(--fg-faint)" /></span>
            </button>
          ))}
        </div></div>
      </div>
      <Bar>
        <button className="wh-btn primary huge" onClick={onNew}><IPlus size={28} /> Нова коробка</button>
      </Bar>
    </>
  );
}

function NewBoxScreen({ onCreated, toast }: { onCreated: (b: Box) => void; toast: (k: Toast['kind'], t: string) => void }) {
  const [cat, setCat] = useState('Z');
  const [code, setCode] = useState('');
  const [title, setTitle] = useState('');
  const [loc, setLoc] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.nextCode(cat).then(r => setCode(r.code)).catch(() => {}); }, [cat]);
  const create = async () => {
    setBusy(true);
    try { const b = await api.createBox({ code: code.trim(), category: cat, title: title.trim() || undefined, location: loc.trim() || undefined }); toast('ok', `Коробку ${b.code} створено`); onCreated(b); }
    catch (e) { toast('err', errText(e, 'Не вдалося створити')); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Header title="Нова коробка" sub="код генерується за категорією" />
      <div className="wh-body">
        <div className="wh-card">
          <div className="wh-label">Категорія</div>
          <div className="wh-seg">
            {CATEGORIES.map(c => <button key={c.letter} className={cat === c.letter ? 'on' : ''} onClick={() => setCat(c.letter)}>{c.letter} · {c.label}</button>)}
          </div>
        </div>
        <div className="wh-card wh-form">
          <div className="wh-label">Код (можна змінити)</div>
          <input className="wh-input code" value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="Z9" autoCapitalize="characters" autoCorrect="off" />
          <input className="wh-input" value={title} onChange={e => setTitle(e.target.value)} placeholder="Назва (що всередині)" />
          <input className="wh-input" value={loc} onChange={e => setLoc(e.target.value)} placeholder="Де стоїть (стелаж, полиця)" />
        </div>
        <div className="wh-hint">Етикетку коробки (QR <b>bms:b:{code || '…'}</b>) можна надрукувати одразу після створення: «···» → «Надрукувати етикетку».</div>
      </div>
      <Bar>
        <button className="wh-btn primary huge" disabled={busy || !code.trim()} onClick={create}><IPlus size={28} /> Створити {code}</button>
      </Bar>
    </>
  );
}
