"""Публічні адреси товарів (/t/<id>) з мета-тегами для прев'ю посилань.

SPA сама по собі адрес не має: усе живе на «/». Через це на конкретну пару не можна
дати посилання — ні в рекламі, ні в чаті покупцю, ні з допису в каналі. А коли
посилання таки кидають, воно розгортається голим рядком без картинки й ціни.

Тут ми віддаємо ТУ САМУ збірку фронтенду, лише підставляємо в <head> заголовок і
Open Graph теги конкретного товару. Краулери (Telegram, Viber, Facebook, Google)
читають розмітку без виконання JS — тому прев'ю будується саме на сервері.
"""

import html
import os
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Path, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from catalog import get_catalog_product
from database import get_db

router = APIRouter()

_DIST = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
_INDEX = os.path.join(_DIST, "index.html")

# Заголовок за замовчуванням — рівно те, що стоїть у зібраному index.html
_DEFAULT_TITLE = "<title>Каталог</title>"


def shop_name() -> str:
    return (os.getenv("SHOP_NAME") or "").strip() or "Каталог"


def _index_html() -> Optional[str]:
    """Свіжий index.html зі збірки (перечитуємо щоразу — файл ~4 КБ, зате після
    деплою не віддаємо застарілий заголовок із памʼяті)."""
    try:
        with open(_INDEX, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _esc(value: Any) -> str:
    return html.escape(str(value or ""), quote=True)


# Гроші — тим самим форматом, що й у вітрині: «2 900 грн» з нерозривним пробілом
def _money(value: Any) -> str:
    return f"{int(value or 0):,}".replace(",", " ") + " грн"


def _prices(product: Dict[str, Any]) -> tuple[str, Optional[str]]:
    """(чинна ціна, стара ціна або None). Знижка має ДВА джерела — як і у вітрині:
    акційна ціна каталогу (sale_price) або вже скинута ціна в BMS (oldprice > price)."""
    price = product.get("price") or 0
    sale = product.get("sale_price")
    old = product.get("oldprice")
    if sale is not None and sale < price:
        return _money(sale), _money(price)
    if old is not None and old > price:
        return _money(price), _money(old)
    return _money(price), None


def _price_line(product: Dict[str, Any]) -> str:
    """Для заголовка — лише чинна ціна: прев'ю обрізає довгі рядки, і «замість»
    з'їло б назву товару. Стара ціна йде в опис, де місця більше."""
    return _prices(product)[0]


def _sizes_line(product: Dict[str, Any]) -> str:
    eu = [v["sizeeu"] for v in product.get("size_variants") or [] if v.get("sizeeu")]
    if eu:
        return f"Розміри: {' · '.join(eu)} EU"
    letters = [v["size_letter"] for v in product.get("size_variants") or [] if v.get("size_letter")]
    return f"Розміри: {' · '.join(letters)}" if letters else ""


def _title(product: Dict[str, Any]) -> str:
    name = " ".join(x for x in (product.get("brandname"), product.get("model")) if x) \
        or product.get("typename") or "Товар"
    return f"{name} — {_price_line(product)} | {shop_name()}"


# Стать — у формі прикметника, як на картці товару («Жіноча» → «Жіночі»)
_GENDER = {"Жіноча": "Жіночі", "Чоловіча": "Чоловічі", "Унісекс": "Унісекс"}


def _gender(product: Dict[str, Any]) -> Optional[str]:
    value = product.get("gendername")
    if not value or value in ("Невідомо", "Невизначено"):
        return None
    return _GENDER.get(value, value)


def _description(product: Dict[str, Any]) -> str:
    """Опис для прев'ю: те, що покупець хоче знати ще до кліку. Через « · », бо
    узгоджувати рід прикметників («чорні кросівки» / «чорна сумка») автоматично
    ненадійно — перелік читається однаково добре й не ризикує граматикою."""
    _, old = _prices(product)
    parts = [x for x in (
        f"Знижка — замість {old}" if old else None,
        product.get("typename"),
        _gender(product),
        _cap(product.get("colorname")),
        _cap(product.get("conditionname")),
        _sizes_line(product),
    ) if x]
    return " · ".join(parts) if parts else shop_name()


def _cap(value: Optional[str]) -> Optional[str]:
    return value[0].upper() + value[1:] if value else value


def _og_image(product: Dict[str, Any]) -> str:
    """Для прев'ю беремо ЛИШЕ студійне фото — те саме правило, що й у вітрині:
    реальні знімки й «нюанси» публіці як обкладинка не показуються."""
    images = product.get("images") or []
    official = next((i for i in images if i.get("kind") == "official"), None)
    return (official or (images[0] if images else {})).get("url", "")


def _inject(page: str, tags: str, title: str) -> str:
    """Підставляємо заголовок і мета-теги в <head> зібраного index.html."""
    page = page.replace(_DEFAULT_TITLE, f"<title>{_esc(title)}</title>", 1)
    return page.replace("</head>", f"{tags}\n  </head>", 1)


def _meta(pairs: Dict[str, str], canonical: str) -> str:
    lines = [f'    <link rel="canonical" href="{_esc(canonical)}" />']
    for key, value in pairs.items():
        if not value:
            continue
        attr = "property" if key.startswith("og:") else "name"
        lines.append(f'    <meta {attr}="{key}" content="{_esc(value)}" />')
    return "\n".join(lines)


def _base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


@router.get("/t/{slug}", response_class=HTMLResponse)
async def product_page(
    request: Request,
    slug: str = Path(..., max_length=120),
    db: Session = Depends(get_db),
):
    """Сторінка товару з власною адресою. У slug після числа може бути будь-який
    «людський» хвіст (/t/170331-ecco-street-1) — читаємо лише число на початку."""
    page = _index_html()
    if page is None:                       # збірки нема (dev) — хай працює SPA-роутинг
        return HTMLResponse("Not found", status_code=404)

    head = slug.split("-", 1)[0]
    canonical = f"{_base_url(request)}/t/{slug}"
    product: Optional[Dict[str, Any]] = None
    if head.isdigit():
        try:
            product = await get_catalog_product(
                product_id=int(head), only_published=True, group_offers=True, db=db,
            )
        except Exception:
            product = None                 # знято з публікації / продано / нема такого

    if product is None:
        # Товару вже нема — віддаємо каталог із загальними тегами. Не 404: людина
        # прийшла з реклами, і порожня сторінка помилки — гірше за вітрину.
        return _shop_html(page, canonical)

    tags = _meta({
        "description": _description(product),
        "og:type": "product",
        "og:site_name": shop_name(),
        "og:title": _title(product),
        "og:description": _description(product),
        "og:image": _og_image(product),
        "og:url": canonical,
        "twitter:card": "summary_large_image",
    }, canonical)
    return _no_store(HTMLResponse(_inject(page, tags, _title(product))))


def _shop_html(page: str, canonical: str) -> HTMLResponse:
    """Загальні теги магазину — для кореня і для знятих з публікації товарів.

    Назва в інтерфейсі (шапка, поле пошуку) і назва назовні — різні задачі. Усередині
    коротке ім'я доречне, а в заголовку вкладки й прев'ю посилання його бачить
    незнайомець у видачі Google чи в чаті — там ім'я без пояснення не каже нічого.
    Тому SHOP_TAGLINE додається ЛИШЕ до зовнішнього заголовка."""
    name = shop_name()
    tagline = (os.getenv("SHOP_TAGLINE") or "").strip()
    title = f"{name} — {tagline}" if tagline else name
    description = (os.getenv("SHOP_DESCRIPTION") or "").strip() \
        or "Наявні товари з пошуком за брендом, розміром і ціною."
    tags = _meta({
        "description": description,
        "og:type": "website",
        "og:site_name": name,
        "og:title": title,
        "og:description": description,
        "og:url": canonical,
        "twitter:card": "summary",
    }, canonical)
    return _no_store(HTMLResponse(_inject(page, tags, title)))


def _no_store(response: HTMLResponse) -> HTMLResponse:
    """Той самий режим, що й для index.html: Telegram-WebView інакше показує
    застряглу сторінку з іменами бандлів, яких після деплою вже не існує."""
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


@router.get("/", response_class=HTMLResponse)
async def shop_root(request: Request):
    """Корінь вітрини: назва магазину в заголовку й нормальне прев'ю посилання
    (замість голої адреси, коли каталог кидають у чат)."""
    page = _index_html()
    if page is None:
        return HTMLResponse("Not found", status_code=404)
    return _shop_html(page, _base_url(request) + "/")
