"""Kho giá thời gian thực trong bộ nhớ và bộ poll nuôi nó — BR-831.

Vì sao kho nằm trong RAM chứ không phải Redis hay một bảng
-----------------------------------------------------------
Đây là dữ liệu **sống đúng một phiên và không ai đọc lại**. Ghi xuống cơ sở dữ liệu là đánh đổi
sai chiều: 150 mã mỗi 2 giây suốt 5,5 giờ là ~1,4 triệu lượt ghi mỗi phiên vào đúng bảng mà
chiến lược và backtest đang đọc, để phục vụ một con số bị thay thế sau 2 giây nữa.

Mô hình in-process cũng đúng với phần còn lại của hệ thống: scheduler in-process
(`app.jobs.scheduler`), danh bạ WebSocket in-process (`app.services.realtime`), tiến độ đồng bộ
in-process (`app.services.market_data.fullsync`). Khi thật sự phải chạy nhiều instance thì điểm
thay thế là một instance duy nhất chạy `poll_once()` rồi phát qua Redis pub/sub — cùng chỗ đã
ghi trong `services/realtime.py`, không phải một kiến trúc mới.

Ràng buộc tuyệt đối
-------------------
`QuoteStore` **không nhận `Session`**. Không phải vì bất tiện mà vì cố ý: muốn ghi cơ sở dữ liệu
từ đây cũng không có đường. Nến chỉ đến từ `job_sync_market` (BR-832).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import Decimal

from app.core.config import settings
from app.core.datetime_utils import local_now, local_today, parse_hhmm, utcnow
from app.services.market_data.quotes import Quote, RealtimeQuoteProvider, get_quote_provider

log = logging.getLogger(__name__)

#: Lùi dần khi nguồn lỗi, tính bằng giây. Chạm đáy thì giữ nguyên 120 giây cho tới khi thành
#: công — nện một endpoint đang hỏng theo nhịp 2 giây là cách nhanh nhất để bị chặn IP.
_BACKOFF_SECONDS = (5, 15, 30, 60, 120)


@dataclass
class _Stats:
    """Số liệu vận hành. Một nguồn im lặng ngừng trả dữ liệu và một nguồn đang chạy bình thường
    trông y hệt nhau trên màn hình nếu không đếm những con số này — cùng lý do
    `SymbolTimeframeSync.last_error` tồn tại."""

    last_poll_at: datetime | None = None
    last_success_at: datetime | None = None
    last_duration_ms: int | None = None
    last_error: str | None = None
    consecutive_errors: int = 0
    polls_ok: int = 0
    polls_failed: int = 0
    symbols_tracked: int = 0
    quotes_changed_last: int = 0
    skip_until: datetime | None = None


class QuoteStore:
    """Ảnh chụp giá mới nhất của từng mã. Đọc từ luồng request, ghi từ luồng scheduler."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._quotes: dict[str, Quote] = {}
        #: (mã, khung) → cây nến đang hình thành. Chỉ khung tự tải về, xem `_live_timeframes`.
        self._live: dict[tuple[str, str], LiveBar] = {}
        self._stats = _Stats()
        self._session_date: date | None = None

    # ------------------------------------------------------------------ đọc
    def get(self, symbol: str) -> Quote | None:
        with self._lock:
            return self._quotes.get(symbol.upper())

    def get_many(self, symbols: list[str]) -> dict[str, Quote]:
        with self._lock:
            return {s.upper(): q for s in symbols if (q := self._quotes.get(s.upper()))}

    def all_symbols(self) -> list[str]:
        with self._lock:
            return sorted(self._quotes)

    @property
    def as_of(self) -> datetime | None:
        with self._lock:
            return self._stats.last_success_at

    def is_stale(self, now: datetime | None = None) -> bool:
        """Kho ôi thì bảng giá phải lùi về dữ liệu cuối phiên và nói rõ cho người đọc biết.

        Kho rỗng cũng tính là ôi: chưa có gì để phủ lên thì hành vi đúng là giữ nguyên đường cũ.
        """
        with self._lock:
            last = self._stats.last_success_at
        if last is None:
            return True
        age = ((now or utcnow()) - last).total_seconds()
        return age > settings.market_realtime_stale_seconds

    def status(self) -> dict:
        """Trạng thái cho màn vận hành và cho phần đầu phản hồi bảng giá."""
        with self._lock:
            s = self._stats
            return {
                "enabled": settings.market_realtime_enabled,
                "provider": settings.market_realtime_provider,
                "interval_seconds": settings.market_realtime_interval_seconds,
                "quotes": len(self._quotes),
                "symbols_tracked": s.symbols_tracked,
                "as_of": s.last_success_at,
                "stale": self.is_stale(),
                "session": current_session(),
                "in_session_window": s.skip_until is None and in_session_window(),
                "last_poll_at": s.last_poll_at,
                "last_duration_ms": s.last_duration_ms,
                "last_error": s.last_error,
                "consecutive_errors": s.consecutive_errors,
                "polls_ok": s.polls_ok,
                "polls_failed": s.polls_failed,
                "quotes_changed_last": s.quotes_changed_last,
                "backoff_until": s.skip_until,
            }

    # ------------------------------------------------------------------ ghi
    def replace(self, quotes: list[Quote]) -> list[Quote]:
        """Ghi đè kho, trả về **những mã thực sự đổi** so với nhịp trước.

        Chỉ trả phần đổi chứ không trả cả kho: bảng giá 60 dòng mở trên trình duyệt cần vài trăm
        byte mỗi nhịp, không phải 143 KB.
        """
        changed: list[Quote] = []
        with self._lock:
            today = local_today()
            if self._session_date != today:
                # Sang phiên mới thì bỏ hết số của hôm qua. Giữ lại thì mã nào chưa khớp lệnh
                # sáng nay vẫn hiện giá và khối lượng của phiên trước như thể đang giao dịch.
                self._quotes.clear()
                self._live.clear()
                self._session_date = today

            for quote in quotes:
                previous = self._quotes.get(quote.symbol)
                if previous is None or _differs(previous, quote):
                    changed.append(quote)
                self._quotes[quote.symbol] = quote
                self._update_live(quote)
            self._stats.quotes_changed_last = len(changed)
        return changed

    def _update_live(self, quote: Quote) -> None:
        """Cập nhật cây nến đang hình thành của mọi khung trong ngày. Giữ `_lock` khi gọi."""
        if quote.price is None:
            return

        from app.services.market_data import timeframes as tfs

        for code in _live_timeframes():
            tf = tfs.get(code)
            bucket = tfs.bucket_start(quote.as_of, tf)
            key = (quote.symbol, code)
            bar = self._live.get(key)

            if bar is None or bar.bucket_start != bucket:
                # Ô mới: mở bằng giá hiện tại và ghi lại mốc khối lượng luỹ kế để trừ ra sau.
                self._live[key] = LiveBar(
                    timeframe=code, bucket_start=bucket,
                    open=quote.price, high=quote.price, low=quote.price, close=quote.price,
                    volume=0, day_volume_at_open=quote.volume,
                )
                continue

            bar.close = quote.price
            bar.high = max(bar.high, quote.price)
            bar.low = min(bar.low, quote.price)
            bar.volume = max(0, quote.volume - bar.day_volume_at_open)

    def live_bar(self, symbol: str, timeframe: str) -> LiveBar | None:
        """Cây nến đang hình thành, hoặc None nếu không dựng được.

        Khung ngày đi đường riêng và **không** dùng số lấy mẫu: nhà cung cấp đã trả sẵn giá mở,
        cao nhất, thấp nhất và khối lượng luỹ kế của cả phiên.
        """
        code = timeframe.upper() if timeframe.upper() == "1D" else timeframe
        symbol = symbol.upper()

        with self._lock:
            if self.is_stale():
                return None

            if code == "1D":
                quote = self._quotes.get(symbol)
                if quote is None or quote.price is None:
                    return None
                from app.services.market_data import timeframes as tfs

                return LiveBar(
                    timeframe="1D",
                    bucket_start=tfs.bucket_start(quote.as_of, tfs.get("1D")),
                    open=quote.open if quote.open is not None else quote.price,
                    high=quote.high if quote.high is not None else quote.price,
                    low=quote.low if quote.low is not None else quote.price,
                    close=quote.price,
                    volume=quote.volume,
                    day_volume_at_open=0,
                    exact=True,
                )

            return self._live.get((symbol, code))

    def clear(self) -> None:
        with self._lock:
            self._quotes.clear()
            self._live.clear()
            self._stats = _Stats()


