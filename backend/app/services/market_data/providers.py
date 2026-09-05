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
    def get_ohlcv(self, symbol: str, date_from: date, date_to: date) -> list[Bar]:
        client = self._get_client()
        params = {
            "symbol": symbol.strip().upper(),
            "resolution": "D",
            "from": int(datetime.combine(date_from, datetime.min.time(),
                                         tzinfo=timezone.utc).timestamp()),
            "to": int(datetime.combine(date_to, datetime.max.time(),
                                       tzinfo=timezone.utc).timestamp()),
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
            raise MarketDataError(f"Không lấy được giá của {symbol}: {exc}") from exc

        status = payload.get("s")
        if status == "no_data":
            return []
        if status != "ok":
            raise MarketDataError(f"{symbol}: nguồn trả về trạng thái {status!r}")

        times = payload.get("t") or []
        bars: list[Bar] = []
        for i, ts in enumerate(times):
            try:
                bar = Bar(
                    trade_date=datetime.fromtimestamp(ts, tz=timezone.utc).date(),
                    open=Decimal(str(payload["o"][i])),
                    high=Decimal(str(payload["h"][i])),
                    low=Decimal(str(payload["l"][i])),
                    close=Decimal(str(payload["c"][i])),
                    volume=int(payload["v"][i] or 0),
                )
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                log.warning("%s: bỏ qua nến lỗi ở vị trí %s: %s", symbol, i, exc)
                continue

            # BR-835 — chặn dữ liệu hỏng ngay tại biên, không để lọt vào cơ sở dữ liệu.
            if bar.is_valid():
                bars.append(bar)
            else:
                log.warning("%s: nến ngày %s không hợp lệ, bỏ qua", symbol, bar.trade_date)

        bars.sort(key=lambda b: b.trade_date)
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


# ======================================================================
_PROVIDERS: dict[str, type[MarketDataProvider]] = {
    "VNDIRECT": VnDirectProvider,
    "VPS": VpsProvider,
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


def attribution(name: str | None = None) -> str:
    """Dòng ghi nguồn dữ liệu, đọc từ class — **không** khởi tạo provider.

    Endpoint bảng giá và biểu đồ gắn dòng này vào mọi phản hồi. Dựng cả một provider (kèm pool
    kết nối HTTP) cho mỗi request chỉ để đọc một hằng số là lãng phí, và là loại rò rỉ dễ bị bỏ
    sót nhất: không có lỗi nào xuất hiện, chỉ có số socket mở tăng dần theo lưu lượng.
    """
    return _provider_class(name).attribution
