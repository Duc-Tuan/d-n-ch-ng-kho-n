"""Kéo tin tự động từ các trang nguồn đã khai báo.

Ba bước, tách rời nhau để hỏng chỗ nào biết chỗ đó:

1. **Dò bài** — mở đường dẫn nguồn, lấy ra danh sách đường dẫn bài. Nguồn là feed XML thì đọc
   theo feed; là trang chuyên mục HTML thì lọc thẻ ``<a>``.
2. **Đọc mô tả** — mở từng bài mới, lấy thẻ Open Graph (``og:title``, ``og:description``,
   ``og:image``, ``article:published_time``).
3. **Ghi** — chỉ những bài **đăng trong ngày hôm nay** (theo giờ Việt Nam) mới thành ``NewsItem``.

Lọc theo ngày chứ không theo số lượng: cắt "mười bài đầu trang" thì một chuyên mục ít bài sẽ kéo
về cả tin tuần trước, còn hôm thị trường sôi động lại bỏ sót. ``max_items`` chỉ còn là **trần an
toàn** cho số bài phải mở ra xem, không phải số tin sẽ lấy.

Ngày đăng lấy từ thẻ do trang nguồn khai; bài không khai ngày thì bỏ qua và đếm riêng — không
chứng minh được là tin hôm nay thì không lấy, nhưng cả nguồn im lặng vì lý do đó phải nói ra.

Cố ý dừng ở bước 2: **không** lấy và không lưu phần thân bài. Thẻ Open Graph là thứ trang nguồn
tự khai để được chia sẻ lại (Facebook, Zalo, Telegram đều đọc đúng những thẻ này), còn toàn văn
bài thì không — lưu lại và hiển thị trên tên miền của mình là đăng lại nội dung của người khác.

Lọc trùng có hai lớp, vì mười nguồn sinh ra hai kiểu trùng khác nhau:

* **Trùng đường dẫn** — cùng một bài gặp lại ở lượt hôm sau, nằm hai lần trên một trang chuyên
  mục, hoặc nhân viên đã tự dán tay trước đó. Chặn bằng ``url_hash``, có chỉ mục ``UNIQUE`` nên
  chốt nằm ở CSDL chứ không ở mã.
* **Trùng nội dung chéo nguồn** — mười báo cùng đăng lại một bản tin, mười đường dẫn khác nhau.
  Chặn bằng so tiêu đề đã chuẩn hoá trong vài ngày gần đây, xem ``recent_title_keys``.

Chỗ mong manh nhất là bước 1: mỗi trang chuyên mục có cấu trúc HTML riêng và đổi giao diện bất
cứ lúc nào. Kiểu hỏng đặc trưng không phải là ném lỗi mà là **im lặng trả về rỗng**. Vì vậy một
lượt chạy không dò ra bài nào bị ghi là ``FAILED`` chứ không phải ``SUCCESS``: thà nguồn hiện
chữ đỏ ở màn quản trị còn hơn nó lặng lẽ ngừng ra tin và không ai để ý suốt vài tháng.
"""

from __future__ import annotations

import hashlib
import logging
import re
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from urllib.parse import parse_qsl, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.datetime_utils import local_today, to_local, utcnow
from app.models.news import NewsItem, NewsSource

log = logging.getLogger(__name__)

#: Nhiều báo chặn request không giống trình duyệt.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
}

TIMEOUT = httpx.Timeout(15.0, connect=10.0)

#: Tham số theo dõi chiến dịch: cùng một bài dán từ hai chỗ khác nhau ở đây chứ không khác nội
#: dung, nên bỏ đi trước khi băm để không thêm trùng.
TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "zarsrc", "ref_src", "source")

MAX_TITLE = 255
MAX_SUMMARY = 2000
MAX_URL = 1000

#: Cửa sổ so tiêu đề khi lọc trùng chéo nguồn. Cùng một sự kiện thì các báo đăng lệch nhau vài
#: giờ, không phải vài ngày; để rộng hơn thì bắt đầu chặn nhầm những bài định kỳ trùng tên
#: ("Nhận định thị trường ngày…").
DUPLICATE_TITLE_DAYS = 3

