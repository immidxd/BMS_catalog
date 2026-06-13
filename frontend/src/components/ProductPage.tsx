// Повна сторінка товару: галерея (свайп), характеристики, зв'язок з продавцем
import React, { useEffect, useRef, useState } from 'react';
import { ProductDetail, fetchProduct, formatPrice } from '../api';
import { contactSeller, haptic, isInTelegram, showBackButton } from '../telegram';

type Props = { productId: number; sellerUsername: string; onBack: () => void };

const KIND_LABELS: Record<string, string> = { real: 'реальне фото', defect: 'нюанс' };
const MATERIAL_LABELS: Record<string, string> = {
  upper: 'Верх', middle: 'Проміжний шар', insole: 'Устілка', sole: 'Підошва', membrane: 'Мембрана',
};

// "10–11 см" / "10 см" / null з пари min/max
const rangeCm = (min: number | null, max: number | null): string | null => {
  if (min == null && max == null) return null;
  if (min != null && max != null && min !== max) return `${min}–${max} см`;
  return `${min ?? max} см`;
};

export const ProductPage = ({ productId, sellerUsername, onBack }: Props) => {
  const [product, setProduct] = useState<ProductDetail | null>(null);
  const [error, setError] = useState(false);
  const [slide, setSlide] = useState(0);
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

  const handleContact = () => {
    haptic('medium');
    if (product) contactSeller(sellerUsername, product.productnumber);
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

  const specs: Array<[string, string | null]> = [
    ['Номер', product.productnumber],
    ['Тип', [product.typename, product.subtypename].filter(Boolean).join(' / ') || null],
    ['Стиль', product.stylename],
    ['Стать', product.gendername],
    ['Колір', product.colorname],
    ['Стан', product.conditionname],
    ['Сезон', product.season],
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

  const materialRows = Object.entries(product.materials)
    .filter(([position]) => MATERIAL_LABELS[position])
    .map(([position, names]) => [MATERIAL_LABELS[position], names.join(', ')] as const);

  return (
    <div className="product-page" onClick={handleBackdrop}>
      {!isInTelegram && <button type="button" className="back-fab" onClick={onBack} aria-label="Назад">←</button>}

      <div className="product-sheet">
      <div className="gallery">
        <div className="gallery-track" ref={trackRef} onScroll={handleScroll}>
          {product.images.length > 0 ? product.images.map((img) => (
            <div className="gallery-slide" key={img.url}>
              <img src={img.url} alt={product.model ?? product.productnumber} loading="lazy" />
              {KIND_LABELS[img.kind] && <span className="kind-tag">{KIND_LABELS[img.kind]}</span>}
            </div>
          )) : <div className="gallery-slide">Без фото</div>}
        </div>
        {product.images.length > 1 && (
          <div className="gallery-dots">
            {product.images.map((img, i) => (
              <button
                type="button"
                key={img.url}
                className={`dot${i === slide ? ' active' : ''}`}
                aria-label={`Фото ${i + 1}`}
                onClick={() => {
                  setSlide(i);
                  trackRef.current?.scrollTo({ left: i * trackRef.current.clientWidth, behavior: 'smooth' });
                }}
              />
            ))}
          </div>
        )}
      </div>

      <div className="product-side">
      <div className="product-info">
        <div className="product-header">
          {product.brandname && <div className="product-brand">{product.brandname}</div>}
          <h1 className="product-title">{product.model ?? product.typename ?? 'Без назви'}</h1>
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
            <p className="description">{product.description}</p>
          </div>
        )}

        <div className="detail-card">
          <h3>Характеристики</h3>
          {specs.filter(([, value]) => value).map(([key, value]) => (
            <div className="spec-row" key={key}>
              <span className="spec-key">{key}</span>
              <span className="spec-val">{value}</span>
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

      {sellerUsername && (
        <div className="contact-bar">
          <button type="button" className="btn-primary" onClick={handleContact}>
            Написати продавцю
          </button>
        </div>
      )}
      </div>
      </div>
    </div>
  );
};
