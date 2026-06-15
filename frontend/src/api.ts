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
  genders: FilterOption[];
  color_groups: ColorGroupOption[];
};

export const fetchFacets = (query: CatalogQuery): Promise<Facets> =>
  fetchJson<Facets>(`/api/catalog/facets?${buildParams(query, 1, 1)}`);

export const fetchProduct = (id: number): Promise<ProductDetail> => fetchJson(`/api/catalog/${id}`);

export const fetchConfig = (): Promise<{ seller_username: string; shop_name: string; admin_tg_ids: number[] }> =>
  fetchJson('/api/config');

export const formatPrice = (price: number): string =>
  `${new Intl.NumberFormat('uk-UA').format(price)} грн`;