#: Vòng đời một nguồn trong lượt chạy. Hai trạng thái đầu tồn tại **chỉ để hiển thị tiến trình**.
STATUS_PENDING = "PENDING"
STATUS_RUNNING = "RUNNING"
STATUS_SUCCESS = "SUCCESS"
STATUS_PARTIAL = "PARTIAL"
STATUS_FAILED = "FAILED"
BUSY_STATUSES = (STATUS_PENDING, STATUS_RUNNING)

#: Quá mốc này mà một nguồn vẫn "đang chạy" thì tiến trình đó đã chết chứ không còn chạy.
#:
#: Mười nguồn × mười bài là khoảng một trăm lượt tải, chừng vài phút; ba mươi phút là biên rộng.
#: Không có mốc này thì backend chết giữa lượt sẽ để lại một thanh tiến trình quay mãi mãi.
STALE_AFTER = timedelta(minutes=30)

#: Gặp bao nhiêu bài cũ liên tiếp thì ngừng quét nguồn đó.
#:
#: Trang chuyên mục xếp bài mới nhất trước, nên qua khỏi bài hôm nay là toàn bài cũ — quét tiếp
#: chỉ tốn lượt tải của trang nguồn. Không dừng ngay ở bài cũ **đầu tiên** vì nhiều báo ghim một
#: hai bài nổi bật (thường là bài cũ) lên đầu chuyên mục.
MAX_CONSECUTIVE_OLD = 5


class NewsSyncError(Exception):
    """Lỗi làm hỏng cả một nguồn (không mở được trang, không dò ra bài nào)."""


# ======================================================================
# Chuẩn hoá và băm đường dẫn
# ======================================================================
def normalize_url(url: str) -> str:
    """Bỏ khác biệt không đổi nội dung: hoa/thường, ``www.``, dấu ``/`` cuối, tham số theo dõi."""
    parts = urlsplit(url.strip())
    host = parts.netloc.lower().removeprefix("www.")
    path = parts.path.rstrip("/") or "/"
    query = "&".join(
        f"{key}={value}"
        for key, value in sorted(parse_qsl(parts.query, keep_blank_values=True))
        if not key.lower().startswith(TRACKING_PARAMS)
    )
    return urlunsplit((parts.scheme.lower(), host, path, query, ""))


def url_hash(url: str) -> str:
    """Khoá chống trùng của một bài. Băm vì cột ``url`` dài 1000 ký tự, không đánh chỉ mục được."""
    return hashlib.sha256(normalize_url(url).encode("utf-8")).hexdigest()


_PUNCT = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def title_key(title: str) -> str:
    """Khoá so tiêu đề: thường hoá, bỏ dấu câu, gộp khoảng trắng. Giữ nguyên dấu tiếng Việt."""
    return _SPACES.sub(" ", _PUNCT.sub(" ", (title or "").lower())).strip()


def recent_title_keys(db: Session, days: int = DUPLICATE_TITLE_DAYS) -> set[str]:
    """Tiêu đề đã có trong ít ngày gần đây, để lọc trùng **chéo nguồn**.

    Chống trùng theo đường dẫn (``url_hash``) chỉ bắt được đúng một bài; mười nguồn cùng đăng
    lại một bản tin của TTXVN thì mười đường dẫn khác nhau, mười lần vào danh sách. So khớp
    tiêu đề đã chuẩn hoá bắt đúng trường hợp đó.

    So **khớp đúng** chứ không so gần đúng: hai báo tự viết lại tiêu đề thì đó là hai bài khác
    nhau thật, và một bộ so gần đúng sẽ âm thầm nuốt mất tin — hỏng theo hướng khó phát hiện hơn
    nhiều so với việc lọt một tin trùng mà nhân viên xoá tay được.
    """
    since = utcnow() - timedelta(days=days)
    titles = db.scalars(
        select(NewsItem.title)
        .where(NewsItem.created_at >= since)
        .order_by(NewsItem.id.desc())
        .limit(1000)
    ).all()
    return {title_key(t) for t in titles if t}


