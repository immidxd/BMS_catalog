// Іконки біля «Сезон» і «Стан» у картці: лінійні з Tabler Icons (MIT) — той самий розмір і
// вага лінії, що й ⓘ, тож баланс рядка не ламається. Колір — ледь тематичний (сезон:
// холодний/оливковий/теплий; стан: від зеленого «Новий» до червоного «Пошкоджений»).
// Невідоме значення — без іконки.
import React from 'react';

const PATHS: Record<string, string[]> = {
  'зима': ['M10 4l2 1l2 -1', 'M12 2v6.5l3 1.72', 'M17.928 6.268l.134 2.232l1.866 1.232',
    'M20.66 7l-5.629 3.25l.01 3.458', 'M19.928 14.268l-1.866 1.232l-.134 2.232',
    'M20.66 17l-5.629 -3.25l-2.99 1.738', 'M14 20l-2 -1l-2 1', 'M12 22v-6.5l-3 -1.72',
    'M6.072 17.732l-.134 -2.232l-1.866 -1.232', 'M3.34 17l5.629 -3.25l-.01 -3.458',
    'M4.072 9.732l1.866 -1.232l.134 -2.232', 'M3.34 7l5.629 3.25l2.99 -1.738'],
  'єврозима': ['M7 18a4.6 4.4 0 0 1 0 -9a5 4.5 0 0 1 11 2h1a3.5 3.5 0 0 1 0 7',
    'M11 15v.01m0 3v.01m0 3v.01m4 -4v.01m0 3v.01'],
  'демі': ['M5 21c.5 -4.5 2.5 -8 7 -10', 'M9 18c6.218 0 10.5 -3.288 11 -12v-2h-4.014c-9 0 -11.986 4 -12 9c0 1 0 3 2 5h3z'],
  'літо': ['M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0',
    'M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7'],
  'всесезон': ['M9.828 9.172a4 4 0 1 0 0 5.656a10 10 0 0 0 2.172 -2.828a10 10 0 0 1 2.172 -2.828a4 4 0 1 1 0 5.656a10 10 0 0 1 -2.172 -2.828a10 10 0 0 0 -2.172 -2.828'],
};

const CIRCLE = 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0';
const CONDITION: Record<string, [string, string[]]> = {
  'новий': ['new', [CIRCLE, 'M9 12l2 2l4 -4']],
  'хороший / сток': ['good', ['M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2z', 'M9 12l2 2l4 -4']],
  'легковживаний': ['light', ['M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3']],
  'вживаний': ['used', ['M12 9v4', 'M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z', 'M12 16h.01']],
  'пошкоджений': ['damaged', [CIRCLE, 'M12 8v4', 'M12 16h.01']],
};
CONDITION['хороший'] = CONDITION['хороший / сток'];
CONDITION['пошкодженний'] = CONDITION['пошкоджений'];   // одрук у довіднику BMS

const Icon = ({ cls, paths }: { cls: string; paths: string[] }) => (
  <svg className={`spec-icon ${cls}`} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {paths.map((d) => <path d={d} key={d} />)}
  </svg>
);

/** «Стан» → іконка перед назвою (або нічого) */
export const ConditionIcon = ({ condition }: { condition: string }) => {
  const hit = CONDITION[condition.trim().toLowerCase()];
  return hit ? <Icon cls={`c-${hit[0]}`} paths={hit[1]} /> : null;
};

export const SeasonIcon = ({ season }: { season: string }) => {
  const key = season.trim().toLowerCase();
  const paths = PATHS[key];
  if (!paths) return null;
  return <Icon cls={`season-icon s-${key}`} paths={paths} />;
};

// «Демі / Літо» → іконка перед кожним сезоном
export const SeasonValue = ({ text }: { text: string }) => (
  <>
    {text.split(' / ').map((s, i) => (
      <React.Fragment key={s}>
        {i > 0 && ' / '}
        <span className="season-part"><SeasonIcon season={s} />{s}</span>
      </React.Fragment>
    ))}
  </>
);
