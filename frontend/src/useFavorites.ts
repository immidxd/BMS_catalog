// «Обране» користувача: у Telegram — серверне (синхрон між пристроями за telegram_user_id),
// поза Telegram (браузер) — локальне (localStorage). Єдиний інтерфейс для UI.
import { useCallback, useEffect, useState } from 'react';
import { fetchFavorites, toggleFavoriteServer } from './api';
import { initDataRaw, isInTelegram } from './telegram';

const LS_KEY = 'tg-shop-favorites';
const loadLocal = (): string[] => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
};
const saveLocal = (list: string[]): void => localStorage.setItem(LS_KEY, JSON.stringify(list));

export const useFavorites = () => {
  const [favSet, setFavSet] = useState<Set<string>>(() => new Set(isInTelegram ? [] : loadLocal()));

  // У Telegram підтягуємо серверний список при старті
  useEffect(() => {
    if (isInTelegram && initDataRaw()) {
      fetchFavorites(initDataRaw()).then((list) => setFavSet(new Set(list))).catch(() => {});
    }
  }, []);

  const isFav = useCallback((pn: string) => favSet.has(pn), [favSet]);

  // Оптимістично перемикаємо; повертаємо новий стан і (для Telegram) серверний лічильник ♥️
  const toggle = useCallback((pn: string): Promise<{ favorite: boolean; fav_count?: number }> => {
    const next = !favSet.has(pn);
    setFavSet((cur) => {
      const s = new Set(cur);
      next ? s.add(pn) : s.delete(pn);
      if (!isInTelegram) saveLocal([...s]);
      return s;
    });
    if (isInTelegram && initDataRaw()) {
      return toggleFavoriteServer(pn, next, initDataRaw())
        .then((r) => ({ favorite: next, fav_count: r.fav_count }))
        .catch(() => ({ favorite: next }));
    }
    return Promise.resolve({ favorite: next });
  }, [favSet]);

  return { favSet, isFav, toggle };
};
