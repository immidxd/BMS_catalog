// Панель «Порядок рекомендованих» — плавне вертикальне перетягування (для адміна).
// Техніка без FLIP-бібліотек: DOM-порядок рядків СТАЛИЙ, позицію задає transform
// translateY(index*H). Зміна порядку → міняються лише transform-и → CSS-анімація.
// Рядок, який тягнуть, слідує за пальцем (translateY без transition); решта — плавно.
import { useRef, useState } from 'react';
import { CatalogItem, formatPrice } from '../api';
import { haptic } from '../telegram';

const ROW_H = 64;   // висота рядка, px (узгоджено з CSS .reorder-row)

export const ReorderSheet = ({ featured, onSave, onClose }: {
  featured: CatalogItem[];              // рекомендовані у поточному порядку
  onSave: (order: string[]) => void;    // новий порядок номерів
  onClose: () => void;
}) => {
  // ЗНІМОК списку при відкритті: далі не залежимо від зовнішніх змін (нескінченний
  // скрол міг додавати ще featured-товари й псувати порядок під час перетягування).
  const [rows] = useState<CatalogItem[]>(() => featured);
  const [order, setOrder] = useState<string[]>(() => rows.map((f) => f.productnumber));
  const orderRef = useRef(order); orderRef.current = order;
  const [dragPn, setDragPn] = useState<string | null>(null);
  const [dragDy, setDragDy] = useState(0);
  const startIdxRef = useRef(0);

  const startDrag = (pn: string, e: React.PointerEvent) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const startY = e.clientY;
    startIdxRef.current = orderRef.current.indexOf(pn);
    setDragPn(pn);
    haptic('light');
    const onMove = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      setDragDy(dy);
      // Куди має стати рядок за поточним положенням пальця (у межах списку)
      let to = Math.round((startIdxRef.current * ROW_H + dy) / ROW_H);
      to = Math.max(0, Math.min(orderRef.current.length - 1, to));
      const from = orderRef.current.indexOf(pn);
      if (to !== from) {
        const next = orderRef.current.filter((p) => p !== pn);
        next.splice(to, 0, pn);
        setOrder(next);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDragPn(null);
      setDragDy(0);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const done = () => { onSave(orderRef.current); onClose(); };

  return (
    <>
      <div className="sheet-backdrop" onClick={done} aria-hidden="true" />
      <div className="sheet reorder-sheet" role="dialog" aria-label="Порядок рекомендованих">
        <div className="sheet-header">
          <h2>Порядок рекомендованих</h2>
          <button type="button" className="sheet-reset" onClick={done}>Готово</button>
        </div>
        <div className="reorder-hint">Перетягніть за ручку ⠿, щоб змінити порядок у вітрині</div>
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
    </>
  );
};
