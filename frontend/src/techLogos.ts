// Технології взуття: парсинг «брудного» рядка (напр. "Vibram, MEGAGRIP, Gore-tex")
// у охайні бейджі. Для відомих технологій — гарний лейбл і слаг лого; логотипи
// (файли в public/tech-logos/<slug>.svg|png) підкладає власник — до того часу
// показуємо чистий текстовий бейдж (див. ProductPage: img з onError → text).

export type Tech = { label: string; slug: string };

// Відомі технології: нормалізований ключ → { гарний лейбл, слаг файлу лого }.
// Ключ = lowercase без ®™ і зайвих пробілів. Невідомі токени лишаємо як текст.
const KNOWN: Record<string, Tech> = {
  'gore-tex': { label: 'GORE-TEX', slug: 'gore-tex' },
  'goretex': { label: 'GORE-TEX', slug: 'gore-tex' },
  'vibram': { label: 'Vibram', slug: 'vibram' },
  'megagrip': { label: 'Vibram Megagrip', slug: 'megagrip' },
  'boost': { label: 'Boost', slug: 'boost' },
  'air': { label: 'Air', slug: 'nike-air' },
  'zoom air': { label: 'Zoom Air', slug: 'zoom-air' },
  'react': { label: 'React', slug: 'react' },
  'gel': { label: 'GEL', slug: 'gel' },
  'ortholite': { label: 'OrthoLite', slug: 'ortholite' },
  'primaloft': { label: 'PrimaLoft', slug: 'primaloft' },
  'thinsulate': { label: 'Thinsulate', slug: 'thinsulate' },
  'contagrip': { label: 'Contagrip', slug: 'contagrip' },
  'dri-fit': { label: 'Dri-FIT', slug: 'dri-fit' },
  'boa': { label: 'BOA', slug: 'boa' },
  'flyknit': { label: 'Flyknit', slug: 'flyknit' },
  'cloudfoam': { label: 'Cloudfoam', slug: 'cloudfoam' },
  'croslite': { label: 'Croslite', slug: 'croslite' },
  'crocslite': { label: 'Croslite', slug: 'croslite' },
  'repreve': { label: 'REPREVE', slug: 'repreve' },
  'abzorb': { label: 'ABZORB', slug: 'abzorb' },
  'meta-rocker': { label: 'Meta-Rocker', slug: 'meta-rocker' },
  'simpatex': { label: 'SimpaTex', slug: 'simpatex' },
  'respira': { label: 'Respira', slug: 'respira' },
  'spherica': { label: 'Spherica', slug: 'spherica' },
  'cordura': { label: 'Cordura', slug: 'cordura' },
  'ultracush': { label: 'UltraCush', slug: 'ultracush' },
  'softwair': { label: 'SoftWair', slug: 'softwair' },
  'zebrilus': { label: 'Zebrilus', slug: 'zebrilus' },
  'super critical eva': { label: 'Super Critical EVA', slug: 'super-critical-eva' },
  'engineered mesh': { label: 'Engineered Mesh', slug: 'engineered-mesh' },
  'luxe foam': { label: 'Luxe Foam', slug: 'luxe-foam' },
  'goga mat': { label: 'Goga Mat', slug: 'goga-mat' },
};

// Слаг для невідомого токена: латиниця/цифри → дефіси (для можливого лого користувача)
const toSlug = (s: string): string =>
  s.toLowerCase().replace(/[®™©]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Гарний лейбл невідомого токена: капіталізація перших літер слів
const titleCase = (s: string): string =>
  s.replace(/[®™©]/g, '').trim().replace(/\b\w/g, (c) => c.toUpperCase());

// Розбиваємо рядок на окремі технології (кома/крапка/слеш — розділювачі),
// нормалізуємо, зіставляємо з відомими, прибираємо дублі (за лейблом).
export const parseTechnologies = (raw: string | null | undefined): Tech[] => {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: Tech[] = [];
  for (const part of raw.split(/[,.\/]+/)) {
    const token = part.replace(/[®™©]/g, '').trim();
    if (!token) continue;
    const key = token.toLowerCase().replace(/\s+/g, ' ');
    const tech = KNOWN[key] ?? { label: titleCase(token), slug: toSlug(token) };
    const dedup = tech.label.toLowerCase();
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push(tech);
  }
  return out;
};
