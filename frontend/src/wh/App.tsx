// BMS Склад — Mini App для працівників: скан стікера/коробки, запакувати,
// вийняти, перемістити, коробки, пошук «де лежить».
//
// Принципи: кожна дія = 1 скан + 1 великий тап; усе ВЕЛИКЕ (номер 44 px,
// кнопки ≥ 60 px) — на складі дивляться мигцем і не в окулярах. «Сесія
// коробки» — відсканував коробку раз, далі скануєш товари поспіль.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, hasAuth, isNetworkError, type Box, type Condition, type Product, type ScanResult, type WhEvent, type WhoAmI } from './api';
import { cached, discard, enqueue, noteOnline, onSynced, parseCodeOffline, remember, retry, runOrQueue, setOnline, useOffline, type Op } from './offline';
import { canScan, confirmDialog, haptic, scanMany, scanOnce } from './scanner';
import { tg, isInTelegram } from '../telegram';
import {
  IAlert, IBox, IBoxes, ICheck, IChevron, IEdit, ILock, IMore, IMove, IPackIn, IPackOut,
  IPhoto, IPlus, IPrinter, IRefresh, IScan, ISearch, ITrash, IUnlock, IX,
} from './icons';

const OFFLINE_ONLY_ONLINE = 'Без мережі ця дія недоступна — спробуйте, коли зʼявиться звʼязок.';
const QUEUED = 'Немає мережі — дію збережено, виконаю, щойно зʼявиться звʼязок.';

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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
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

/* ───────────────────────────── Немає доступу ─────────────────────────────── */

