"""BR-830 — tầng trừu tượng bắt buộc cho dữ liệu thị trường.

Ứng dụng **chỉ gọi interface này**, không bao giờ gọi thẳng API của nhà cung cấp. Đổi nhà cung
cấp sau này chỉ cần viết một class mới, không phải sửa toàn bộ hệ thống.

Đây là quyết định kiến trúc quan trọng nhất ở phần dữ liệu, vì gần như chắc chắn sẽ đổi nguồn ít
nhất một lần: nguồn hiện tại là endpoint công khai không có hợp đồng và không có SLA.

> ⚠️ **BR-833 — quyền hiển thị lại (redistribution).** Nguồn đang dùng là endpoint công khai của
> công ty chứng khoán, KHÔNG phải gói dữ liệu có hợp đồng. Rất nhiều gói dữ liệu chỉ cho phép sử
> dụng nội bộ, không cho hiển thị lại cho khách hàng trả phí. Phải làm rõ điều khoản này trước khi
> vận hành thương mại — cách rẻ nhất là hỏi công ty chứng khoán mà bạn đang làm IB (mục 12.2).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from decimal import Decimal


@dataclass(slots=True)
class SymbolInfo:
    symbol: str
    exchange: str
    company_name: str | None = None
    company_name_en: str | None = None


@dataclass(slots=True)
class Bar:
    """Một nến. Giá theo đơn vị hiển thị của thị trường Việt Nam (nghìn đồng)."""

    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int

    def is_valid(self) -> bool:
        """BR-835 — chặn dữ liệu hỏng ngay tại biên: giá bằng 0, khối lượng âm, cao/thấp ngược."""
        if min(self.open, self.high, self.low, self.close) <= 0:
            return False
        if self.volume < 0:
            return False
        if self.high < self.low:
            return False
        if not (self.low <= self.open <= self.high):
            return False
        if not (self.low <= self.close <= self.high):
            return False
        return True


class MarketDataError(Exception):
    """Lỗi khi lấy dữ liệu. Tầng gọi quyết định thử lại hay bỏ qua."""


class MarketDataProvider(ABC):
    """Interface cố định cho mọi nhà cung cấp dữ liệu thị trường."""

    #: Tên hiển thị, đồng thời là giá trị ghi vào cột `source` để biết dữ liệu từ đâu ra.
    name: str = "UNKNOWN"

    #: BR-836 — hiển thị "Nguồn dữ liệu: ..." dưới bảng giá và biểu đồ.
    #: Vừa là yêu cầu hợp đồng của nhiều nhà cung cấp, vừa tăng độ tin cậy với khách hàng.
    attribution: str = ""

    @abstractmethod
    def list_symbols(self) -> list[SymbolInfo]:
        """Toàn bộ mã đang niêm yết."""

    @abstractmethod
    def get_ohlcv(self, symbol: str, date_from: date, date_to: date) -> list[Bar]:
        """Giá lịch sử theo ngày, sắp xếp tăng dần theo thời gian."""

    def get_quote(self, symbol: str) -> dict | None:
        """Giá hiện tại. Chưa bắt buộc — bảng giá realtime thuộc giai đoạn sau."""
        raise NotImplementedError(
            f"{self.name} chưa hỗ trợ lấy giá realtime. Xem mục 12.1 về độ trễ chấp nhận được."
        )

    def get_fundamentals(self, symbol: str) -> dict | None:
        """Dữ liệu tài chính doanh nghiệp (EPS, P/E, P/B, ROE...). Chưa bắt buộc."""
        raise NotImplementedError(f"{self.name} chưa hỗ trợ dữ liệu tài chính doanh nghiệp.")

    def get_foreign_flow(self, symbol: str, date_from: date, date_to: date) -> list[dict]:
        """Giao dịch khối ngoại. Chưa bắt buộc."""
        raise NotImplementedError(f"{self.name} chưa hỗ trợ dữ liệu khối ngoại.")
