"""Giá thời gian thực cho bảng giá — BR-830, BR-831.

Tầng này **chỉ phục vụ hiển thị**. Không có một lời gọi ghi cơ sở dữ liệu nào ở đây, và đó là
ràng buộc quan trọng nhất của cả module: nến ngày và nến trong ngày vẫn chỉ đến từ
`job_sync_market`, xem `app.models.market.OhlcvDaily` (BR-832).

Vì sao nguồn mặc định là VPS chứ không phải một feed có hợp đồng
----------------------------------------------------------------
VPS đã là nhà cung cấp nến ngày của hệ thống. Dùng lại chính nó cho giá thời gian thực nghĩa là
**không trộn hệ số điều chỉnh cổ tức** — điều luật BR-83x sinh ra để chặn. Đối chiếu trực tiếp
ngày 10/09/2026 cho thấy hậu quả của việc trộn: cùng mã FPT, cùng khối lượng từng phiên, giá
phiên 2007-10-08 của VPS là 11,61 còn của SSI FastConnect là 137,185 — lệch **11,8 lần**. Cùng
một nhà thì con số cuối phiên của bảng giá và con số job 16:00 ghi xuống là một.

Cộng thêm: VPS trả sẵn **nghìn đồng** (`lastPrice: 21.95`) đúng quy ước hiển thị của hệ thống,
nên không có bước chia 1000 nào để mà quên.

Ba cạm bẫy đã đo được, đừng bỏ bất kỳ cái nào
---------------------------------------------
1. **Khối lượng theo lô 10.** Mọi trường khối lượng (`lot`, `lastVolume`, phần sau dấu gạch đứng
   của `g1..g6`) đều là số lô 10 cổ phiếu, không phải số cổ phiếu. Đo trên 2.314 mẫu dư mua/dư
   bán của cả sàn HOSE: 100,0% chia hết cho 10 nhưng chỉ 13,4% chia hết cho 100 — mà lô tối
   thiểu của HOSE là 100 cổ phiếu. Nếu con số đã là cổ phiếu thì tỉ lệ chia hết cho 100 phải
   xấp xỉ 100%. Quên nhân 10 thì cột khối lượng sai đúng một bậc mà không có lỗi nào báo.

2. **Trường `ot` và `changePc` không mang dấu.** Đo 405 mã HOSE: **0 dòng** có dấu âm, kể cả
   những mã đang giảm (AAA giá 7,32 · tham chiếu 7,35 · `ot` bằng "0.03"). Lấy thẳng hai trường
   này thì mọi mã giảm hiện thành tăng. Thay đổi giá **luôn tự tính** từ `price - reference`.

3. **Bắt tay TLS tốn 40 giây.** Lần gọi đầu tới `bgapidatafeed.vps.com.vn` mất ~42 giây, các
   lần sau giữ kết nối chỉ 66–81 ms. Client phải sống suốt vòng đời tiến trình; dựng client mới
   mỗi nhịp thì mỗi nhịp tốn 40 giây và tính năng coi như không chạy.

Số đo dung lượng (10/09/2026, phiên chiều): 150 mã cho 143 KB trong 118 ms; 1.523 mã cả ba sàn
cho 1,4 MB trong 226 ms, vẫn chỉ **một** lời gọi.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Protocol, runtime_checkable

import httpx

from app.core.datetime_utils import utcnow
from app.services.market_data.base import MarketDataError
from app.services.market_data.providers import BROWSER_HEADERS

log = logging.getLogger(__name__)

#: Một lô của VPS là 10 cổ phiếu — xem cạm bẫy 1 ở đầu file.
LOT_SIZE = 10

#: Số bậc dư mua/dư bán VPS phục vụ. Trường g1..g3 là bên mua (giá giảm dần), g4..g6 là bên bán
#: (giá tăng dần) — đã đối chiếu với best1Bid/best1Offer của SSI iBoard trên cùng thời điểm.
DEPTH = 3


def _decimal(value: object) -> Decimal | None:
    """Về Decimal hoặc None. VPS trả lẫn lộn số và chuỗi cho cùng một nhóm trường.

    Trường `lastPrice` là số thực (21.95) nhưng `openPrice` là chuỗi ("22.0") — cùng một đơn vị,
    khác kiểu, trong cùng một dòng dữ liệu.
    """
    if value is None or value == "":
        return None
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    # Mã chưa khớp lệnh nào trong phiên trả về 0 ở mọi trường giá. 0 không phải một mức giá có
    # thật, và để nguyên thì nó kéo mọi phép tính thay đổi giá thành -100%.
    return result if result != 0 else None


def _lots_to_shares(value: object) -> int:
    """Đổi khối lượng theo lô của VPS sang số cổ phiếu."""
    if value is None or value == "":
        return 0
    try:
        return int(float(value)) * LOT_SIZE
    except (TypeError, ValueError):
        return 0


@dataclass(slots=True, frozen=True)
class QuoteLevel:
    """Một bậc trong sổ lệnh."""

    price: Decimal
    volume: int


@dataclass(slots=True)
class Quote:
    """Ảnh chụp giá của một mã tại một thời điểm.

    Giá theo **nghìn đồng**, khối lượng theo **số cổ phiếu** — cả hai đã quy đổi tại biên
    provider để không nhánh nào phía dưới phải nhớ quy ước của nhà cung cấp.
    """

    symbol: str
    price: Decimal | None = None
    reference: Decimal | None = None
    ceiling: Decimal | None = None
    floor: Decimal | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    avg_price: Decimal | None = None
    change: Decimal | None = None
    change_pct: float | None = None
    volume: int = 0
    #: Giá trị giao dịch suy ra từ avg_price nhân volume — VPS không trả trường này. Đơn vị
    #: nghìn đồng nhân cổ phiếu, tức nghìn đồng, cùng hệ với cột giá.
    value: Decimal | None = None
    last_volume: int = 0
    bids: tuple[QuoteLevel, ...] = ()
    asks: tuple[QuoteLevel, ...] = ()
    foreign_buy: int = 0
    foreign_sell: int = 0
    foreign_room: int | None = None
    as_of: datetime = field(default_factory=utcnow)

    @property
    def at_ceiling(self) -> bool:
        return self.price is not None and self.ceiling is not None and self.price >= self.ceiling

    @property
    def at_floor(self) -> bool:
        return self.price is not None and self.floor is not None and self.price <= self.floor

    def as_dict(self) -> dict:
        """Dạng phẳng cho gói tin WebSocket.

        Mọi giá ra **số thực**, không phải `Decimal`.

        Đường REST đi qua `PriceBoardItem` nên kiểu `Money` lo việc này; đường WebSocket thì
        không có Pydantic ở giữa, và `json.dumps(default=str)` sẽ lặng lẽ biến `Decimal('21.95')`
        thành chuỗi `"21.95"`. Frontend khai kiểu `number`, nên TypeScript không bắt được, và
        hậu quả xuất hiện ở chỗ không ai ngờ: `"9.5" > "10.5"` trong JavaScript là **đúng** — ô
        giá nháy xanh cho một mã vừa giảm. Cùng loại lỗi mà `tests/test_api_contract.py` được
        lập ra để chặn ở phía REST.
        """
        def num(value: Decimal | None) -> float | None:
            return float(value) if value is not None else None

        return {
            "symbol": self.symbol,
            "price": num(self.price),
            "reference": num(self.reference),
            "ceiling": num(self.ceiling),
            "floor": num(self.floor),
            "open": num(self.open),
            "high": num(self.high),
            "low": num(self.low),
            "avg_price": num(self.avg_price),
            "change": num(self.change),
            "change_pct": self.change_pct,
            "volume": self.volume,
            "value": num(self.value),
            "last_volume": self.last_volume,
            "bids": [{"price": float(b.price), "volume": b.volume} for b in self.bids],
            "asks": [{"price": float(a.price), "volume": a.volume} for a in self.asks],
            "foreign_buy": self.foreign_buy,
            "foreign_sell": self.foreign_sell,
            "foreign_room": self.foreign_room,
            "as_of": self.as_of.isoformat(),
        }


@runtime_checkable
class RealtimeQuoteProvider(Protocol):
    """BR-830 áp cho giá thời gian thực: đổi nguồn là viết một class mới ở đây.

    Cùng khuôn với `MarketDataProvider` của nến lịch sử. Nguồn thứ hai đã khảo sát và chạy thử
    được là SSI FastConnect Data (SignalR cổ điển, hub FcMarketDataV2Hub, kênh X-TRADE) — cho
    tick thật thay vì poll, nhưng cần ConsumerID/ConsumerSecret của một tài khoản đăng ký nên
    không đặt làm mặc định.
    """

    name: str

    def snapshot(self, symbols: list[str]) -> list[Quote]:
        """Giá hiện tại của các mã. Một lời gọi cho cả danh sách, không phải mỗi mã một lời gọi."""
        ...

    def close(self) -> None:
        ...


class VpsBoardProvider:
    """Bảng giá VPS — không cần khoá, không cần đăng ký."""

    name = "VPS"
    URL = "https://bgapidatafeed.vps.com.vn/getliststockdata/"

    #: Trần số mã mỗi lời gọi. Đã thử thẳng 1.523 mã (URL 6.141 ký tự) và máy chủ trả đủ, nhưng
    #: giữ một trần để không phụ thuộc vào giới hạn độ dài URL không có tài liệu nào bảo đảm.
    MAX_PER_CALL = 500

    def __init__(self, timeout: float = 20.0) -> None:
        self._timeout = timeout
        self._client: httpx.Client | None = None

    # ------------------------------------------------------------------
    def _get_client(self) -> httpx.Client:
        """Client riêng, giữ nguyên vòng đời tiến trình — xem cạm bẫy 3 ở đầu file.

        Không dùng chung pool với `app.core.http`: bộ poll gọi mỗi vài giây và không được phép
        tranh kết nối với worker Telegram, mà `connect=5s` của pool đó cũng quá chặt cho lần bắt
        tay đầu tiên tới máy chủ này.
        """
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(
                headers=BROWSER_HEADERS,
                timeout=httpx.Timeout(connect=15.0, read=self._timeout, write=10.0, pool=5.0),
                limits=httpx.Limits(
                    max_connections=4, max_keepalive_connections=2, keepalive_expiry=300.0
                ),
                follow_redirects=True,
            )
        return self._client

    def close(self) -> None:
        if self._client and not self._client.is_closed:
            self._client.close()
        self._client = None

    # ------------------------------------------------------------------
    def snapshot(self, symbols: list[str]) -> list[Quote]:
        codes = [s.upper() for s in symbols if s]
        if not codes:
            return []

        client = self._get_client()
        quotes: list[Quote] = []
        for start in range(0, len(codes), self.MAX_PER_CALL):
            batch = codes[start:start + self.MAX_PER_CALL]
            try:
                response = client.get(self.URL + ",".join(batch))
                response.raise_for_status()
                rows = response.json()
            except httpx.HTTPError as exc:
                raise MarketDataError(f"VPS bảng giá lỗi mạng: {exc}") from exc
            except ValueError as exc:
                raise MarketDataError(f"VPS bảng giá trả về không phải JSON: {exc}") from exc

            if not isinstance(rows, list):
                raise MarketDataError(f"VPS bảng giá trả về kiểu lạ: {type(rows).__name__}")

            now = utcnow()
            for row in rows:
                if not isinstance(row, dict):
                    continue
                quote = self._parse(row, now)
                if quote is not None:
                    quotes.append(quote)
        return quotes

    # ------------------------------------------------------------------
    @staticmethod
    def _level(raw: object) -> QuoteLevel | None:
        """Tách một bậc sổ lệnh từ chuỗi "21.95|41540|d" — giá, khối lượng lô, cờ màu."""
        if not isinstance(raw, str) or "|" not in raw:
            return None
        parts = raw.split("|")
        price = _decimal(parts[0])
        if price is None:
            return None
        return QuoteLevel(price=price, volume=_lots_to_shares(parts[1] if len(parts) > 1 else 0))

    @classmethod
    def _parse(cls, row: dict, now: datetime) -> Quote | None:
        symbol = (row.get("sym") or "").strip().upper()
        if not symbol:
            return None

        price = _decimal(row.get("lastPrice"))
        reference = _decimal(row.get("r"))
        volume = _lots_to_shares(row.get("lot"))
        avg_price = _decimal(row.get("avePrice"))

        # Cạm bẫy 2: ot và changePc của VPS không mang dấu, tự tính lấy.
        change = change_pct = None
        if price is not None and reference is not None:
            change = price - reference
            change_pct = round(float(change / reference * 100), 2)

        bids = tuple(x for x in (cls._level(row.get(f"g{i}")) for i in (1, 2, 3)) if x)
        asks = tuple(x for x in (cls._level(row.get(f"g{i}")) for i in (4, 5, 6)) if x)

        try:
            foreign_room = int(float(row["fRoom"])) if row.get("fRoom") else None
        except (TypeError, ValueError):
            foreign_room = None

        return Quote(
            symbol=symbol,
            price=price,
            reference=reference,
            ceiling=_decimal(row.get("c")),
            floor=_decimal(row.get("f")),
            open=_decimal(row.get("openPrice")),
            high=_decimal(row.get("highPrice")),
            low=_decimal(row.get("lowPrice")),
            avg_price=avg_price,
            change=change,
            change_pct=change_pct,
            volume=volume,
            value=(avg_price * volume) if (avg_price is not None and volume) else None,
            last_volume=_lots_to_shares(row.get("lastVolume")),
            bids=bids[:DEPTH],
            asks=asks[:DEPTH],
            foreign_buy=_lots_to_shares(row.get("fBVol")),
            foreign_sell=_lots_to_shares(row.get("fSVolume")),
            foreign_room=foreign_room,
            as_of=now,
        )


#: Danh bạ nguồn giá thời gian thực. Thêm nguồn mới là thêm một dòng ở đây.
_PROVIDERS: dict[str, type] = {"VPS": VpsBoardProvider}


def get_quote_provider(name: str | None = None) -> RealtimeQuoteProvider:
    """Điểm vào duy nhất. Tên không nhận ra thì lùi về VPS thay vì làm sập bộ poll."""
    key = (name or "VPS").strip().upper()
    provider_class = _PROVIDERS.get(key)
    if provider_class is None:
        log.warning("Nguồn giá thời gian thực %r không tồn tại, dùng VPS", name)
        provider_class = VpsBoardProvider
    return provider_class()
