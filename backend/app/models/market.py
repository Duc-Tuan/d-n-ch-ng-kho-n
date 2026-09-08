"""Dữ liệu thị trường: danh mục mã, giá lịch sử, sự kiện doanh nghiệp (Phần 12)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Index,
    Integer,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, CreatedAtMixin, IdMixin, TimestampMixin


class Symbol(Base, IdMixin, TimestampMixin):
    """Danh mục mã chứng khoán niêm yết."""

    __tablename__ = "symbols"

    symbol: Mapped[str] = mapped_column(String(20), unique=True, nullable=False)
    exchange: Mapped[str] = mapped_column(String(10), nullable=False, index=True)  # HOSE|HNX|UPCOM
    company_name: Mapped[str | None] = mapped_column(String(255))
    company_name_en: Mapped[str | None] = mapped_column(String(255))
    #: Ngành nghề — bổ sung sau khi có nguồn phân ngành.
    industry: Mapped[str | None] = mapped_column(String(150), index=True)
    #: A|B|C — mức độ phù hợp để giao dịch theo tín hiệu, xem `app.data.symbol_universe`.
    tier: Mapped[str | None] = mapped_column(String(1), index=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    #: Mốc cuối cùng đã đồng bộ được giá — dùng để đồng bộ tăng dần thay vì tải lại từ đầu.
    last_ohlcv_date: Mapped[date | None] = mapped_column(Date)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (Index("ix_symbol_exchange_active", "exchange", "is_active"),)

    def __repr__(self) -> str:  # pragma: no cover
        return f"<Symbol {self.symbol} {self.exchange}>"


class OhlcvDaily(Base, IdMixin):
    """Giá lịch sử theo ngày.

    BR-832 — backtest và chốt kết quả tín hiệu **phải chạy trên dữ liệu ổn định lưu tại chỗ**.
    Không gọi API bên ngoài mỗi lần chạy: vừa chậm, vừa đắt, vừa cho kết quả khác nhau giữa các
    lần chạy nếu nhà cung cấp sửa dữ liệu.
    """

    __tablename__ = "ohlcv_daily"

    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    trade_date: Mapped[date] = mapped_column(Date, nullable=False)

    # Giá đơn vị nghìn đồng theo quy ước hiển thị của thị trường Việt Nam.
    open: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    high: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    low: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    close: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    volume: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    #: Giá đã điều chỉnh theo sự kiện doanh nghiệp (BR-834). NULL nghĩa là chưa tính.
    adjusted_close: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))

    source: Mapped[str] = mapped_column(String(30), nullable=False, default="VNDIRECT")

    __table_args__ = (
        UniqueConstraint("symbol", "trade_date", name="uq_ohlcv_symbol_date"),
        # Truy vấn nóng: lấy chuỗi nến của một mã trong một khoảng thời gian.
        Index("ix_ohlcv_symbol_date", "symbol", "trade_date"),
    )


class OhlcvBar(Base, IdMixin):
    """Nến của các khung **khác ngày**: 1m, 5m, 15m, 30m, 1h.

    Vì sao không nhập chung vào `ohlcv_daily`: bảng đó là nguồn sự thật của chiến lược, backtest
    và phân tích AI, khoá bởi `UNIQUE(symbol, trade_date)`. Nhét nến trong ngày vào đó là phá
    chính ràng buộc đang giữ cho mỗi lần chạy chiến lược đọc đúng một nến mỗi phiên.

    Khung suy ra (3m, 2h, 4h, 1W, 1M) **không** có dòng nào ở đây — chúng được gộp lúc đọc, xem
    `app.services.market_data.timeframes`.
    """

    __tablename__ = "ohlcv_bars"

    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    #: Mã khung theo `timeframes.TIMEFRAMES` — "1m", "5m", "15m", "30m", "1h".
    timeframe: Mapped[str] = mapped_column(String(8), nullable=False)
    #: Mốc **mở** nến, lưu ở UTC theo BR-130. Nến 09:15 giờ Việt Nam nằm ở 02:15 UTC.
    ts: Mapped[datetime] = mapped_column(DateTime, nullable=False)

    open: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    high: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    low: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    close: Mapped[Decimal] = mapped_column(Numeric(18, 4), nullable=False)
    volume: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    source: Mapped[str] = mapped_column(String(30), nullable=False, default="VPS")

    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", "ts", name="uq_ohlcv_bar"),
        # Truy vấn nóng: chuỗi nến của một mã ở một khung, mới nhất trước.
        Index("ix_ohlcv_bar_symbol_tf_ts", "symbol", "timeframe", "ts"),
        # Dọn dữ liệu quá hạn chạy `DELETE ... WHERE timeframe = ? AND ts < ?` — không có index
        # này thì mỗi lần dọn là một lần quét toàn bảng hàng chục triệu dòng.
        Index("ix_ohlcv_bar_tf_ts", "timeframe", "ts"),
    )


class SymbolTimeframeSync(Base, IdMixin):
    """Mốc đồng bộ gần nhất của từng cặp (mã, khung).

    Tách khỏi `symbols.last_ohlcv_date` vì một mã bây giờ có nhiều mốc chứ không còn một: khung
    1 phút có thể đứng từ hôm qua trong khi khung 1 giờ vẫn mới. Gộp tất cả vào một cột thì màn
    vận hành không còn phân biệt được khung nào đang thiếu.

    `last_error` giữ lại lỗi gần nhất: một mã im lặng không có dữ liệu và một mã bị nguồn từ chối
    trông giống hệt nhau trên bảng đếm, và đó là kiểu hỏng lặng lẽ nhất của cả phần dữ liệu.
    """

    __tablename__ = "symbol_timeframe_sync"

    symbol: Mapped[str] = mapped_column(String(20), nullable=False)
    timeframe: Mapped[str] = mapped_column(String(8), nullable=False)

    last_ts: Mapped[datetime | None] = mapped_column(DateTime)
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(String(255))

    __table_args__ = (
        UniqueConstraint("symbol", "timeframe", name="uq_symbol_timeframe_sync"),
    )


class CorporateAction(Base, IdMixin, CreatedAtMixin):
    """BR-834 — chia tách, thưởng cổ phiếu, cổ tức tiền mặt đều làm gãy chuỗi giá.

    Không điều chỉnh thì biểu đồ lịch sử và toàn bộ tín hiệu backtest sẽ sai.
    """

    __tablename__ = "corporate_actions"

    symbol: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    ex_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    action_type: Mapped[str] = mapped_column(String(30), nullable=False)  # CASH_DIV|STOCK_DIV|SPLIT
    #: Hệ số nhân áp lên giá trước ngày giao dịch không hưởng quyền.
    ratio: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    cash_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    note: Mapped[str | None] = mapped_column(String(255))

    __table_args__ = (
        UniqueConstraint("symbol", "ex_date", "action_type", name="uq_corp_action"),
    )


class MarketSyncLog(Base, IdMixin, CreatedAtMixin):
    """BR-835 — nhật ký kiểm tra chất lượng dữ liệu hằng ngày.

    Dữ liệu sai âm thầm nguy hiểm hơn dữ liệu không có.
    """

    __tablename__ = "market_sync_logs"

    run_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    symbols_total: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    symbols_synced: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    symbols_failed: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_written: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Danh sách bất thường phát hiện được: giá bằng 0, khối lượng âm, ngày trùng…
    anomalies: Mapped[dict | None] = mapped_column(nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
