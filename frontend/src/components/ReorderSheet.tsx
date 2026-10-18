// Панель «Порядок рекомендованих» — плавне вертикальне перетягування (для адміна).
// Техніка без FLIP-бібліотек: DOM-порядок рядків СТАЛИЙ, позицію задає transform
// translateY(index*H). Зміна порядку → міняються лише transform-и → CSS-анімація.
// Рядок, який тягнуть, слідує за пальцем (translateY без transition); решта — плавно.
// Список прокручується сам (на десктопі Telegram він не вміщався й обрізався), а
// біля краю під час перетягування — автопрокрутка. «Перемішати» й «Оновити» лише
// готують набір; у вітрину він іде за «Готово».
import { useEffect, useRef, useState } from 'react';
import { CatalogItem, formatPrice } from '../api';
import { haptic } from '../telegram';

const ROW_H = 64;   // висота рядка, px (узгоджено з CSS .reorder-row)
const EDGE = 48;    // зона автопрокрутки біля краю списку, px

export const ReorderSheet = ({ featured, onSave, onClose, loadCandidates }: {
  featured: CatalogItem[];              // рекомендовані у поточному порядку
  onSave: (order: string[], replaced: boolean) => void;   // новий порядок; replaced — змінився сам набір
  onClose: () => void;
  loadCandidates?: (count: number, exclude: string[]) => Promise<CatalogItem[]>;
}) => {
  // ЗНІМОК списку при відкритті: далі не залежимо від зовнішніх змін (нескінченний
  // скрол міг додавати ще featured-товари й псувати порядок під час перетягування).
  const [rows, setRows] = useState<CatalogItem[]>(() => featured);
  const [order, setOrder] = useState<string[]>(() => featured.map((f) => f.productnumber));
  const orderRef = useRef(order); orderRef.current = order;
  const [dragPn, setDragPn] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);
  const [replaced, setReplaced] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const shown = useRef(new Set(featured.map((f) => f.productnumber)));   // усе, що вже пропонували
  const startIdxRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timer = useRef(0);   // автопрокрутка біля краю (таймер, а не rAF — не залежить від видимості вкладки)
  useEffect(() => () => window.clearInterval(timer.current), []);

  const startDrag = (pn: string, e: React.PointerEvent) => {
    e.preventDefault();
    try { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    const el = scrollRef.current;
    const startY = e.clientY;
    const startScroll = el?.scrollTop ?? 0;
    let lastY = startY;
    startIdxRef.current = orderRef.current.indexOf(pn);
    setDragPn(pn);
    haptic('light');
    // Положення рядка = зсув пальця + наскільки список прокрутився з початку жесту
    const place = () => {
      const dy = lastY - startY + ((el?.scrollTop ?? 0) - startScroll);
      setDragDy(dy);
      let to = Math.round((startIdxRef.current * ROW_H + dy) / ROW_H);
      to = Math.max(0, Math.min(orderRef.current.length - 1, to));
      const from = orderRef.current.indexOf(pn);
      if (to !== from) {
        const next = orderRef.current.filter((p) => p !== pn);
        next.splice(to, 0, pn);
        setOrder(next);
      }
    };
    window.clearInterval(timer.current);
    timer.current = window.setInterval(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const step = lastY < r.top + EDGE ? -8 : lastY > r.bottom - EDGE ? 8 : 0;
      if (step) { el.scrollTop += step; place(); }
    }, 16);
    const onMove = (ev: PointerEvent) => { lastY = ev.clientY; place(); };
    const onUp = () => {
      window.clearInterval(timer.current);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragPn(null);
      setDragDy(0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Випадковий порядок (Фішер — Єйтс)
  const shuffle = () => {
    haptic('light');
    const next = [...orderRef.current];
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    setOrder(next);
  };

  // Новий набір під сезон; якщо кандидатів менше — решту місць лишаємо за поточними
  const refresh = async () => {
    if (!loadCandidates || refreshing) return;
    haptic('light');
    setRefreshing(true);
    try {
      const fresh = await loadCandidates(rows.length, [...shown.current]);
      if (fresh.length === 0) return;
      fresh.forEach((f) => shown.current.add(f.productnumber));
      const keep = orderRef.current.slice(0, Math.max(0, rows.length - fresh.length))
        .map((pn) => rows.find((r) => r.productnumber === pn)!).filter(Boolean);
      const next = [...fresh, ...keep];
      setRows(next);
      setOrder(next.map((r) => r.productnumber));
      setReplaced(true);
      scrollRef.current?.scrollTo({ top: 0 });
    } catch { /* без мережі — лишаємо як було */ } finally {
      setRefreshing(false);
    }
  };

  const done = () => { onSave(orderRef.current, replaced); onClose(); };

  return (
    <>
      <div className="sheet-backdrop" onClick={done} aria-hidden="true" />
      <div className="sheet reorder-sheet" role="dialog" aria-label="Порядок рекомендованих">
        <div className="sheet-header">
          <h2>Порядок рекомендованих</h2>
          <button type="button" className="sheet-reset" onClick={done}>Готово</button>
        </div>
        <div className="reorder-tools">
          <span className="reorder-hint">Перетягніть за ручку ⠿, щоб змінити порядок у вітрині</span>
          <button type="button" className="reorder-tool" onClick={shuffle} title="Перемішати порядок">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 4l3 3l-3 3" /><path d="M18 20l3 -3l-3 -3" /><path d="M3 7h3a5 5 0 0 1 5 5a5 5 0 0 0 5 5h5" /><path d="M21 7h-5a4.978 4.978 0 0 0 -3 1m-4 8a4.984 4.984 0 0 1 -3 1h-3" />
            </svg>
            Перемішати
          </button>
          {loadCandidates && (
            <button type="button" className="reorder-tool" onClick={refresh} disabled={refreshing} title="Інші товари під поточний сезон">
              <svg className={refreshing ? 'spin' : ''} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4" /><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4" />
              </svg>
              Оновити
            </button>
          )}
        </div>
        <div className="reorder-scroll" ref={scrollRef}>
          <div className="reorder-list" style={{ height: order.length * ROW_H }}>
            {rows.map((f) => {
              const pn = f.productnumber;
              const dragging = dragPn === pn;
              const y = dragging ? startIdxRef.current * ROW_H + dragDy : order.indexOf(pn) * ROW_H;
              return (
                <div key={pn} className={`reorder-row${dragging ? ' dragging' : ''}`}
                  style={{ transform: `translateY(${y}px)`, transition: dragging ? 'none' : 'transform 0.18s ease' }}>
                  <span className="reorder-handle" title="Перетягнути"
                    onPointerDown={(e) => startDrag(pn, e)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
                      <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
                      <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
                    </svg>
                  </span>
                  {f.image
                    ? <img className="reorder-thumb" src={f.image} alt="" loading="lazy" />
                    : <span className="reorder-thumb reorder-thumb-empty" />}
                  <div className="reorder-info">
                    <div className="reorder-brand">{f.brand ?? f.type ?? ' '}</div>
                    <div className="reorder-title">{f.model ?? f.type ?? f.productnumber}</div>
                  </div>
                  <span className="reorder-price">{formatPrice(f.sale_price ?? f.price)}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
};