@dataclass(slots=True)
class LiveBar:
    """Cây nến **đang hình thành** của một mã ở một khung. Không bao giờ được ghi xuống đâu cả.

    Độ chính xác khác nhau theo khung, và chỗ này phải nói thẳng:

    * **1D chính xác tuyệt đối.** VPS trả `openPrice`/`highPrice`/`lowPrice`/`lot` là số **luỹ kế
      cả ngày** do sở tính, không phải do mình lấy mẫu. Nến ngày hôm nay dựng từ đó bằng đúng
      con số job 16:00 sẽ ghi xuống.
    * **Khung trong ngày là xấp xỉ.** `high`/`low` *trong riêng ô đó* chỉ có thể lấy từ các mẫu
      poll cách nhau vài giây, nên một đỉnh nhọn nằm lọt giữa hai mẫu sẽ mất. Đây là lý do nó
      mang cờ `partial` và **không bao giờ** được lưu: `sync_bars` lấy về nến đúng từ nguồn, và
      cây xấp xỉ này biến mất ở lượt đọc kế tiếp.
    """

    timeframe: str
    bucket_start: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    #: Khối lượng luỹ kế cả ngày ở thời điểm ô này mở — để suy ra khối lượng riêng của ô.
    day_volume_at_open: int
    exact: bool = False


