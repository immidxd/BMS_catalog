// TG Shop — каталог: пошук, фільтри, сітка товарів, сторінка товару
import { useEffect, useMemo, useRef, useState } from 'react';
import { CatalogItem, CatalogQuery, Facets, FilterOptions, fetchConfig, fetchFacets, fetchFilters, fetchViews, setCatalogPublication, setFeaturedOrder, syncFavorites } from './api';
import { FilterSheet, countActiveFilters } from './components/FilterSheet';
import { ReorderSheet } from './components/ReorderSheet';
import { ProductCard, SkeletonCard } from './components/ProductCard';
import { ProductPage } from './components/ProductPage';
import { useCatalog, useDebounced } from './hooks/useCatalog';
import { useFavorites } from './useFavorites';
import { trackCatalogEvent } from './analytics';
import { ADMIN_TOKEN_KEY, clearAdminToken, currentTheme, haptic, hapticSelect, hydrateAdminTokenFromCloud, initDataRaw, openChannel, saveAdminTokenEverywhere, telegramUserId, toggleTheme } from './telegram';

// Адмін-режим (бачить тумблер «з фото» тощо): Telegram ID у allowlist або ?admin=1
const hasAdminParam = new URLSearchParams(window.location.search).has('admin');

const SORTS: Array<{ value: NonNullable<CatalogQuery['sort']>; label: string }> = [
  { value: 'newest', label: 'Новинки' },
  { value: 'price_asc', label: 'Дешевші' },
  { value: 'price_desc', label: 'Дорожчі' },
];

