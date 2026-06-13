// Нижній лист гнучких фільтрів каталогу — компактний акордеон зі згорнутими
// секціями: користувач бачить охайний перелік, розгортає лише потрібне.
import { ReactNode, useEffect, useState } from 'react';
import { CatalogQuery, FilterOption, FilterOptions, fetchCatalog, formatPrice } from '../api';
import { useDebounced } from '../hooks/useCatalog';
import { haptic, hapticSelect } from '../telegram';

type Props = {
  options: FilterOptions;
  query: CatalogQuery;
  total: number;
  isAdmin: boolean;   // тумблер «з фото» бачить лише адмін
  onApply: (query: CatalogQuery) => void;
  onClose: () => void;
};

type IdKey = 'typeids' | 'brandids' | 'genderids' | 'color_group_ids' | 'conditionids';
type StrKey = 'seasons' | 'size_letters';

// Пошукові секції (Тип/Бренд): за замовчуванням показуємо лише топ-6 (за
// продажами), щоб не перенавантажувати; решту користувач знаходить пошуком.
const CHIP_DEFAULT = 6;
const CHIP_LIMIT = 40;   // максимум під час активного пошуку в секції
// Базові цілі EU-розміри 14..53. Чіп цілого ловить і дроби (39.5→39), і
// діапазони (39-40 → 39 і 40) — «розумне» зіставлення на боці backend.
const EU_SIZES = Array.from({ length: 53 - 14 + 1 }, (_, i) => 14 + i);

// Перемикання значення у multi-select масиві (undefined коли порожньо)
const toggleValue = <T,>(list: T[] | undefined, value: T): T[] | undefined => {
  const current = list ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return next.length > 0 ? next : undefined;
};

// Назви обраних опцій за id (для згорнутого підсумку секції)
const namesByIds = (opts: FilterOption[], ids?: number[]): string[] =>
  (ids ?? []).map((id) => opts.find((o) => o.id === id)?.name).filter(Boolean) as string[];

// Короткий підсумок: "Adidas, Nike" або "Adidas +3"
const summarize = (values: string[]): string => {
  if (values.length === 0) return '';
  if (values.length <= 2) return values.join(', ');
  return `${values[0]} +${values.length - 1}`;
};

// ── Перемикач (iOS-style) ───────────────────────────────────────────────────
const Toggle = ({ label, checked, onToggle }: { label: string; checked: boolean; onToggle: () => void }) => (
  <button type="button" className="toggle-row" onClick={onToggle} aria-pressed={checked}>
    <span>{label}</span>
    <span className={`switch${checked ? ' on' : ''}`}><span className="knob" /></span>
  </button>
);

// ── Згортувана секція ───────────────────────────────────────────────────────
const Accordion = ({ title, summary, badge, open, onToggle, children }: {
  title: string; summary: string; badge: number; open: boolean; onToggle: () => void; children: ReactNode;
}) => (
  <div className="acc">
    <button type="button" className="acc-head" onClick={onToggle} aria-expanded={open}>
      <span className="acc-title">
        {title}
        {badge > 0 && <span className="acc-badge">{badge}</span>}
      </span>
      <span className="acc-right">
        {!open && summary && <span className="acc-summary">{summary}</span>}
        <svg className={`acc-chevron${open ? ' open' : ''}`} width="16" height="16" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </span>
    </button>
    <div className={`acc-body${open ? ' open' : ''}`}><div className="acc-inner">{children}</div></div>
  </div>
);

// ── Пошукова секція з чіпами (Тип/Бренд) ────────────────────────────────────
const SearchableChips = ({ options, selectedIds, query, onQueryChange, onToggle, placeholder }: {
  options: FilterOption[]; selectedIds: number[] | undefined; query: string;
  onQueryChange: (value: string) => void; onToggle: (id: number) => void; placeholder: string;
}) => {
  const selected = new Set(selectedIds ?? []);
  // Відфільтровані за пошуком, обрані — першими (щоб обране лишалось видимим)
  const filtered = options
    .filter((o) => o.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));
  // Без пошуку — топ-6 (+ будь-які обрані понад це); під час пошуку — більше
  const isSearching = query.trim().length > 0;
  const visibleCount = isSearching ? CHIP_LIMIT : Math.max(CHIP_DEFAULT, selected.size);
  const shown = filtered.slice(0, visibleCount);
  const limit = visibleCount;
  return (
    <>
      <input className="chip-search" type="search" placeholder={placeholder}
        value={query} onChange={(e) => onQueryChange(e.target.value)} />
      <div className="filter-options">
        {shown.map((opt) => (
          <button type="button" key={opt.id}
            className={`chip${selected.has(opt.id) ? ' active' : ''}`}
            onClick={() => onToggle(opt.id)}>
            {opt.name}<span className="option-count">{opt.count}</span>
          </button>
        ))}
      </div>
      {filtered.length > limit && (
        <div className="show-more-hint">Уточніть пошук, щоб побачити решту ({filtered.length})</div>
      )}
      {filtered.length === 0 && <div className="show-more-hint">Нічого не знайдено</div>}
    </>
  );
};