def _live_timeframes() -> list[str]:
    """Các khung **tự tải về** cần một cây nến đang chạy.

    Khung suy ra (3m, 2h, 4h, 1W, 1M) cố ý không có mặt: chúng được gộp từ khung gốc ngay lúc
    đọc, nên ghép đuôi sống vào khung gốc là chúng có đuôi sống miễn phí và **luôn khớp** với
    khung gốc người dùng đang nhìn. Dựng riêng cho từng khung là tự tạo ra đúng cái trôi lệch
    mà `timeframes.py` viết ra để tránh.
    """
    from app.services.market_data import timeframes as tfs

    codes = tfs.parse_list(settings.market_intraday_timeframes, default=())
    return [c for c in codes if not tfs.get(c).derived]


def _differs(a: Quote, b: Quote) -> bool:
    """So hai ảnh chụp ở đúng những trường bảng giá vẽ ra.

    Cố ý không so `as_of`: mốc thời gian đổi ở **mọi** nhịp, đưa vào phép so thì mọi mã đều
    "đổi" và phần lọc diff trở thành vô nghĩa.
    """
    return (
        a.price != b.price
        or a.volume != b.volume
        or a.bids != b.bids
        or a.asks != b.asks
        or a.high != b.high
        or a.low != b.low
        or a.foreign_buy != b.foreign_buy
        or a.foreign_sell != b.foreign_sell
    )


