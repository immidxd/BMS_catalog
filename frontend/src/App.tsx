// TG Shop — каталог: пошук, фільтри, сітка товарів, сторінка товару
import { useEffect, useMemo, useRef, useState } from 'react';
import { CatalogItem, CatalogQuery, Facets, FilterOptions, fetchConfig, fetchFacets, fetchFilters, setCatalogPublication } from './api';
import { FilterSheet, countActiveFilters } from './components/FilterSheet';
import { ProductCard, SkeletonCard } from './components/ProductCard';
import { ProductPage } from './components/ProductPage';
import { useCatalog, useDebounced } from './hooks/useCatalog';
import { currentTheme, haptic, hapticSelect, initDataRaw, isInTelegram, telegramUserId, toggleTheme } from './telegram';

// Адмін-режим (бачить тумблер «з фото» тощо): Telegram ID у allowlist або ?admin=1
const hasAdminParam = new URLSearchParams(window.location.search).has('admin');
// Адмін-токен для запису з браузера (поза Telegram) — зберігається локально
const ADMIN_TOKEN_KEY = 'tg-shop-admin-token';

const SORTS: Array<{ value: NonNullable<CatalogQuery['sort']>; label: string }> = [
  { value: 'newest', label: 'Новинки' },
  { value: 'price_asc', label: 'Дешевші' },
  { value: 'price_desc', label: 'Дорожчі' },
];

// Дефолт каталогу: «Тільки з фото» увімкнено за замовчуванням (базовий стан,
// не рахується як активний фільтр). Скидання повертає саме до цього дефолту.
const DEFAULT_QUERY: CatalogQuery = { sort: 'newest', has_photo: true };

