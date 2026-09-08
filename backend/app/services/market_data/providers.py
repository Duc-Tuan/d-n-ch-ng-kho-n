"""Các implementation cụ thể của `MarketDataProvider`.

Nguồn hiện tại là **endpoint công khai** của các công ty chứng khoán Việt Nam — dùng được ngay,
không tốn phí, nhưng không có hợp đồng và không có SLA. Xem cảnh báo BR-833 ở `base.py`.

Khi chuyển sang nguồn có hợp đồng, chỉ cần viết thêm một class ở file này và đổi
`MARKET_DATA_PROVIDER` trong `.env` — không phải sửa chỗ nào khác.
"""

from __future__ import annotations

import logging
import time
from datetime import date, datetime, timezone
from decimal import Decimal

import httpx

from app.core.config import settings
from app.services.market_data.base import (
    Bar,
    MarketDataError,
    MarketDataProvider,
    SymbolInfo,
)

log = logging.getLogger(__name__)

#: Nhiều endpoint công khai chặn request không giống trình duyệt.
BROWSER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
}


class _UdfProvider(MarketDataProvider):
    """Phần dùng chung cho các nguồn nói giao thức UDF của TradingView.

    Nhiều công ty chứng khoán Việt Nam phục vụ biểu đồ bằng cùng một giao thức — trả về sáu mảng
    song song `t/o/h/l/c/v` kèm trạng thái `s`. Khác nhau chỉ ở URL và vài header, nên phần đọc
    và kiểm tra dữ liệu viết một lần ở đây; lớp con chỉ khai báo endpoint của mình.

    Danh mục mã thì lấy từ SSI iBoard cho mọi nguồn: các endpoint biểu đồ chỉ trả giá theo mã
    được hỏi, không nơi nào liệt kê đủ mã ba sàn kèm tên doanh nghiệp.
    """

    #: Đã đo trực tiếp trên cả hai nguồn: `240` (4 giờ), `W` và `M` **không** có dữ liệu.
    #: Ba khung đó được gộp ra từ khung nhỏ hơn, xem `market_data.timeframes`.
    supported_resolutions = frozenset({"1", "5", "15", "30", "60", "D"})

    #: Đổi tên khung sang cách gọi riêng của nguồn. Rỗng nghĩa là dùng nguyên tên chuẩn.
    #:
    #: Cần thiết vì "giao thức UDF" không phải một chuẩn được ai đóng dấu: cùng khung một giờ,
    #: VPS gọi là `60` còn Entrade gọi là `1H` và trả về **mảng rỗng** cho `60` — im lặng, không
    #: báo lỗi, nhìn hệt như mã không có giao dịch.
    RESOLUTION_MAP: dict[str, str] = {}

    OHLCV_URL: str = ""
    #: Header riêng cho lời gọi giá — có nguồn kiểm tra `Referer`/`Origin` mới chịu trả dữ liệu.
    OHLCV_HEADERS: dict[str, str] = {}

    SYMBOL_URL = "https://iboard-query.ssi.com.vn/stock/exchange/{exchange}"
    EXCHANGES = ("hose", "hnx", "upcom")

    def __init__(self, timeout: int = 25, delay_seconds: float = 0.25) -> None:
        self.timeout = timeout
        #: Giãn cách giữa các lần gọi — tránh bị chặn khi đồng bộ hàng nghìn mã.
        self.delay_seconds = delay_seconds
        self._client: httpx.Client | None = None

    # ------------------------------------------------------------------
    def _get_client(self) -> httpx.Client:
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(headers=BROWSER_HEADERS, timeout=self.timeout)
        return self._client

    def close(self) -> None:
        if self._client and not self._client.is_closed:
            self._client.close()

    def __enter__(self) -> _UdfProvider:
        return self

    def __exit__(self, *args) -> None:
        self.close()

    # ------------------------------------------------------------------
    def list_symbols(self) -> list[SymbolInfo]:
        client = self._get_client()
        results: list[SymbolInfo] = []
        seen: set[str] = set()

        for exchange in self.EXCHANGES:
            url = self.SYMBOL_URL.format(exchange=exchange)
            try:
                response = client.get(url)
                response.raise_for_status()
                payload = response.json()
            except Exception as exc:
                raise MarketDataError(f"Không lấy được danh sách mã sàn {exchange}: {exc}") from exc

            for item in payload.get("data", []):
                symbol = (item.get("stockSymbol") or "").strip().upper()
                # Bỏ mã rỗng, mã trùng, và các mã không phải cổ phiếu thường (chứng quyền C…).
                if not symbol or symbol in seen or len(symbol) > 10:
                    continue
                seen.add(symbol)
                results.append(
                    SymbolInfo(
                        symbol=symbol,
                        exchange=exchange.upper(),
                        company_name=(item.get("companyNameVi") or "").strip() or None,
                        company_name_en=(item.get("companyNameEn") or "").strip() or None,
                    )
                )
            time.sleep(self.delay_seconds)

        if not results:
            raise MarketDataError("Danh sách mã trả về rỗng — không ghi đè dữ liệu đang có")
        return results

    # ------------------------------------------------------------------
    def _has_data(self, payload: dict, symbol: str, resolution: str) -> bool:
        """Phản hồi có dữ liệu dùng được không. Lớp con đổi cách đọc trạng thái ở đây."""
        status = payload.get("s")
        if status == "no_data":
            return False
        if status != "ok":
            raise MarketDataError(f"{symbol} ({resolution}): nguồn trả về trạng thái {status!r}")
        return True

    def get_ohlcv(self, symbol: str, date_from: date, date_to: date) -> list[Bar]:
        return self.get_bars(
            symbol,
            datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc),
            datetime.combine(date_to, datetime.max.time(), tzinfo=timezone.utc),
            "D",
        )

    def get_bars(
        self, symbol: str, start: datetime, end: datetime, resolution: str = "D"
    ) -> list[Bar]:
        """Một lời gọi UDF cho mọi khung. Khung nào nguồn không có thì chặn ngay tại đây.

        Chặn trước khi gọi mạng chứ không đọc kết quả rồi đoán: hỏi `240` thì VPS trả trạng thái
        rỗng còn VNDIRECT trả `ok` kèm mảng nến trống — nhìn hệt như một mã không giao dịch hôm
        đó. Để lọt xuống dưới thì mỗi mã trong danh mục thành một dòng lỗi trên màn vận hành,
        mỗi ngày, cho một khung mà đằng nào cũng phải gộp ra từ khung nhỏ hơn.
        """
        if resolution not in self.supported_resolutions:
            raise MarketDataError(
                f"{self.name} không phục vụ khung {resolution!r}. "
                f"Khung có sẵn: {', '.join(sorted(self.supported_resolutions))}"
            )

        intraday = resolution not in ("D", "W", "M")
        client = self._get_client()
        params = {
            "symbol": symbol.strip().upper(),
            "resolution": self.RESOLUTION_MAP.get(resolution, resolution),
            "from": int(start.timestamp()),
            "to": int(end.timestamp()),
        }

        try:
            response = client.get(
                self.OHLCV_URL,
                params=params,
                headers={**BROWSER_HEADERS, **self.OHLCV_HEADERS},
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:
            raise MarketDataError(
                f"Không lấy được giá {resolution} của {symbol}: {exc}"
            ) from exc

        if not self._has_data(payload, symbol, resolution):
            return []

        times = payload.get("t") or []
        bars: list[Bar] = []
        for i, ts in enumerate(times):
            try:
                opened_at = datetime.fromtimestamp(ts, tz=timezone.utc)
                bar = Bar(
                    # Ngày giao dịch của một nến trong ngày phải tính theo **giờ Việt Nam**:
                    # phiên 09:00–14:45 nằm gọn trong 02:00–07:45 UTC, nên lấy ngày UTC thì
                    # đúng ở đây nhưng sai ngay khi nguồn đổi múi giờ hoặc thị trường đổi giờ.
                    trade_date=(
                        opened_at.astimezone(settings.tz).date()
                        if intraday
                        else opened_at.date()
                    ),
                    open=Decimal(str(payload["o"][i])),
                    high=Decimal(str(payload["h"][i])),
                    low=Decimal(str(payload["l"][i])),
                    close=Decimal(str(payload["c"][i])),
                    volume=int(payload["v"][i] or 0),
                    ts=opened_at if intraday else None,
                )
            except (KeyError, IndexError, TypeError, ValueError, OSError) as exc:
                log.warning("%s: bỏ qua nến lỗi ở vị trí %s: %s", symbol, i, exc)
                continue

            # BR-835 — chặn dữ liệu hỏng ngay tại biên, không để lọt vào cơ sở dữ liệu.
            if bar.is_valid():
                bars.append(bar)
            else:
                log.warning(
                    "%s: nến %s lúc %s không hợp lệ, bỏ qua", symbol, resolution, bar.opened_at()
                )

        bars.sort(key=lambda b: b.opened_at())
        return bars


class VnDirectProvider(_UdfProvider):
    """Giá lịch sử từ endpoint biểu đồ của VNDIRECT; danh mục mã từ SSI iBoard.

    Lịch sử **chỉ có từ đầu 2013** — hỏi xa hơn cũng chỉ nhận được bấy nhiêu, đã kiểm chứng bằng
    cách xin từ 1998 cho REE và SAM (niêm yết 7/2000) và vẫn nhận về mốc 2013-01-02.
    """

    name = "VNDIRECT"
    attribution = "Nguồn dữ liệu: VNDIRECT, SSI iBoard"

    OHLCV_URL = "https://dchart-api.vndirect.com.vn/dchart/history"
    OHLCV_HEADERS = {
        "Referer": "https://dchart.vndirect.com.vn/",
        "Origin": "https://dchart.vndirect.com.vn",
    }


class VpsProvider(_UdfProvider):
    """Giá lịch sử từ VPS; danh mục mã từ SSI iBoard.

    Đi ngược tới **2000-07-28** — phiên đầu tiên của thị trường chứng khoán Việt Nam — nên phủ
    thêm khoảng 20% số nến so với VNDIRECT.

    > ⚠️ **Không trộn được với VNDIRECT.** Hai nguồn áp hệ số điều chỉnh cổ tức khác nhau: trên
    > FPT và HPG, hơn 2.000 trong 3.392 phiên trùng nhau cho giá lệch hẳn (FPT 2013-01-02:
    > VNDIRECT 4.031 và VPS 4.683). Ghép hai bên sẽ tạo một cú nhảy giá giả ở mốc giao nhau và
    > máy chạy chiến lược sẽ đọc thành tín hiệu. Đổi nguồn thì phải **nạp lại toàn bộ** danh mục,
    > không được vá thêm phần thiếu.
    """

    name = "VPS"
    attribution = "Nguồn dữ liệu: VPS, SSI iBoard"

    OHLCV_URL = "https://histdatafeed.vps.com.vn/tradingview/history"


class EntradeProvider(_UdfProvider):
    """Giá từ Entrade (DNSE); danh mục mã từ SSI iBoard.

    Lý do tồn tại là **độ sâu của nến trong ngày**, thứ mà VPS và VNDIRECT đều không có. Đã đo
    trên FPT, HPG, AAA, VNM, SSI ngày 08/09/2026:

    ==========  ===================  =============================
    Khung       VPS                  Entrade
    ==========  ===================  =============================
    1 phút      ~800 nến (4 phiên)   ~14.200 nến (từ 2026-06)
    5 phút      ~350 nến             ~2.900 nến
    15 phút     ~300 nến             ~1.000 nến
    30 phút     ~360 nến             ~570 nến
    **1 giờ**   ~310 nến (3 tháng)   **~3.720 nến (từ 2023-09)**
    ==========  ===================  =============================

    Và quan trọng hơn con số tổng: lịch sử 1 giờ của Entrade **liền mạch** — 1.248 nến năm 2024,
    1.245 nến năm 2025, đúng bằng một năm giao dịch đầy đủ. VNDIRECT nhìn qua cũng "sâu 5 năm"
    nhưng chỉ có 10–50 nến mỗi năm cho các năm cũ, tức là vài mẩu vụn chứ không phải lịch sử.

    > **Về việc trộn nguồn.** BR-83x cấm ghép hai nguồn áp hệ số điều chỉnh cổ tức khác nhau —
    > VNDIRECT và VPS lệch tới 16% trên cùng một phiên, đủ để máy chạy chiến lược đọc thành tín
    > hiệu. Entrade thì **không** như vậy: đối chiếu nến 1 giờ gộp lại với nến ngày của VPS trên
    > 5 mã × 745 phiên cho lệch trung bình 0,004–0,03% và lớn nhất 0,11%, không phiên nào quá
    > 0,5%. Đó là sai số làm tròn (VPS trả 3 chữ số thập phân, Entrade trả 2), không phải khác
    > hệ số. Dù vậy nến ngày vẫn **chỉ** lấy từ nguồn chính: `ohlcv_daily` là thứ chiến lược và
    > backtest đọc, còn `ohlcv_bars` chỉ phục vụ biểu đồ.
    """

    name = "ENTRADE"
    attribution = "Nguồn dữ liệu: Entrade (DNSE), SSI iBoard"

    OHLCV_URL = "https://services.entrade.com.vn/chart-api/v2/ohlcs/stock"

    #: Không có `240`/`W`/`M`, giống hai nguồn kia — các khung đó vẫn gộp lúc đọc.
    supported_resolutions = frozenset({"1", "3", "5", "15", "30", "60", "D"})

    #: Entrade gọi khung giờ là `1H` và khung ngày là `1D`. Hỏi bằng `60` thì nó trả mảng rỗng
    #: chứ không báo lỗi — đúng kiểu hỏng lặng lẽ mà bảng đổi tên này sinh ra để chặn.
    RESOLUTION_MAP = {"60": "1H", "D": "1D"}

    def _has_data(self, payload: dict, symbol: str, resolution: str) -> bool:
        # Không có trường `s` như hai nguồn kia; mã sai thì trả HTTP 400 và đã bị chặn ở trên,
        # nên tới được đây mà mảng rỗng thì đơn giản là khoảng thời gian đó không có nến.
        return bool(payload.get("t"))


# ======================================================================
_PROVIDERS: dict[str, type[MarketDataProvider]] = {
    "VNDIRECT": VnDirectProvider,
    "VPS": VpsProvider,
    "ENTRADE": EntradeProvider,
}


def _provider_class(name: str | None = None) -> type[MarketDataProvider]:
    from app.core.config import settings

    key = (name or settings.market_data_provider).upper()
    provider_class = _PROVIDERS.get(key)
    if not provider_class:
        raise MarketDataError(
            f"Nhà cung cấp dữ liệu {key!r} chưa được cài đặt. "
            f"Các lựa chọn hiện có: {', '.join(sorted(_PROVIDERS))}"
        )
    return provider_class


def get_provider(name: str | None = None) -> MarketDataProvider:
    """Điểm vào duy nhất để lấy provider. Không class nào khác được khởi tạo provider trực tiếp.

    Đối tượng trả về **giữ một pool kết nối** — luôn dùng trong `with`, hoặc gọi `close()` ở
    `finally`. Chỉ cần đọc dòng ghi nguồn để hiển thị thì dùng `attribution()`, đừng dựng provider.
    """
    return _provider_class(name)()


def intraday_provider_name() -> str:
    """Tên nguồn phục vụ **nến trong ngày**. Bỏ trống cấu hình thì dùng chung nguồn chính.

    Tách riêng vì hai loại nến có hai bài toán khác hẳn nhau. Nến ngày cần lịch sử thật sâu và
    phải khớp tuyệt đối với thứ chiến lược đang chạy — VPS đi tới 2000. Nến trong ngày thì mọi
    nguồn đều chỉ phục vụ một cửa sổ gần đây, và cửa sổ đó rộng hẹp rất khác nhau: Entrade cho
    ba năm nến 1 giờ, VPS cho ba tháng.
    """
    from app.core.config import settings

    return (settings.market_intraday_provider or settings.market_data_provider).upper()


def get_intraday_provider() -> MarketDataProvider:
    """Provider cho nến trong ngày. Cùng ràng buộc `close()` như `get_provider()`."""
    return _provider_class(intraday_provider_name())()


def attribution(name: str | None = None) -> str:
    """Dòng ghi nguồn dữ liệu, đọc từ class — **không** khởi tạo provider.

    Endpoint bảng giá và biểu đồ gắn dòng này vào mọi phản hồi. Dựng cả một provider (kèm pool
    kết nối HTTP) cho mỗi request chỉ để đọc một hằng số là lãng phí, và là loại rò rỉ dễ bị bỏ
    sót nhất: không có lỗi nào xuất hiện, chỉ có số socket mở tăng dần theo lưu lượng.
    """
    return _provider_class(name).attribution