export const FilterSheet = ({ options, query, total, isAdmin, onApply, onClose }: Props) => {
  const [draft, setDraft] = useState<CatalogQuery>(query);
  const [draftTotal, setDraftTotal] = useState(total);
  const [openId, setOpenId] = useState<string | null>(null);   // одна розгорнута секція
  const [typeQuery, setTypeQuery] = useState('');
  const [brandQuery, setBrandQuery] = useState('');
  const debouncedDraft = useDebounced(draft);

  // Живий підрахунок: скільки товарів покаже чернетка фільтрів
  useEffect(() => {
    let cancelled = false;
    fetchCatalog(debouncedDraft, 1, 1)
      .then((data) => { if (!cancelled) setDraftTotal(data.total); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [debouncedDraft]);

  // Блокуємо прокрутку каталогу під листом
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  const toggleSection = (id: string) => { haptic('light'); setOpenId((cur) => (cur === id ? null : id)); };
  const toggleId = (key: IdKey, id: number) => { hapticSelect(); setDraft((d) => ({ ...d, [key]: toggleValue(d[key], id) })); };
  const toggleStr = (key: StrKey, value: string) => { hapticSelect(); setDraft((d) => ({ ...d, [key]: toggleValue(d[key], value) })); };
  const toggleEuSize = (n: number) => { hapticSelect(); setDraft((d) => ({ ...d, eu_sizes: toggleValue(d.eu_sizes, n) })); };

  const handleReset = () => {
    haptic('medium');
    // «Тільки з фото» НЕ скидається — зберігаємо поточний стан тумблера
    setDraft({ search: draft.search, sort: draft.sort, has_photo: draft.has_photo });
    setTypeQuery('');
    setBrandQuery('');
  };

  const handleApply = () => {
    haptic('light');
    onApply(draft);
    onClose();
  };

  // Чіпи опцій-id (тип/стать/стан) з лічильниками
  const idChips = (key: IdKey, list: FilterOption[]) => list.map((opt) => (
    <button type="button" key={opt.id}
      className={`chip${draft[key]?.includes(opt.id) ? ' active' : ''}`}
      onClick={() => toggleId(key, opt.id)}>
      {opt.name}<span className="option-count">{opt.count}</span>
    </button>
  ));

  // Чіпи рядкових опцій (сезон)
  const strChips = (key: StrKey, list: string[]) => list.map((value) => (
    <button type="button" key={value}
      className={`chip${draft[key]?.includes(value) ? ' active' : ''}`}
      onClick={() => toggleStr(key, value)}>
      {value}
    </button>
  ));

  // ── Підсумки для згорнутих секцій ─────────────────────────────────────────
  const sizeSummary = summarize([...(draft.eu_sizes ?? []).map(String), ...(draft.size_letters ?? [])]);
  const priceSummary = (draft.min_price != null || draft.max_price != null)
    ? `${draft.min_price != null ? formatPrice(draft.min_price) : '0'} – ${draft.max_price != null ? formatPrice(draft.max_price) : '∞'}`
    : '';
  const sizeBadge = (draft.eu_sizes?.length ?? 0) + (draft.size_letters?.length ?? 0);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-label="Фільтри">
        <div className="sheet-header">
          <h2>Фільтри</h2>
          <button type="button" className="sheet-reset" onClick={handleReset}>Скинути все</button>
        </div>

        <div className="sheet-body">
          {isAdmin && (
            <Toggle
              label="Тільки з фото"
              checked={Boolean(draft.has_photo)}
              onToggle={() => { hapticSelect(); setDraft((d) => ({ ...d, has_photo: d.has_photo ? undefined : true })); }}
            />
          )}

          {options.types.length > 0 && (
            <Accordion title="Тип" badge={draft.typeids?.length ?? 0}
              summary={summarize(namesByIds(options.types, draft.typeids))}
              open={openId === 'type'} onToggle={() => toggleSection('type')}>
              <SearchableChips options={options.types} selectedIds={draft.typeids} query={typeQuery}
                onQueryChange={setTypeQuery} onToggle={(id) => toggleId('typeids', id)}
                placeholder="Пошук типу…" />
            </Accordion>
          )}

          <Accordion title="Розмір" badge={sizeBadge} summary={sizeSummary}
            open={openId === 'size'} onToggle={() => toggleSection('size')}>
            <div className="filter-label">EU</div>
            <div className="size-grid">
              {EU_SIZES.map((n) => (
                <button type="button" key={n}
                  className={`size-chip${draft.eu_sizes?.includes(n) ? ' active' : ''}`}
                  onClick={() => toggleEuSize(n)}>
                  {n}
                </button>
              ))}
            </div>
            {options.size_letters.length > 0 && (
              <>
                <div className="filter-label">Розмірна сітка</div>
                <div className="filter-options">{strChips('size_letters', options.size_letters)}</div>
              </>
            )}
          </Accordion>

          {options.brands.length > 0 && (
            <Accordion title="Бренд" badge={draft.brandids?.length ?? 0}
              summary={summarize(namesByIds(options.brands, draft.brandids))}
              open={openId === 'brand'} onToggle={() => toggleSection('brand')}>
              <SearchableChips options={options.brands} selectedIds={draft.brandids} query={brandQuery}
                onQueryChange={setBrandQuery} onToggle={(id) => toggleId('brandids', id)}
                placeholder="Пошук бренду…" />
            </Accordion>
          )}

          <Accordion title="Ціна" badge={priceSummary ? 1 : 0} summary={priceSummary}
            open={openId === 'price'} onToggle={() => toggleSection('price')}>
            <div className="price-inputs">
              <input type="number" inputMode="numeric"
                placeholder={`від ${Math.floor(options.price_range.min)}`}
                value={draft.min_price ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, min_price: e.target.value ? Number(e.target.value) : undefined }))} />
              <span>—</span>
              <input type="number" inputMode="numeric"
                placeholder={`до ${Math.ceil(options.price_range.max)}`}
                value={draft.max_price ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, max_price: e.target.value ? Number(e.target.value) : undefined }))} />
            </div>
          </Accordion>

          {options.color_groups.length > 0 && (
            <Accordion title="Колір" badge={draft.color_group_ids?.length ?? 0}
              summary={summarize(namesByIds(options.color_groups, draft.color_group_ids))}
              open={openId === 'color'} onToggle={() => toggleSection('color')}>
              <div className="filter-options">
                {options.color_groups.map((group) => (
                  <button type="button" key={group.id}
                    className={`chip${draft.color_group_ids?.includes(group.id) ? ' active' : ''}`}
                    onClick={() => toggleId('color_group_ids', group.id)}>
                    {group.hex_code && <span className="color-dot" style={{ background: group.hex_code }} />}
                    {group.name}<span className="option-count">{group.count}</span>
                  </button>
                ))}
              </div>
            </Accordion>
          )}

          {options.seasons.length > 0 && (
            <Accordion title="Сезон" badge={draft.seasons?.length ?? 0}
              summary={summarize(draft.seasons ?? [])}
              open={openId === 'season'} onToggle={() => toggleSection('season')}>
              <div className="filter-options">{strChips('seasons', options.seasons)}</div>
            </Accordion>
          )}

          {options.genders.length > 0 && (
            <Accordion title="Стать" badge={draft.genderids?.length ?? 0}
              summary={summarize(namesByIds(options.genders, draft.genderids))}
              open={openId === 'gender'} onToggle={() => toggleSection('gender')}>
              <div className="filter-options">{idChips('genderids', options.genders)}</div>
            </Accordion>
          )}

          {options.conditions.length > 0 && (
            <Accordion title="Стан" badge={draft.conditionids?.length ?? 0}
              summary={summarize(namesByIds(options.conditions, draft.conditionids))}
              open={openId === 'condition'} onToggle={() => toggleSection('condition')}>
              <div className="filter-options">{idChips('conditionids', options.conditions)}</div>
            </Accordion>
          )}
        </div>

        <div className="sheet-footer">
          <button type="button" className="btn-primary" onClick={handleApply} disabled={draftTotal === 0}>
            {draftTotal > 0 ? `Показати ${draftTotal} товарів` : 'Нічого не знайдено'}
          </button>
        </div>
      </div>
    </>
  );
};

// Кількість активних фільтрів — бейдж на кнопці фільтрів
export const countActiveFilters = (query: CatalogQuery): number => {
  const lists = [
    query.typeids, query.subtypeids, query.brandids, query.genderids,
    query.color_group_ids, query.conditionids, query.seasons, query.eu_sizes, query.size_letters,
  ];
  let count = lists.reduce((acc, list) => acc + (list?.length ?? 0), 0);
  if (query.min_price !== undefined) count += 1;
  if (query.max_price !== undefined) count += 1;
  // has_photo — базовий дефолт каталогу, не рахуємо як активний фільтр
  return count;
};
