import { initDataRaw, telegramUserId } from './telegram';

export type CatalogEventType =
  | 'catalog_open'
  | 'product_view'
  | 'favorite_add'
  | 'favorite_remove'
  | 'contact_click';

const VISITOR_KEY = 'bms-catalog-visitor-v1';
const SESSION_KEY = 'bms-catalog-session-v1';

const uuid = (): string => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
};

const storedUuid = (storage: Storage, key: string): string => {
  try {
    const old = storage.getItem(key);
    if (old) return old;
    const next = uuid();
    storage.setItem(key, next);
    return next;
  } catch {
    return uuid();
  }
};

export const catalogVisitorId = (): string => storedUuid(localStorage, VISITOR_KEY);
export const catalogSessionId = (): string => storedUuid(sessionStorage, SESSION_KEY);

export const analyticsHeaders = (): Record<string, string> => ({
  'X-Catalog-Visitor': catalogVisitorId(),
  'X-Catalog-Session': catalogSessionId(),
});

export const trackCatalogEvent = (
  eventType: CatalogEventType,
  productnumber?: string,
  metadata?: { channel?: 'telegram' | 'phone' | 'instagram' | 'viber'; size?: string },
): void => {
  const initData = initDataRaw();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...analyticsHeaders(),
  };
  if (initData) headers['X-Telegram-Init-Data'] = initData;
  void fetch('/api/analytics/events', {
    method: 'POST',
    headers,
    keepalive: true,
    body: JSON.stringify({
      event_id: uuid(),
      event_type: eventType,
      productnumber,
      metadata,
      user_id: telegramUserId ?? undefined,
    }),
  }).catch(() => { /* аналітика ніколи не блокує покупку чи навігацію */ });
};
