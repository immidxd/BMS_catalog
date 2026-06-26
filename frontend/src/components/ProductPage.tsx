// Повна сторінка товару: галерея (свайп), характеристики, зв'язок з продавцем
import React, { useEffect, useRef, useState } from 'react';
import { ProductDetail, fetchProduct, formatPrice, formatSeason } from '../api';
import { contactInstagram, contactPhone, contactSeller, haptic, isInTelegram, showBackButton } from '../telegram';

type Props = {
  productId: number;
  sellerUsername: string;
  sellerPhone: string;
  sellerInstagram: string;
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

// "10–11 см" / "10 см" / null з пари min/max
const rangeCm = (min: number | null, max: number | null): string | null => {
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${min}–${max} см`;
  return `${min ?? max} см`;
};

// Стандартизована капіталізація значень характеристик (перша літера велика)
const cap = (s: string | null): string | null =>
  s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export const ProductPage = ({ productId, sellerUsername, sellerPhone, sellerInstagram, onBack }: Props) => {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState(false);
  const [slide, setSlide] = useState(0);
  const [copied, setCopied] = useState(false);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => showBackButton(onBack), [onBack]);

  // Esc закриває картку (зручно на десктопі)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onBack(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Клік по затемненому фону (поза карткою) на десктопі — закрити
  const handleBackdrop = (e: React.MouseEvent) => { if (e.target === e.currentTarget) onBack(); };

  useEffect(() => {
    let cancelled = false;
    fetchProduct(productId)
      .then((data) => { if (!cancelled) setProduct(data); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [productId]);

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

  const specs: Array<[string, string | null]> = [
    ['Підвид', product.subtypename],
    ['Стиль', product.stylename],
    ['Колір', product.colorname],
    ['Стан', product.conditionname],
    ['Сезон', formatSeason(product.season)],
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

  return (
    <div className="product-page" onClick={handleBackdrop}>
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
              onClick={() => goToSlide(slide - 1)}>‹</button>
            <button type="button" className="gallery-arrow next" aria-label="Наступне фото"
              onClick={() => goToSlide(slide + 1)}>›</button>
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
        </div>

        {product.size_variants.length > 0 && (
          <div className="detail-card">
            <h3>Розміри в наявності</h3>
            <div className="filter-options">
              {product.size_variants.map((variant) => (
                <span className="chip active" key={variant.id}>
                  {variantLabel(variant)}
                  {variant.measurementscm && variant.sizeeu && (
                    <span className="option-count">{variant.measurementscm} см</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {product.description && (
          <div className="detail-card">
            <h3>Опис</h3>
            <p className="description">{cap(product.description)}</p>
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

      {(sellerUsername || sellerPhone || sellerInstagram) && (
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
        </div>
      )}
      </div>
      </div>
    </div>
  );
};

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
