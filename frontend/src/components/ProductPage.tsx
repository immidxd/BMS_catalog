// Повна сторінка товару: галерея (свайп), характеристики, зв'язок з продавцем
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { AdminAuth, ProductDetail, cap, capSlash, discountPct, fetchProduct, formatPrice, formatSeason, setCatalogDescription, setCatalogDiscount } from '../api';
import { parseTechnologies } from '../techLogos';
import { contactInstagram, contactPhone, contactSeller, contactViber, haptic, isInTelegram, showBackButton } from '../telegram';

type Props = {
  productId: number;
  siblingIds?: number[];             // порядок карток у каталозі — для гортання свайпом
  onNavigate?: (id: number) => void; // відкрити сусідню картку
  onNeedMore?: () => void;           // підвантажити ще (коли дійшли до кінця списку)
  isFavorite?: (pn: string) => boolean;
  onToggleFav?: (pn: string) => Promise<{ favorite: boolean; fav_count?: number }>;
  // Авторизація адмін-запису. onAuthed — колбек: якщо токена ще нема (відкриється
  // модалка), він АВТОМАТИЧНО повторить дію одразу після введення токена.
  adminAuth?: (onAuthed?: () => void) => AdminAuth | null;
  // 401 (токен був, але невалідний) — теж відкриває токен-модалку з retry, а не alert().
  onAdminAuthFailure?: (hint: string, retry?: () => void) => void;
  sellerUsername: string;
  sellerPhone: string;
  sellerInstagram: string;
  sellerViber: string;
  admin?: boolean;   // адмін може відкрити деталь ще не опублікованого товару
  onBack: () => void;
};

const KIND_LABELS: Record<string, string> = { real: 'реальне фото', defect: 'нюанс' };
// Матеріали показуємо саме в цьому порядку (тільки наявні позиції)
const MATERIAL_ORDER = ['upper', 'middle', 'membrane', 'lining', 'insole', 'midsole', 'sole'];
const MATERIAL_LABELS: Record<string, string> = {
  upper: 'Верх',
  middle: 'Середина',
  membrane: 'Мембрана',
  lining: 'Підкладка',
  insole: 'Устілка',
  midsole: 'Проміжна підошва',
  sole: 'Підошва',
};

// Типи-аксесуари, для яких «Сезон» недоречний (на відміну від одягу/взуття)
const NO_SEASON_TYPES = new Set(['Сумка', 'Валіза', 'Ремінь', 'Окуляри', 'Гаманець', 'Рюкзак']);

