"""Bảng giá và biểu đồ — Customer Site (F01, F02).

BR-832 — đọc từ cơ sở dữ liệu của mình, không gọi API nhà cung cấp ở đường đi của request.
BR-836 — luôn trả kèm `attribution` để giao diện ghi rõ nguồn dữ liệu.
"""

from __future__ import annotations

from datetime import date, datetime

from fastapi import APIRouter, Query

from app.api.market_common import ohlcv_payload, timeframe_list
from app.core.deps import ActiveUser, DbSession
from app.schemas.domain import PriceBoardItem, SymbolOut, TimeframeOut
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
    """Bảng giá — giá đang chạy khi có, giá cuối phiên khi không.

    Phần đầu phản hồi nói rõ **dữ liệu đang xem là loại nào**: `realtime`, `as_of`, `session` và
    `stale`. BR-836 — dán nhãn sai nguồn là nói sai với người đọc, và ở đây khoảng cách giữa hai
    loại là khoảng cách giữa "giá lúc này" và "giá hôm qua".
    """
    rows = market_data.get_price_board(db, symbols=symbols, exchange=exchange, limit=limit)
    status = market_data.quote_store.store.status()
    live = bool(status["enabled"]) and not status["stale"] and any(r.get("realtime") for r in rows)
    session = status["session"]

    return {
        "items": [PriceBoardItem.model_validate(r) for r in rows],
        "exchange": exchange.upper(),
        "attribution": market_data.attribution(),
        "realtime": live,
        # Tách khỏi `realtime`: cờ trên nói "dữ liệu **đang** chạy", cờ này nói "tính năng có bật
        # hay không". Giao diện cần cờ thứ hai để quyết định có mở kênh WebSocket — lúc mới vào
        # trang thì kho có thể chưa kịp đầy nhịp đầu tiên, và nếu nhìn vào `realtime` thì bảng
        # giá sẽ không bao giờ mở kênh để rồi không bao giờ chạy.
        "realtime_enabled": bool(status["enabled"]),
        "as_of": status["as_of"] if live else None,
        "session": session,
        "session_label": market_data.quote_store.SESSION_LABELS.get(session, session),
        "stale": bool(status["stale"]),
        "note": (
            # BR-833 — nguồn là endpoint công khai không có hợp đồng. Người đọc phải biết đây là
            # giá tham khảo trước khi họ dùng nó để quyết định điều gì.
            "Giá tham khảo, có thể lệch vài giây so với sở. Không dùng để đặt lệnh."
            if live else "Dữ liệu cuối phiên, không phải giá thời gian thực."
        ),
    }


@router.get("/timeframes", response_model=list[TimeframeOut])
def list_timeframes(user: ActiveUser) -> list[TimeframeOut]:
    """Các khung thời gian biểu đồ vẽ được — nguồn cho hàng nút 1m · 5m · … · 1M.

    Đọc từ máy chủ chứ không viết cứng trong giao diện: bỏ một khung khỏi danh mục mà hàng nút
    vẫn còn nó thì người dùng bấm vào và nhận biểu đồ trắng, không kèm lời giải thích nào.
    """
    return [TimeframeOut.model_validate(tf) for tf in timeframe_list()]


@router.get("/ohlcv", response_model=dict)
def ohlcv(
    symbol: str,
    user: ActiveUser,
    db: DbSession,
    resolution: str = Query(default="1D", description="1m · 3m · 5m · 15m · 30m · 1h · 2h · 4h · 1D · 1W · 1M"),
    date_from: date | None = None,
    date_to: date | None = None,
    before: datetime | None = Query(
        default=None,
        description="Chỉ lấy nến mở trước mốc này — dùng để cuộn ngược về quá khứ",
    ),
    limit: int = Query(default=400, ge=10, le=2000),
) -> dict:
    """Nến của một mã ở một khung thời gian — nguồn dữ liệu cho biểu đồ."""
    return ohlcv_payload(
        db, symbol, resolution,
        date_from=date_from, date_to=date_to, before=before, limit=limit,
    )

