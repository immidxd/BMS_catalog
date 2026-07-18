// «Обране» користувача. Стійка модель:
//  • localStorage — довговічний бекап ЗАВЖДИ (працює навіть без initData/сервера,
//    напр. якщо Mini App відкрито звичайним URL, а не як повноцінний Web App);
//  • сервер — джерело істини й синхрон між пристроями, КОЛИ є підписаний initData
//    (за telegram_user_id). Ознака «можемо на сервер» — саме наявність initData,
//    а НЕ isInTelegram (у Telegram initData інколи порожній → сервер недоступний).
import { useCallback, useEffect, useState } from 'react';
import { fetchFavorites, toggleFavoriteServer } from './api';
import { initDataRaw } from './telegram';

const LS_KEY = 'tg-shop-favorites';
const loadLocal = (): string[] => {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; }
};
const saveLocal = (list: string[]): void => {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* private mode */ }
};

export const useFavorites = () => {
  // Старт із localStorage — миттєво й довговічно (не зникає при повторному вході).
  const [favSet, setFavSet] = useState<Set<string>>(() => new Set(loadLocal()));

  // Є підписаний initData → тягнемо серверний список (він стає джерелом істини) і
  // дзеркалимо в localStorage. Немає initData / сервер недоступний → лишаємось локально.
  useEffect(() => {
    const init = initDataRaw();
    if (!init) return;
    fetchFavorites(init)
      .then((list) => { setFavSet(new Set(list)); saveLocal(list); })
      .catch(() => { /* лишаємось на локальному бекапі */ });
  }, []);

  const isFav = useCallback((pn: string) => favSet.has(pn), [favSet]);

  // Оптимістично перемикаємо; ЗАВЖДИ зберігаємо локально; за наявності initData —
  // ще й на сервер (звідти приходить публічний лічильник ♥️).
  const toggle = useCallback((pn: string): Promise<{ favorite: boolean; fav_count?: number }> => {
    const next = !favSet.has(pn);
    setFavSet((cur) => {
      const s = new Set(cur);
      next ? s.add(pn) : s.delete(pn);
      saveLocal([...s]);
      return s;
    });
    const init = initDataRaw();
    if (init) {
      return toggleFavoriteServer(pn, next, init)
        .then((r) => ({ favorite: next, fav_count: r.fav_count }))
        .catch(() => ({ favorite: next }));   // сервер впав → лишається локально
    }
    return Promise.resolve({ favorite: next });
  }, [favSet]);

  return { favSet, isFav, toggle };
};