// "10–11 см" / "10 см" / null з пари min/max
const rangeCm = (min: number | null, max: number | null): string | null => {
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${min}–${max} см`;
  return `${min ?? max} см`;
};

// Проміжок між сусідніми картками під час свайпу: крізь нього видно фон — картка
// саме «витягується» з-за краю, а не змінює вміст на місці.
const SWIPE_GAP = 12;
const SWIPE_EASE = 'cubic-bezier(.22,.61,.36,1)';

export const ProductPage = ({ productId, siblingIds = [], onNavigate, onNeedMore, isFavorite, onToggleFav, adminAuth, onAdminAuthFailure, sellerUsername, sellerPhone, sellerInstagram, sellerViber, admin = false, onBack }: Props) => {
  const [error, setError] = useState(false);
  const [, bump] = useState(0);                    // ререндер, коли поповнився кеш деталей
  const cache = useRef(new Map<string, ProductDetail>()).current;
  const pageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);    // стрічка з трьох панелей
  const railX = useRef(0);                         // поточне зміщення стрічки, px
  const animating = useRef(false);                 // йде анімація переходу
  const dragging = useRef(false);                  // палець зараз веде картку

  // Ключ кешу враховує режим: адмін бачить більше полів, ніж публіка
  const cacheKey = (id: number) => `${admin ? 'a' : 'p'}:${id}`;
  const product = cache.get(cacheKey(productId)) ?? null;

  // Сусідні картки в поточному порядку каталогу (для гортання свайпом/стрілками)
  const idx = siblingIds.indexOf(productId);
  const prevId = idx > 0 ? siblingIds[idx - 1] : null;
  const nextId = idx >= 0 && idx < siblingIds.length - 1 ? siblingIds[idx + 1] : null;
  // Панелі стрічки: [попередня] [поточна] [наступна]. Ключі = id товару, тому після
  // переходу React ПЕРЕСУВАЄ вже змонтований DOM сусіда в центр, а не малює його заново
  // — саме тому перемикання виглядає як один неперервний рух, без «блимання».
  const ids = [prevId, productId, nextId].filter((v): v is number => v != null);
  const baseIndex = ids.indexOf(productId);
  // Свіжий зріз для обробників жесту (вони переживають рендери й не бачать нових пропсів)
  const live = useRef({ baseIndex, prevId, nextId, idx, total: siblingIds.length });
  live.current = { baseIndex, prevId, nextId, idx, total: siblingIds.length };

  useEffect(() => showBackButton(onBack), [onBack]);

  // Завантаження деталей у кеш: поточна картка + СУСІДИ наперед — щоб під час свайпу
  // сусідня панель уже була намальована (жодного очікування мережі всередині жесту).
  useEffect(() => {
    let cancelled = false;
    const load = (id: number, isCurrent: boolean) => {
      if (cache.has(cacheKey(id))) return;
      fetchProduct(id, admin).then((p) => {
        if (cancelled) return;
        cache.set(cacheKey(id), p);
        const url = p.images[0]?.url;
        if (url) new Image().src = url;            // перше фото — теж наперед
        bump((n) => n + 1);
      }).catch(() => { if (!cancelled && isCurrent) setError(true); });
    };
    setError(false);
    load(productId, true);
    [prevId, nextId].forEach((sid) => { if (sid != null) load(sid, false); });
    return () => { cancelled = true; };
  }, [productId, prevId, nextId, admin]);

  // Локальні зміни картки (обране, опис, знижка) — правимо копію в кеші
  const patchProduct = (id: number, updater: (p: ProductDetail) => ProductDetail) => {
    const cur = cache.get(cacheKey(id));
    if (!cur) return;
    cache.set(cacheKey(id), updater(cur));
    bump((n) => n + 1);
  };

  // ── Стрічка: геометрія і рух ───────────────────────────────────────────────
  const stepPx = () => (pageRef.current?.clientWidth || window.innerWidth) + SWIPE_GAP;
  const restPx = () => -live.current.baseIndex * stepPx();
  const setRail = (px: number, dur = 0) => {
    const r = railRef.current;
    if (!r) return;
    railX.current = px;
    r.style.transition = dur ? `transform ${dur}ms ${SWIPE_EASE}` : 'none';
    r.style.transform = `translate3d(${px}px,0,0)`;
  };

  // Стрічка завжди стоїть на «своїй» панелі: після зміни товару, доїзду списку чи
  // повороту екрана. Під час анімації переходу не чіпаємо — інакше зіб'ємо рух.
  // (і поки палець веде картку — теж не чіпаємо: список міг довантажитись саме в цю мить)
  useLayoutEffect(() => { if (!animating.current && !dragging.current) setRail(restPx()); });
  useEffect(() => {
    const onResize = () => { if (!animating.current && !dragging.current) setRail(restPx()); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Перехід на сусідню картку однією неперервною анімацією: стрічка доїжджає рівно
  // на крок, і В ТОМУ Ж кадрі, коли рух завершився, ми міняємо productId і повертаємо
  // стрічку в базове положення — сусідня панель уже під пальцем, тож підміни не видно.
  const slideTo = (dir: -1 | 1, velocity = 0) => {
    if (animating.current) return;          // попередній перехід ще їде — не накладаємось
    const target = dir === 1 ? live.current.nextId : live.current.prevId;
    if (target == null) { setRail(restPx(), 240); return; }
    const to = restPx() - dir * stepPx();
    const dist = Math.abs(to - railX.current);
    // Тривалість за швидкістю кидка: різкий флік — швидше, повільне ведення — м'якше
    const dur = Math.round(Math.min(360, Math.max(170, dist / Math.max(1.1, Math.abs(velocity) * 1.6))));
    const rail = railRef.current;
    animating.current = true;
    let guard = 0;
    const commit = () => {
      if (!animating.current) return;
      animating.current = false;
      window.clearTimeout(guard);
      rail?.removeEventListener('transitionend', onDone);
      // flushSync: DOM з новою центральною панеллю має з'явитися ДО того, як стрічка
      // повернеться в базове положення — інакше буде видно кадр зі стрибком.
      flushSync(() => onNavigate?.(target));
      setRail(restPx());
      // Наближаємось до кінця завантаженого списку — просимо ще (безкінечне гортання)
      if (dir === 1 && live.current.idx >= live.current.total - 2) onNeedMore?.();
    };
    const onDone = (e: TransitionEvent) => {
      if (e.target === rail && e.propertyName === 'transform') commit();
    };
    guard = window.setTimeout(commit, dur + 140);   // на випадок втраченого transitionend
    rail?.addEventListener('transitionend', onDone);
    setRail(to, dur);
  };

  // Esc закриває картку; ← / → гортають сусідні картки (зручно на десктопі)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
      else if (e.key === 'ArrowLeft' && prevId != null) slideTo(-1);
      else if (e.key === 'ArrowRight' && nextId != null) slideTo(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, prevId, nextId]);

  // Свайп між картками: горизонтальний жест ПОЗА галереєю (галерея ловить свій
  // свайп фото). Розмежовуємо за початковою точкою дотику й домінантою осі X.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    let x0 = 0, y0 = 0, lastX = 0, lastT = 0, v = 0, dx = 0;
    let active = false, inGallery = false, atStart = true, atEnd = true;
    let mode: 'undecided' | 'drag' | 'ignore' = 'undecided';

    const onStart = (e: TouchEvent) => {
      if (animating.current) return;              // ще їде — новий жест не перехоплюємо
      const t = e.touches[0];
      x0 = lastX = t.clientX; y0 = t.clientY; lastT = e.timeStamp;
      v = 0; dx = 0; active = true; mode = 'undecided';
      // Галерея перехоплює свайп ЛИШЕ коли є що гортати (≥2 фото). За одного фото
      // свайп по фото теж гортає ТОВАРИ (інакше на фото «нічого не відбувається»).
      const g = (e.target as HTMLElement)?.closest?.('.gallery') as HTMLElement | null;
      const track = g?.querySelector('.gallery-track') as HTMLElement | null;
      inGallery = !!g && g.querySelectorAll('.gallery-slide').length > 1;
      // Чи галерея вже на краю ДО жесту — щоб «дотяг» за останнє/перше фото
      // гортав ТОВАРИ (як у великих магазинах), а не впирався в кінець стрічки.
      atStart = !track || track.scrollLeft <= 2;
      atEnd = !track || track.scrollLeft >= track.scrollWidth - track.clientWidth - 2;
    };

    const onMove = (e: TouchEvent) => {
      if (!active) return;
      const t = e.touches[0];
      const ddx = t.clientX - x0, ddy = t.clientY - y0;
      if (mode === 'undecided') {
        if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;   // ще замало руху — не вирішуємо
        // Горизонтальний намір + чи взагалі дозволено тягти (галерея має бути на краю)
        const horizontal = Math.abs(ddx) > Math.abs(ddy) * 1.2;
        const allowed = !inGallery || (ddx < 0 ? atEnd : atStart);
        mode = horizontal && allowed ? 'drag' : 'ignore';
      }
      if (mode !== 'drag') return;
      dragging.current = true;
      // Гасимо власний скрол сторінки — інакше жест «пливе» по діагоналі
      if (e.cancelable) e.preventDefault();
      const dt = e.timeStamp - lastT;
      if (dt > 0) { v = (t.clientX - lastX) / dt; lastX = t.clientX; lastT = e.timeStamp; }
      // Якщо в цей бік товарів немає — сильний опір (гумка), щоб було видно межу
      const noTarget = (ddx < 0 ? live.current.nextId : live.current.prevId) == null;
      dx = noTarget ? ddx * 0.22 : ddx;
      // Пишемо transform одразу: touchmove уже приходить покадрово, а зайвий rAF
      // лише додав би кадр затримки між пальцем і карткою.
      setRail(restPx() + dx);
    };

    const onEnd = () => {
      if (!active) return;
      active = false;
      dragging.current = false;
      if (mode !== 'drag') { mode = 'undecided'; return; }
      mode = 'undecided';
      const w = el.clientWidth || window.innerWidth;
      const dir: -1 | 1 = dx < 0 ? 1 : -1;
      const target = dir === 1 ? live.current.nextId : live.current.prevId;
      // «Дотягнув» = чверть екрана АБО швидкий кидок (як у сучасних стрічках)
      const pass = target != null
        && (Math.abs(dx) > w * 0.24 || (Math.abs(v) > 0.45 && Math.abs(dx) > 24));
      if (pass) slideTo(dir, v);
      else setRail(restPx(), 260);   // не дотягнув — пружиною назад
      dx = 0; v = 0;
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
      // Страховка: якщо слухачі перечепились посеред жесту — не лишаємо стрічку зсунутою
      if (dragging.current) { dragging.current = false; setRail(restPx()); }
    };
    // product?.id у залежностях: доки товар вантажиться, рендериться заглушка БЕЗ ref
    // (pageRef.current === null) і слухачі не чіпляються — без цього свайп на щойно
    // відкритій картці не працював зовсім.
  }, [product?.id]);

  // Клік по затемненому фону (поза карткою) на десктопі — закрити
  const handleBackdrop = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('product-pane') && window.matchMedia('(min-width: 768px)').matches) onBack();
  };

  if (error) {
    return (
      <div className="product-page">
        {!isInTelegram && <button type="button" className="back-fab" onClick={onBack} aria-label="Назад">←</button>}
        <div className="empty">
          <div className="title">Товар недоступний</div>
          <div>Можливо, його вже продано</div>
        </div>
      </div>
    );
  }

  if (!product) return <div className="product-page"><div className="empty">Завантаження…</div></div>;

  return (
    <div className="product-page" ref={pageRef} onClick={handleBackdrop}>
      {!isInTelegram && <button type="button" className="back-fab" onClick={onBack} aria-label="Назад">←</button>}
      <div className="swipe-rail" ref={railRef}>
        {ids.map((id, i) => {
          const p = cache.get(cacheKey(id));
          return (
            <div className="product-pane" key={id}
              style={{ transform: `translate3d(calc(${i} * (100% + ${SWIPE_GAP}px)), 0, 0)` }}>
              {p ? (
                <ProductSheet product={p} admin={admin} adminAuth={adminAuth}
                  onAdminAuthFailure={onAdminAuthFailure}
                  isFavorite={isFavorite} onToggleFav={onToggleFav}
                  onPatch={(updater) => patchProduct(id, updater)}
                  sellerUsername={sellerUsername} sellerPhone={sellerPhone}
                  sellerInstagram={sellerInstagram} sellerViber={sellerViber} />
              ) : (
                <div className="empty">Завантаження…</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

type SheetProps = {
  product: ProductDetail;
  onPatch: (updater: (p: ProductDetail) => ProductDetail) => void;
  isFavorite?: (pn: string) => boolean;
  onToggleFav?: (pn: string) => Promise<{ favorite: boolean; fav_count?: number }>;
  adminAuth?: (onAuthed?: () => void) => AdminAuth | null;
  onAdminAuthFailure?: (hint: string, retry?: () => void) => void;
  sellerUsername: string;
  sellerPhone: string;
  sellerInstagram: string;
  sellerViber: string;
  admin: boolean;
};

// Одна картка товару всередині панелі стрічки: галерея, характеристики, зв'язок.
// Власний стан галереї (слайд/скрол) — у кожної панелі свій, тому сусідні картки
// не «підглядають» одна за одною під час свайпу.
const ProductSheet = ({ product, onPatch, isFavorite, onToggleFav, adminAuth, onAdminAuthFailure, sellerUsername, sellerPhone, sellerInstagram, sellerViber, admin }: SheetProps) => {
  const [slide, setSlide] = useState(0);
  const [copied, setCopied] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setSlide(0); trackRef.current?.scrollTo({ left: 0 }); }, [product.id]);

  const handleScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const index = Math.round(track.scrollLeft / track.clientWidth);
    if (index !== slide) setSlide(index);
  };

  // Навігація галереї (стрілки/крапки) з циклом
  const goToSlide = (i: number) => {
    const total = product.images.length;
    if (total === 0) return;
    const next = (i + total) % total;
    setSlide(next);
    trackRef.current?.scrollTo({ left: next * (trackRef.current?.clientWidth ?? 0), behavior: 'smooth' });
  };

  const handleContact = () => {
    haptic('medium');
    contactSeller(sellerUsername, product.productnumber);
  };

  // ♥️ на сторінці товару: перемикаємо обране й оновлюємо лічильник у стані картки
  const handleFav = () => {
    if (!onToggleFav) return;
    onToggleFav(product.productnumber).then((r) => {
      onPatch((p) => ({
        ...p,
        fav_count: r.fav_count != null ? r.fav_count : Math.max(0, (p.fav_count ?? 0) + (r.favorite ? 1 : -1)),
      }));
    });
  };

  // Копіювання номера товару в буфер обміну (з fallback для обмежених контекстів)
  const handleCopyNumber = () => {
    const text = product.productnumber;
    const done = () => { haptic('light'); setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => { fallback(); done(); });
    } else {
      fallback();
      done();
    }
  };

  // Назва = бренд + модель (напр. «Ecco Street 720»)
  const titleText = [product.brandname, product.model].filter(Boolean).join(' ')
    || product.typename || 'Без назви';
  // Підзаголовок = Тип / Стать (напр. «Кросівки / Жіночі»); стать — у формі прикметника
  const GENDER_LABEL: Record<string, string> = { 'Жіноча': 'Жіночі', 'Чоловіча': 'Чоловічі', 'Унісекс': 'Унісекс' };
  const genderLabel = product.gendername && !['Невідомо', 'Невизначено'].includes(product.gendername)
    ? (GENDER_LABEL[product.gendername] ?? product.gendername) : null;
  const subtitle = [product.typename, genderLabel].filter(Boolean).join(' / ');

  // Сезон ховаємо для аксесуарів (сумки/валізи/ремені/окуляри); Габарити — лише де є
  const showSeason = !NO_SEASON_TYPES.has(product.typename ?? '');
  const specs: Array<[string, string | null]> = [
    ['Підвид', product.subtypename],
    ['Стиль', product.stylename],
    ['Колір', product.colorname],
    ['Стан', product.conditionname],
    ['Габарити', product.dimensions],
    ['Сезон', showSeason ? formatSeason(product.season) : null],
    ['Довжина', rangeCm(product.measurements_length_min, product.measurements_length_max)],
    ['Висота', rangeCm(product.measurements_height_min, product.measurements_height_max)],
    ['Каблук', rangeCm(product.measurements_heel_min, product.measurements_heel_max)],
    ['Платформа', rangeCm(product.measurements_sole_thickness_min, product.measurements_sole_thickness_max)],
    ['Повнота', product.width],
    ['Рік', product.year ? String(product.year) : null],
  ];

  // Підпис розміру варіанта: EU → літерний → устілка в см
  const variantLabel = (v: typeof product.size_variants[number]): string =>
    v.sizeeu ? `${v.sizeeu} EU` : v.size_letter ?? (v.measurementscm ? `${v.measurementscm} см` : 'один розмір');

  const materialRows = MATERIAL_ORDER
    .filter((position) => product.materials[position]?.length)
    .map((position) => [MATERIAL_LABELS[position],
      product.materials[position].map((m) => capSlash(m)).join(', ')] as const);

  // Технології моделі (GORE-TEX, Vibram…) — важливий аргумент вибору. Парсимо
  // «брудний» рядок у бейджі; лого підхопиться з /tech-logos/<slug>.svg, якщо є.
  const techs = parseTechnologies(product.technology);

  // Знижка — ДВА джерела: акційна ціна каталогу (sale_price) АБО «стара» знижена
  // ціна (oldprice > price, скинуто в BMS). Обидві дають −X% і закреслений оригінал.
  const catalogSale = product.sale_price != null && product.sale_price < product.price;
  const legacySale = !catalogSale && product.oldprice != null && product.oldprice > product.price;
  const onSale = catalogSale || legacySale;
  const shownPrice = catalogSale ? product.sale_price! : product.price;
  const priceOriginal = catalogSale ? product.price : (legacySale ? product.oldprice! : null);

  return (
    <div className="product-sheet">
      <div className="gallery">
        {/* Номер товару — мінімалістично в кутку, клік копіює в буфер */}
        <button type="button" className="number-pill" onClick={handleCopyNumber}
          title="Скопіювати номер">
          {copied ? 'Скопійовано ✓' : product.productnumber}
        </button>
        <div className="gallery-track" ref={trackRef} onScroll={handleScroll}>
          {product.images.length > 0 ? product.images.map((img, i) => (
            <div className="gallery-slide" key={img.url}>
              <img src={img.url} alt={titleText} decoding="async"
                loading={i === 0 ? 'eager' : 'lazy'} />
              {KIND_LABELS[img.kind] && <span className="kind-tag">{KIND_LABELS[img.kind]}</span>}
            </div>
          )) : <div className="gallery-slide">Без фото</div>}
        </div>
        {product.images.length > 1 && (
          <>
            <button type="button" className="gallery-arrow prev" aria-label="Попереднє фото"
              onClick={() => goToSlide(slide - 1)}><ChevronIcon dir="left" /></button>
            <button type="button" className="gallery-arrow next" aria-label="Наступне фото"
              onClick={() => goToSlide(slide + 1)}><ChevronIcon dir="right" /></button>
            <div className="gallery-dots">
              {product.images.map((img, i) => (
                <button type="button" key={img.url}
                  className={`dot${i === slide ? ' active' : ''}`}
                  aria-label={`Фото ${i + 1}`}
                  onClick={() => goToSlide(i)} />
              ))}
            </div>
          </>
        )}
      </div>

      <div className="product-side">
      <div className="product-info">
        <div className="product-header">
          {subtitle && <div className="product-brand">{subtitle}</div>}
          <h1 className="product-title">{titleText}</h1>
          <div className="price-row">
            <span className={`price product-price${onSale ? ' sale' : ''}`}>{formatPrice(shownPrice)}</span>
            {priceOriginal && <span className="price-old">{formatPrice(priceOriginal)}</span>}
            {onSale && priceOriginal && <span className="sale-badge inline">−{discountPct(priceOriginal, shownPrice)}%</span>}
          </div>
          <div className="meta-line">
            {onToggleFav && (
              <button type="button"
                className={`fav-line${isFavorite?.(product.productnumber) ? ' on' : ''}`}
                onClick={handleFav} aria-pressed={isFavorite?.(product.productnumber)}
                title={isFavorite?.(product.productnumber) ? 'Прибрати з обраного' : 'Додати в обране'}>
                <HeartIcon filled={isFavorite?.(product.productnumber)} />
                {(product.fav_count ?? 0) > 0 ? `${product.fav_count} в обраному` : 'В обране'}
              </button>
            )}
            {admin && (
              <span className="views-line" title="Переглядів цієї картки покупцями">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" />
                </svg>
                {product.views ?? 0} переглядів
              </span>
            )}
          </div>
        </div>

        {product.size_variants.length > 0 && (
          <div className="detail-card">
            <h3>Розміри в наявності</h3>
            <div className="filter-options">
              {product.size_variants.map((variant) => (
                <span className="size-pill" key={variant.id}>
                  {variantLabel(variant)}
                  {variant.measurementscm && variant.sizeeu && (
                    <span className="option-count">{variant.measurementscm} см</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Опис: адмін редагує текст і керує публічністю; публіка бачить опис лише
            якщо адмін зробив його публічним (бекенд віддає description тільки тоді). */}
        {admin && adminAuth ? (
          <AdminDescription product={product} auth={adminAuth} onAuthFailure={onAdminAuthFailure}
            onSaved={(patch) => onPatch((p) => ({
              ...p,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.is_public !== undefined ? { description_public: patch.is_public } : {}),
            }))} />
        ) : product.description ? (
          <div className="detail-card">
            <h3>Опис</h3>
            <p className="description">{cap(product.description)}</p>
          </div>
        ) : null}

        {/* Знижка — керує лише адмін (акційна ціна для вітрини, products.price недоторканий) */}
        {admin && adminAuth && (
          <AdminDiscount product={product} auth={adminAuth} onAuthFailure={onAdminAuthFailure}
            onSaved={(r) => onPatch((p) => ({ ...p, on_sale: r.is_on_sale, sale_price: r.sale_price }))} />
        )}

        {techs.length > 0 && (
          <div className="detail-card">
            <h3>Технології</h3>
            <div className="tech-row">
              {techs.map((t) => (
                <span className="tech-badge" key={t.slug || t.label} title={t.label}>
                  <img className="tech-logo" src={`/tech-logos/${t.slug}.svg`} alt=""
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                  {t.label}
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="detail-card">
          <h3>Характеристики</h3>
          {specs.filter(([, value]) => value).map(([key, value]) => (
            <div className="spec-row" key={key}>
              <span className="spec-key">{key}</span>
              <span className="spec-val">{capSlash(value)}</span>
            </div>
          ))}
        </div>

        {materialRows.length > 0 && (
          <div className="detail-card">
            <h3>Матеріали</h3>
            {materialRows.map(([key, value]) => (
              <div className="spec-row" key={key}>
                <span className="spec-key">{key}</span>
                <span className="spec-val">{value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {(sellerUsername || sellerPhone || sellerInstagram || sellerViber) && (
        <div className="contact-bar">
          {sellerUsername && (
            <button type="button" className="btn-primary contact-primary" onClick={handleContact}>
              Замовити
            </button>
          )}
          {sellerPhone && (
            <button type="button" className="contact-ghost"
              onClick={() => { haptic('light'); contactPhone(sellerPhone); }}
              aria-label="Подзвонити" title="Подзвонити">
              <PhoneIcon />
            </button>
          )}
          {sellerInstagram && (
            <button type="button" className="contact-ghost"
              onClick={() => { haptic('light'); contactInstagram(sellerInstagram); }}
              aria-label="Instagram" title="Instagram">
              <InstagramIcon />
            </button>
          )}
          {sellerViber && (
            <button type="button" className="contact-ghost"
              onClick={() => { haptic('light'); contactViber(sellerViber); }}
              aria-label="Viber" title="Viber">
              <ViberIcon />
            </button>
          )}
        </div>
      )}
      </div>
    </div>
  );
};

const HeartIcon = ({ filled }: { filled?: boolean }) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8z" />
  </svg>
);

// Адмін-редактор опису: текст (пишеться в products.description) + перемикач публічності.
// Зміни — ті самі поля в БД, що бачить/редагує BMS.
const AdminDescription = ({ product, auth, onAuthFailure, onSaved }: {
  product: ProductDetail;
  auth: (onAuthed?: () => void) => AdminAuth | null;
  onAuthFailure?: (hint: string, retry?: () => void) => void;
  onSaved: (patch: { description?: string | null; is_public?: boolean }) => void;
}) => {
  const [text, setText] = useState(product.description ?? '');
  const [isPublic, setIsPublic] = useState(!!product.description_public);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(product.description ?? ''); setIsPublic(!!product.description_public); },
    [product.id, product.description, product.description_public]);

  const dirty = text.trim() !== (product.description ?? '').trim();

  const save = async (patch: { description?: string; is_public?: boolean }) => {
    const a = auth(() => save(patch));   // токена ще нема → після вводу повторить сам
    if (!a) return;
    setSaving(true);
    try {
      await setCatalogDescription({ product_id: product.id, productnumber: product.productnumber, ...patch }, a);
      onSaved({
        ...(patch.description !== undefined ? { description: patch.description.trim() || null } : {}),
        ...(patch.is_public !== undefined ? { is_public: patch.is_public } : {}),
      });
      haptic('light');
    } catch {
      // Токен був, але сервер відхилив (401) — токен-модалка з retry, а не мертвий alert()
      onAuthFailure?.('Не вдалося зберегти опис — перевірте адмін-токен.', () => save(patch));
    } finally {
      setSaving(false);
    }
  };

  const togglePublic = () => { const next = !isPublic; setIsPublic(next); save({ is_public: next }); };

  return (
    <div className="detail-card">
      <h3>
        Опис <span className="admin-only-tag">адмін</span>
        <button type="button" className={`desc-public-toggle${isPublic ? ' on' : ''}`}
          onClick={togglePublic} disabled={saving} aria-pressed={isPublic}
          title={isPublic ? 'Опис видно всім' : 'Опис видно лише вам'}>
          {isPublic ? '● Публічний' : 'Зробити публічним'}
        </button>
      </h3>
      <textarea className="desc-edit" value={text} rows={3}
        placeholder="Опис товару (видно лише вам, поки не публічний)…"
        onChange={(e) => setText(e.target.value)} />
      {dirty && (
        <button type="button" className="desc-save" disabled={saving}
          onClick={() => save({ description: text })}>
          {saving ? 'Збереження…' : 'Зберегти опис'}
        </button>
      )}
    </div>
  );
};

// Адмін-контрол знижки: акційна ціна ЛИШЕ для вітрини (products.price не чіпаємо).
const AdminDiscount = ({ product, auth, onAuthFailure, onSaved }: {
  product: ProductDetail;
  auth: (onAuthed?: () => void) => AdminAuth | null;
  onAuthFailure?: (hint: string, retry?: () => void) => void;
  onSaved: (r: { sale_price: number | null; is_on_sale: boolean }) => void;
}) => {
  const [price, setPrice] = useState(product.sale_price != null ? String(product.sale_price) : '');
  const [on, setOn] = useState(!!product.on_sale);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setPrice(product.sale_price != null ? String(product.sale_price) : '');
    setOn(!!product.on_sale);
  }, [product.id, product.sale_price, product.on_sale]);

  const sp = price.trim() ? Number(price) : null;
  const valid = sp != null && sp > 0 && sp < product.price;

  const save = async (nextOn: boolean) => {
    const a = auth(() => save(nextOn));   // токена ще нема → після вводу повторить сам
    if (!a) return;
    setSaving(true);
    try {
      const r = await setCatalogDiscount(
        { productnumber: product.productnumber, sale_price: sp, is_on_sale: nextOn }, a);
      setOn(r.is_on_sale);
      onSaved(r);
      haptic('light');
    } catch {
      onAuthFailure?.('Не вдалося зберегти знижку — перевірте адмін-токен.', () => save(nextOn));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="detail-card">
      <h3>
        Знижка <span className="admin-only-tag">адмін</span>
        <button type="button" className={`desc-public-toggle${on ? ' on' : ''}`}
          onClick={() => save(!on)} disabled={saving || (!on && !valid)} aria-pressed={on}
          title={on ? 'Знижка активна у вітрині' : 'Увімкнути знижку'}>
          {on ? '● Активна' : 'Увімкнути'}
        </button>
      </h3>
      <div className="discount-row">
        <input className="discount-input" type="number" inputMode="numeric"
          placeholder="Акційна ціна" value={price}
          onChange={(e) => setPrice(e.target.value)} />
        <span className="discount-hint">
          {valid
            ? `−${discountPct(product.price, sp!)}% від ${formatPrice(product.price)}`
            : `Реальна ціна ${formatPrice(product.price)} (products.price не змінюється)`}
        </span>
      </div>
      <button type="button" className="desc-save" disabled={saving}
        onClick={() => save(on)}>
        {saving ? 'Збереження…' : 'Зберегти знижку'}
      </button>
    </div>
  );
};

const ChevronIcon = ({ dir }: { dir: 'left' | 'right' }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {dir === 'left' ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
  </svg>
);

const PhoneIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
  </svg>
);

const InstagramIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4" /><line x1="17.5" y1="6.5" x2="17.5" y2="6.5" />
  </svg>
);

const ViberIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 2.5C6.8 2.5 3.5 5.6 3.5 9.6c0 2 .9 3.8 2.5 5v3.4l3-1.7c1 .2 2 .3 3 .3 5.2 0 8.5-3.1 8.5-7S17.2 2.5 12 2.5z" />
    <path d="M9.2 8.2c.5 1.9 1.9 3.3 3.8 3.9" />
  </svg>
);
