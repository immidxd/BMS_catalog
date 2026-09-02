// Екран «Як купити»: оплата, доставка, обмін, гарантія оригіналу. Відкривається
// зі сторінки товару (там сумнів найгостріший) і з кінця сітки каталогу.
// Зміст приходить із бекенда (shop_info.py) разом із конфігом — без окремого запиту.
import { useEffect } from 'react';
import { ShopInfoSection } from '../api';
import { haptic } from '../telegram';

type Props = {
  sections: ShopInfoSection[];
  sellerUsername: string;
  onClose: () => void;
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
            <section className="info-block" key={section.title}>
              <h3>
                {section.title}
                {/* Чернетка — видно лише коли ввімкнено SHOP_INFO_DRAFT; покупцям
                    такі блоки бекенд взагалі не віддає */}
                {section.draft && <span className="info-draft">чернетка</span>}
              </h3>
              <ul>
                {section.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
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