# ======================================================================
# Bước 1 — dò đường dẫn bài
# ======================================================================
class _LinkCollector(HTMLParser):
    """Nhặt ``href`` của mọi thẻ ``<a>``, giữ nguyên thứ tự xuất hiện trong trang."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        for name, value in attrs:
            if name == "href" and value:
                self.hrefs.append(value)
                return


#: Đuôi tệp của trang bài. Một mình nó **không** đủ để kết luận: CafeF dùng ``.chn`` cho cả
#: trang chuyên mục (``/xa-hoi.chn``) lẫn bài, VnEconomy dùng ``.htm`` cho cả hai.
_ARTICLE_EXT = re.compile(r"\.(chn|htm|html|epi)$", re.I)

#: Mã bài. Đây là dấu hiệu chắc nhất và bắt được CafeF, VnExpress, Vietstock, Tuổi Trẻ, Thanh
#: Niên: bài nào cũng gắn một dãy số dài, trang chuyên mục thì không.
_ARTICLE_ID = re.compile(r"\d{5,}")

#: Đường dẫn theo ngày, kiểu ``/2026/09/01/``.
_ARTICLE_DATE = re.compile(r"/\d{4}/\d{1,2}/\d{1,2}/")

#: VnEconomy không gắn mã số vào đường dẫn bài, chỉ có slug tiêu đề. Phân biệt bằng độ dài: slug
#: bài là cả câu tiêu đề (70–100 ký tự), slug chuyên mục là một cụm từ (``/nhip-cau-doanh-
#: nghiep.htm`` — 21 ký tự). Ngưỡng đặt ở giữa hai nhóm, và vẫn bắt buộc có đuôi tệp bài để
#: không quét nhầm các trang giới thiệu dịch vụ có đường dẫn dài.
_MIN_SLUG_LEN = 40
_MIN_SLUG_WORDS = 6

#: Nhánh chắc chắn không chứa bài: trang liệt kê, chuyên trang, trang dịch vụ, tệp tải về.
_SKIP_PATTERNS = re.compile(
    r"(^/(tag|tags|chu-de|nhom-chu-de|topic|page|trang|search|tim-kiem|rss|video|photo"
    r"|infographic|infographics|emagazine|podcast|multimedia|nganh|du-lieu|dao-tao|an-pham"
    r"|lien-he|quang-cao)(/|$))"
    r"|(\.(pdf|jpg|jpeg|png|gif|zip|mp4)$)",
    re.I,
)


def _looks_like_article(path: str) -> bool:
    """Đường dẫn này là một bài, hay chỉ là trang chuyên mục / menu?

    Nhận nhầm một trang chuyên mục thì hậu quả là một tin có tiêu đề vô nghĩa mà nhân viên xoá
    đi; bỏ sót bài thì không ai biết. Nhưng nhận nhầm cả menu thì nguồn nào cũng "chạy thành
    công" mà toàn rác, nên bộ lọc bám vào dấu hiệu thật của từng báo thay vì nới rộng.
    """
    if not path or path == "/":
        return False
    if _SKIP_PATTERNS.search(path):
        return False
    if _ARTICLE_ID.search(path) or _ARTICLE_DATE.search(path):
        return True

    if not _ARTICLE_EXT.search(path):
        return False
    slug = _ARTICLE_EXT.sub("", path.rsplit("/", 1)[-1])
    return len(slug) >= _MIN_SLUG_LEN and slug.count("-") >= _MIN_SLUG_WORDS


def _same_site(host: str, source_host: str) -> bool:
    """Chỉ nhận link trong cùng trang nguồn — trang chuyên mục nào cũng đầy link quảng cáo."""
    host = host.lower().removeprefix("www.")
    source_host = source_host.lower().removeprefix("www.")
    return host == source_host or host.endswith("." + source_host)


def _links_from_html(body: str, base_url: str, limit: int) -> list[str]:
    parser = _LinkCollector()
    try:
        parser.feed(body)
    except Exception:  # HTML hỏng giữa chừng — dùng những gì đã nhặt được
        log.warning("HTML của %s không phân tích trọn vẹn, dùng phần đã đọc", base_url)

    source_host = urlsplit(base_url).netloc
    # Trang chuyên mục nào cũng tự trỏ về chính nó ở menu và ở nút phân trang.
    seen: set[str] = {normalize_url(base_url)}
    links: list[str] = []
    for href in parser.hrefs:
        if href.startswith(("#", "javascript:", "mailto:", "tel:")):
            continue
        absolute = urljoin(base_url, href)
        parts = urlsplit(absolute)
        if parts.scheme not in ("http", "https"):
            continue
        if not _same_site(parts.netloc, source_host):
            continue
        if not _looks_like_article(parts.path):
            continue
        key = normalize_url(absolute)
        if key in seen:
            continue
        seen.add(key)
        links.append(absolute)
        if len(links) >= limit:
            break
    return links


def _links_from_feed(body: str, limit: int) -> list[str]:
    """RSS 2.0 (``<item><link>``) và Atom (``<entry><link href>``) — hai định dạng, một hàm."""
    root = ElementTree.fromstring(body)
    links: list[str] = []
    seen: set[str] = set()

    for entry in root.iter():
        tag = entry.tag.rsplit("}", 1)[-1]
        if tag not in ("item", "entry"):
            continue
        url: str | None = None
        for child in entry:
            if child.tag.rsplit("}", 1)[-1] != "link":
                continue
            # RSS để đường dẫn trong nội dung thẻ, Atom để trong thuộc tính ``href``.
            url = (child.text or "").strip() or child.get("href")
            if url:
                break
        if not url:
            continue
        key = normalize_url(url)
        if key in seen:
            continue
        seen.add(key)
        links.append(url)
        if len(links) >= limit:
            break
    return links


def _is_feed(body: str, content_type: str) -> bool:
    if "xml" in content_type.lower():
        return True
    head = body.lstrip()[:512].lower()
    return head.startswith("<?xml") or "<rss" in head or "<feed" in head


def discover_links(body: str, content_type: str, base_url: str, limit: int) -> list[str]:
    if _is_feed(body, content_type):
        try:
            return _links_from_feed(body, limit)
        except ElementTree.ParseError as exc:
            # Có trang trả `content-type: xml` cho một trang HTML. Thử lại theo HTML trước khi bỏ.
            log.info("%s không phải feed hợp lệ (%s), đọc như HTML", base_url, exc)
    return _links_from_html(body, base_url, limit)


# ======================================================================
# Bước 2 — đọc mô tả bài từ thẻ Open Graph
# ======================================================================
class _MetaCollector(HTMLParser):
    """Gom thẻ ``<meta>`` và ``<title>``. Dừng khi hết ``<head>`` — thân bài không cần tới."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: str = ""
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.done:
            return
        if tag == "title":
            self._in_title = True
            return
        if tag == "body":
            self.done = True
            return
        if tag != "meta":
            return
        data = {key.lower(): (value or "") for key, value in attrs}
        key = data.get("property") or data.get("name") or data.get("itemprop")
        content = data.get("content")
        if key and content:
            # `setdefault`: thẻ đầu tiên thắng. Vài trang lặp lại `og:title` ở cuối trang với
            # nội dung của bài liên quan, lấy thẻ sau là gán nhầm tiêu đề.
            self.meta.setdefault(key.lower(), content.strip())

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.title:
            self.title = data.strip()


