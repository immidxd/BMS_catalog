// Картка товару в сітці каталогу
import { useEffect, useState } from 'react';
import { CatalogItem, discountPct, formatPrice, formatSeason } from '../api';

// priority — для перших видимих карток (above the fold): вантажимо одразу й
// з високим пріоритетом; решта — lazy (браузер сам відкладе позаекранні).
// admin/onTogglePublish — швидкий тумблер публікації (лише адмін, Фаза 2).
type Props = {
  item: CatalogItem;
  onOpen: (id: number) => void;
  priority?: boolean;
  admin?: boolean;
  onTogglePublish?: (item: CatalogItem) => void;
  onToggleFeatured?: (item: CatalogItem) => void;   // тумблер «Рекомендований» (адмін)
  onOpenReorder?: () => void;               // відкрити панель порядку рекомендованих (адмін)
  isFav?: boolean;                          // чи товар у «Обраному» користувача
  onToggleFav?: (item: CatalogItem) => void;
};

// Розміри для картки: пріоритет EU → літерні → см
const sizeLabel = (item: CatalogItem): string | null => {
  if (item.sizes.length > 0) return `${item.sizes.join(' · ')} EU`;
  if (item.size_letters.length > 0) return item.size_letters.join(' · ');
  if (item.measurementscm) return `${item.measurementscm} см`;
  return null;
};