# ======================================================================
# CỬA SỔ PHIÊN
# ======================================================================
#: Các mốc phiên của HOSE. VPS không trả trạng thái phiên — đo 405 mã thì `tradingSession` là
#: None và `mkStatus` là chuỗi rỗng ở **mọi** dòng — nên nhãn phải suy từ đồng hồ. Kém chính xác
#: hơn một nguồn có trường trạng thái, nhưng hơn hẳn việc không hiện gì.
_SESSIONS = (
    ("09:00", "09:15", "ATO"),
    ("09:15", "11:30", "LO"),
    ("11:30", "13:00", "BREAK"),
    ("13:00", "14:30", "LO"),
    ("14:30", "14:45", "ATC"),
    ("14:45", "15:00", "PT"),
)

SESSION_LABELS = {
    "ATO": "Mở cửa (ATO)",
    "LO": "Khớp lệnh liên tục",
    "BREAK": "Nghỉ trưa",
    "ATC": "Đóng cửa (ATC)",
    "PT": "Thỏa thuận",
    "CLOSED": "Đóng cửa",
}


def _window() -> tuple[time, time]:
    """Cửa sổ poll, đọc từ cấu hình. Giá trị hỏng thì lùi về mặc định thay vì làm chết bộ poll."""
    try:
        return (
            parse_hhmm(settings.market_realtime_session_start),
            parse_hhmm(settings.market_realtime_session_end),
        )
    except (ValueError, AttributeError):
        log.warning("Cửa sổ phiên cấu hình sai, dùng 08:45-15:15")
        return parse_hhmm("08:45"), parse_hhmm("15:15")


def in_session_window(now: datetime | None = None) -> bool:
    """Trong giờ có thể có giá chạy. Ngoài cửa sổ thì không gọi mạng lần nào.

    Không có lý do gì để nện endpoint của VPS suốt đêm và cả cuối tuần để nhận lại đúng con số
    đã nhận lúc 15:00.
    """
    current = (now or local_now()).time()
    start, end = _window()
    return start <= current <= end


def current_session(now: datetime | None = None) -> str:
    """Mã phiên hiện tại — nguồn cho nhãn ATO / Liên tục / Nghỉ trưa / ATC trên bảng giá."""
    current = (now or local_now()).time()
    for start, end, code in _SESSIONS:
        if parse_hhmm(start) <= current < parse_hhmm(end):
            return code
    return "CLOSED"


# ======================================================================
# BỘ POLL
# ======================================================================
store = QuoteStore()

_provider: RealtimeQuoteProvider | None = None
_provider_lock = threading.Lock()


def _get_provider() -> RealtimeQuoteProvider:
    """Một provider duy nhất toàn tiến trình — giữ kết nối TLS sống, xem cạm bẫy 3 ở `quotes.py`."""
    global _provider
    if _provider is None:
        with _provider_lock:
            if _provider is None:
                _provider = get_quote_provider(settings.market_realtime_provider)
    return _provider


def close_provider() -> None:
    """Đóng kết nối khi tắt ứng dụng. Gọi từ `lifespan`."""
    global _provider
    with _provider_lock:
        if _provider is not None:
            _provider.close()
            _provider = None


def _tracked_symbols() -> list[str]:
    """Danh mục cần theo dõi — đúng những mã đang bật trong bảng `symbols`.

    Đọc cơ sở dữ liệu ở đây là đọc **danh sách mã**, không phải đọc hay ghi giá. Kho vẫn không
    chạm cơ sở dữ liệu.
    """
    from sqlalchemy import select

    from app.core.database import session_scope
    from app.models.market import Symbol

    with session_scope() as db:
        return list(db.scalars(
            select(Symbol.symbol).where(Symbol.is_active.is_(True)).order_by(Symbol.symbol)
        ).all())