def _first(meta: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = meta.get(key)
        if value:
            return value
    return None


def _strip_site_suffix(title: str, site_name: str | None) -> str:
    """Bỏ đuôi tên báo trong tiêu đề ("… | Vietstock").

    Thẻ tin đã có nhãn nguồn riêng, để thêm đuôi này là lặp lại và ăn mất chỗ hiển thị. Chỉ cắt
    khi đuôi khớp đúng ``og:site_name`` do chính trang khai — cắt theo dấu phân cách sẽ chém
    nhầm những tiêu đề vốn có dấu gạch.
    """
    title = (title or "").strip()
    if not site_name:
        return title
    for separator in (" | ", " - ", " – ", " — "):
        suffix = f"{separator}{site_name.strip()}"
        if title.endswith(suffix):
            return title[: -len(suffix)].strip()
    return title


def _parse_published(raw: str | None) -> datetime | None:
    """Ngày đăng do trang nguồn khai. Không đọc được thì trả None chứ không đoán bừa hôm nay."""
    if not raw:
        return None
    text = raw.strip().replace("Z", "+00:00")
    for parse in (
        datetime.fromisoformat,
        lambda v: datetime.strptime(v, "%a, %d %b %Y %H:%M:%S %z"),
        lambda v: datetime.strptime(v, "%Y-%m-%d %H:%M:%S"),
        lambda v: datetime.strptime(v, "%d/%m/%Y %H:%M"),
    ):
        try:
            parsed = parse(text)
        except (ValueError, TypeError):
            continue
        if parsed.tzinfo:
            return parsed.astimezone(timezone.utc)
        return parsed.replace(tzinfo=timezone.utc)
    log.debug("Không đọc được ngày đăng %r", raw)
    return None


def parse_article(body: str, url: str) -> dict:
    """Rút tiêu đề / mô tả / ảnh / ngày đăng từ phần ``<head>`` của một bài."""
    parser = _MetaCollector()
    try:
        parser.feed(body)
    except Exception:
        log.warning("HTML của %s không phân tích trọn vẹn", url)

    meta = parser.meta
    title = _strip_site_suffix(
        _first(meta, "og:title", "twitter:title") or parser.title,
        meta.get("og:site_name"),
    )
    summary = _first(meta, "og:description", "twitter:description", "description")
    image = _first(meta, "og:image", "og:image:url", "twitter:image", "twitter:image:src")
    published = _parse_published(
        _first(
            meta,
            "article:published_time",
            "article:modified_time",
            "og:updated_time",
            "pubdate",
            "publishdate",
            "datepublished",
        )
    )

    return {
        "title": (title or "").strip()[:MAX_TITLE],
        "summary": ((summary or "").strip()[:MAX_SUMMARY] or None),
        "image_url": (urljoin(url, image)[:MAX_URL] if image else None),
        "published_at": published,
    }


def _published_today(published_at: datetime | None, today: date) -> bool:
    """Bài này có đăng trong ngày hôm nay không (theo giờ Việt Nam)?

    So theo **ngày địa phương** chứ không theo UTC: bài đăng 22:00 giờ Việt Nam là 15:00 UTC
    cùng ngày, nhưng bài đăng 08:00 giờ Việt Nam lại là 01:00 UTC — so bằng UTC sẽ cắt nhầm
    hẳn bảy tiếng đầu ngày làm việc.

    Không khai ngày đăng thì trả `False`: không chứng minh được là tin hôm nay thì không lấy.
    """
    if published_at is None:
        return False
    local = to_local(published_at)
    return local is not None and local.date() == today


# ======================================================================
# Tiến trình lượt chạy
# ======================================================================
def mark_pending(db: Session, sources: list[NewsSource], batch_at: datetime) -> None:
    """Xếp hàng cả mẻ trước khi chạy, để giao diện thấy ngay tổng số nguồn của lượt này.

    Đóng **cùng một** ``batch_at`` cho mọi nguồn: đó là thứ giao diện dùng để gom chúng thành
    một mẻ và đếm "xong mấy trên mấy". Đóng mốc riêng cho từng nguồn thì không còn mẻ nào cả.
    """
    for source in sources:
        source.last_status = STATUS_PENDING
        source.last_started_at = batch_at
        source.last_error = None
        source.last_added = 0
    db.commit()


def heal_stalled(db: Session) -> int:
    """Đóng lại các nguồn kẹt ở "đang chạy" quá lâu. Trả về số dòng đã sửa.

    Backend tắt giữa lượt kéo thì không ai ghi trạng thái cuối cho những nguồn còn dở — chúng
    nằm lại ở ``PENDING``/``RUNNING`` vĩnh viễn và màn quản trị sẽ báo "đang kéo" mãi. Gọi ở
    chỗ đọc danh sách nguồn: đây là nơi duy nhất trạng thái kẹt gây hại.
    """
    stalled = db.scalars(
        select(NewsSource).where(
            NewsSource.last_status.in_(BUSY_STATUSES),
            NewsSource.last_started_at < utcnow() - STALE_AFTER,
        )
    ).all()
    for source in stalled:
        source.last_status = STATUS_FAILED
        source.last_error = (
            "Lượt kéo bị gián đoạn — nhiều khả năng máy chủ tắt giữa chừng. Bấm Kéo thử để "
            "chạy lại nguồn này."
        )
        source.last_fetched_at = utcnow()
    if stalled:
        db.commit()
    return len(stalled)


# ======================================================================
# Bước 3 — ghi vào CSDL
# ======================================================================
def _get(client: httpx.Client, url: str) -> tuple[str, str, str]:
    response = client.get(url)
    response.raise_for_status()
    return response.text, response.headers.get("content-type", ""), str(response.url)


def sync_source(
    db: Session,
    source: NewsSource,
    client: httpx.Client | None = None,
    seen_titles: set[str] | None = None,
    batch_at: datetime | None = None,
) -> dict:
    """Kéo một nguồn. Luôn ghi lại kết quả vào chính bản ghi nguồn, kể cả khi lỗi.

    Không ném ngoại lệ ra ngoài: một nguồn chết không được phép chặn các nguồn còn lại.

    ``seen_titles`` là tập tiêu đề đã có, dùng chung cho cả lượt chạy nhiều nguồn — hàm này bổ
    sung vào đó mỗi khi thêm tin, nên nguồn thứ mười trong lượt không đăng lại bài mà nguồn thứ
    nhất vừa lấy. Gọi lẻ một nguồn thì tự dựng tập này từ CSDL.

    ``batch_at`` là mốc chung của mẻ đang chạy; gọi lẻ thì nguồn tự thành một mẻ một nguồn.
    """
    owns_client = client is None
    if client is None:
        client = httpx.Client(
            headers=BROWSER_HEADERS, timeout=TIMEOUT, follow_redirects=True
        )
    if seen_titles is None:
        seen_titles = recent_title_keys(db)
    result = {
        "source": source.name, "discovered": 0, "added": 0, "existing": 0,
        "duplicate": 0, "old": 0, "unknown_date": 0, "failed": 0,
    }
    error: str | None = None
    today = local_today()

    # Ghi "đang kéo" trước khi chạm mạng: từ đây tới lúc xong có thể mất vài chục giây, và đó
    # đúng là quãng màn quản trị cần nhìn thấy.
    source.last_status = STATUS_RUNNING
    source.last_started_at = batch_at or utcnow()
    source.last_added = 0
    db.commit()

    try:
        body, content_type, final_url = _get(client, source.url)
        links = discover_links(body, content_type, final_url, source.max_items)
        result["discovered"] = len(links)

        if not links:
            # Kiểu hỏng đặc trưng của bộ dò: trang vẫn tải được, chỉ là không còn nhận ra link
            # bài nào. Ghi thành lỗi để nó nổi lên màn quản trị thay vì im lặng ngừng ra tin.
            raise NewsSyncError(
                "Tải được trang nhưng không tìm thấy đường dẫn bài nào. Nhiều khả năng trang "
                "nguồn đã đổi giao diện, hoặc đường dẫn này không phải trang chuyên mục."
            )

        consecutive_old = 0
        for link in links:
            digest = url_hash(link)
            if db.scalar(select(NewsItem.id).where(NewsItem.url_hash == digest)):
                result["existing"] += 1
                continue

            try:
                article_body, _, article_url = _get(client, link)
                meta = parse_article(article_body, article_url)
            except Exception as exc:
                log.warning("Không đọc được bài %s: %s", link, exc)
                result["failed"] += 1
                continue

            if not meta["title"]:
                log.warning("Bỏ qua %s: không có tiêu đề", link)
                result["failed"] += 1
                continue

            if not _published_today(meta["published_at"], today):
                if meta["published_at"] is None:
                    # Không khai ngày đăng thì không chứng minh được là bài hôm nay. Bỏ qua,
                    # nhưng đếm riêng: cả nguồn im lặng vì lý do này là chuyện phải nói ra.
                    result["unknown_date"] += 1
                else:
                    result["old"] += 1
                consecutive_old += 1
                if consecutive_old >= MAX_CONSECUTIVE_OLD:
                    log.info("Nguồn %s: đã qua vùng tin hôm nay, dừng quét", source.name)
                    break
                continue
            consecutive_old = 0

            key = title_key(meta["title"])
            if key in seen_titles:
                log.info("Bỏ qua %s: đã có tin cùng tiêu đề", link)
                result["duplicate"] += 1
                continue

            db.add(
                NewsItem(
                    title=meta["title"],
                    summary=meta["summary"],
                    url=article_url[:MAX_URL],
                    image_url=meta["image_url"],
                    source_name=source.name,
                    published_at=meta["published_at"],
                    is_active=True,
                    sort_order=0,
                    source_id=source.id,
                    url_hash=digest,
                    created_by=source.created_by,
                )
            )
            try:
                # Chốt từng tin: một bài lỗi không kéo đổ những bài đã lấy được trong cùng lượt.
                db.commit()
            except IntegrityError:
                # Lượt chạy khác vừa chèn đúng bài này, giữa lúc kiểm tra và lúc ghi.
                db.rollback()
                result["existing"] += 1
                continue
            seen_titles.add(key)
            result["added"] += 1

        source = db.get(NewsSource, source.id) or source
        source.item_count += result["added"]

        if result["failed"]:
            source.last_status = STATUS_PARTIAL
            error = f"{result['failed']} bài không đọc được, đã bỏ qua."
        elif result["unknown_date"] and not result["added"]:
            # Không phải lỗi mạng, cũng không phải "hôm nay không có tin": trang nguồn không
            # khai ngày đăng nên không lọc theo ngày được. Nói thẳng ra thay vì báo 0 tin.
            source.last_status = STATUS_PARTIAL
            error = (
                f"{result['unknown_date']} bài không khai ngày đăng nên không xác nhận được là "
                "tin hôm nay, đã bỏ qua. Nguồn này có thể không dùng được với chế độ chỉ lấy "
                "tin trong ngày."
            )
        else:
            source.last_status = STATUS_SUCCESS

    except Exception as exc:
        error = str(exc) if isinstance(exc, NewsSyncError) else f"{type(exc).__name__}: {exc}"
        log.warning("Nguồn tin %s lỗi: %s", source.name, error)
        db.rollback()
        source = db.get(NewsSource, source.id) or source
        source.last_status = STATUS_FAILED

    finally:
        if owns_client:
            client.close()

    source.last_error = error[:500] if error else None
    source.last_added = result["added"]
    source.last_fetched_at = utcnow()
    db.commit()

    result["status"] = source.last_status
    result["error"] = error
    return result


def sync_all(db: Session) -> dict:
    """Kéo mọi nguồn đang bật. Trả về tổng hợp để job ghi vào ``sync_jobs.summary``."""
    sources = db.scalars(
        select(NewsSource).where(NewsSource.is_active.is_(True)).order_by(NewsSource.id)
    ).all()

    totals: dict = {
        "sources": len(sources), "added": 0, "duplicate": 0, "old": 0,
        "failed_sources": 0, "details": [],
    }
    if not sources:
        return totals

    # Đọc một lần cho cả lượt: mười nguồn thì mười lần truy vấn lại cùng một tập tiêu đề.
    seen_titles = recent_title_keys(db)

    # Xếp hàng cả mẻ ngay từ đầu. Nguồn thứ mười phải hiện "đang chờ" từ giây đầu tiên chứ
    # không phải im lìm như chưa có gì xảy ra cho tới lượt của nó.
    batch_at = utcnow()
    mark_pending(db, list(sources), batch_at)
    totals["started_at"] = batch_at.isoformat()

    with httpx.Client(
        headers=BROWSER_HEADERS, timeout=TIMEOUT, follow_redirects=True
    ) as client:
        for source in sources:
            detail = sync_source(
                db, source, client=client, seen_titles=seen_titles, batch_at=batch_at
            )
            totals["added"] += detail["added"]
            totals["duplicate"] += detail["duplicate"]
            totals["old"] += detail["old"]
            if detail["status"] == "FAILED":
                totals["failed_sources"] += 1
            totals["details"].append(detail)
    return totals