export const ProductCard = ({ item, onOpen, priority = false, admin = false, onTogglePublish, onToggleFeatured, onOpenReorder, isFav = false, onToggleFav }: Props) => {
  const size = sizeLabel(item);
  const favCount = item.fav_count ?? 0;
  // Ключ спалаху ♥️ (0 = немає). Змінюємо число, щоб CSS-анімація перезапускалась
  // навіть при швидких повторних тапах.
  const [burst, setBurst] = useState(0);
  // Знімаємо спалах ТАЙМЕРОМ, а не по onAnimationEnd: якщо WebView у фоні (Telegram
  // згорнули) або система просить «менше руху», анімація не йде і подія animationend
  // не приходить — клас 'burst' залипав би назавжди й наступний «пух» не відтворився.
  useEffect(() => {
    if (!burst) return;
    const t = setTimeout(() => setBurst(0), 700);   // трохи довше за анімацію (0.62с)
    return () => clearTimeout(t);
  }, [burst]);
  // Знижка — ДВА джерела: акційна ціна каталогу (sale_price, products.price не чіпаємо)
  // АБО «стара» знижена ціна (oldprice > price, ціну вже скинуто в BMS). Обидві дають
  // бейдж −X% і закреслений оригінал.
  const catalogSale = item.sale_price != null && item.sale_price < item.price;
  const legacySale = !catalogSale && item.oldprice != null && item.oldprice > item.price;
  const onSale = catalogSale || legacySale;
  const shownPrice = catalogSale ? item.sale_price! : item.price;
  const original = catalogSale ? item.price : (legacySale ? item.oldprice! : null);
  // «unlisted» (не в каталозі) бачить лише адмін — публіці неопубліковані не доходять
  // «Рекомендований» і «−X%» НЕ конкурують: якщо товар і рекомендований, і зі знижкою —
  // показуємо обидва бейджі поруч (у спільному ряду .card-badges).
  const isFeatured = item.published && item.featured;
  const showFeatBadge = isFeatured;
  return (
    <div className="card-wrap" data-pn={item.productnumber}>
    <button type="button" className={`card${item.published ? '' : ' unlisted'}`}
      onClick={() => onOpen(item.id)} aria-label={`Товар ${item.productnumber}`}>
      <div className="card-image">
        {/* Ряд бейджів у верхньому лівому куті: спершу «Рекомендований», за ним знижка */}
        <div className={`card-badges${admin ? ' with-admin' : ''}`}>
          {!item.published && <span className="unlisted-badge">не в каталозі</span>}
          {/* Публіці — бейдж «Рекомендований»; адміну на рекомендованій — маленька
              ручка ⠿ (тап відкриває панель порядку). Додати/прибрати — зірка (нижче). */}
          {showFeatBadge && !admin && <span className="featured-badge">Рекомендований</span>}
          {isFeatured && admin && onOpenReorder && (
            <button type="button" className="feat-grip" title="Змінити порядок рекомендованих"
              onClick={(e) => { e.stopPropagation(); onOpenReorder(); }}>
              <GripIcon />
            </button>
          )}
          {item.published && onSale && original && <span className="sale-badge">−{discountPct(original, shownPrice)}%</span>}
        </div>
        {/* «Обране» ♥️ — у кутку фото: тап додає/прибирає, поряд публічний лічильник */}
        {onToggleFav && (
          <button type="button"
            className={`fav-btn${isFav ? ' on' : ''}${burst ? ' burst' : ''}`}
            onClick={(e) => {
              e.stopPropagation();
              if (!isFav) setBurst((n) => n + 1);   // спалах лише на ДОДАВАННЯ, не на зняття
              onToggleFav(item);
            }}
            aria-pressed={isFav}
            aria-label={isFav ? 'Прибрати з обраного' : 'Додати в обране'}>
            <HeartIcon filled={isFav} />
            {favCount > 0 && <span className="fav-count">{favCount}</span>}
            {/* Серце, що вилітає вгору й тане (декор — прихований від скрінрідерів) */}
            {burst > 0 && (
              <span className="fav-burst" key={burst} aria-hidden="true">
                <HeartIcon filled />
              </span>
            )}
          </button>
        )}
        {admin && (
          <span className="views-badge" title="Переглядів картки покупцями">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
            </svg>
            {item.views ?? 0}
          </span>
        )}
        {item.image
          ? <img src={item.image} alt={item.model ?? item.productnumber}
              loading={priority ? 'eager' : 'lazy'} decoding="async" />
          : <PhotoPlaceholder />}
      </div>
      <div className="card-body">
        <div className="card-brand">{item.brand ?? item.type ?? ' '}</div>
        <div className="card-title">{item.model ?? item.type ?? 'Без назви'}</div>
        <div className="card-meta">{[size, formatSeason(item.season)].filter(Boolean).join(' · ') || ' '}</div>
        <div>
          <span className={`price${onSale ? ' sale' : ''}`}>{formatPrice(shownPrice)}</span>
          {original && <span className="price-old">{formatPrice(original)}</span>}
        </div>
      </div>
    </button>

      {admin && onTogglePublish && (
        <button type="button"
          className={`pub-fab${item.published ? ' on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onTogglePublish(item); }}
          aria-pressed={item.published}
          title={item.published ? 'Прибрати з каталогу' : 'Опублікувати в каталозі'}>
          {item.published ? <EyeIcon /> : <EyeOffIcon />}
        </button>
      )}
      {/* Зірка — тумблер «Рекомендований» в ОБИДВА боки: залита (прибрати) / порожня (додати).
          Одна консистентна кнопка на всіх опублікованих картках. Грип ⠿ — окремо, лише порядок. */}
      {admin && onToggleFeatured && item.published && (
        <button type="button"
          className={`feat-fab${item.featured ? ' on' : ''}`}
          onClick={(e) => { e.stopPropagation(); onToggleFeatured(item); }}
          aria-pressed={item.featured}
          title={item.featured ? 'Прибрати з рекомендованих' : 'Позначити «Рекомендований»'}>
          <StarIcon filled={item.featured} />
        </button>
      )}
    </div>
  );
};

const GripIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
    <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
    <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
  </svg>
);

const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polygon points="12 2 15.1 8.6 22 9.3 17 14.1 18.2 21 12 17.6 5.8 21 7 14.1 2 9.3 8.9 8.6 12 2" />
  </svg>
);

const HeartIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
);

const EyeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
  </svg>
);

const EyeOffIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.9 4.2A9.1 9.1 0 0 1 12 4c6.5 0 10 7 10 7a13.2 13.2 0 0 1-2.2 2.9M6.1 6.1A13.3 13.3 0 0 0 2 11s3.5 7 10 7a9 9 0 0 0 3.8-.8" /><path d="M3 3l18 18" />
  </svg>
);

const PhotoPlaceholder = () => (
  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="8.5" cy="8.5" r="1.5" />
    <path d="M21 15l-5-5L5 21" />
  </svg>
);

export const SkeletonCard = () => (
  <div className="card skeleton" aria-hidden="true">
    <div className="card-image" />
    <div className="sk-line" />
    <div className="sk-line short" />
    <div style={{ height: 8 }} />
  </div>
);