def _should_skip(now: datetime) -> str | None:
    """Lý do bỏ qua nhịp này, hoặc None nếu phải chạy."""
    if not settings.market_realtime_enabled:
        return "tắt"

    stats = store._stats  # noqa: SLF001 — cùng module, cùng vòng đời
    if stats.skip_until and utcnow() < stats.skip_until:
        return "đang lùi sau lỗi"

    if not in_session_window(now):
        return "ngoài cửa sổ phiên"

    # Ngày nghỉ lễ đọc từ `trading_calendar` — dùng lại đúng hàm `job_sync_market` đang dùng để
    # hai nơi không bao giờ bất đồng về việc hôm nay có phải ngày giao dịch hay không.
    from app.core.database import session_scope
    from app.services import nav_sync_service

    try:
        with session_scope() as db:
            if not nav_sync_service.is_trading_day(db, local_today()):
                return "không phải ngày giao dịch"
    except Exception as exc:  # noqa: BLE001
        log.debug("Không đọc được lịch giao dịch, vẫn chạy nhịp poll: %s", exc)
    return None


def poll_once(force: bool = False) -> dict:
    """Một nhịp lấy giá. Gọi từ scheduler, hoặc từ nút chạy tay ở màn quản trị.

    Lỗi **không** xoá kho: bảng giá chậm 30 giây vẫn đọc được, bảng giá trắng thì không. Mã cũ ở
    lại và cờ `stale` bật lên để giao diện nói rõ dữ liệu đang chậm.
    """
    now = local_now()
    if not force:
        reason = _should_skip(now)
        if reason:
            return {"skipped": True, "reason": reason}

    started = utcnow()
    stats = store._stats  # noqa: SLF001
    stats.last_poll_at = started

    try:
        symbols = _tracked_symbols()
        stats.symbols_tracked = len(symbols)
        if not symbols:
            return {"skipped": True, "reason": "danh mục trống"}

        quotes = _get_provider().snapshot(symbols)
        changed = store.replace(quotes)

        stats.last_duration_ms = int((utcnow() - started).total_seconds() * 1000)
        stats.last_success_at = utcnow()
        stats.last_error = None
        stats.consecutive_errors = 0
        stats.skip_until = None
        stats.polls_ok += 1

        if changed:
            _broadcast(changed)

        return {
            "skipped": False,
            "quotes": len(quotes),
            "changed": len(changed),
            "duration_ms": stats.last_duration_ms,
        }

    except Exception as exc:  # noqa: BLE001
        stats.polls_failed += 1
        stats.consecutive_errors += 1
        stats.last_error = f"{type(exc).__name__}: {exc}"[:300]
        stats.last_duration_ms = int((utcnow() - started).total_seconds() * 1000)

        index = min(stats.consecutive_errors - 1, len(_BACKOFF_SECONDS) - 1)
        wait = _BACKOFF_SECONDS[index]
        from datetime import timedelta

        stats.skip_until = utcnow() + timedelta(seconds=wait)
        log.warning(
            "Nhịp lấy giá lỗi lần %s (%s), lùi %ss",
            stats.consecutive_errors, stats.last_error, wait,
        )
        return {"skipped": False, "error": stats.last_error, "backoff_seconds": wait}


def _broadcast(changed: list[Quote]) -> None:
    """Đẩy phần đổi sang kênh WebSocket. Kênh chết không được phép làm hỏng nhịp poll."""
    try:
        from app.services import realtime

        realtime.broadcast_quotes([q.as_dict() for q in changed])
    except Exception as exc:  # noqa: BLE001
        log.debug("Không đẩy được giá qua WebSocket: %s", exc)


def warm_up() -> None:
    """Bắt tay TLS trước, ngoài đường đi của nhịp poll đầu tiên.

    Lần gọi đầu tới VPS mất 30–42 giây vì DNS và TLS; các lần sau 50–80 ms. Không làm nóng trước
    thì nhịp đầu tiên của phiên chiếm chỗ `max_instances=1` suốt nửa phút và bảng giá trắng
    trong chừng ấy thời gian.
    """
    if not settings.market_realtime_enabled:
        return
    try:
        _get_provider().snapshot(["VNM"])
        log.info("Đã làm nóng kết nối nguồn giá thời gian thực")
    except Exception as exc:  # noqa: BLE001
        log.warning("Không làm nóng được kết nối nguồn giá: %s", exc)
