// Повноекранний перегляд фото з масштабуванням. Магазин продає в тому числі
// вживане й стокове взуття — можливість роздивитися підошву чи потертість це не
// зручність, а умова довіри. Раніше зум був заборонений на рівні viewport.
//
// Один набір жестів на Pointer Events працює і пальцем, і мишею:
//   палець — щипок, подвійний тап, тягнути (панорама), свайп ← → між фото,
//            свайп вниз — закрити;
//   миша   — колесо (масштаб у точку курсора), подвійний клік, тягнути,
//            стрілки ← →, Esc — закрити.
import { useEffect, useRef, useState } from 'react';
import { ProductImage } from '../api';
import { haptic } from '../telegram';

type Props = {
  images: ProductImage[];
  index: number;
  alt: string;
  onClose: () => void;
};

const MAX_SCALE = 4;
const DOUBLE_TAP_SCALE = 2.5;
const SWIPE_PX = 60;          // поріг зміни фото / закриття свайпом
const DOUBLE_TAP_MS = 300;

type Point = { x: number; y: number };

export const Lightbox = ({ images, index, alt, onClose }: Props) => {
  const [current, setCurrent] = useState(index);
  const [zoomed, setZoomed] = useState(false);   // лише для курсора/підказки
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // Стан жесту тримаємо в ref: рух пальця має йти без ререндерів, інакше він «рваний»
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef({ startDist: 0, startScale: 1, startX: 0, startY: 0, mid: { x: 0, y: 0 },
    downAt: 0, downPoint: { x: 0, y: 0 }, lastTap: 0, moved: false });

  const apply = (animate = false) => {
    const el = imgRef.current;
    if (!el) return;
    const { scale, x, y } = view.current;
    el.style.transition = animate ? 'transform .22s cubic-bezier(.22,.61,.36,1)' : 'none';
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
  };

  // Не даємо картинці «поїхати» за межі екрана: панорама обмежена реальним
  // перерозміром зображення, тож порожнього поля збоку не буває.
  const clamp = () => {
    const el = imgRef.current;
    const stage = stageRef.current;
    if (!el || !stage) return;
    const { scale } = view.current;
    const maxX = Math.max(0, (el.clientWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (el.clientHeight * scale - stage.clientHeight) / 2);
    view.current.x = Math.min(maxX, Math.max(-maxX, view.current.x));
    view.current.y = Math.min(maxY, Math.max(-maxY, view.current.y));
  };

  const setScaleAt = (next: number, cx: number, cy: number, animate = false) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const px = cx - rect.left - rect.width / 2;
    const py = cy - rect.top - rect.height / 2;
    const prev = view.current.scale;
    const scale = Math.min(MAX_SCALE, Math.max(1, next));
    // Точка під пальцем/курсором лишається на місці — масштаб «у точку», а не в центр
    view.current.x = px - ((px - view.current.x) * scale) / prev;
    view.current.y = py - ((py - view.current.y) * scale) / prev;
    view.current.scale = scale;
    if (scale === 1) { view.current.x = 0; view.current.y = 0; }
    clamp();
    apply(animate);
    setZoomed(scale > 1);
  };

  const reset = (animate = false) => {
    view.current = { scale: 1, x: 0, y: 0 };
    apply(animate);
    setZoomed(false);
  };

  const goTo = (next: number) => {
    const total = images.length;
    if (total < 2) return;
    setCurrent((next + total) % total);
    reset();
    haptic('light');
  };

  // Нове фото — завжди з масштабу 1:1
  useEffect(() => { reset(); }, [current]);

  // Клавіатура (десктоп) + блокування прокрутки сторінки під переглядачем
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') goTo(current + 1);
      if (e.key === 'ArrowLeft') goTo(current - 1);
      if (e.key === '0') reset(true);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [current, images.length, onClose]);

  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  const onPointerDown = (e: React.PointerEvent) => {
    // Захоплення вказівника — бажане, але не обов'язкове: воно кидає NotFoundError,
    // якщо вказівник уже відпущено. Без try/catch виняток обірвав би весь обробник,
    // і жест не почався б узагалі.
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* не критично */ }
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.startDist = dist(a, b);
      g.startScale = view.current.scale;
      g.mid = mid(a, b);
    } else if (pointers.current.size === 1) {
      g.downAt = Date.now();
      g.downPoint = { x: e.clientX, y: e.clientY };
      g.startX = view.current.x;
      g.startY = view.current.y;
      g.moved = false;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;

    if (pointers.current.size === 2) {          // щипок
      const [a, b] = [...pointers.current.values()];
      const ratio = dist(a, b) / (g.startDist || 1);
      setScaleAt(g.startScale * ratio, g.mid.x, g.mid.y);
      g.moved = true;
      return;
    }
    const dx = e.clientX - g.downPoint.x;
    const dy = e.clientY - g.downPoint.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) g.moved = true;

    if (view.current.scale > 1) {               // панорама збільшеного фото
      view.current.x = g.startX + dx;
      view.current.y = g.startY + dy;
      clamp();
      apply();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const start = g.downPoint;
    const wasSingle = pointers.current.size === 1;
    pointers.current.delete(e.pointerId);
    if (!wasSingle) return;

    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    // Подвійний тап/клік — перемикач 1:1 ↔ збільшено (у точку дотику)
    if (!g.moved && Date.now() - g.downAt < DOUBLE_TAP_MS) {
      const now = Date.now();
      if (now - g.lastTap < DOUBLE_TAP_MS) {
        g.lastTap = 0;
        haptic('light');
        if (view.current.scale > 1) reset(true);
        else setScaleAt(DOUBLE_TAP_SCALE, e.clientX, e.clientY, true);
        return;
      }
      g.lastTap = now;
      return;
    }

    if (view.current.scale > 1) return;         // збільшене фото свайпами не гортаємо
    if (dy > SWIPE_PX && Math.abs(dy) > Math.abs(dx)) { onClose(); return; }
    if (Math.abs(dx) > SWIPE_PX) goTo(current + (dx < 0 ? 1 : -1));
  };

  // Колесо миші — масштаб у точку курсора (десктоп)
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScaleAt(view.current.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX, e.clientY);
  };

  const image = images[current];
  return (
    <div className="lightbox" role="dialog" aria-label="Перегляд фото">
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Закрити">✕</button>
      {images.length > 1 && (
        <div className="lightbox-counter">{current + 1} / {images.length}</div>
      )}
      <div className={`lightbox-stage${zoomed ? ' zoomed' : ''}`} ref={stageRef}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove}
        onPointerUp={onPointerUp} onPointerCancel={onPointerUp} onWheel={onWheel}>
        <img ref={imgRef} src={image.url} alt={alt} draggable={false} />
      </div>
      {images.length > 1 && (
        <>
          <button type="button" className="lightbox-arrow prev" aria-label="Попереднє фото"
            onClick={() => goTo(current - 1)}>‹</button>
          <button type="button" className="lightbox-arrow next" aria-label="Наступне фото"
            onClick={() => goTo(current + 1)}>›</button>
        </>
      )}
      <div className="lightbox-hint">
        {zoomed ? 'Тягніть, щоб роздивитись' : 'Подвійний тап або щипок — збільшити'}
      </div>
    </div>
  );
};
