// Фільтри ↔ адреса: добіркою можна поділитися посиланням («жіночі, 38, зима»), а
// оновлення сторінки її не губить. Лише фільтри й сортування; інші параметри
// (?admin, ?hints) лишаються як були. Адресу ЗАМІНЮЄМО, а не додаємо крок в
// історію — інакше «назад» довелося б тиснути за кожен клік у фільтрах.
import { CatalogQuery } from './api';

type ListKey = 'typeids' | 'brandids' | 'genderids' | 'color_group_ids' | 'conditionids' | 'eu_sizes';
const NUM_LISTS: Record<string, ListKey> = {
  type: 'typeids', brand: 'brandids', gender: 'genderids', color: 'color_group_ids',
  cond: 'conditionids', eu: 'eu_sizes',
};
const STR_LISTS: Record<string, 'seasons' | 'size_letters'> = { season: 'seasons', size: 'size_letters' };
const OURS = ['sort', 'sale', 'pmin', 'pmax', ...Object.keys(NUM_LISTS), ...Object.keys(STR_LISTS)];
const SORTS = new Set(['price_asc', 'price_desc']);   // публічні; «Новинки» — без параметра

export const queryFromUrl = (search = window.location.search): Partial<CatalogQuery> => {
  const p = new URLSearchParams(search);
  const out: Partial<CatalogQuery> = {};
  for (const [param, key] of Object.entries(NUM_LISTS)) {
    const v = (p.get(param) ?? '').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
    if (v.length) out[key] = v;
  }
  for (const [param, key] of Object.entries(STR_LISTS)) {
    const v = (p.get(param) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (v.length) out[key] = v;
  }
  const num = (k: string) => { const n = Number(p.get(k)); return p.has(k) && Number.isFinite(n) && n >= 0 ? n : undefined; };
  if (num('pmin') !== undefined) out.min_price = num('pmin');
  if (num('pmax') !== undefined) out.max_price = num('pmax');
  if (p.get('sale') === '1') out.on_sale = true;
  const sort = p.get('sort');
  if (sort && SORTS.has(sort)) out.sort = sort as CatalogQuery['sort'];
  return out;
};

export const syncQueryToUrl = (query: CatalogQuery): void => {
  const p = new URLSearchParams(window.location.search);
  OURS.forEach((k) => p.delete(k));
  for (const [param, key] of Object.entries(NUM_LISTS)) if (query[key]?.length) p.set(param, query[key]!.join(','));
  for (const [param, key] of Object.entries(STR_LISTS)) if (query[key]?.length) p.set(param, query[key]!.join(','));
  if (query.min_price != null) p.set('pmin', String(query.min_price));
  if (query.max_price != null) p.set('pmax', String(query.max_price));
  if (query.on_sale) p.set('sale', '1');
  if (query.sort && SORTS.has(query.sort)) p.set('sort', query.sort);
  const qs = p.toString().replace(/%2C/g, ',');
  const next = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.replaceState(window.history.state, '', next);
  }
};
