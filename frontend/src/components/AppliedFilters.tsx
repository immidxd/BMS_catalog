// Застосовані фільтри над сіткою — кожен окремим чіпом із «×», як у великих магазинах:
// видно, ЩО звужує список, і будь-що прибирається одним тапом, без відкриття шторки.
// Те, що вже видно в ряду чіпів (сезонний чіп, «Сумки», «Знижки», «Обране»), не дублюємо.
import { CatalogQuery, FilterOption, FilterOptions, capSlash, formatPrice } from '../api';
import { hapticSelect } from '../telegram';

type Applied = { key: string; label: string; swatch?: string | null; drop: (q: CatalogQuery) => CatalogQuery };
type IdKey = 'typeids' | 'genderids' | 'brandids' | 'color_group_ids' | 'conditionids';

const LETTERS = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
const letterRank = (l: string) => { const i = LETTERS.indexOf(l.toUpperCase()); return i < 0 ? 99 : i; };
const rank = (list: FilterOption[] | undefined, id: number) => { const i = list?.findIndex((o) => o.id === id) ?? -1; return i < 0 ? 1e9 : i; };

const without = <T,>(list: T[] | undefined, v: T): T[] | undefined => {
  const next = (list ?? []).filter((x) => x !== v);
  return next.length ? next : undefined;
};

export const AppliedFilters = ({ query, options, hideSeasons, hideTypeId, onChange }: {
  query: CatalogQuery;
  options: FilterOptions | null;
  hideSeasons: boolean;           // сезон уже показаний активним чіпом у ряду
  hideTypeId?: number | null;     // «Сумки» — теж окремий чіп у ряду
  onChange: (next: CatalogQuery) => void;
}) => {
  const items: Applied[] = [];
  // Порядок — як у шторці, а не як клікали: розміри за зростанням, решта — за списком опцій
  [...(query.eu_sizes ?? [])].sort((a, b) => a - b).forEach((n) => items.push({ key: `eu${n}`, label: `${n} EU`, drop: (q) => ({ ...q, eu_sizes: without(q.eu_sizes, n) }) }));
  [...(query.size_letters ?? [])].sort((a, b) => letterRank(a) - letterRank(b)).forEach((l) => items.push({ key: `sz${l}`, label: l, drop: (q) => ({ ...q, size_letters: without(q.size_letters, l) }) }));
  const ids = (key: IdKey, list: FilterOption[] | undefined, skip?: number | null) =>
    [...(query[key] ?? [])].sort((a, b) => rank(list, a) - rank(list, b)).forEach((id) => {
      if (id === skip) return;
      const opt = list?.find((o) => o.id === id);
      if (!opt) return;
      const swatch = key === 'color_group_ids' ? (opt as FilterOption & { hex_code?: string | null }).hex_code : undefined;
      items.push({ key: `${key}${id}`, label: capSlash(opt.name) ?? opt.name, swatch, drop: (q) => ({ ...q, [key]: without(q[key], id) }) });
    });
  ids('typeids', options?.types, hideTypeId);
  ids('genderids', options?.genders);
  ids('brandids', options?.brands);
  ids('color_group_ids', options?.color_groups);
  ids('conditionids', options?.conditions);
  if (!hideSeasons) query.seasons?.forEach((s) => items.push({ key: `se${s}`, label: s, drop: (q) => ({ ...q, seasons: without(q.seasons, s) }) }));
  if (query.min_price != null || query.max_price != null) {
    const { min_price: lo, max_price: hi } = query;
    const label = lo != null && hi != null ? `${formatPrice(lo).replace(' грн', '')}–${formatPrice(hi)}`
      : lo != null ? `від ${formatPrice(lo)}` : `до ${formatPrice(hi!)}`;
    items.push({ key: 'price', label, drop: (q) => ({ ...q, min_price: undefined, max_price: undefined }) });
  }
  if (items.length === 0) return null;

  return (
    <div className="chips-row applied-row" aria-label="Застосовані фільтри">
      {items.map((it) => (
        <button type="button" key={it.key} className="chip chip-applied"
          aria-label={`Прибрати фільтр ${it.label}`}
          onClick={() => { hapticSelect(); onChange(it.drop(query)); }}>
          {it.swatch && <span className={`applied-swatch${it.swatch.toLowerCase() === '#ffffff' ? ' white' : ''}`} style={{ background: it.swatch }} />}
          {it.label}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M18 6L6 18" /><path d="M6 6l12 12" />
          </svg>
        </button>
      ))}
    </div>
  );
};
