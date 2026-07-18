// «Обране» користувача — НАДІЙНЕ per-user збереження, стійке до проблем з initData/ботом:
//  • Telegram CloudStorage — основне сховище: Telegram сам тримає його per-user і
//    синхронізує МІЖ ПРИСТРОЯМИ, без initData/HMAC (працює, навіть коли сервер каталогу
//    не приймає запит). Авторитетне джерело набору обраного.
//  • localStorage — локальний бекап (і для звичайного браузера поза Telegram) + міграція
//    у CloudStorage при першому запуску.
//  • Сервер (/api/favorites) — лише best-effort, щоб оновити ПУБЛІЧНИЙ лічильник ♥️
//    (потребує коректного initData/бота; на персональне збереження вже не впливає).
import { useCallback, useEffect, useState } from 'react';
import { toggleFavoriteServer } from './api';
import { cloudGet, cloudSet, cloudStorageAvailable, initDataRaw } from './telegram';

const CS_KEY = 'favorites';            // ключ у Telegram CloudStorage
const LS_KEY = 'tg-shop-favorites';    // локальний бекап

const loadLocal = (): string[] => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
};
const saveLocal = (list: string[]): void => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* private mode */ }
};
const parse = (raw: string | null): string[] => {
  try { return raw ? JSON.parse(raw) : []; } catch { return []; }
};

export const useFavorites = () => {
  const [favSet, setFavSet] = useState<Set<string>>(() => new Set(loadLocal()));

  // Завантаження з CloudStorage (якщо доступний). Уже ініціалізований → авторитетний
  // (видалення теж поширюються). Ще не ініціалізований → мігруємо локальний бекап у хмару.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cloudStorageAvailable()) return;   // поза Mini App → лишаємось на localStorage
      const raw = await cloudGet(CS_KEY);
      if (cancelled) return;
      if (raw && raw !== '') {
        const list = parse(raw);
        setFavSet(new Set(list));
        saveLocal(list);
      } else {
        const local = loadLocal();
        if (local.length) void cloudSet(CS_KEY, JSON.stringify(local));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const isFav = useCallback((pn: string) => favSet.has(pn), [favSet]);

  const toggle = useCallback((pn: string): Promise<{ favorite: boolean; fav_count?: number }> => {
    const next = !favSet.has(pn);
    const s = new Set(favSet);
    next ? s.add(pn) : s.delete(pn);
    const list = [...s];
    setFavSet(s);
    saveLocal(list);                          // локальний бекап
    void cloudSet(CS_KEY, JSON.stringify(list));   // per-user хмара Telegram (синхрон пристроїв)
    // Сервер — лише для публічного лічильника ♥️ (best-effort; не критично для персонального обраного)
    const init = initDataRaw();
    if (init) {
      return toggleFavoriteServer(pn, next, init)
        .then((r) => ({ favorite: next, fav_count: r.fav_count }))
        .catch(() => ({ favorite: next }));
    }
    return Promise.resolve({ favorite: next });
  }, [favSet]);

  return { favSet, isFav, toggle };
};
