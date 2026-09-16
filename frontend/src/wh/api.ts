// Клієнт API складу (/api/wh/*). Авторизація: підписаний Telegram initData
// (працівник у білому списку) або, поза Telegram для розробки, адмін-токен
// із ?token=… (кладеться в sessionStorage, у URL не лишається).
import { initDataRaw } from '../telegram';

export type Location = {
  box_code: string; box_title: string | null; box_location: string | null;
  box_status: string; needs_check: boolean; qty: number; packed_at: string;
};

export type Product = {
  id: number; productnumber: string; number: string; size: string; insole: string;
  brand: string | null; model: string | null; type: string | null; color: string | null;
  gender: string | null; season: string | null; condition: string | null;
  price: number | null; quantity: number; sold_count: number; available_qty: number;
  image: string | null; locations: Location[]; missing?: boolean;
};

export type BoxItem = { item_id: number; product_id: number; qty: number; packed_at: string; packed_by: string | null; product: Product };

export type Box = {
  id: number; code: string; category: string | null; title: string | null; location: string | null;
  status: 'open' | 'sealed' | 'archived'; needs_check: boolean; note: string | null;
  items: number; units: number; value: number; created_at: string; sealed_at: string | null;
  checked_at: string | null; contents?: BoxItem[];
};

export type ScanResult =
  | { kind: 'product'; product: Product }
  | { kind: 'products'; products: Product[]; stale_sticker?: boolean }
  | { kind: 'box'; box: Box };

export type WhEvent = {
  id: number; at: string; actor: string | null; kind: string; box_code: string | null;
  productnumber: string | null; qty: number | null; details: Record<string, unknown> | null;
};

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, detail: unknown) {
    super(typeof detail === 'string' ? detail : (detail as any)?.message || `HTTP ${status}`);
    this.status = status;
    this.detail = detail;
  }
}

const TOKEN_KEY = 'bmswh-token';

(function pickDevToken() {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (t) {
      sessionStorage.setItem(TOKEN_KEY, t);
      u.searchParams.delete('token');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    }
  } catch { /* ignore */ }
})();

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  const init = initDataRaw();
  if (init) h['X-Telegram-Init-Data'] = init;
  const tok = sessionStorage.getItem(TOKEN_KEY);
  if (tok) h['Authorization'] = `Bearer ${tok}`;
  return h;
}

export function hasAuth(): boolean {
  return Boolean(initDataRaw() || sessionStorage.getItem(TOKEN_KEY));
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.detail ?? data ?? res.statusText);
  return data as T;
}

const q = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&');

export const api = {
  scan: (code: string) => req<ScanResult>('GET', `/api/wh/scan?${q({ code })}`),
  search: (text: string) => req<{ products: Product[] }>('GET', `/api/wh/search?${q({ q: text })}`),
  product: (id: number) => req<Product>('GET', `/api/wh/products/${id}`),
  boxes: () => req<{ boxes: Box[] }>('GET', '/api/wh/boxes'),
  box: (code: string) => req<Box>('GET', `/api/wh/boxes/${encodeURIComponent(code)}`),
  nextCode: (category: string) => req<{ code: string }>('GET', `/api/wh/boxes/next-code?${q({ category })}`),
  createBox: (p: { code?: string; category?: string; title?: string; location?: string }) => req<Box>('POST', '/api/wh/boxes', p),
  patchBox: (code: string, p: Partial<Pick<Box, 'title' | 'location' | 'note' | 'needs_check'>>) =>
    req<Box>('PATCH', `/api/wh/boxes/${encodeURIComponent(code)}`, p),
  seal: (code: string) => req<Box>('POST', `/api/wh/boxes/${encodeURIComponent(code)}/seal`),
  open: (code: string) => req<Box>('POST', `/api/wh/boxes/${encodeURIComponent(code)}/open`),
  check: (code: string) => req<Box>('POST', `/api/wh/boxes/${encodeURIComponent(code)}/check`),
  deleteBox: (code: string, force = false) =>
    req<{ deleted: string; unpacked_items: number }>('DELETE', `/api/wh/boxes/${encodeURIComponent(code)}${force ? '?force=true' : ''}`),
  pack: (code: string, product_id: number, qty = 1, move = false) =>
    req<{ ok: boolean; box: string; product: Product; moved_from: string[]; warning: string | null }>(
      'POST', `/api/wh/boxes/${encodeURIComponent(code)}/pack`, { product_id, qty, move }),
  unpackFrom: (code: string, product_id: number, qty?: number) =>
    req<{ ok: boolean }>('POST', `/api/wh/boxes/${encodeURIComponent(code)}/unpack`, { product_id, qty: qty ?? null }),
  unpack: (product_id: number, qty?: number) =>
    req<{ ok: boolean; unpacked: { box_code: string; qty: number }[] }>('POST', '/api/wh/unpack', { product_id, qty: qty ?? null }),
  unpackAll: (code: string) => req<{ ok: boolean; unpacked_items: number; units: number }>(
    'POST', `/api/wh/boxes/${encodeURIComponent(code)}/unpack-all`),
  events: (p: { box?: string; product_id?: number; limit?: number }) =>
    req<{ events: WhEvent[] }>('GET', `/api/wh/events?${q(p)}`),
};
