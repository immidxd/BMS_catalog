// Картка товару в сітці каталогу
import { CatalogItem, formatPrice, formatSeason } from '../api';

type Props = { item: CatalogItem; onOpen: (id: number) => void };

// Розміри для картки: пріоритет EU → літерні → см
const sizeLabel = (item: CatalogItem): string | null => {
  if (item.sizes.length > 0) return `${item.sizes.join(' · ')} EU`;
  if (item.size_letters.length > 0) return item.size_letters.join(' · ');
  if (item.measurementscm) return `${item.measurementscm} см`;
  return null;
};

export const ProductCard = ({ item, onOpen }: Props) => {
  const size = sizeLabel(item);
  return (
    <button type="button" className="card" onClick={() => onOpen(item.id)} aria-label={`Товар ${item.productnumber}`}>
      <div className="card-image">
        {item.image
          ? <img src={item.image} alt={item.model ?? item.productnumber} loading="lazy" />
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
  );
};

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
