// Екран «Як купити»: оплата, доставка, обмін, гарантія оригіналу. Відкривається
// зі сторінки товару (там сумнів найгостріший) і з кінця сітки каталогу.
// Зміст приходить із бекенда (shop_info.py) разом із конфігом — без окремого запиту.
//
// Кожен блок читається у два кроки: іконка + заголовок + ГОЛОВНА відповідь, і вже
// під нею — деталі дрібнішим. Суцільний список рівноцінних пунктів читався як
// стіна тексту: очей нема за що зачепитись. Тепер відповідь ловиться поглядом.
import { useEffect } from 'react';
import { ShopInfoSection } from '../api';
import { haptic } from '../telegram';

type Props = {
  sections: ShopInfoSection[];
  sellerUsername: string;
  onClose: () => void;
};

// Мінімалістичні лінійні іконки — один стиль, один вага лінії, без заливок:
// вони мають розмічати текст, а не сперечатися з ним за увагу.
const Icon = ({ name }: { name: string }) => {
  const p = { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true };
  switch (name) {
    case 'order':      // чат
      return <svg {...p}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20l1.1-4a8.4 8.4 0 0 1-.9-3.8 8.4 8.4 0 0 1 8.4-8.4h.5a8.4 8.4 0 0 1 8 8z" /></svg>;
    case 'payment':    // картка
      return <svg {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></svg>;
    case 'delivery':   // фургон
      return <svg {...p}><path d="M1 3h13v13H1z" /><path d="M14 8h4l3 3v5h-7" /><circle cx="6" cy="19" r="2" /><circle cx="17" cy="19" r="2" /></svg>;
    case 'return':     // стрілка повернення
      return <svg {...p}><path d="M3 7v6h6" /><path d="M3.5 13a9 9 0 1 0 2.1-5.7L3 10" /></svg>;
    case 'original':   // щит
      return <svg {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="m9 12 2 2 4-4" /></svg>;
    case 'size':       // лінійка
      return <svg {...p}><rect x="2" y="8" width="20" height="8" rx="1.5" /><path d="M6 8v3M10 8v4M14 8v3M18 8v4" /></svg>;
    case 'condition':  // мітка
      return <svg {...p}><path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.2" /></svg>;
    default:
      return null;
  }
};

export const HowToBuySheet = ({ sections, sellerUsername, onClose }: Props) => {
  // Esc закриває — на десктопі це очікувана дія, а лист поверх усього
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet info-sheet" role="dialog" aria-label="Як купити">
        <div className="sheet-header">
          <h2>Як купити</h2>
          <button type="button" className="sheet-reset" onClick={() => { haptic('light'); onClose(); }}>
            Закрити
          </button>
        </div>
        <div className="sheet-body info-body">
          {sections.map((section) => (
            <section className="info-block" key={section.key ?? section.title}>
              <h3>
                <Icon name={section.key ?? ''} />
                {section.title}
                {/* Чернетка — видно лише коли ввімкнено SHOP_INFO_DRAFT; покупцям
                    такі блоки бекенд взагалі не віддає */}
                {section.draft && <span className="info-draft">чернетка</span>}
              </h3>
              {section.lead && <p className="info-lead">{section.lead}</p>}
              {section.items.length > 0 && (
                <ul>
                  {section.items.map((item) => <li key={item}>{item}</li>)}
                </ul>
              )}
            </section>
          ))}
          {sellerUsername && (
            <p className="info-tail">
              Лишилось питання — просто напишіть менеджеру, відповімо.
            </p>
          )}
        </div>
      </div>
    </>
  );
};