// Новий працівник: підпис бота складу є, але його ще не пустили → одна велика
// кнопка «Попросити доступ»; власник підтверджує в BMS («Склад → Працівники»).
// Діагностику (токени, підписи) показуємо лише коли проблема на сервері.
function NoAccess({ who, onChanged }: { who: WhoAmI | null; onChanged: () => void }) {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const canAsk = !!who && who.signature_warehouse_bot && !who.access && who.staff_status !== 'blocked';
  const pending = who?.staff_status === 'pending' || sent;
  const blocked = who?.staff_status === 'blocked';
  const ask = async () => {
    setSending(true);
    try { const r = await api.requestAccess(); setSent(true); haptic.ok(); if (r.status === 'active' || r.status === 'owner') onChanged(); }
    catch { haptic.err(); }
    finally { setSending(false); }
  };
  if (canAsk) {
    return (
      <div className="wh-card wh-noaccess">
        <div className="wh-noaccess-title">{pending ? 'Запит надіслано' : 'Потрібен доступ'}</div>
        <div className="wh-noaccess-sub">
          {who?.name ? `${who.name} · ` : ''}Telegram id {who?.user_id}
        </div>
        {pending ? (
          <>
            <div className="wh-hint">Чекаємо, поки власник підтвердить у BMS («Склад → Працівники»). Потім натисніть «Перевірити».</div>
            <button className="wh-btn primary huge" onClick={onChanged}><IRefresh size={26} /> Перевірити</button>
          </>
        ) : (
          <>
            <div className="wh-hint">Натисніть — і власник побачить ваш запит у BMS та підтвердить його.</div>
            <button className="wh-btn primary huge" disabled={sending} onClick={() => void ask()}><ICheck size={26} /> Попросити доступ</button>
          </>
        )}
      </div>
    );
  }
  return (
    <div className="wh-banner err">
      <IAlert size={24} />
      <div>
        {blocked ? 'Доступ заблоковано.' : 'Немає доступу до складу.'}
        {who?.user_id ? <div className="sub">Ваш Telegram id: {who.user_id}{who.name ? ` (${who.name})` : ''}</div> : null}
        {(who?.problems || []).map((p, i) => <div key={i} className="sub">• {p}</div>)}
        {!hasAuth() && <div className="sub">Відкрийте застосунок із Telegram через бота «BMS Склад».</div>}
      </div>
    </div>
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

  useEffect(() => { api.whoami().then(w => { setWho(w); noteOnline(); }).catch(() => setWho(null)); }, []);
  const off = useOffline();
  const [fixOpen, setFixOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

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
    // Усе побачене — в копію: саме з неї застосунок живе без мережі.
    if (r.kind === 'product') remember.product(r.product);
    else if (r.kind === 'box') remember.box(r.box);
    else remember.products(r.products);
    if (r.kind === 'product') push({ name: 'product', product: r.product });
    else if (r.kind === 'box') push({ name: 'box', box: r.box });
    else if (r.products.length === 1) push({ name: 'product', product: r.products[0] });
    else push({ name: 'choose', products: r.products, stale: r.stale_sticker });
  }, [push]);

  // Скан без мережі: QR несе id і номер — цього досить, щоб відкрити картку з
  // копії (або хоча б із номером) і покласти в коробку.
  const scanResolve = useCallback(async (code: string): Promise<ScanResult> => {
    try { const r = await api.scan(code); noteOnline(); return r; }
    catch (e) {
      if (!isNetworkError(e)) throw e;
      setOnline(false);
      const local = parseCodeOffline(code);
      if (!local) throw e;
      return local;
    }
  }, []);

  const doScan = useCallback(async () => {
    const code = await scanOnce();
    if (!code) return;
    setBusy(true);
    try { openScan(await scanResolve(code)); haptic.tap(); }
    catch (e) { toast('err', isNetworkError(e) ? 'Немає мережі, і цього коду ще нема в копії' : errText(e, 'Не впізнав код')); }
    finally { setBusy(false); }
  }, [openScan, scanResolve, toast]);

  const doSearch = useCallback(async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      let products: Product[];
      try { const r = await api.search(text); noteOnline(); products = r.products; }
      catch (e) {
        if (!isNetworkError(e)) throw e;
        setOnline(false);
        products = cached.byNumber(text);
        if (products.length) toast('warn', 'Немає мережі — показую з копії');
      }
      if (products.length === 0) toast('warn', off.online ? `«${text}» не знайдено` : `«${text}» нема в копії, а мережі нема`);
      else openScan({ kind: 'products', products });
    } catch (e) { toast('err', errText(e, 'Пошук не вдався')); }
    finally { setBusy(false); }
  }, [openScan, toast, off.online]);

  const packInto = useCallback(async (box: Box | string, product: Product, qty: number): Promise<Product | null> => {
    const code = typeof box === 'string' ? box : box.code;
    const queueIt = (move: boolean) => {
      enqueue('pack', { code, product, qty, move }, `${product.number} → ${code}${move ? ' (перенести)' : ''}`);
      toast('warn', QUEUED);
      return cached.product(product.id) || product;
    };
    try {
      const r = await api.pack(code, product.id, qty);
      noteOnline();
      remember.product(r.product);
      toast('ok', r.moved_from.length ? `${product.number} → ${code} (з ${r.moved_from.join(', ')})` : `${product.number} → ${code}`);
      if (r.warning) toast('warn', r.warning);
      return r.product;
    } catch (e) {
      if (isNetworkError(e)) {
        setOnline(false);
        // Копія знає, де лежить товар: питаємо про перенесення, як і онлайн.
        const elsewhere = (cached.product(product.id)?.locations || product.locations || []).filter(l => l.box_code !== code);
        if (elsewhere.length) {
          haptic.warn();
          if (!(await confirmDialog(`${product.number} лежить у ${elsewhere.map(l => l.box_code).join(', ')} (за копією). Перенести в ${code}?`))) return null;
          return queueIt(true);
        }
        return queueIt(false);
      }
      if (e instanceof ApiError && e.status === 409 && (e.detail as any)?.code === 'elsewhere') {
        const d = e.detail as { message: string };
        haptic.warn();
        if (!(await confirmDialog(`${d.message}. Перенести в ${code}?`))) return null;
        try {
          const r = await api.pack(code, product.id, qty, true);
          remember.product(r.product);
          toast('ok', `${product.number}: ${r.moved_from.join(', ')} → ${code}`);
          return r.product;
        } catch (e2) {
          if (isNetworkError(e2)) { setOnline(false); return queueIt(true); }
          toast('err', errText(e2, 'Не вдалося перенести')); return null;
        }
      }
      toast('err', errText(e, 'Не вдалося запакувати'));
      return null;
    }
  }, [toast]);

  // Друк з телефона: завдання в хмару → агент BMS у крамниці друкує на Xprinter.
  const printViaAgent = useCallback(async (fn: () => Promise<{ id: number; agent_seen_at?: string | null; duplicate?: boolean }>, what: string) => {
    setBusy(true);
    try {
      const [job, agent] = await Promise.all([fn(), api.printAgent().catch(() => null)]);
      if (job.duplicate) { haptic.warn(); toast('warn', `${what} — уже в черзі, чекає принтера.`); return job; }
      if (agent && agent.online && agent.printer) { haptic.ok(); toast('ok', `${what} — друкується`); }
      else if (agent && agent.online) { haptic.warn(); toast('warn', `${what} — у черзі. BMS працює, але принтер не відповідає: увімкніть Windows-ПК з принтером (міст, порт 9100).`); }
      else { haptic.warn(); toast('warn', `${what} — у черзі. Надрукується, щойно BMS на компʼютері буде запущена.`); }
      return job;
    } catch (e) { toast('err', isNetworkError(e) ? OFFLINE_ONLY_ONLINE : errText(e, 'Не вдалося поставити на друк')); return null; }
    finally { setBusy(false); }
  }, [toast]);

  // Правка товару з телефона: кладемо в чергу → агент BMS застосовує її тим
  // самим шляхом, що й картка (база + журнал + лок + «стара ціна») і оновлює
  // дзеркало в хмарі → перечитуємо картку. Чекаємо до ~40 с, далі — «пізніше».
  const editProduct = useCallback(async (p: Product, fields: { price?: number; current_condition_name?: string }) => {
    setBusy(true);
    try {
      const [job, agent] = await Promise.all([api.editProduct(p.id, fields), api.printAgent().catch(() => null)]);
      if (!agent || !agent.online) {
        haptic.warn();
        toast('warn', 'Правка в черзі — застосується, щойно BMS на компʼютері буде запущена.');
        return;
      }
      toast('ok', 'Надіслано — BMS зберігає…');
      for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const j = await api.job(job.id).catch(() => null);
        if (!j) continue;
        if (j.status === 'done') {
          const fresh = await api.product(p.id);
          setStack(st => st.map(v => (v.name === 'product' && v.product.id === p.id ? { name: 'product', product: fresh } : v)));
          haptic.ok();
          toast('ok', `${p.number} — збережено в BMS`);
          return;
        }
        if (j.status === 'failed' || j.status === 'cancelled') {
          haptic.err();
          toast('err', j.error || 'BMS не змогла застосувати правку');
          return;
        }
      }
      toast('warn', 'BMS ще не застосувала правку — оновіть картку трохи пізніше.');
    } catch (e) { haptic.err(); toast('err', isNetworkError(e) ? OFFLINE_ONLY_ONLINE : errText(e, 'Не вдалося зберегти')); }
    finally { setBusy(false); }
  }, [toast]);

  // Картка коробки: з сервера (і в копію), а без мережі — з копії.
  const loadBox = useCallback(async (code: string): Promise<Box> => {
    try { const b = await api.box(code); noteOnline(); remember.box(b); return b; }
    catch (e) {
      if (!isNetworkError(e)) throw e;
      setOnline(false);
      const local = cached.box(code);
      if (!local) throw e;
      return local;
    }
  }, []);
  const loadProduct = useCallback(async (id: number): Promise<Product> => {
    try { const p = await api.product(id); noteOnline(); remember.product(p); return p; }
    catch (e) {
      if (!isNetworkError(e)) throw e;
      setOnline(false);
      const local = cached.product(id);
      if (!local) throw e;
      return local;
    }
  }, []);

  const refreshBox = useCallback(async (code: string) => {
    try { replace({ name: 'box', box: await loadBox(code) }); } catch { /* ignore */ }
  }, [replace, loadBox]);

  // Зі списків приходить коробка без вмісту — довантажуємо картку цілком.
  const openBox = useCallback(async (b: Box) => {
    setBusy(true);
    try { push({ name: 'box', box: b.contents ? b : await loadBox(b.code) }); }
    catch (e) { toast('err', isNetworkError(e) ? 'Немає мережі, а цієї коробки ще нема в копії' : errText(e, 'Не вдалося відкрити коробку')); }
    finally { setBusy(false); }
  }, [push, toast, loadBox]);

  // Черга досинхронізувалась — перечитати те, що на екрані, зі свіжого сервера.
  useEffect(() => onSynced(async (done) => {
    toast('ok', done.length === 1 ? 'Дію з черги виконано' : `Виконано дій з черги: ${done.length}`);
    const v = stack[stack.length - 1];
    try {
      if (v.name === 'product') replace({ name: 'product', product: await api.product(v.product.id) });
      else if (v.name === 'box' || v.name === 'session') replace({ name: v.name, box: await api.box(v.box.code) } as View);
      else setReloadKey(k => k + 1);
    } catch { /* тихо */ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [stack, replace, toast]);

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
      <OfflineBar off={off} onFix={() => setFixOpen(true)} />
      {view.name === 'home' && (
        <Home key={reloadKey} busy={busy} who={who} onScan={doScan} onSearch={doSearch}
          onBoxes={() => push({ name: 'boxes' })} onOpenBox={b => void openBox(b)} onNewBox={() => push({ name: 'newBox' })} />
      )}
      {view.name === 'choose' && (
        <Choose products={view.products} stale={view.stale} onPick={p => push({ name: 'product', product: p })} />
      )}
      {view.name === 'product' && (
        <ProductScreen product={view.product} busy={busy}
          onRefresh={async () => { try { replace({ name: 'product', product: await loadProduct(view.product.id) }); } catch { /* ignore */ } }}
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
          onEdit={fields => editProduct(view.product, fields)}
          onUnpack={async (boxCode, qty) => {
            setBusy(true);
            try {
              const { queued } = await runOrQueue(() => api.unpackFrom(boxCode, view.product.id, qty),
                { kind: 'unpackFrom', args: { code: boxCode, product_id: view.product.id, qty: qty ?? null }, label: `${view.product.number} ← вийняти з ${boxCode}` });
              toast(queued ? 'warn' : 'ok', queued ? QUEUED : `${view.product.number} вийнято з ${boxCode}`);
              replace({ name: 'product', product: await loadProduct(view.product.id) });
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
        <BoxesScreen key={reloadKey} pickFor={view.pickFor}
          onOpen={b => (view.pickFor ? void packFromPicker(b, view.pickFor) : void openBox(b))}
          onNew={() => push({ name: 'newBox', pickFor: view.pickFor })} />
      )}
      {view.name === 'newBox' && (
        <NewBoxScreen toast={toast}
          onCreated={async (b) => { if (view.pickFor) await packFromPicker(b, view.pickFor); else replace({ name: 'box', box: b }); }} />
      )}
      {view.name === 'session' && (
        <SessionScreen box={view.box} packInto={packInto} toast={toast} scanResolve={scanResolve}
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
      {fixOpen && <FixQueueSheet ops={off.failed} onClose={() => setFixOpen(false)} />}
    </div>
  );
}

/* ───────────────────────────── Офлайн ────────────────────────────────────── */

// Смужка стану мережі. Живе рівно стільки, скільки є що сказати: без мережі,
// синхронізація, або сервер відмовив (тоді — «розібрати»).
function OfflineBar({ off, onFix }: { off: ReturnType<typeof useOffline>; onFix: () => void }) {
  if (off.failed.length) {
    return (
      <button className="wh-netbar err" onClick={onFix}>
        <IAlert size={20} /> Не синхронізовано: {off.failed.length} · розібрати
      </button>
    );
  }
  if (!off.online) {
    return (
      <div className="wh-netbar warn">
        <IAlert size={20} /> Немає мережі — працюю з копією{off.pending ? ` · у черзі ${off.pending}` : ''}
      </div>
    );
  }
  if (off.pending || off.syncing) {
    return <div className="wh-netbar"><IRefresh size={20} /> Синхронізую{off.pending ? ` · ${off.pending}` : '…'}</div>;
  }
  return null;
}

// Сервер відмовив у дії з черги: черга стоїть, поки людина не вирішить.
// «Перенести» — для «уже лежить в іншій коробці»; «Повторити» — якщо причина
// зникла; «Прибрати» — визнати, що дія не потрібна (копія лишиться як є до
// наступного оновлення з сервера).
function FixQueueSheet({ ops, onClose }: { ops: Op[]; onClose: () => void }) {
  useEffect(() => { if (ops.length === 0) onClose(); }, [ops.length, onClose]);
  return (
    <Sheet title="Не синхронізовано" onClose={onClose}>
      {ops.map(op => (
        <div key={op.id} className="wh-card" style={{ padding: 14 }}>
          <div style={{ fontWeight: 800, fontSize: 18 }}>{op.label}</div>
          <div className="wh-hint" style={{ marginTop: 4 }}>{op.error || 'Сервер відмовив'}</div>
          <div className="wh-row-btns" style={{ marginTop: 10 }}>
            {op.kind === 'pack' && op.errorCode === 'elsewhere' && (
              <button className="wh-btn sm primary" onClick={() => retry(op.id, { move: true })}><IMove size={20} /> Перенести</button>
            )}
            <button className="wh-btn sm" onClick={() => retry(op.id)}><IRefresh size={20} /> Повторити</button>
            <button className="wh-btn sm danger" onClick={() => discard(op.id)}><ITrash size={20} /> Прибрати</button>
          </div>
        </div>
      ))}
    </Sheet>
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
    api.boxes()
      .then(r => { noteOnline(); remember.boxes(r.boxes); setBoxes(r.boxes.filter(b => b.status !== 'archived')); })
      .catch(e => { if (isNetworkError(e)) { setOnline(false); setBoxes(cached.boxes().filter(b => b.status !== 'archived')); } else setBoxes([]); });
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
        {noAccess && <NoAccess who={who} onChanged={load} />}

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

function ProductScreen({ product: p, busy, onScanBox, onPickBox, onNewBox, onUnpack, onRefresh, onPrintSticker, onEdit }: {
  product: Product; busy: boolean;
  onScanBox: (qty: number) => void; onPickBox: (qty: number) => void; onNewBox: (qty: number) => void;
  onUnpack: (boxCode: string, qty?: number) => void; onRefresh: () => void; onPrintSticker: () => void;
  onEdit: (fields: { price?: number; current_condition_name?: string }) => Promise<void>;
}) {
  const sold = p.available_qty <= 0;
  const maxQty = Math.max(1, p.available_qty || p.quantity || 1);
  const [qty, setQty] = useState(1);
  const [sheet, setSheet] = useState(false);
  const [edit, setEdit] = useState(false);
  useEffect(() => { setQty(1); setSheet(false); setEdit(false); }, [p.id]);
  const inBox = p.locations.length > 0;

  return (
    <>
      <Header title="Товар" sub={[p.brand, p.type].filter(Boolean).join(' · ') || undefined}
        right={<>
          <button className="wh-iconbtn" onClick={() => setEdit(true)} disabled={busy} title="Змінити ціну / стан"><IEdit size={22} /></button>
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
            <button className="wh-chip tap" onClick={() => setEdit(true)} disabled={busy}>{p.condition || 'стан —'}<IEdit size={16} /></button>
            <button className="wh-chip tap" onClick={() => setEdit(true)} disabled={busy}>
              {p.price != null ? money(p.price) : 'ціна —'}
              {p.oldprice != null && p.oldprice > 0 && <s className="wh-old">{money(p.oldprice)}</s>}
              <IEdit size={16} />
            </button>
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
      {edit && (
        <EditProductSheet product={p} busy={busy} onClose={() => setEdit(false)}
          onSubmit={async (fields) => { setEdit(false); await onEdit(fields); }} />
      )}
    </>
  );
}

/* ───────────────────────────── Правка товару ─────────────────────────────── */

// Ціна і стан — те, що реально правлять на складі. Усе інше — в BMS.
// «Стара ціна»: BMS сама перенесе туди поточну, якщо ціну ЗНИЖУЮТЬ, а стара
// порожня (той самий код, що й у картці) — тут лише підказка, що так буде.
function EditProductSheet({ product: p, busy, onClose, onSubmit }: {
  product: Product; busy: boolean; onClose: () => void;
  onSubmit: (fields: { price?: number; current_condition_name?: string }) => Promise<void>;
}) {
  const [price, setPrice] = useState(p.price != null ? String(Math.round(p.price)) : '');
  const [cond, setCond] = useState(p.condition || '');
  const [conds, setConds] = useState<Condition[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.conditions().then(r => { if (alive) setConds(r.conditions); }).catch(() => { if (alive) setConds([]); });
    return () => { alive = false; };
  }, []);

  const names = useMemo(() => {
    const list = (conds || []).map(c => c.name);
    if (p.condition && !list.includes(p.condition)) list.unshift(p.condition);
    return list;
  }, [conds, p.condition]);

  const priceNum = price.trim() === '' ? null : Number(price.replace(',', '.').replace(/\s/g, ''));
  const priceBad = priceNum != null && (Number.isNaN(priceNum) || priceNum < 0);
  const priceChanged = priceNum != null && !priceBad && priceNum !== (p.price == null ? null : Number(p.price));
  const condChanged = !!cond && cond !== (p.condition || '');
  const willMarkdown = priceChanged && p.price != null && priceNum! < Number(p.price) && !(p.oldprice && p.oldprice > 0);
  const canSave = !busy && !priceBad && (priceChanged || condChanged);

  const fields: { price?: number; current_condition_name?: string } = {};
  if (priceChanged) fields.price = priceNum!;
  if (condChanged) fields.current_condition_name = cond;

  return (
    <Sheet title={`${p.number} — змінити`} onClose={onClose}>
      <div className="wh-label">Ціна, ₴</div>
      <input className="wh-input price" value={price} inputMode="decimal" autoComplete="off"
        onChange={e => setPrice(e.target.value)} placeholder={p.price != null ? String(Math.round(p.price)) : '0'} />
      {willMarkdown && <div className="wh-hint">Стара ціна стане <b>{money(p.price)}</b> — BMS запише її автоматично.</div>}
      {!willMarkdown && p.oldprice != null && p.oldprice > 0 && <div className="wh-hint">Стара ціна: {money(p.oldprice)} (не змінюється)</div>}
      {priceBad && <div className="wh-hint" style={{ color: '#b42318' }}>Ціна має бути числом ≥ 0</div>}

      <div className="wh-label" style={{ marginTop: 6 }}>Стан</div>
      {conds === null ? <div className="wh-muted">Завантажую…</div> : (
        <div className="wh-seg cond">
          {names.map(n => (
            <button key={n} className={cond === n ? 'on' : ''} onClick={() => setCond(n)}>{n}</button>
          ))}
        </div>
      )}

      <button className="wh-btn primary huge" disabled={!canSave} onClick={() => void onSubmit(fields)} style={{ marginTop: 8 }}>
        <ICheck size={28} /> Зберегти в BMS
      </button>
      <div className="wh-hint">Правку застосує BMS на компʼютері (база, журнал, каталог) за кілька секунд.</div>
    </Sheet>
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

  // Дія коробки: онлайн — як є; без мережі — у чергу (якщо дія це дозволяє:
  // видалення і «розпакувати все» — лише онлайн).
  const run = async (fn: () => Promise<unknown>, okMsg?: string, fallback?: { kind: Op['kind']; args: Record<string, any>; label: string }) => {
    setBusy(true);
    try {
      if (fallback) {
        const { queued } = await runOrQueue(fn, fallback);
        if (queued) toast('warn', QUEUED); else if (okMsg) toast('ok', okMsg);
      } else { await fn(); noteOnline(); if (okMsg) toast('ok', okMsg); }
      await onRefresh();
    }
    catch (e) { toast('err', isNetworkError(e) ? OFFLINE_ONLY_ONLINE : errText(e, 'Не вдалося')); }
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
                    <button className="wh-btn sm primary" disabled={busy} onClick={() => run(() => api.patchBox(box.code, { title, location: loc }), 'Збережено',
                      { kind: 'patchBox', args: { code: box.code, patch: { title, location: loc } }, label: `${box.code}: назва / місце` })}>Зберегти</button>
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
            <button className="wh-btn sm" disabled={busy} onClick={() => run(() => api.check(box.code), 'Коробку звірено', { kind: 'check', args: { code: box.code }, label: `${box.code}: звірено` })}><ICheck size={22} />Звірено</button>
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
                <button className="wh-btn sm" disabled={busy} title="Вийняти" onClick={() => run(() => api.unpackFrom(box.code, it.product_id, it.qty > 1 ? 1 : undefined), `${it.product.number} вийнято`,
                  { kind: 'unpackFrom', args: { code: box.code, product_id: it.product_id, qty: it.qty > 1 ? 1 : null }, label: `${it.product.number} ← вийняти з ${box.code}` })}><IPackOut size={24} /></button>
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
            ? <button className="wh-btn" disabled={busy} onClick={() => { setMore(false); void run(() => api.open(box.code), 'Коробку відкрито', { kind: 'open', args: { code: box.code }, label: `${box.code}: відкрити` }); }}><IUnlock size={26} /> Відкрити</button>
            : <button className="wh-btn" disabled={busy || box.status === 'archived'} onClick={() => { setMore(false); void run(() => api.seal(box.code), 'Запечатано', { kind: 'seal', args: { code: box.code }, label: `${box.code}: запечатати` }); }}><ILock size={26} /> Запечатати</button>}
          {box.needs_check && <button className="wh-btn" disabled={busy} onClick={() => { setMore(false); void run(() => api.check(box.code), 'Коробку звірено', { kind: 'check', args: { code: box.code }, label: `${box.code}: звірено` }); }}><ICheck size={26} /> Звірено</button>}
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
            catch (e) { toast('err', isNetworkError(e) ? OFFLINE_ONLY_ONLINE : errText(e, 'Не вдалося видалити')); }
            finally { setBusy(false); }
          }}><ITrash size={26} /> Видалити коробку</button>
        </Sheet>
      )}
    </>
  );
}

/* ───────────────────────────── Сесія пакування ───────────────────────────── */

function SessionScreen({ box, packInto, toast, onDone, scanResolve }: {
  box: Box; packInto: (box: Box, p: Product, qty: number) => Promise<Product | null>;
  toast: (k: Toast['kind'], t: string) => void; onDone: () => void;
  scanResolve: (code: string) => Promise<ScanResult>;
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
      let products: Product[];
      try { const r = await api.search(text); noteOnline(); remember.products(r.products); products = r.products; }
      catch (e) { if (!isNetworkError(e)) throw e; setOnline(false); products = cached.byNumber(text); }
      if (products.length === 0) { toast('warn', `«${text}» не знайдено`); setHits(null); }
      else if (products.length === 1) await packProduct(products[0]);
      else setHits(products);
    } catch (e) { toast('err', errText(e, 'Пошук не вдався')); }
    finally { setSearching(false); }
  };

  const start = () => {
    setScanning(true);
    stopRef.current = scanMany(`Пакую в ${box.code} · скануйте товари поспіль`, async (code) => {
      try {
        const r = await scanResolve(code);
        if (r.kind === 'box') { toast('warn', `Це коробка ${r.box.code}, а не товар`); return false; }
        const p = r.kind === 'product' ? r.product : (r.products.length === 1 ? r.products[0] : null);
        if (!p) { toast('warn', 'Кілька розмірів з таким номером — відкрийте товар окремо'); return false; }
        if (p.available_qty <= 0) { toast('warn', `${p.number} ПРОДАНО — не кладу`); return false; }
        const done = await packInto(box, p, 1);
        if (done) setLog(l => [{ number: p.number, size: p.size, qty: 1 }, ...l]);
      } catch (e) { toast('err', isNetworkError(e) ? 'Немає мережі, і цього коду ще нема в копії' : errText(e, 'Не впізнав код')); }
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
  useEffect(() => {
    api.boxes()
      .then(r => { noteOnline(); remember.boxes(r.boxes); setBoxes(r.boxes.filter(b => b.status !== 'archived')); })
      .catch(e => { if (isNetworkError(e)) { setOnline(false); setBoxes(cached.boxes().filter(b => b.status !== 'archived')); } else setErr(errText(e, 'Не вдалося завантажити')); });
  }, []);
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
  const [noNet, setNoNet] = useState(false);
  useEffect(() => { api.nextCode(cat).then(r => { setCode(r.code); setNoNet(false); }).catch(e => { if (isNetworkError(e)) setNoNet(true); }); }, [cat]);
  const create = async () => {
    setBusy(true);
    const clean = code.trim().toUpperCase();
    try {
      const { result, queued } = await runOrQueue(
        () => api.createBox({ code: clean, category: cat, title: title.trim() || undefined, location: loc.trim() || undefined }),
        { kind: 'createBox', args: { code: clean, category: cat, title: title.trim() || undefined, location: loc.trim() || undefined }, label: `нова коробка ${clean}` });
      if (result) { remember.box(result); toast('ok', `Коробку ${result.code} створено`); onCreated(result); }
      else if (queued) { toast('warn', QUEUED); const local = cached.box(clean); if (local) onCreated(local); }
    }
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
        {noNet && <div className="wh-banner warn"><IAlert size={24} /><div>Немає мережі — код підказати не можу.<div className="sub">Введіть код руками (напр. {cat}12). Якщо такий уже є, дізнаємось при синхронізації.</div></div></div>}
        <div className="wh-hint">Етикетку коробки (QR <b>bms:b:{code || '…'}</b>) можна надрукувати одразу після створення: «···» → «Надрукувати етикетку».</div>
      </div>
      <Bar>
        <button className="wh-btn primary huge" disabled={busy || !code.trim()} onClick={create}><IPlus size={28} /> Створити {code}</button>
      </Bar>
    </>
  );
}
