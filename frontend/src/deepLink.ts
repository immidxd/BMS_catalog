// Адреси товарів: /t/<id>-<назва>. Досі каталог жив на одній адресі «/», тож на
// конкретну пару не можна було дати посилання — ні в рекламі, ні покупцю в чат.
// Мета-теги для прев'ю підставляє бекенд (sharing.py); тут — лише навігація.
import { tg } from './telegram';

const PREFIX = '/t/';

// «Ecco Street 720» → «ecco-street-720». Кирилицю не транслітеруємо: хвіст slug
// суто косметичний (сервер читає лише число), а %D0%A4… у посиланні виглядає гірше,
// ніж його відсутність.
const slugify = (title: string): string =>
  title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export const productPath = (id: number, title?: string): string => {
  const slug = title ? slugify(title) : '';
  return `${PREFIX}${id}${slug ? `-${slug}` : ''}`;
};

export const productUrl = (id: number, title?: string): string =>
  `${window.location.origin}${productPath(id, title)}`;

// Число на початку сегмента після /t/ — усе інше в адресі є лише підписом
export const idFromPath = (pathname: string = window.location.pathname): number | null => {
  if (!pathname.startsWith(PREFIX)) return null;
  const head = pathname.slice(PREFIX.length).split('-', 1)[0];
  return /^\d+$/.test(head) ? Number(head) : null;
};

// Вхід у Mini App за посиланням t.me/<бот>/<застосунок>?startapp=<id>: усередині
// Telegram шляху немає, параметр приходить окремим полем.
const idFromStartParam = (): number | null => {
  const raw = tg?.initDataUnsafe?.start_param;
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
};

// Який товар відкрити одразу на старті (пряме посилання ззовні)
export const initialProductId = (): number | null => idFromStartParam() ?? idFromPath();

// Історія: відкриття товару — новий крок (щоб «назад» повертало в каталог),
// гортання свайпом між товарами — ЗАМІНА кроку, інакше «назад» довелося б тиснути
// стільки разів, скільки карток гортали.
export const pushProduct = (id: number, title?: string): void => {
  window.history.pushState({ productId: id }, '', productPath(id, title) + window.location.search);
};

export const replaceProduct = (id: number, title?: string): void => {
  window.history.replaceState({ productId: id }, '', productPath(id, title) + window.location.search);
};

// Прямий вхід за посиланням: під картку підкладаємо синтетичний крок «каталог».
// Без цього «назад» з товару, відкритого з реклами, викидало б із застосунку геть.
export const seedHistoryForDeepLink = (id: number): void => {
  // Зберігаємо адресу, з якою прийшли (з підписом), а не перескладаємо її:
  // назви товару на цей момент ще немає — сітка не завантажилась.
  const here = window.location.pathname + window.location.search;
  window.history.replaceState({ productId: null }, '', '/' + window.location.search);
  window.history.pushState({ productId: id }, '', here);
};
