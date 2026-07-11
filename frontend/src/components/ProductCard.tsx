// Картка товару в сітці каталогу
import { CatalogItem, formatPrice, formatSeason } from '../api';

// priority — для перших видимих карток (above the fold): вантажимо одразу й
// з високим пріоритетом; решта — lazy (браузер сам відкладе позаекранні).
// admin/onTogglePublish — швидкий тумблер публікації (лише адмін, Фаза 2).
type Props = {
  item: CatalogItem;
  onOpen: (id: number) => void;
  priority?: boolean;
  admin?: boolean;
  onTogglePublish?: (item: CatalogItem) => void;
};

// Розміри для картки: пріоритет EU → літерні → см
const sizeLabel = (item: CatalogItem): string | null => {
  if (item.sizes.length > 0) return `${item.sizes.join(' · ')} EU`;
  if (item.size_letters.length > 0) return item.size_letters.join(' · ');
  if (item.measurementscm) return `${item.measurementscm} см`;
  return null;
};

export const ProductCard = ({ item, onOpen, priority = false, admin = false, onTogglePublish }: Props) => {
  const size = sizeLabel(item);
  // «unlisted» (не в каталозі) бачить лише адмін — публіці неопубліковані не доходять
  return (
    <div className="card-wrap">
    <button type="button" className={`card${item.published ? '' : ' unlisted'}`}
      onClick={() => onOpen(item.id)} aria-label={`Товар ${item.productnumber}`}>
      <div className="card-image">
        {item.featured && <span className="featured-badge">Рекомендований</span>}
        {!item.published && <span className="unlisted-badge">не в каталозі</span>}
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
          <span className="price">{formatPrice(item.price)}</span>
          {item.oldprice && item.oldprice > item.price && (
            <span className="price-old">{formatPrice(item.oldprice)}</span>
          )}
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
    </div>
  );
};

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
