// Стан каталогу: фільтри, пошук (з дебаунсом), нескінченне підвантаження сторінок
import { useCallback, useEffect, useRef, useState } from 'react';
import { CatalogItem, CatalogQuery, fetchCatalog } from '../api';

export const useCatalog = (query: CatalogQuery) => {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const pageRef = useRef(1);
  const pagesRef = useRef(1);
  const busyRef = useRef(false);
  // Захист від гонок: відповіді застарілого запиту ігноруються
  const requestIdRef = useRef(0);

  const load = useCallback(async (page: number) => {
    const requestId = ++requestIdRef.current;
    busyRef.current = true;
    setIsLoading(true);
    setError(false);
    try {
      const data = await fetchCatalog(query, page);
      if (requestId !== requestIdRef.current) return;
      pageRef.current = data.page;
      pagesRef.current = data.pages;
      setTotal(data.total);
      setItems((prev) => (page === 1 ? data.items : [...prev, ...data.items]));
    } catch {
      if (requestId === requestIdRef.current) setError(true);
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false);
        busyRef.current = false;
      }
    }
  }, [query]);

  // Зміна фільтрів/пошуку → перезавантаження з першої сторінки. НЕ чистимо items
  // одразу (це давало «мелькання» порожнім екраном при перемиканні, напр. «Обране»):
  // стара сітка лишається видимою, доки не прийде нова сторінка 1 і не замінить її.
  useEffect(() => {
    load(1);
  }, [load]);

  const loadMore = useCallback(() => {
    if (busyRef.current || pageRef.current >= pagesRef.current) return;
    load(pageRef.current + 1);
  }, [load]);

  // Локальне оновлення однієї картки (напр. після адмін-перемикача публікації) —
  // без перезавантаження сітки й втрати позиції скролу.
  const patchItem = useCallback((id: number, partial: Partial<CatalogItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...partial } : it)));
  }, []);

  return { items, total, isLoading, error, loadMore, retry: () => load(1), patchItem };
};

// Дебаунс значення (для пошуку під час набору)
export const useDebounced = <T>(value: T, delayMs = 350): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
};