export const App = () => {
  const [search, setSearch] = useState('');
  // Адмін (?admin=1) одразу бачить ПУЛ кандидатів на публікацію (наявні з фото),
  // а не порожній публічний каталог — щоб було що вмикати 👁. Публіка — як було.
  const [query, setQuery] = useState<CatalogQuery>(
    hasAdminParam ? { ...DEFAULT_QUERY, only_published: false } : DEFAULT_QUERY,
  );
  const [filterOptions, setFilterOptions] = useState<FilterOptions | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [productId, setProductId] = useState<number | null>(null);
  const [sellerUsername, setSellerUsername] = useState('');
  const [sellerPhone, setSellerPhone] = useState('');
  const [sellerInstagram, setSellerInstagram] = useState('');
  const [sellerViber, setSellerViber] = useState('');
  const [shopName, setShopName] = useState('Каталог');
  const [isAdmin, setIsAdmin] = useState(hasAdminParam);
  const [adminWrites, setAdminWrites] = useState(false);   // чи бекенд дозволяє адмін-запис
  // Фасети наперед: щоб лист фільтрів одразу показував коректні (звужені)
  // розміри/стать/колір без стрибка «повна сітка → звужена».
  const [facets, setFacets] = useState<Facets | null>(null);

  const debouncedSearch = useDebounced(search);
  const effSearch = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;
  // Мемоізація обов'язкова: новий об'єкт на кожен рендер зациклив би useCatalog
  const effectiveQuery = useMemo(
    // Пошук вмикається від 2 символів: один символ дає шумну/безглузду видачу.
    // effSearch — примітив у deps: поки він не змінився (напр. 1 символ → undefined),
    // об'єкт запиту НЕ перестворюється і сітка не рефетчиться (не «мигає»).
    () => ({ ...query, search: effSearch, group_offers: !isAdmin }),
    [query, effSearch, isAdmin],
  );
  const { items, total, isLoading, error, loadMore, retry, patchItem } = useCatalog(effectiveQuery);

  // Тримаємо фасети актуальними для застосованого запиту (для миттєвого листа)
  useEffect(() => {
    let cancelled = false;
    fetchFacets(effectiveQuery).then((f) => { if (!cancelled) setFacets(f); }).catch(() => {});
    return () => { cancelled = true; };
  }, [effectiveQuery]);

  // Опції фільтрів: адміну — по ВСЬОМУ пулу (інакше при 0 опублікованих лист
  // фільтрів порожній: немає типів/брендів/розмірів). Публіці — по опублікованих.
  useEffect(() => {
    fetchFilters(isAdmin).then(setFilterOptions).catch(() => {});
  }, [isAdmin]);

  useEffect(() => {
    fetchConfig().then((config) => {
      setSellerUsername(config.seller_username);
      setSellerPhone(config.seller_phone);
      setSellerInstagram(config.seller_instagram);
      setSellerViber(config.seller_viber);
      if (config.shop_name) {
        setShopName(config.shop_name);
        document.title = config.shop_name;
      }
      setAdminWrites(config.admin_writes);
      // Адмін, якщо Telegram ID у allowlist (або вже за ?admin=1)
      if (telegramUserId && config.admin_tg_ids.includes(telegramUserId)) setIsAdmin(true);
    }).catch(() => {});
  }, []);

  // Авторизація адмін-запису: у Telegram — підписаний initData; у браузері — токен
  // (питаємо один раз, зберігаємо локально). null → нема чим авторизуватись.
  const adminAuth = (): { initData?: string; token?: string } | null => {
    if (isInTelegram) return { initData: initDataRaw() };
    let token = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    if (!token) {
      token = (window.prompt('Адмін-токен каталогу:') || '').trim();
      if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    }
    return token ? { token } : null;
  };

  // Швидкий перемикач публікації картки прямо в каталозі (оптимістично)
  const handleTogglePublish = async (item: CatalogItem) => {
    const auth = adminAuth();
    if (!auth) return;
    const next = !item.published;
    try {
      const r = await setCatalogPublication(
        item.productnumber,
        { is_published: next, is_featured: next ? item.featured : false },
        auth,
      );
      patchItem(item.id, { published: r.is_published, featured: r.is_featured });
      haptic('light');
    } catch {
      if (!isInTelegram) localStorage.removeItem(ADMIN_TOKEN_KEY);   // невірний токен — скинути
      haptic('medium');
      alert('Не вдалося оновити публікацію (перевірте адмін-токен/доступ).');
    }
  };

  // Нескінченний скрол: сторож унизу сітки. Перевіряємо близькість сторожа до
  // видимої області І на скрол, І ОДРАЗУ після кожного завантаження (deps: items) —
  // щоб заповнити екран і НЕ застрягати, коли сторож лишається у видимості після
  // підвантаження (IntersectionObserver у такому разі повторно не спрацьовував).
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const maybeLoad = () => {
      const s = sentinelRef.current;
      if (s && s.getBoundingClientRect().top <= window.innerHeight + 800) loadMore();
    };
    maybeLoad();
    window.addEventListener('scroll', maybeLoad, { passive: true });
    window.addEventListener('resize', maybeLoad);
    return () => {
      window.removeEventListener('scroll', maybeLoad);
      window.removeEventListener('resize', maybeLoad);
    };
  }, [loadMore, items]);

  const handleOpenProduct = (id: number) => {
    haptic('light');
    setProductId(id);   // картка — оверлей поверх каталогу; скрол каталогу зберігається
  };

  const handleSort = (sort: NonNullable<CatalogQuery['sort']>) => {
    hapticSelect();
    setQuery((q) => ({ ...q, sort }));
  };

  // Швидкі чіпи-фільтри одним тапом: тип «Сумки» і сезон «Літо». Id типу беремо
  // з фасетів за назвою (не хардкодимо), тож чіп зникає, якщо сумок немає в наявності.
  const bagType = filterOptions?.types.find((t) => t.name === 'Сумка');
  const bagsActive = !!bagType && query.typeids?.length === 1 && query.typeids[0] === bagType.id;
  const summerActive = query.seasons?.length === 1 && query.seasons[0] === 'Літо';
  const toggleBags = () => {
    if (!bagType) return;
    hapticSelect();
    setQuery((q) => ({ ...q, typeids: bagsActive ? undefined : [bagType.id] }));
  };
  const toggleSummer = () => {
    hapticSelect();
    setQuery((q) => ({ ...q, seasons: summerActive ? undefined : ['Літо'] }));
  };

  const activeCount = countActiveFilters(query);

  return (
    <>
      <header className="header">
        <div className="search-row">
          <div className="search-input">
            <SearchIcon />
            <input
              type="search"
              placeholder={`Пошук у «${shopName}»`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Пошук товарів"
            />
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={() => { haptic('light'); setIsSheetOpen(true); }}
            aria-label="Фільтри"
            disabled={!filterOptions}
          >
            <FilterIcon />
            {activeCount > 0 && <span className="badge">{activeCount}</span>}
          </button>
          <ThemeToggle />
        </div>
        <div className="chips-row">
          {SORTS.map((sort) => (
            <button
              type="button"
              key={sort.value}
              className={`chip${query.sort === sort.value ? ' active' : ''}`}
              onClick={() => handleSort(sort.value)}
            >
              {sort.label}
            </button>
          ))}
          {bagType && (
            <button type="button" className={`chip${bagsActive ? ' active' : ''}`} onClick={toggleBags}>
              Сумки
            </button>
          )}
          {filterOptions?.seasons.includes('Літо') && (
            <button type="button" className={`chip${summerActive ? ' active' : ''}`} onClick={toggleSummer}>
              Літо
            </button>
          )}
          {activeCount > 0 && (
            <button
              type="button"
              className="chip"
              onClick={() => { haptic('medium'); setQuery({ sort: query.sort, has_photo: query.has_photo, only_published: query.only_published }); }}
            >
              Скинути фільтри <span className="x">✕</span>
            </button>
          )}
        </div>
        {/* Лічильник: видно, що показано ВЕСЬ набір (сортування не обмежує список) */}
        {!error && total > 0 && (
          <div className="result-count">{isAdmin ? 'Кандидатів' : 'Товарів'}: {total}</div>
        )}
      </header>

      {error && (
        <div className="empty">
          <div className="title">Не вдалося завантажити</div>
          <button type="button" className="chip" onClick={retry}>Спробувати ще раз</button>
        </div>
      )}

      {!error && !isLoading && items.length === 0 && (
        <div className="empty">
          <div className="title">Нічого не знайдено</div>
          <div>Спробуйте змінити пошук або фільтри</div>
        </div>
      )}

      <main className="grid">
        {items.map((item, i) => (
          <ProductCard key={item.id} item={item} onOpen={handleOpenProduct} priority={i < 4}
            admin={isAdmin && adminWrites} onTogglePublish={handleTogglePublish} />
        ))}
        {isLoading && Array.from({ length: 6 }, (_, i) => <SkeletonCard key={`sk-${i}`} />)}
      </main>
      <div className="load-sentinel" ref={sentinelRef} />

      {isSheetOpen && filterOptions && (
        <FilterSheet
          options={filterOptions}
          query={effectiveQuery}
          total={total}
          isAdmin={isAdmin}
          initialFacets={facets}
          onApply={(next) => setQuery({ ...next, search: undefined, sort: query.sort })}
          onClose={() => setIsSheetOpen(false)}
        />
      )}

      {/* Десктоп: наведення курсору на лівий край відкриває фільтри */}
      {filterOptions && !isSheetOpen && productId === null && (
        <div
          className="filter-hover-zone"
          onMouseEnter={() => setIsSheetOpen(true)}
          aria-hidden="true"
        />
      )}

      {/* Картка товару — оверлей поверх каталогу: повернення зберігає позицію скролу */}
      {productId !== null && (
        <ProductPage
          productId={productId}
          sellerUsername={sellerUsername}
          sellerPhone={sellerPhone}
          sellerInstagram={sellerInstagram}
          sellerViber={sellerViber}
          admin={isAdmin}
          onBack={() => setProductId(null)}
        />
      )}
    </>
  );
};

const SearchIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </svg>
);

const FilterIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h16M7 12h10M10 18h4" />
  </svg>
);

// Мінімалістичний перемикач теми (за замовч. слідує за пристроєм/Telegram)
const ThemeToggle = () => {
  const [theme, setTheme] = useState(currentTheme());
  const handleToggle = () => { haptic('light'); setTheme(toggleTheme()); };
  return (
    <button type="button" className="theme-btn" onClick={handleToggle} aria-label="Перемкнути тему">
      {theme === 'dark' ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      )}
    </button>
  );
};
