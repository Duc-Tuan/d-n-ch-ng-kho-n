"""Phần dựng dữ liệu biểu đồ dùng chung cho hai site.

Route `/market/ohlcv` **phải** tồn tại hai bản — một bên khách hàng, một bên quản trị — vì hai
site đọc hai cookie khác nhau (`cst_at` và `adm_at`), ký bằng hai secret khác nhau: nhân viên
trực trang quản trị gọi vào route khách hàng luôn nhận 401. Nhưng phần *dựng dữ liệu* thì không
có lý do gì khác nhau, và để nó nhân đôi là để hai biểu đồ trôi khỏi nhau ở lần sửa thứ ba —
lúc đó cùng một mã, cùng một khung, hai màn hình cho hai hình khác nhau.

Đặt ở `app/api/` chứ không ở tầng service vì nó dựng **hình dạng phản hồi HTTP** (khoá
`resolution`, `attribution`, `tz_offset_seconds`), và vì nó phải đi qua `CandleOut` — schema đó
là chỗ duy nhất ép giá `Decimal` thành số JSON thật, thứ mà thư viện biểu đồ bắt buộc phải có.
"""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.exceptions import NotFound, ValidationError
from app.schemas.domain import CandleOut
from app.services import market_data
from app.services.market_data import providers  # noqa: F401
from app.services.market_data.timeframes import Timeframe, UnknownTimeframe


def timeframe_list() -> list[dict]:
    """Danh mục khung thời gian cho hàng nút trên biểu đồ."""
    return [tf.as_dict() for tf in market_data.timeframes.TIMEFRAMES.values()]


def ohlcv_payload(
    db: Session,
    symbol: str,
    resolution: str,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    before: datetime | None = None,
    limit: int = 400,
) -> dict:
    """Chuỗi nến của một mã ở một khung, kèm mọi thứ giao diện cần để vẽ."""
    try:
        tf = market_data.timeframes.get(resolution)
    except UnknownTimeframe as exc:
        raise ValidationError(str(exc), {"field": "resolution"}) from exc

    candles = market_data.read_bars(
        db, symbol, tf.code,
        date_from=date_from, date_to=date_to, before=before, limit=limit,
    )

    if not candles:
        # Cuộn ngược tới hết lịch sử là chuyện bình thường, không phải lỗi: trả 404 ở đây làm
        # biểu đồ bật thông báo đỏ ngay giữa thao tác kéo chuột của người dùng.
        if before is not None or date_to is not None:
            return _payload(symbol, tf, [])
        raise NotFound(
            f"Chưa có dữ liệu giá khung {tf.label} cho mã {symbol.upper()}", "NO_PRICE_DATA"
        )

    return _payload(symbol, tf, [CandleOut.model_validate(c) for c in candles])


def _payload(symbol: str, tf: Timeframe, candles: list[CandleOut]) -> dict:
    return {
        "symbol": symbol.upper(),
        # Tên khoá cũ, giá trị mới. Giữ `resolution` để mọi thứ đang đọc nó không gãy.
        "resolution": tf.code,
        "timeframe": tf.as_dict(),
        # Thư viện biểu đồ vẽ nhãn thời gian theo UTC. Giao diện cộng số giây này vào để nến
        # 09:15 hiện đúng 09:15 giờ Việt Nam thay vì 02:15. Múi giờ nằm ở đây chứ không viết
        # cứng bên giao diện, để đổi thị trường sau này không phải sửa hai nơi.
        "tz_offset_seconds": _tz_offset_seconds(),
        "candles": candles,
        # BR-836 — ghi đúng nguồn của **chuỗi đang xem**. Nến trong ngày có thể đến từ một nguồn
        # khác nến ngày, và dán nhãn nguồn kia lên là nói sai với người đọc biểu đồ.
        "attribution": _attribution_for(tf),
    }


def _attribution_for(tf: Timeframe) -> str:
    base = market_data.timeframes.base_of(tf.code)
    if base.is_daily:
        return market_data.attribution()
    return market_data.attribution(market_data.providers.intraday_provider_name())


def _tz_offset_seconds() -> int:
    offset = datetime.now(settings.tz).utcoffset()
    return int(offset.total_seconds()) if offset else 0
