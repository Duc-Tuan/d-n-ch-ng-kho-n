"""Danh mục khung thời gian — một chỗ khai báo duy nhất cho đồng bộ, đọc và giao diện.

Bộ khung theo đúng thói quen của TradingView: 1m · 3m · 5m · 15m · 30m · 1h · 2h · 4h · 1D ·
1W · 1M. Nhưng **không phải khung nào cũng xin được từ nhà cung cấp**, và đó là điều quyết
định toàn bộ cấu trúc của module này. Đã đo trực tiếp trên hai nguồn đang cài đặt:

* Xin được (giao thức UDF): ``1``, ``5``, ``15``, ``30``, ``60``, ``D``.
* **Không** có: ``240`` (4 giờ), ``W``, ``M`` — VPS trả trạng thái rỗng, VNDIRECT trả 0 nến.

Nên mỗi khung thuộc đúng một trong hai loại:

* **Tải về** (``provider_resolution``) — hỏi thẳng nhà cung cấp rồi ghi vào cơ sở dữ liệu.
* **Suy ra** (``derive_from``) — gộp từ khung nhỏ hơn ngay lúc đọc, không lưu thêm dòng nào.

Suy ra thay vì lưu là lựa chọn có chủ đích, không phải để tiết kiệm chỗ: nến 4 giờ gộp từ nến
1 giờ **luôn khớp** với nến 1 giờ mà người dùng đang nhìn. Lưu thành một bảng riêng thì hai
chuỗi trôi khỏi nhau ngay lần đầu một mẻ đồng bộ chạy thiếu, và không có gì báo cho ai biết.

> ⚠️ **Lịch sử trong ngày không lùi lại được.** VPS chỉ phục vụ một cửa sổ trượt gần đây —
> khoảng 800 nến 1 phút (4 phiên), 350 nến 5 phút, 300 nến 15 phút, ~350 nến 30 phút, ~300 nến
> 1 giờ. Xin một khoảng trong quá khứ nhận về ``no_data``, kể cả khoảng chỉ cách vài tháng.
> Nghĩa là lịch sử trong ngày **chỉ dày lên theo thời gian** nhờ chạy đồng bộ đều đặn; không có
> cách nào nạp bù một lần cho xong như nến ngày. Đây là lý do ``retention_days`` được đặt rộng
> tay và job đồng bộ phải chạy ít nhất vài phiên một lần với khung 1 phút.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time, timedelta, timezone

from app.core.config import settings

#: Khung mặc định của toàn hệ thống — cũng là khung mà chiến lược và backtest chạy trên đó.
DAILY = "1D"


@dataclass(frozen=True, slots=True)
class Timeframe:
    """Một khung thời gian. Bất biến và không chạm cơ sở dữ liệu — chỉ là bảng khai báo."""

    code: str
    label: str
    #: Nhãn ngắn cho hàng nút trên biểu đồ, nơi mỗi ký tự đều phải trả tiền chỗ.
    short_label: str
    seconds: int
    #: Mã ``resolution`` gửi cho nhà cung cấp. ``None`` nghĩa là khung này phải suy ra.
    provider_resolution: str | None = None
    #: Khung nhỏ hơn dùng để gộp ra khung này. ``None`` nghĩa là khung này tự tải về.
    derive_from: str | None = None
    #: Giữ lại bao nhiêu ngày nến trong cơ sở dữ liệu. ``None`` = giữ vĩnh viễn (nến ngày).
    #:
    #: Nến 1 phút của 150 mã là ~43.000 dòng mỗi phiên; không dọn thì trong một năm bảng phình
    #: lên hàng chục triệu dòng để phục vụ một khung mà gần như không ai kéo ngược quá vài tuần.
    retention_days: int | None = None

    @property
    def intraday(self) -> bool:
        return self.seconds < 86_400

    @property
    def derived(self) -> bool:
        return self.derive_from is not None

    @property
    def is_daily(self) -> bool:
        return self.code == DAILY

    def as_dict(self) -> dict:
        return {
            "code": self.code,
            "label": self.label,
            "short_label": self.short_label,
            "seconds": self.seconds,
            "intraday": self.intraday,
            "derived": self.derived,
            "derive_from": self.derive_from,
            "retention_days": self.retention_days,
        }


#: Thứ tự ở đây là thứ tự hiện trên hàng nút chọn khung của biểu đồ.
_ALL: tuple[Timeframe, ...] = (
    # Giữ 90 ngày để bằng đúng cửa sổ nguồn phục vụ — cắt ngắn hơn là tự vứt đi phần lịch sử
    # xin về được, mà xin lại thì không có đường nào. Khoảng 150 mã × 90 ngày ≈ 2 triệu dòng.
    Timeframe("1m", "1 phút", "1m", 60, provider_resolution="1", retention_days=90),
    Timeframe("3m", "3 phút", "3m", 180, derive_from="1m"),
    Timeframe("5m", "5 phút", "5m", 300, provider_resolution="5", retention_days=120),
    Timeframe("15m", "15 phút", "15m", 900, provider_resolution="15", retention_days=365),
    Timeframe("30m", "30 phút", "30m", 1_800, provider_resolution="30", retention_days=730),
    Timeframe("1h", "1 giờ", "1h", 3_600, provider_resolution="60", retention_days=1_825),
    Timeframe("2h", "2 giờ", "2h", 7_200, derive_from="1h"),
    Timeframe("4h", "4 giờ", "4h", 14_400, derive_from="1h"),
    # Nến ngày không nằm ở `ohlcv_bars` mà ở `ohlcv_daily` — bảng gốc mà chiến lược, backtest và
    # phân tích AI đang đọc. Đổi chỗ nó là viết lại nửa hệ thống để không được thêm gì.
    Timeframe(DAILY, "1 ngày", "1D", 86_400, provider_resolution="D"),
    Timeframe("1W", "1 tuần", "1W", 604_800, derive_from=DAILY),
    Timeframe("1M", "1 tháng", "1M", 2_592_000, derive_from=DAILY),
)

TIMEFRAMES: dict[str, Timeframe] = {tf.code: tf for tf in _ALL}

#: Khung tự tải về — những khung duy nhất chiếm chỗ trong cơ sở dữ liệu.
FETCHED: tuple[str, ...] = tuple(tf.code for tf in _ALL if not tf.derived)
#: Khung trong ngày có lưu — phần việc thêm của job đồng bộ so với trước đây.
STORED_INTRADAY: tuple[str, ...] = tuple(
    tf.code for tf in _ALL if not tf.derived and tf.intraday
)

#: Cách viết khác cho cùng một khung. Có ba nơi gọi tên khác nhau cùng lúc: giao thức UDF của
#: nhà cung cấp (`60`, `D`), thói quen MetaTrader (`H1`, `D1`) và địa chỉ cũ của chính hệ thống
#: này (`D`). Chuẩn hoá ở một chỗ, để chỗ khác không phải đoán.
#:
#: **Phân biệt hoa thường ở đây là bắt buộc**: `1m` là một phút còn `1M` là một tháng — quy ước
#: của TradingView, và cũng là cái bẫy kinh điển khi ai đó gọi `.upper()` cho tiện.
_ALIASES: dict[str, str] = {
    "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
    "60": "1h", "120": "2h", "240": "4h",
    "m1": "1m", "M1": "1m", "1min": "1m",
    "m5": "5m", "M5": "5m", "m15": "15m", "M15": "15m", "m30": "30m", "M30": "30m",
    "h1": "1h", "H1": "1h", "1H": "1h", "h": "1h", "H": "1h",
    "h2": "2h", "H2": "2h", "2H": "2h", "h4": "4h", "H4": "4h", "4H": "4h",
    "d": DAILY, "D": DAILY, "1d": DAILY, "d1": DAILY, "D1": DAILY, "day": DAILY,
    "w": "1W", "W": "1W", "1w": "1W", "w1": "1W", "W1": "1W", "week": "1W",
    "M": "1M", "mn": "1M", "MN": "1M", "month": "1M",
}


class UnknownTimeframe(ValueError):
    """Mã khung không nằm trong danh mục. Nơi gọi quyết định báo lỗi hay lùi về mặc định."""


def normalize(code: str | None) -> str:
    """Đưa một cách viết bất kỳ về mã chuẩn. Bỏ trống thì trả khung mặc định."""
    if code is None:
        return DAILY
    raw = code.strip()
    if not raw:
        return DAILY
    if raw in TIMEFRAMES:
        return raw
    if raw in _ALIASES:
        return _ALIASES[raw]
    raise UnknownTimeframe(
        f"Khung thời gian {code!r} không có trong danh mục. "
        f"Các khung hiện có: {', '.join(TIMEFRAMES)}"
    )


def get(code: str | None) -> Timeframe:
    """Khung thời gian theo mã, chấp nhận mọi cách viết ở `_ALIASES`."""
    return TIMEFRAMES[normalize(code)]


def base_of(code: str | None) -> Timeframe:
    """Khung **có dữ liệu thật** đứng sau một khung: chính nó, hoặc khung nó được gộp từ đó.

    Chuỗi suy ra chỉ sâu một bậc theo thiết kế (4h ← 1h, 1W ← 1D), nhưng vẫn đi vòng lặp để
    thêm một bậc sau này không phải sửa chỗ gọi.
    """
    tf = get(code)
    seen: set[str] = set()
    while tf.derived:
        if tf.code in seen:  # pragma: no cover — chỉ xảy ra nếu khai báo vòng tròn
            raise UnknownTimeframe(f"Khai báo khung {tf.code!r} tạo thành vòng lặp")
        seen.add(tf.code)
        tf = TIMEFRAMES[tf.derive_from]
    return tf


def parse_list(raw: str | list[str] | None, *, default: tuple[str, ...] = ()) -> list[str]:
    """Đọc danh sách khung từ cấu hình hoặc query string, bỏ mã hỏng thay vì ném lỗi.

    Dùng cho `.env` và cho tham số API. Một mã viết sai trong `.env` **không được** làm backend
    chết lúc khởi động: mất cả scheduler chỉ vì một dấu phẩy thừa là cái giá quá đắt.
    """
    if raw is None:
        return list(default)
    items = raw.split(",") if isinstance(raw, str) else list(raw)

    codes: list[str] = []
    for item in items:
        # Mục rỗng bị bỏ hẳn, **không** đi qua `normalize`: ở đó chuỗi rỗng nghĩa là "không nói
        # gì thì lấy khung mặc định", còn ở đây một dấu phẩy thừa trong `.env` mà lặng lẽ thêm
        # nến ngày vào danh sách là một khung chạy mà không ai yêu cầu.
        if not item or not item.strip():
            continue
        try:
            code = normalize(item)
        except UnknownTimeframe:
            continue
        if code not in codes:
            codes.append(code)
    return codes or list(default)


def configured() -> list[str]:
    """Các khung hệ thống **đang thật sự đồng bộ**: nến ngày + khung trong ngày bật ở `.env`.

    Một chỗ duy nhất trả lời câu đó, và cả ba nơi cùng hỏi nó: job hằng đêm, nút *Đồng bộ tất
    cả* và nút bù mã thiếu dữ liệu. Trước đây hai cái nút mặc định chỉ chạy nến ngày trong khi
    job chạy đủ khung — người vận hành bấm "đồng bộ tất cả", thấy báo hoàn tất, rồi mở biểu đồ
    1 giờ ra vẫn trống mà không có gì giải thích vì sao.
    """
    from app.core.config import settings

    codes = parse_list(settings.market_intraday_timeframes, default=())
    return sorted({DAILY, *codes}, key=sort_key)


def sort_key(code: str) -> int:
    """Sắp khung theo độ dài nến — để giao diện và nhật ký luôn cùng một thứ tự."""
    return get(code).seconds


# ======================================================================
# Chia nến vào ô thời gian
# ======================================================================
def bucket_start(ts: datetime, tf: Timeframe) -> datetime:
    """Mốc mở của nến `tf` chứa thời điểm `ts`. Trả về UTC có tzinfo.

    Neo theo **nửa đêm giờ Việt Nam**, không phải nửa đêm UTC. Đây là điểm dễ sai nhất của cả
    module: neo theo UTC thì nến 4 giờ rơi vào 07:00 giờ Việt Nam — cắt ngang phiên sáng — và
    biểu đồ 4 giờ hiện ra những cây nến không khớp bất kỳ mốc nào người xem nhận ra.

    Với phiên 09:00–14:45 của thị trường Việt Nam, cách neo này cho ra: khung 2 giờ bốn nến mỗi
    phiên (08, 10, 12, 14), khung 4 giờ hai nến (08 và 12) — đúng như TradingView vẽ.
    """
    local = ts.astimezone(settings.tz)

    if tf.code == "1M":
        anchor = local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        return anchor.astimezone(timezone.utc)

    if tf.code == "1W":
        monday = local.date() - timedelta(days=local.weekday())
        return datetime.combine(monday, time.min, tzinfo=settings.tz).astimezone(timezone.utc)

    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if tf.seconds >= 86_400:
        return midnight.astimezone(timezone.utc)

    elapsed = int((local - midnight).total_seconds())
    return (midnight + timedelta(seconds=elapsed - elapsed % tf.seconds)).astimezone(timezone.utc)


def bars_per_bucket(tf: Timeframe) -> int:
    """Ước lượng số nến gốc gộp thành một nến `tf`. Chỉ dùng để tính số dòng cần đọc.

    Cố ý ước lượng **dư**: đọc thừa vài trăm dòng là chuyện của một truy vấn, còn đọc thiếu thì
    nến cũ nhất trên biểu đồ bị gộp từ dữ liệu không đủ và không ai nhận ra nó sai.
    """
    if not tf.derived:
        return 1
    base = TIMEFRAMES[tf.derive_from]
    if base.is_daily:
        # Nến ngày → tuần/tháng: đếm theo **phiên giao dịch**, không theo ngày lịch.
        return 6 if tf.code == "1W" else 24
    return max(1, tf.seconds // base.seconds)
