"""Bảng giá và biểu đồ — Customer Site (F01, F02).

BR-832 — đọc từ cơ sở dữ liệu của mình, không gọi API nhà cung cấp ở đường đi của request.
BR-836 — luôn trả kèm `attribution` để giao diện ghi rõ nguồn dữ liệu.
"""

from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Query

from app.core.deps import ActiveUser, DbSession
from app.core.exceptions import NotFound
from app.schemas.domain import CandleOut, PriceBoardItem, SymbolOut
from app.services import market_data

router = APIRouter(prefix="/market", tags=["customer-market"])


@router.get("/symbols", response_model=list[SymbolOut])
def list_symbols(
    user: ActiveUser,
    db: DbSession,
    q: str | None = Query(default=None, max_length=50, description="Tìm theo mã hoặc tên công ty"),
    exchange: str | None = Query(default=None, description="HOSE | HNX | UPCOM"),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[SymbolOut]:
    """Tra cứu mã. Dùng cho ô tìm kiếm ở bảng giá và ô chọn mã khi tạo chiến lược."""
    rows = market_data.search_symbols(db, query=q, exchange=exchange, limit=limit)
    return [SymbolOut.model_validate(r) for r in rows]


@router.get("/symbols/codes", response_model=list[str])
def list_symbol_codes(
    user: ActiveUser,
    db: DbSession,
    exchange: str | None = Query(default=None, description="HOSE | HNX | UPCOM"),
) -> list[str]:
    """Chỉ danh sách mã, không kèm tên doanh nghiệp — cho nút chọn cả sàn hoặc cả danh mục.

    Cố ý không có tham số `limit`: xem `market_data.list_symbol_codes`.
    """
    return market_data.list_symbol_codes(db, exchange=exchange)


@router.get("/board", response_model=dict)
def price_board(
    user: ActiveUser,
    db: DbSession,
    symbols: list[str] | None = Query(default=None),
    exchange: str = Query(default="HOSE"),
    limit: int = Query(default=50, ge=1, le=200),
) -> dict:
    """Bảng giá phiên gần nhất.

    Chưa phải giá thời gian thực — mục 12.1 chấp nhận dữ liệu cuối ngày ở giai đoạn này, và
    phần lớn giá trị của hệ thống nằm ở nội dung phân tích chứ không ở tốc độ giá.
    """
    rows = market_data.get_price_board(db, symbols=symbols, exchange=exchange, limit=limit)
    return {
        "items": [PriceBoardItem.model_validate(r) for r in rows],
        "exchange": exchange.upper(),
        "attribution": market_data.attribution(),
        "realtime": False,
        "note": "Dữ liệu cuối phiên, không phải giá thời gian thực.",
    }


@router.get("/ohlcv", response_model=dict)
def ohlcv(
    symbol: str,
    user: ActiveUser,
    db: DbSession,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=400, ge=10, le=2000),
) -> dict:
    """Nến ngày của một mã — nguồn dữ liệu cho biểu đồ."""
    candles = market_data.get_candles(
        db, symbol, date_from=date_from, date_to=date_to, limit=limit
    )
    if not candles:
        raise NotFound(f"Chưa có dữ liệu giá cho mã {symbol.upper()}", "NO_PRICE_DATA")

    return {
        "symbol": symbol.upper(),
        "resolution": "D",
        "candles": [CandleOut.model_validate(c) for c in candles],
        "attribution": market_data.attribution(),
    }