// Адмін-аналітика (лише для адміна): сортування за інтересом покупців. Чіпи стоять
// одразу за звичайними сортуваннями — бо це той самий вибір (взаємовиключні), лише
// пунктирні, щоб було видно: це службові. Повторний тап по активному чіпу перевертає
// напрям (↓ найбільше → ↑ найменше — щоб бачити й «мертві» позиції).
const ADMIN_SORTS = [
  { key: 'views', label: 'Перегляди', hint: 'Сортувати за переглядами картки' },
  { key: 'favs', label: 'Лайки', hint: 'Сортувати за ♥ у «Обраному»' },
  { key: 'popular', label: 'Найпопулярніші', hint: 'Перегляди + лайки разом (♥ важить ×10)' },
] as const;

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
  const [tgChannel, setTgChannel] = useState('');
  const [shopName, setShopName] = useState('Каталог');
  const [isAdmin, setIsAdmin] = useState(hasAdminParam);
  const [adminWrites, setAdminWrites] = useState(false);   // чи бекенд дозволяє адмін-запис
  // Фасети наперед: щоб лист фільтрів одразу показував коректні (звужені)
  // розміри/стать/колір без стрибка «повна сітка → звужена».
  const [facets, setFacets] = useState<Facets | null>(null);
  // Перегляди карток для адмін-бейджів; оновлюються «живо» полінгом (лише адмін).
  const [viewsMap, setViewsMap] = useState<Record<string, number>>({});
  // «Обране» користувача + режим перегляду лише обраного
  const { favSet, isFav, toggle: toggleFav } = useFavorites();
  const [favView, setFavView] = useState(false);
  // Публічні лічильники ♥️ (override поверх серверних): оновлюються при синку обраного
  // й при власному тапі — щоб число завжди відповідало реальності.
  const [favCounts, setFavCounts] = useState<Record<string, number>>({});

  useEffect(() => { trackCatalogEvent('catalog_open'); }, []);

  const searchRef = useRef<HTMLInputElement>(null);   // для фокуса після очищення хрестиком
  const debouncedSearch = useDebounced(search);
  const effSearch = debouncedSearch.trim().length >= 2 ? debouncedSearch.trim() : undefined;
  // Набір номерів обраного як стабільний примітив (для deps) — щоб сітка не мигала
  const favKey = useMemo(() => Array.from(favSet).sort().join(','), [favSet]);
  // Пошук вмикається від 2 символів: один символ дає шумну/безглузду видачу.
  // favView: показуємо лише обране; порожній набір → сентинел '__none__' (0 результатів,
  // далі покажемо спец-повідомлення «ви ще не маєте обраного»).
  const queryDraft: CatalogQuery = {
    ...query, search: effSearch, group_offers: !isAdmin,
    favnums: favView ? (favSet.size ? Array.from(favSet) : ['__none__']) : undefined,
  };
  // Мемоізація обов'язкова: новий об'єкт на кожен рендер зациклив би useCatalog.
  // Ключ — ВМІСТ запиту, а не залежності: поки вміст той самий, ідентичність об'єкта
  // не змінюється. Це критично для ♥️ у сітці: тап змінює favSet (і favKey), але поза
  // режимом «Обране» сам запит ІДЕНТИЧНИЙ (favnums лишається undefined). Раніше об'єкт
  // усе одно перестворювався → useCatalog перезавантажував сторінку 1, список згортався
  // до перших 20 карток, і користувача викидало на початок стрічки («блимало»).
  const queryKey = JSON.stringify(queryDraft);
  const effectiveQuery = useMemo(() => queryDraft, [queryKey]);
  const { items, total, isLoading, error, loadMore, retry, patchItem } = useCatalog(effectiveQuery);

  // Синк обраного → серверний лічильник (ідемпотентно), щоб counts «наздогнали» те,
  // що вже в обраному (старий бандл/інший пристрій). Оновлюємо override-лічильники.
  useEffect(() => {
    const init = initDataRaw();
    syncFavorites(Array.from(favSet), init, telegramUserId)
      .then((counts) => setFavCounts((prev) => ({ ...prev, ...counts })));
  }, [favKey]);

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

  // «Живі» перегляди в адмін-режимі: полінг мапи {номер: перегляди} кожні 20с
  // (бейджі оновлюються без рефетчу сітки). Публіці не запитуємо.
  useEffect(() => {
    if (!isAdmin) return;
    let stop = false;
    const tick = () => fetchViews().then((m) => { if (!stop) setViewsMap(m); }).catch(() => {});
    tick();
    const t = setInterval(tick, 20000);
    return () => { stop = true; clearInterval(t); };
  }, [isAdmin]);

  useEffect(() => {
    fetchConfig().then((config) => {
      setSellerUsername(config.seller_username);
      setSellerPhone(config.seller_phone);
      setSellerInstagram(config.seller_instagram);
      setSellerViber(config.seller_viber);
      setTgChannel(config.tg_channel || '');
      if (config.shop_name) {
        setShopName(config.shop_name);
        document.title = config.shop_name;
      }
      setAdminWrites(config.admin_writes);
      // Адмін, якщо Telegram ID у allowlist (або вже за ?admin=1)
      if (telegramUserId && config.admin_tg_ids.includes(telegramUserId)) setIsAdmin(true);
    }).catch(() => {});
  }, []);

  // Токен-модалка (заміна window.prompt — нативні prompt/confirm ненадійні у вбудованому
  // браузері Telegram, коли каталог відкрито звичайним посиланням, а не як Web App).
  const [tokenPromptOpen, setTokenPromptOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenHint, setTokenHint] = useState<string | null>(null);
  // Дія, що чекала на токен (напр. «зробити рекомендованим») — після збереження
  // токена повторюється АВТОМАТИЧНО, щоб не «нічого не сталось» на перший тап.
  const pendingRetryRef = useRef<(() => void) | null>(null);

  // Відновлюємо токен з Telegram CloudStorage у локальний кеш РАЗ при старті —
  // localStorage у Mini App, відкритому через посилання-кнопку (не кнопку меню
  // бота), часто СТИРАЄТЬСЯ між відкриттями; CloudStorage переживає це. Якщо юзер
  // встиг тапнути адмін-дію ДО завершення цього запиту (модалка вже відкрита) —
  // токен щойно підхопився з хмари, закриваємо модалку й повторюємо дію самі.
  useEffect(() => {
    hydrateAdminTokenFromCloud().then((hydrated) => {
      if (!hydrated) return;
      const retry = pendingRetryRef.current;
      pendingRetryRef.current = null;
      setTokenPromptOpen(false);
      if (retry) retry();
    });
  }, []);

  const saveAdminToken = () => {
    const t = tokenInput.trim();
    if (!t) return;
    saveAdminTokenEverywhere(t);   // локально (миттєво) + Telegram CloudStorage (надійно)
    setTokenInput('');
    setTokenHint(null);
    setTokenPromptOpen(false);
    haptic('light');
    const retry = pendingRetryRef.current;
    pendingRetryRef.current = null;
    if (retry) retry();
  };

  // Авторизація адмін-запису. Пріоритет: збережений ТОКЕН → підписаний initData →
  // запит токена. Токен перший, бо якщо initData не приймається сервером (Mini App
  // відкрито звичайним посиланням або від іншого бота — часта ситуація), єдиний
  // робочий шлях — адмін-токен; він працює і в Telegram. null → нема чим авторизуватись.
  // onAuthed (опційно) — колбек, який САМ повторить дію одразу після введення токена.
  const adminAuth = (onAuthed?: () => void): { initData?: string; token?: string } | null => {
    const token = localStorage.getItem(ADMIN_TOKEN_KEY) || '';
    if (token) return { token };
    const init = initDataRaw();
    if (init) return { initData: init };
    pendingRetryRef.current = onAuthed ?? null;
    setTokenPromptOpen(true);
    return null;
  };

  // Невалідний токен/initData (401) — чистимо токен і ЗАВЖДИ пропонуємо ввести токен
  // (наша модалка працює і в Telegram, на відміну від ненадійного window.prompt).
  // retry — та сама дія: повторюється АВТОМАТИЧНО після збереження нового токена
  // (раніше тут retry губився — саме тому «ввів токен, а нічого не сталось»).
  const handleAdminAuthFailure = (hint: string, retry?: () => void) => {
    clearAdminToken();
    haptic('medium');
    setTokenHint(hint);
    pendingRetryRef.current = retry ?? null;
    setTokenPromptOpen(true);
  };

  // Швидкий перемикач публікації картки прямо в каталозі (оптимістично)
  const handleTogglePublish = async (item: CatalogItem) => {
    const auth = adminAuth(() => handleTogglePublish(item));
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
      handleAdminAuthFailure('Не вдалося оновити публікацію — перевірте адмін-токен.', () => handleTogglePublish(item));
    }
  };

  // Тумблер «Рекомендований» прямо в каталозі (лише опублікований товар)
  const handleToggleFeatured = async (item: CatalogItem) => {
    const auth = adminAuth(() => handleToggleFeatured(item));
    if (!auth) return;
    const next = !item.featured;
    try {
      const r = await setCatalogPublication(item.productnumber, { is_published: true, is_featured: next }, auth);
      patchItem(item.id, { published: r.is_published, featured: r.is_featured });
      haptic('light');
    } catch {
      handleAdminAuthFailure('Не вдалося оновити «Рекомендований» — перевірте адмін-токен.', () => handleToggleFeatured(item));
    }
  };

  // ── Порядок рекомендованих (адмін): окрема панель із плавним drag ────────────
  const [reorderOpen, setReorderOpen] = useState(false);
  const [featOrder, setFeatOrder] = useState<string[] | null>(null);   // локальний override показу

  // Порядок показу: рекомендовані — у featOrder (після зміни), решта — як з сервера
  const displayItems = useMemo(() => {
    if (!isAdmin || !featOrder) return items;
    const byPn = new Map(items.filter((i) => i.featured).map((i) => [i.productnumber, i]));
    const ordered = featOrder.map((pn) => byPn.get(pn)).filter(Boolean) as CatalogItem[];
    items.forEach((i) => { if (i.featured && !featOrder.includes(i.productnumber)) ordered.push(i); });
    return [...ordered, ...items.filter((i) => !i.featured)];
  }, [items, featOrder, isAdmin]);

  // Список рекомендованих для панелі (у поточному порядку показу)
  const featuredItems = useMemo(() => displayItems.filter((i) => i.featured), [displayItems]);

  // Зберегти новий порядок: одразу застосувати у сітці (override) + на сервер (з retry)
  const saveReorder = (order: string[]) => {
    setFeatOrder(order);
    const trySave = () => {
      const auth = adminAuth(trySave);
      if (!auth) return;
      setFeaturedOrder(order, auth).then(() => haptic('light'))
        .catch(() => handleAdminAuthFailure('Не вдалося зберегти порядок — перевірте адмін-токен.', trySave));
    };
    trySave();
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

  // Тап по ♥️: перемикаємо обране (оптимістично) і оновлюємо публічний лічильник
  // картки. У Telegram лічильник приходить із сервера; локально рахуємо самі.
  const handleToggleFav = (item: CatalogItem) => {
    haptic('light');
    const base = favCounts[item.productnumber] ?? item.fav_count ?? 0;
    toggleFav(item.productnumber).then((r) => {
      const count = r.fav_count != null ? r.fav_count : Math.max(0, base + (r.favorite ? 1 : -1));
      setFavCounts((prev) => ({ ...prev, [item.productnumber]: count }));
    });
  };

  const handleSort = (sort: NonNullable<CatalogQuery['sort']>) => {
    hapticSelect();
    setQuery((q) => ({ ...q, sort }));
  };

  // Адмін-сортування: перший тап — від найбільшого (↓), повторний по активному —
  // перевертає на найменше (↑). Інші фільтри лишаються (це саме сортування, не фільтр).
  const adminSortBase = (query.sort || '').replace(/_(asc|desc)$/, '');
  const handleAdminSort = (key: (typeof ADMIN_SORTS)[number]['key']) => {
    hapticSelect();
    setQuery((q) => ({
      ...q,
      sort: q.sort === `${key}_desc` ? `${key}_asc` : `${key}_desc`,
    } as CatalogQuery));
  };

  // Швидкі чіпи-фільтри одним тапом: тип «Сумки» і сезон «Літо». Id типу беремо
  // з фасетів за назвою (не хардкодимо), тож чіп зникає, якщо сумок немає в наявності.
  const bagType = filterOptions?.types.find((t) => t.name === 'Сумка');
  const bagsActive = !!bagType && query.typeids?.length === 1 && query.typeids[0] === bagType.id;
  const summerActive = query.seasons?.length === 1 && query.seasons[0] === 'Літо';
  // «Обране» — по суті кошик: або дивимось збережене, або фільтруємо каталог.
  // Тому вмикання «Обраного» скидає звужуючі фільтри, а будь-який чіп-фільтр
  // (Сумки/Літо/Знижки) чи застосування листа фільтрів вимикає «Обране». Інакше
  // комбінація «Обране + фільтр» майже завжди давала порожній екран.
  const toggleFavView = () => {
    hapticSelect();
    if (!favView) setQuery((q) => ({ sort: q.sort, has_photo: q.has_photo, only_published: q.only_published }));
    setFavView(!favView);
  };
  const toggleBags = () => {
    if (!bagType) return;
    hapticSelect();
    setFavView(false);
    // Перемикання на «Сумки» скидає несумісні з сумками фільтри розміру (EU/буквені —
    // сумки їх не мають), щоб не отримати порожньо. Колір/ціна/сезон лишаються
    // (сезон сам працює: всесезонні сумки підходять під будь-який сезон). Знявши
    // «Сумки», користувач може одразу продовжити пошук взуття за розмірами.
    setQuery((q) => bagsActive
      ? { ...q, typeids: undefined }
      : { ...q, typeids: [bagType.id], eu_sizes: undefined, size_letters: undefined });
  };
  const toggleSummer = () => {
    hapticSelect();
    setFavView(false);
    setQuery((q) => ({ ...q, seasons: summerActive ? undefined : ['Літо'] }));
  };
  const onSaleActive = !!query.on_sale;
  const toggleOnSale = () => {
    hapticSelect();
    setFavView(false);
    setQuery((q) => ({ ...q, on_sale: onSaleActive ? undefined : true }));
  };

  const activeCount = countActiveFilters(query);
  // Чи активний БУДЬ-ЯКИЙ чіп/фільтр: сорт (не «Новинки»), «Обране», знижки, або
  // звичайні фільтри/розмір — для показу кнопки «Скинути» (сприймається як фільтри).
  const anyActive = activeCount > 0 || query.sort !== 'newest' || favView || onSaleActive;

  // Повне скидання: фільтри + сорт «Новинки» + вимкнути «Обране» (адмін-тумблери зберігаємо)
  const resetFilters = () => {
    haptic('medium');
    setFavView(false);
    setQuery({ sort: 'newest', has_photo: query.has_photo, only_published: query.only_published });
  };

  return (
    <>
      <header className="header">
        <div className="search-row">
          <div className="search-input">
            <SearchIcon />
            <input
              ref={searchRef}
              type="search"
              placeholder={`Пошук у «${shopName}»`}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Пошук товарів"
            />
            {/* Хрестик очищення — лише коли є що скидати; фокус лишаємо в полі,
                щоб можна було одразу набирати далі (клавіатура не закривається). */}
            {search && (
              <button type="button" className="search-clear" aria-label="Очистити пошук"
                onClick={() => { haptic('light'); setSearch(''); searchRef.current?.focus(); }}>
                <ClearIcon />
              </button>
            )}
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
          {/* Наш канал — делікатна ghost-кнопка поряд із темою (лише якщо задано TG_CHANNEL) */}
          {tgChannel && (
            <button type="button" className="channel-btn" title="Наш Telegram-канал"
              aria-label="Наш Telegram-канал"
              onClick={() => { haptic('light'); openChannel(tgChannel); }}>
              <ChannelIcon />
            </button>
          )}
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
          {/* Адмін-аналітика: топ за переглядами / лайками / обома разом. Публіці
              не рендеримо взагалі — чіпів просто немає в розмітці. */}
          {isAdmin && ADMIN_SORTS.map((s) => {
            const active = adminSortBase === s.key;
            const asc = query.sort === `${s.key}_asc`;
            return (
              <button type="button" key={s.key} title={s.hint}
                className={`chip chip-admin${active ? ' active' : ''}`}
                onClick={() => handleAdminSort(s.key)}>
                <AdminSortIcon kind={s.key} />
                {s.label}
                {active && <span className="sort-dir">{asc ? '↑' : '↓'}</span>}
              </button>
            );
          })}
          {/* «Обране»: показати лише збережені товари користувача */}
          <button type="button" className={`chip chip-fav${favView ? ' active' : ''}`}
            onClick={toggleFavView}>
            <ChipHeartIcon filled={favView} />
            Обране
          </button>
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
          {/* «Знижки»: лише товари з активною акційною ціною */}
          <button type="button" className={`chip chip-sale${onSaleActive ? ' active' : ''}`} onClick={toggleOnSale}>
            Знижки %
          </button>
          {/* Скидання будь-яких активних чіпів/фільтрів — у кінці ряду, червоним */}
          {anyActive && (
            <button type="button" className="chip chip-reset" onClick={resetFilters}>
              <ResetIcon />
              Скинути
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
        favView ? (
          <div className="empty">
            <div className="title">Ви ще не маєте обраного</div>
            <div>Натискайте ♥ на картці товару, щоб зберегти його сюди</div>
          </div>
        ) : (
          <div className="empty">
            <div className="title">Нічого не знайдено</div>
            <div>Спробуйте змінити пошук або фільтри</div>
          </div>
        )
      )}

      <main className="grid">
        {displayItems.map((item, i) => {
          const merged = { ...item };
          if (viewsMap[item.productnumber] != null) merged.views = viewsMap[item.productnumber];
          if (favCounts[item.productnumber] != null) merged.fav_count = favCounts[item.productnumber];
          return (
          <ProductCard key={item.id} priority={i < 4}
            item={merged}
            onOpen={handleOpenProduct}
            isFav={isFav(item.productnumber)} onToggleFav={handleToggleFav}
            admin={isAdmin} onTogglePublish={adminWrites ? handleTogglePublish : undefined}
            onToggleFeatured={adminWrites ? handleToggleFeatured : undefined}
            onOpenReorder={adminWrites ? () => setReorderOpen(true) : undefined} />
          );
        })}
        {isLoading && items.length === 0 && Array.from({ length: 6 }, (_, i) => <SkeletonCard key={`sk-${i}`} />)}
      </main>
      <div className="load-sentinel" ref={sentinelRef} />

      {isSheetOpen && filterOptions && (
        <FilterSheet
          options={filterOptions}
          query={effectiveQuery}
          total={total}
          isAdmin={isAdmin}
          initialFacets={facets}
          onApply={(next) => { setFavView(false); setQuery({ ...next, search: undefined, sort: query.sort }); }}
          onClose={() => setIsSheetOpen(false)}
        />
      )}

      {reorderOpen && featuredItems.length > 0 && (
        <ReorderSheet
          featured={featuredItems}
          onSave={saveReorder}
          onClose={() => setReorderOpen(false)}
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
          siblingIds={items.map((it) => it.id)}
          onNavigate={(id) => { haptic('light'); setProductId(id); }}
          onNeedMore={loadMore}
          isFavorite={isFav}
          onToggleFav={(pn) => { haptic('light'); return toggleFav(pn); }}
          adminAuth={adminWrites ? adminAuth : undefined}
          onAdminAuthFailure={adminWrites ? handleAdminAuthFailure : undefined}
          sellerUsername={sellerUsername}
          sellerPhone={sellerPhone}
          sellerInstagram={sellerInstagram}
          sellerViber={sellerViber}
          admin={isAdmin}
          onBack={() => setProductId(null)}
        />
      )}

      {/* Токен адмін-доступу (поза Telegram): власна модалка замість window.prompt —
          нативні діалоги ненадійні у вбудованому браузері Telegram (звичайне посилання,
          не Web App). Вводиться раз, зберігається локально. */}
      {tokenPromptOpen && (
        <div className="sheet-backdrop" onClick={() => setTokenPromptOpen(false)} aria-hidden="true">
          <div className="token-modal" role="dialog" aria-label="Адмін-токен" onClick={(e) => e.stopPropagation()}>
            <h3>Адмін-токен каталогу</h3>
            {tokenHint && <p className="token-hint">{tokenHint}</p>}
            <input type="password" autoFocus value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') saveAdminToken(); }}
              placeholder="Вставте токен" className="token-input" />
            <p className="token-help">Значення — у Railway → Variables → CATALOG_ADMIN_TOKEN.
              Вводиться один раз і зберігається. Щоб не вводити взагалі — відкривайте каталог
              через кнопку меню бота (☰).</p>
            <div className="token-actions">
              <button type="button" className="chip" onClick={() => setTokenPromptOpen(false)}>Скасувати</button>
              <button type="button" className="btn-primary" onClick={saveAdminToken} disabled={!tokenInput.trim()}>Зберегти</button>
            </div>
          </div>
        </div>
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

// Серце для чіпа «Обране» (залите, коли режим активний)
const ChipHeartIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
);

// Іконки адмін-чіпів аналітики: око (перегляди), серце (лайки), полум'я (популярність)
const AdminSortIcon = ({ kind }: { kind: 'views' | 'favs' | 'popular' }) => {
  if (kind === 'favs') return <ChipHeartIcon filled />;
  if (kind === 'views') return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.4-.5-2-1-3-1.1-2.1-.2-4.1 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.2.4-2.3 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
    </svg>
  );
};

// Іконка скидання (стрілка-коло) — інтуїтивний знак «повернути як було»
const ResetIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" />
  </svg>
);

// Хрестик очищення пошуку — тонкий, мінімалістичний
const ClearIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

// Паперовий літачок — вхід у наш Telegram-канал (у стилі решти лінійних іконок)
const ChannelIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21.5 2.5 10.6 13.4" />
    <path d="M21.5 2.5 14.6 21.5l-4-8.1-8.1-4 19.1-6.9z" />
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
