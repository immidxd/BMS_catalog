// Клієнт публічного API каталогу + типи відповідей

export type CatalogItem = {
  id: number;
  productnumber: string;
  model: string | null;
  brand: string | null;
  type: string | null;
  price: number;
  oldprice: number | null;
  sizes: string[];
  size_letters: string[];
  measurementscm: string | null;
  season: string | null;
  image: string | null;
  featured: boolean;
  published: boolean;   // для адмін-сітки: видно, що ввімкнено в каталог
};

export type CatalogResponse = {
  items: CatalogItem[];
  total: number;
  page: number;
  pages: number;
};

export type FilterOption = { id: number; name: string; count: number };
export type ColorGroupOption = FilterOption & { hex_code: string | null };

export type FilterOptions = {
  types: FilterOption[];
  subtypes: FilterOption[];
  brands: FilterOption[];
  genders: FilterOption[];
  conditions: FilterOption[];
  color_groups: ColorGroupOption[];
  eu: number[];   // стабільний «всесвіт» EU-розмірів (динаміка лише гасить недоступні)
  size_letters: string[];
  seasons: string[];
  price_range: { min: number; max: number };
};

export type ProductImage = { url: string; kind: 'official' | 'real' | 'defect' };

export type SizeVariant = {
  id: number;
  sizeeu: string | null;
  sizeua: string | null;
  size_letter: string | null;
  measurementscm: string | null;
  available: number;
};

export type ProductDetail = {
  id: number;
  productnumber: string;
  model: string | null;
  price: number;
  oldprice: number | null;
  sizeeu: string | null;
  sizeua: string | null;
  size_letter: string | null;
  measurementscm: string | null;
  season: string | null;
  description: string | null;
  subtypename: string | null;
  stylename: string | null;
  gendername: string | null;
  colorname: string | null;
  conditionname: string | null;
  brandname: string | null;
  typename: string | null;
  year: number | null;
  width: string | null;
  available: number;
  measurements_length_min: number | null;
  measurements_length_max: number | null;
  measurements_height_min: number | null;
  measurements_height_max: number | null;
  measurements_heel_min: number | null;
  measurements_heel_max: number | null;
  measurements_sole_thickness_min: number | null;
  measurements_sole_thickness_max: number | null;
  materials: Record<string, string[]>;
  images: ProductImage[];
  size_variants: SizeVariant[];
  published: boolean;
  featured: boolean;
};

export type CatalogQuery = {
  search?: string;
  typeids?: number[];
  subtypeids?: number[];
  brandids?: number[];
  genderids?: number[];
  color_group_ids?: number[];
  conditionids?: number[];
  seasons?: string[];
  sizeeu?: string[];
  size_letters?: string[];
  eu_sizes?: number[];
  min_price?: number;
  max_price?: number;
  has_photo?: boolean;
  only_published?: boolean;   // публіка=true; адмін може вимкнути, щоб бачити весь пул
  sort?: 'newest' | 'price_asc' | 'price_desc';
};

const buildParams = (query: CatalogQuery, page: number, perPage: number): URLSearchParams => {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('per_page', String(perPage));
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (Array.isArray(value)) value.forEach((v) => params.append(key, String(v)));
    else params.set(key, String(value));
  });
  return params;
};

const fetchJson = async <T>(url: string): Promise<T> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const fetchCatalog = (query: CatalogQuery, page: number, perPage = 20): Promise<CatalogResponse> =>
  fetchJson(`/api/catalog?${buildParams(query, page, perPage)}`);

export const fetchFilters = (): Promise<FilterOptions> => fetchJson('/api/catalog/filters');

// Динамічні фасети: EU-розміри, стать, кольорові групи — наявні в поточному
// наборі. Кожен фасет виключає свій фільтр — опції адаптуються під інші фільтри.
export type Facets = {
  eu: number[];
  size_letters: string[];
  genders: FilterOption[];
  color_groups: ColorGroupOption[];
};

export const fetchFacets = (query: CatalogQuery): Promise<Facets> =>
  fetchJson<Facets>(`/api/catalog/facets?${buildParams(query, 1, 1)}`);

export const fetchProduct = (id: number): Promise<ProductDetail> => fetchJson(`/api/catalog/${id}`);

export const fetchConfig = (): Promise<{
  seller_username: string; seller_phone: string; seller_instagram: string;
  shop_name: string; admin_tg_ids: number[]; admin_writes: boolean;
}> => fetchJson('/api/config');

// ── Адмін-запис публікації (Фаза 2) — захищений: Telegram initData АБО адмін-токен ──
export type AdminAuth = { initData?: string; token?: string };

export const setCatalogPublication = async (
  productnumber: string,
  payload: { is_published: boolean; is_featured?: boolean },
  auth: AdminAuth,
): Promise<{ productnumber: string; is_published: boolean; is_featured: boolean }> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.initData) headers['X-Telegram-Init-Data'] = auth.initData;
  else if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch('/api/admin/catalog', {
    method: 'PATCH', headers, body: JSON.stringify({ productnumber, ...payload }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

export const formatPrice = (price: number): string =>
  `${new Intl.NumberFormat('uk-UA').format(price)} грн`;

// Сезон для показу: якщо їх кілька і є «Всесезон» — «Всесезон» ховаємо
// (показуємо лише решту); розділювач — слеш. Один «Всесезон» лишаємо як є.
export const formatSeason = (season: string | null): string | null => {
  if (!season) return null;
  let parts = season.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) parts = parts.filter((p) => p.toLowerCase() !== 'всесезон');
  return parts.join(' / ') || season;
};
