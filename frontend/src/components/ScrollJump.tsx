// Швидкі переходи по стрічці: ↑ — на початок, ↓ — туди, куди вже догорнули.
// Стрічка нескінченна (довантажується), тож «кінець» — це найдальша точка, до якої
// покупець дійшов: саме туди він хоче повернутися, стрибнувши нагору змінити чіп.
// Кнопки з'являються лише коли є куди стрибати (> 1.5 екрана) і плавно зникають.
import { useEffect, useRef, useState } from 'react';
import { haptic } from '../telegram';

type Props = {
  resetKey: string;   // змінився запит (фільтри/сорт/пошук) — стара «точка повернення» не має сенсу
  hidden: boolean;    // відкрита картка товару чи лист — кнопки не потрібні
};

const SCREENS = 1.5;

export const ScrollJump = ({ resetKey, hidden }: Props) => {
  const maxY = useRef(0);
  const [up, setUp] = useState(false);
  const [down, setDown] = useState(false);

  useEffect(() => { maxY.current = 0; setDown(false); }, [resetKey]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const y = window.scrollY;
      const gap = window.innerHeight * SCREENS;
      maxY.current = Math.max(maxY.current, y);
      setUp(y > gap);
      setDown(maxY.current - y > gap);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  const jump = (top: number) => {
    haptic('light');
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
  };

  return (
    <div className={`scroll-jump${hidden ? ' hidden' : ''}`}>
      <button type="button" className={`scroll-fab${up ? ' on' : ''}`} tabIndex={up ? 0 : -1}
        aria-label="На початок" title="На початок" onClick={() => jump(0)}>
        <Chevron up />
      </button>
      <button type="button" className={`scroll-fab${down ? ' on' : ''}`} tabIndex={down ? 0 : -1}
        aria-label="Туди, де ви зупинились" title="Туди, де ви зупинились"
        onClick={() => jump(Math.min(maxY.current, document.documentElement.scrollHeight - window.innerHeight))}>
        <Chevron />
      </button>
    </div>
  );
};

const Chevron = ({ up = false }: { up?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {up ? <polyline points="6 15 12 9 18 15" /> : <polyline points="6 9 12 15 18 9" />}
  </svg>
);
