// Вибір розмірів перед «Замовити» для ростовки: покупець відмічає один чи кілька, і
// менеджер одразу отримує повний запит. Один розмір цього кроку не має — там
// «Замовити» веде в чат одразу.
//
// Порталом у body: картка живе в трансформованій панелі стрічки, і position:fixed
// усередині неї поїхав би разом зі скролом панелі.
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { SizeVariant } from '../api';
import { haptic, pushBackLayer } from '../telegram';

type Props = {
  variants: SizeVariant[];
  label: (v: SizeVariant) => string;
  onOrder: (chosen: SizeVariant[]) => void;
  onClose: () => void;
};

// «Замовити 2 розміри» / «5 розмірів» — кількість видно на самій кнопці
const orderLabel = (n: number): string => {
  if (n < 2) return 'Замовити';
  const few = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
  return `Замовити ${n} ${few ? 'розміри' : 'розмірів'}`;
};

export const SizeSheet = ({ variants, label, onOrder, onClose }: Props) => {
  const [picked, setPicked] = useState<number[]>([]);

  // Esc і «Назад» Telegram закривають лист, а не саму картку
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const offBack = pushBackLayer(onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      offBack();
    };
  }, [onClose]);

  const toggle = (id: number) => {
    haptic('light');
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };
  const chosen = variants.filter((v) => picked.includes(v.id));

  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet size-sheet" role="dialog" aria-label="Вибір розміру">
        <div className="sheet-header">
          <h2>Оберіть розмір</h2>
          <button type="button" className="sheet-reset" onClick={() => { haptic('light'); onClose(); }}>
            Закрити
          </button>
        </div>
        <div className="sheet-body">
          <p className="size-sheet-note">Можна кілька</p>
          <div className="filter-options">
            {variants.map((v) => (
              <button type="button" key={v.id}
                className={`size-pill pickable${picked.includes(v.id) ? ' on' : ''}`}
                aria-pressed={picked.includes(v.id)} onClick={() => toggle(v.id)}>
                {label(v)}
                {v.measurementscm && v.sizeeu && <span className="option-count">{v.measurementscm} см</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="sheet-footer">
          <button type="button" className="btn-primary" disabled={chosen.length === 0}
            onClick={() => onOrder(chosen)}>
            {orderLabel(chosen.length)}
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};
