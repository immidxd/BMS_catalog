// Разова підказка-«вказівка» на кнопку (для новачків і тих, хто давно не заходив; коли
// показувати — вирішує onboarding.ts і місце виклику). М'яке пульсуюче кільце навколо
// кнопки + темна плашка зі стрілочкою, що двічі легко «тицяє» в неї. Будь-який дотик
// ховає (сам дотик спрацьовує як звичайно), інакше зникає сама. Порталом у body —
// поверх листів, і позиція не залежить від трансформованих батьків.
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 12;    // відступ плашки від країв екрана
const GAP = 12;       // від кнопки до плашки (з урахуванням стрілочки)
const LIFE_MS = 4500;

export const CoachMark = ({ target, text, onDone }: {
  target: HTMLElement | null;
  text: string;
  onDone: () => void;
}) => {
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [leaving, setLeaving] = useState(false);

  useLayoutEffect(() => {
    const measure = () => setRect(target?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [target]);

  useEffect(() => {
    let gone = 0;
    const hide = () => {
      setLeaving(true);
      window.clearTimeout(gone);
      gone = window.setTimeout(onDone, 180);
    };
    const auto = window.setTimeout(hide, LIFE_MS);
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', hide, opts);
    window.addEventListener('keydown', hide, opts);
    return () => {
      window.clearTimeout(auto);
      window.clearTimeout(gone);
      window.removeEventListener('pointerdown', hide, opts);
      window.removeEventListener('keydown', hide, opts);
    };
  }, [onDone]);

  if (!rect || rect.width === 0) return null;
  const cx = rect.left + rect.width / 2;
  // Плашка — під кнопкою; по горизонталі центр навпроти кнопки, але не за краєм екрана
  const width = Math.min(260, window.innerWidth - MARGIN * 2);
  const left = Math.max(MARGIN, Math.min(cx - width / 2, window.innerWidth - MARGIN - width));
  const pad = 4;
  return createPortal(
    <div className={`coach${leaving ? ' out' : ''}`} aria-live="polite">
      <span className="coach-ring" style={{
        left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2,
      }} />
      <div className="coach-bubble" role="status" style={{ left, top: rect.bottom + GAP, width }}>
        <span className="coach-arrow" style={{ left: Math.max(14, Math.min(cx - left, width - 14)) }} />
        {text}
      </div>
    </div>,
    document.body,
  );
};
