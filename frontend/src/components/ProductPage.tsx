// Повна сторінка товару: галерея (свайп), характеристики, зв'язок з продавцем
import React, { useEffect, useRef, useState } from 'react';
import { AdminAuth, ProductDetail, fetchProduct, formatPrice, formatSeason, setCatalogDescription } from '../api';
import { parseTechnologies } from '../techLogos';
import { contactInstagram, contactPhone, contactSeller, contactViber, haptic, isInTelegram, showBackButton } from '../telegram';

type Props = {
  productId: number;
  siblingIds?: number[];             // порядок карток у каталозі — для гортання свайпом
  onNavigate?: (id: number) => void; // відкрити сусідню картку
  onNeedMore?: () => void;           // підвантажити ще (коли дійшли до кінця списку)
  isFavorite?: (pn: string) => boolean;
  onToggleFav?: (pn: string) => Promise<{ favorite: boolean; fav_count?: number }>;
  adminAuth?: () => AdminAuth | null;   // авторизація адмін-запису (для редагування опису)
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

// Стандартизована капіталізація значень характеристик (перша літера велика)
const cap = (s: string | null): string | null =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export const ProductPage = ({ productId, siblingIds = [], onNavigate, onNeedMore, isFavorite, onToggleFav, adminAuth, sellerUsername, sellerPhone, sellerInstagram, sellerViber, admin = false, onBack }: Props) => {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState(false);
  const [slide, setSlide] = useState(0);
  const [copied, setCopied] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Сусідні картки в поточному порядку каталогу (для гортання свайпом/стрілками)
  const idx = siblingIds.indexOf(productId);
  const prevId = idx > 0 ? siblingIds[idx - 1] : null;
  const nextId = idx >= 0 && idx < siblingIds.length - 1 ? siblingIds[idx + 1] : null;
  const goSibling = (dir: -1 | 1) => {
    const target = dir === -1 ? prevId : nextId;
    if (target != null) onNavigate?.(target);
    // Наближаємось до кінця завантаженого списку — просимо ще (безкінечне гортання)
    if (dir === 1 && idx >= siblingIds.length - 2) onNeedMore?.();
  };

  useEffect(() => showBackButton(onBack), [onBack]);

  // Esc закриває картку; ← / → гортають сусідні картування (зручно на десктопі)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
      else if (e.key === 'ArrowLeft' && prevId != null) goSibling(-1);
      else if (e.key === 'ArrowRight' && nextId != null) goSibling(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack, prevId, nextId]);

  // Свайп між картками: горизонтальний жест ПОЗА галереєю (галерея ловить свій
  // свайп фото). Розмежовуємо за початковою точкою дотику й домінантою осі X.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    let x0 = 0, y0 = 0, inGallery = false, active = false;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      x0 = t.clientX; y0 = t.clientY; active = true;
      inGallery = !!(e.target as HTMLElement)?.closest?.('.gallery');
    };
    const onEnd = (e: TouchEvent) => {
      if (!active || inGallery) { active = false; return; }
      active = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      // Впевнено горизонтальний жест (не вертикальний скрол) і достатньої довжини
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        goSibling(dx < 0 ? 1 : -1);   // свайп вліво → наступна, вправо → попередня
      }
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
    };
  }, [prevId, nextId, idx, siblingIds.length]);

  // Клік по затемненому фону (поза карткою) на десктопі — закрити
  const handleBackdrop = (e: React.MouseEvent) => { if (e.target === e.currentTarget) onBack(); };

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setSlide(0);                                   // нова картка — з першого фото
    pageRef.current?.scrollTo({ top: 0 });         // і згори
    trackRef.current?.scrollTo({ left: 0 });
    fetchProduct(productId, admin)
      .then((data) => { if (!cancelled) setProduct(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [productId, admin]);

  const handleScroll = () => {
    const track = trackRef.current;
    if (!track) return;
    const index = Math.round(track.scrollLeft / track.clientWidth);
    if (index !== slide) setSlide(index);
  };

  // Навігація галереї (стрілки/крапки) з циклом
  const goToSlide = (i: number) => {
    const total = product?.images.length ?? 0;
    if (total === 0) return;
    const idx = (i + total) % total;
    setSlide(idx);
    trackRef.current?.scrollTo({ left: idx * (trackRef.current?.clientWidth ?? 0), behavior: 'smooth' });
  };

  const handleContact = () => {
    haptic('medium');
    if (product) contactSeller(sellerUsername, product.productnumber);
  };

  // ♥️ на сторінці товару: перемикаємо обране й оновлюємо лічильник у стані картки
  const handleFav = () => {
    if (!product || !onToggleFav) return;
    onToggleFav(product.productnumber).then((r) => {
      setProduct((p) => p ? {
        ...p,
        fav_count: r.fav_count != null ? r.fav_count : Math.max(0, (p.fav_count ?? 0) + (r.favorite ? 1 : -1)),
      } : p);
    });
  };

  // Копіювання номера товару в буфер обміну (з fallback для обмежених контекстів)
  const handleCopyNumber = () => {
    if (!product) return;
    const text = product.productnumber;
    const done = () => { haptic('light'); setCopied(true); setTimeout(() => setCopied(false), 1500); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
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
    .map((position) => [MATERIAL_LABELS[position], cap(product.materials[position].join(', '))] as const);

  // Технології моделі (GORE-TEX, Vibram…) — важливий аргумент вибору. Парсимо
  // «брудний» рядок у бейджі; лого підхопиться з /tech-logos/<slug>.svg, якщо є.
  const techs = parseTechnologies(product.technology);

  return (
    <div className="product-page" ref={pageRef} onClick={handleBackdrop}>
      {!isInTelegram && <button type="button" className="back-fab" onClick={onBack} aria-label="Назад">←</button>}

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
          <div>
            <span className="price product-price">{formatPrice(product.price)}</span>
            {product.oldprice && product.oldprice > product.price && (
              <span className="price-old">{formatPrice(product.oldprice)}</span>
            )}
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
          <AdminDescription product={product} auth={adminAuth}
            onSaved={(patch) => setProduct((p) => p ? {
              ...p,
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(patch.is_public !== undefined ? { description_public: patch.is_public } : {}),
            } : p)} />
        ) : product.description ? (
          <div className="detail-card">
            <h3>Опис</h3>
            <p className="description">{cap(product.description)}</p>
          </div>
        ) : null}

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
              <span className="spec-val">{cap(value)}</span>
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
const AdminDescription = ({ product, auth, onSaved }: {
  product: ProductDetail;
  auth: () => AdminAuth | null;
  onSaved: (patch: { description?: string | null; is_public?: boolean }) => void;
}) => {
  const [text, setText] = useState(product.description ?? '');
  const [isPublic, setIsPublic] = useState(!!product.description_public);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setText(product.description ?? ''); setIsPublic(!!product.description_public); },
    [product.id, product.description, product.description_public]);

  const dirty = text.trim() !== (product.description ?? '').trim();

  const save = async (patch: { description?: string; is_public?: boolean }) => {
    const a = auth();
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
      haptic('medium');
      alert('Не вдалося зберегти опис (перевірте доступ/токен).');
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
