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
  views?: number;       // перегляди картки (адмін-бейдж)
  fav_count?: number;   // скільки людей додали в «Обране» (♥️, публічно)
  on_sale?: boolean;    // чи діє знижка (акційна ціна для вітрини)
  sale_price?: number | null;   // акційна ціна
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
  technology: string | null;   // сирий рядок технологій (напр. "Vibram, MEGAGRIP")
  year: number | null;
  width: string | null;
  dimensions: string | null;   // габарити сумки/валізи, напр. "40x20x5"
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
  description_public?: boolean;   // чи опис публічний (адмін керує)
  views?: number;       // перегляди картки (адмін)
  fav_count?: number;   // скільки людей у «Обраному» (♥️)
  on_sale?: boolean;    // чи діє знижка
  sale_price?: number | null;   // акційна ціна (для вітрини)
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
  favnums?: string[];         // «Обране»: показати лише ці номери товарів
  on_sale?: boolean;          // чіп «Знижки»: показати лише товари з активною знижкою
  has_photo?: boolean;
  only_published?: boolean;   // публіка=true; адмін може вимкнути, щоб бачити весь пул
  // публіка=true (зливаємо дублі-завози в одну картку); адмін=false (кожен номер окремо)
  group_offers?: boolean;
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

// admin=true → опції по всьому наявному пулу (для модерації, коли ще нічого не
// опубліковано); інакше — лише по опублікованих (публічний вид).
export const fetchFilters = (admin = false): Promise<FilterOptions> =>
  fetchJson(`/api/catalog/filters${admin ? '?only_published=false' : ''}`);

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

// admin=true → дозволяє відкрити деталь ЩЕ НЕ опублікованого товару (для модерації);
// інакше неопублікований → 404 (публіці не доступний).
export const fetchProduct = (id: number, admin = false): Promise<ProductDetail> =>
  fetchJson(`/api/catalog/${id}${admin ? '?only_published=false&group_offers=false' : ''}`);

// Мапа {productnumber: перегляди} — для «живого» оновлення адмін-бейджів (полінг)
export const fetchViews = (): Promise<Record<string, number>> =>
  fetchJson<{ views: Record<string, number> }>(`/api/catalog/views`).then((r) => r.views || {});

export const fetchConfig = (): Promise<{
  seller_username: string; seller_phone: string; seller_instagram: string; seller_viber: string;
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

// ── «Обране» (Фаза B) — серверне, авторизоване Telegram initData ──────────────
// Поза Telegram initData немає → фронт тримає обране локально (localStorage).
export const fetchFavorites = (initData: string): Promise<string[]> =>
  fetch('/api/favorites', { headers: { 'X-Telegram-Init-Data': initData } })
    .then((r) => (r.ok ? r.json() : { productnumbers: [] }))
    .then((d) => d.productnumbers || []);

export const toggleFavoriteServer = (
  productnumber: string, favorite: boolean, initData: string, userId?: number | null,
): Promise<{ fav_count: number }> =>
  fetch('/api/favorites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
    // user_id — непідписаний фолбек: дозволяє рахувати ♥️ навіть коли initData не
    // верифікується сервером (напр. Mini App від іншого бота).
    body: JSON.stringify({ productnumber, favorite, user_id: userId ?? undefined }),
  }).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

// ── Адмін: редагування/публікація опису (Фаза B) ─────────────────────────────
export const setCatalogDescription = async (
  payload: { product_id: number; productnumber: string; description?: string; is_public?: boolean },
  auth: AdminAuth,
): Promise<{ description: string | null; is_description_public: boolean | null }> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.initData) headers['X-Telegram-Init-Data'] = auth.initData;
  else if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch('/api/admin/catalog/description', {
    method: 'PATCH', headers, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Ідемпотентно синхронізує обране (з CloudStorage) у серверний лічильник ♥️ і повертає
// актуальні counts — щоб лічильники «наздогнали» обране зі старого бандла/іншого пристрою.
export const syncFavorites = (
  productnumbers: string[], initData: string, userId?: number | null,
): Promise<Record<string, number>> =>
  fetch('/api/favorites/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
    body: JSON.stringify({ productnumbers, user_id: userId ?? undefined }),
  }).then((r) => (r.ok ? r.json() : { counts: {} })).then((d) => d.counts || {}).catch(() => ({}));

// ── Адмін: знижка (Фаза C) — акційна ціна лише для вітрини ────────────────────
export const setCatalogDiscount = async (
  payload: { productnumber: string; sale_price: number | null; is_on_sale: boolean },
  auth: AdminAuth,
): Promise<{ sale_price: number | null; is_on_sale: boolean }> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.initData) headers['X-Telegram-Init-Data'] = auth.initData;
  else if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch('/api/admin/catalog/discount', {
    method: 'PATCH', headers, body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

// Відсоток знижки (для бейджа «−X%») — округлений
export const discountPct = (price: number, salePrice: number): number =>
  Math.round((1 - salePrice / price) * 100);

// Адмін: порядок рекомендованих товарів у вітрині (після перетягування)
export const setFeaturedOrder = async (productnumbers: string[], auth: AdminAuth): Promise<void> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth.initData) headers['X-Telegram-Init-Data'] = auth.initData;
  else if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
  const res = await fetch('/api/admin/catalog/featured-order', {
    method: 'PATCH', headers, body: JSON.stringify({ productnumbers }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
