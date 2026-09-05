"""Phân tích theo yêu cầu — nghiệp vụ dùng chung cho API khách hàng, worker và MCP server.

Ba việc khó nằm hết ở đây, và cả ba đều là chuyện đồng thời:

**Không chạy trùng.** Nhiều khách bấm cùng lúc trên cùng một cặp (chiến lược, mã) thì đúng một
lượt chạy được khởi động. Chốt chặn là ràng buộc `uq_symbol_analysis_day` ở CSDL chứ không phải
một phép kiểm tra trong mã: kiểm tra "đã có chưa" rồi mới chèn là khoảng trống kinh điển giữa hai
tiến trình. Ở đây cứ chèn, ai thua thì đọc lại dòng của người thắng.

**Không trừ lượt oan.** Chỉ lượt bấm thực sự khởi động một mẻ AI mới mới ghi vào
`analysis_quota_usage`. Người bấm sau đọc bản đã có — miễn phí. Chiến lược loại RULE chạy bộ điều
kiện tại chỗ — cũng miễn phí.

**Không để việc treo.** Trạng thái đi một chiều `QUEUED → RUNNING → DONE|FAILED`, và bước
`QUEUED → RUNNING` là một `UPDATE ... WHERE status = 'QUEUED'` có điều kiện. Hai worker cùng nhặt
một việc thì chỉ một cái đổi được trạng thái; cái còn lại thấy 0 dòng bị ảnh hưởng và bỏ qua.
"""

from __future__ import annotations

import logging
from datetime import date
from decimal import Decimal, InvalidOperation

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import (
    AnalysisConfidence,
    AnalysisSource,
    SignalDirection,
    StrategyKind,
    SymbolAnalysisStatus,
)
from app.core.datetime_utils import as_utc, local_today, utcnow
from app.core.exceptions import Conflict, NotFound, TooManyRequests, ValidationError
from app.models.analysis import AnalysisQuotaUsage, SymbolAnalysis, SymbolAnalysisSetup
from app.models.market import OhlcvDaily
from app.models.strategy import Strategy, StrategySymbol
from app.services import html_sanitizer

log = logging.getLogger(__name__)


# ======================================================================
# Hạn mức
# ======================================================================
def quota_used(db: Session, user_id: int, day: date | None = None) -> int:
    """Số lượt chạy AI mà tài khoản này đã tiêu trong ngày."""
    return int(
        db.scalar(
            select(func.count())
            .select_from(AnalysisQuotaUsage)
            .where(
                AnalysisQuotaUsage.user_id == user_id,
                AnalysisQuotaUsage.usage_date == (day or local_today()),
            )
        )
        or 0
    )


def quota_state(db: Session, user_id: int, day: date | None = None) -> dict:
    used = quota_used(db, user_id, day)
    limit = settings.analysis_daily_quota
    return {"used": used, "limit": limit, "remaining": max(limit - used, 0)}


# ======================================================================
# Nguồn phân tích
# ======================================================================
def source_for(strategy: Strategy) -> str:
    """Chiến lược loại DOCUMENT thì gọi AI, loại RULE thì chạy bộ điều kiện tại chỗ.

    Đọc thẳng `strategy.kind` chứ không đoán theo "có tài liệu không / có rules_json không" như
    cơ chế cũ. Người tạo chiến lược chọn loại ngay lúc tạo, nên nhìn vào là biết bấm Phân tích
    sẽ chạy cái gì — không còn chuyện gắn thêm một file rồi chiến lược lặng lẽ đổi cách chạy.
    """
    return AnalysisSource.AI if strategy.kind == StrategyKind.DOCUMENT else AnalysisSource.ENGINE


def _assert_symbol_in_scope(db: Session, strategy: Strategy, symbol: str) -> None:
    """BR-860c — chỉ phân tích mã nằm trong phạm vi của chiến lược."""
    exists = db.scalar(
        select(StrategySymbol.id).where(
            StrategySymbol.strategy_id == strategy.id, StrategySymbol.symbol == symbol
        )
    )
    if not exists:
        raise ValidationError(
            f"Mã {symbol} không nằm trong phạm vi của chiến lược này", {"field": "symbol"}
        )


def _assert_has_candles(db: Session, symbol: str) -> None:
    """Không có nến thì không có gì để phân tích — nói ngay thay vì để mô hình bịa."""
    has = db.scalar(select(OhlcvDaily.id).where(OhlcvDaily.symbol == symbol).limit(1))
    if not has:
        raise ValidationError(
            f"Chưa có dữ liệu giá của mã {symbol} để phân tích", {"field": "symbol"}
        )


# ======================================================================
# Nhận yêu cầu
# ======================================================================
def request_analysis(
    db: Session, *, user_id: int, strategy: Strategy, symbol: str
) -> tuple[SymbolAnalysis, bool]:
    """Trả `(bản phân tích, có khởi động lượt chạy mới không)`.

    Không bao giờ ném lỗi vì "người khác đang chạy": đó là trạng thái bình thường và người gọi
    chỉ cần chờ. Chỉ ném khi hết hạn mức, mã ngoài phạm vi, hoặc mã chưa có giá.
    """
    symbol = (symbol or "").strip().upper()
    if not symbol:
        raise ValidationError("Chưa chọn mã để phân tích", {"field": "symbol"})

    _assert_symbol_in_scope(db, strategy, symbol)
    _assert_has_candles(db, symbol)

    day = local_today()
    source = source_for(strategy)

    existing = _find(db, day, strategy.id, symbol)
    if existing:
        return _touch(db, existing), False

    # Hạn mức xét **trước** khi chèn: chèn xong mới phát hiện hết lượt thì phải xoá lại, và giữa
    # hai bước đó worker có thể đã nhặt việc đi chạy.
    if source == AnalysisSource.AI:
        state = quota_state(db, user_id, day)
        if state["remaining"] <= 0:
            raise TooManyRequests(
                f"Bạn đã dùng hết {state['limit']} lượt phân tích của hôm nay. "
                "Hạn mức đặt lại vào đầu ngày hôm sau.",
                "ANALYSIS_QUOTA_EXCEEDED",
            )

    item = SymbolAnalysis(
        analysis_date=day,
        strategy_id=strategy.id,
        symbol=symbol,
        source=source,
        status=SymbolAnalysisStatus.QUEUED,
        requested_by=user_id,
        view_count=1,
    )
    try:
        # `begin_nested` để `IntegrityError` chỉ huỷ đúng lệnh chèn này. Không có nó thì cả
        # transaction của request bị đánh dấu hỏng và mọi truy vấn sau đều lỗi.
        with db.begin_nested():
            db.add(item)
            db.flush()
    except IntegrityError:
        # Người khác vừa chèn xong giữa lúc ta kiểm tra và lúc ta chèn. Đây là đường đi bình
        # thường của mục 1.4, không phải lỗi: đọc lại dòng của họ và chờ cùng mọi người.
        existing = _find(db, day, strategy.id, symbol)
        if not existing:  # pragma: no cover — ràng buộc khác vỡ, không phải khoá trùng
            raise
        return _touch(db, existing), False

    if source == AnalysisSource.AI:
        db.add(AnalysisQuotaUsage(user_id=user_id, usage_date=day, analysis_id=item.id))
    db.flush()
    return item, True


def _find(db: Session, day: date, strategy_id: int, symbol: str) -> SymbolAnalysis | None:
    return db.scalar(
        select(SymbolAnalysis).where(
            SymbolAnalysis.analysis_date == day,
            SymbolAnalysis.strategy_id == strategy_id,
            SymbolAnalysis.symbol == symbol,
        )
    )


def _touch(db: Session, item: SymbolAnalysis) -> SymbolAnalysis:
    """Đếm lượt mở. Cộng bằng biểu thức SQL để hai người mở cùng lúc không đè số của nhau."""
    db.execute(
        update(SymbolAnalysis)
        .where(SymbolAnalysis.id == item.id)
        .values(view_count=SymbolAnalysis.view_count + 1)
    )
    db.flush()
    db.refresh(item)
    return item


def find_for(db: Session, strategy_id: int, symbol: str, day: date | None = None):
    """Bản phân tích của một ngày cho cặp này, hoặc None. Không tạo mới, không đếm lượt.

    `day` để trống là hôm nay. Truyền một ngày quá khứ vào đây là cách khách xem lại bản cũ:
    khoá `(analysis_date, strategy_id, symbol)` giữ mỗi ngày một bản, nên bản của hôm qua vẫn
    nằm nguyên đó sau khi hôm nay có bản mới — chỉ là trước đây không có đường nào đọc tới.
    """
    return _find(db, day or local_today(), strategy_id, (symbol or "").strip().upper())


def history_for(
    db: Session, strategy_id: int, symbol: str, limit: int = 30
) -> list[SymbolAnalysis]:
    """Các bản **đã xong** của cặp này, ngày mới nhất trước — để khách chọn ngày xem lại.

    Chỉ lấy `DONE`: một ngày chạy hỏng hay đang chạy dở không phải một bản để đọc lại, và đưa
    nó vào danh sách chọn ngày chỉ tạo ra những mục bấm vào thì rỗng. Bản của hôm nay vẫn nằm
    trong danh sách này ngay khi chạy xong — nó là bản mới nhất, không phải một trường hợp riêng.
    """
    symbol = (symbol or "").strip().upper()
    if not symbol:
        return []
    return list(
        db.scalars(
            select(SymbolAnalysis)
            .where(
                SymbolAnalysis.strategy_id == strategy_id,
                SymbolAnalysis.symbol == symbol,
                SymbolAnalysis.status == SymbolAnalysisStatus.DONE,
            )
            .order_by(SymbolAnalysis.analysis_date.desc())
            .limit(limit)
        ).all()
    )


# ======================================================================
# Vòng đời của một lượt chạy
# ======================================================================
def claim(db: Session, analysis_id: int) -> bool:
    """QUEUED → RUNNING. Trả False khi worker khác đã nhặt việc này.

    Điều kiện `status == QUEUED` nằm trong chính câu `UPDATE` — đó là thứ khiến hai worker không
    thể cùng chạy một việc. Kiểm tra bằng `SELECT` rồi mới `UPDATE` sẽ để lọt.
    """
    affected = db.execute(
        update(SymbolAnalysis)
        .where(
            SymbolAnalysis.id == analysis_id,
            SymbolAnalysis.status == SymbolAnalysisStatus.QUEUED,
        )
        .values(status=SymbolAnalysisStatus.RUNNING, started_at=utcnow())
    ).rowcount
    db.flush()
    return bool(affected)


def _to_decimal(value, field: str) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValidationError(
            f"Giá trị không hợp lệ cho {field}: {value!r}", {"field": field}
        ) from exc


def validate_setup(direction: str, entry: Decimal | None, sl: Decimal | None,
                   tp: Decimal | None) -> None:
    """Kịch bản vào lệnh phải đọc được: cắt lỗ và chốt lời nằm đúng phía của giá vào.

    Kiểm ngay lúc mô hình ghi kết quả, không để lọt xuống giao diện: một thẻ "MUA, vào 20, cắt lỗ
    25, chốt lời 18" không phải là dữ liệu thiếu — nó là lời khuyên ngược, và khách không có cách
    nào biết đó là lỗi máy.
    """
    if direction not in (SignalDirection.BUY, SignalDirection.SELL):
        raise ValidationError("Chiều lệnh phải là BUY hoặc SELL", {"field": "direction"})
    if entry is None or entry <= 0:
        raise ValidationError("Giá vào phải lớn hơn 0", {"field": "entry_price"})
    if sl is not None and tp is not None:
        if direction == SignalDirection.BUY and not (sl < entry < tp):
            raise ValidationError("Kịch bản MUA phải có: cắt lỗ < giá vào < chốt lời",
                                  {"field": "sl"})
        if direction == SignalDirection.SELL and not (tp < entry < sl):
            raise ValidationError("Kịch bản BÁN phải có: chốt lời < giá vào < cắt lỗ",
                                  {"field": "sl"})


#: Thứ tự để so độ tin cậy. Không khai thì xếp dưới cùng: mô hình bỏ trống `confidence` là nó
#: không dám chấm, và một kịch bản có chấm LOW vẫn hơn một kịch bản không chấm gì.
_CONFIDENCE_RANK = {
    AnalysisConfidence.HIGH: 3,
    AnalysisConfidence.MEDIUM: 2,
    AnalysisConfidence.LOW: 1,
}


def _best_per_direction(rows: list[SymbolAnalysisSetup]) -> list[SymbolAnalysisSetup]:
    """Giữ lại mỗi chiều đúng một kịch bản — cái có độ tin cậy cao nhất.

    Chỉ áp cho phân tích theo biểu đồ ở màn bảng giá. Người dùng ở đó đang nhìn một mã và hỏi
    một câu dứt khoát; trả về bốn thẻ lệnh chỉ lệch nhau vài giá là đẩy phần chọn ngược lại cho
    chính người vừa hỏi. Bên chiến lược thì **không** cắt: tài liệu có thể mô tả nhiều lối vào
    khác hẳn nhau và bỏ bớt là bỏ mất nội dung của chính chiến lược đó.

    Cắt ở đây chứ không báo lỗi về cho mô hình: lời nhắc đã dặn rõ tối đa hai cái, nên gửi dư
    là chuyện hiếm — không đáng để vứt cả bản phân tích đã chạy xong và bắt khách đợi thêm một
    lượt model. Bằng điểm thì lấy cái đứng trước: mô hình liệt kê cái nó tin nhất lên đầu.
    """
    best: dict[str, SymbolAnalysisSetup] = {}
    for row in rows:
        current = best.get(row.direction)
        if current is None or _CONFIDENCE_RANK.get(row.confidence, 0) > _CONFIDENCE_RANK.get(
            current.confidence, 0
        ):
            best[row.direction] = row
    # Giữ nguyên thứ tự mô hình đưa ra thay vì sắp lại theo chiều.
    return [row for row in rows if best.get(row.direction) is row]


def save_result(
    db: Session,
    analysis_id: int,
    *,
    title: str | None = None,
    summary: str | None = None,
    rationale: str | None = None,
    setups: list[dict] | None = None,
    evidence=None,
) -> SymbolAnalysis:
    """Ghi kết quả và chuyển bản phân tích sang DONE.

    `setups` là danh sách kịch bản vào lệnh — **cả chiều mua lẫn chiều bán nếu có**. Danh sách
    rỗng cũng là kết quả hợp lệ: phiên không có điểm vào là một câu trả lời, không phải lỗi.

    Phân tích theo biểu đồ (`strategy_id` rỗng) bị cắt còn **tối đa một kịch bản mỗi chiều** — xem
    `_best_per_direction`. Phân tích theo chiến lược giữ nguyên toàn bộ danh sách.
    """
    item = db.get(SymbolAnalysis, analysis_id)
    if not item:
        raise NotFound(f"Không tìm thấy bản phân tích #{analysis_id}")
    if item.status == SymbolAnalysisStatus.DONE:
        raise Conflict(f"Bản phân tích #{analysis_id} đã có kết quả", "ANALYSIS_ALREADY_DONE")

    rows: list[SymbolAnalysisSetup] = []
    for raw in setups or []:
        direction = str(raw.get("direction") or "").strip().upper()
        entry = _to_decimal(raw.get("entry_price"), "entry_price")
        sl = _to_decimal(raw.get("sl"), "sl")
        tp = _to_decimal(raw.get("tp"), "tp")
        validate_setup(direction, entry, sl, tp)

        confidence = (raw.get("confidence") or "").strip().upper() or None
        if confidence and confidence not in tuple(AnalysisConfidence):
            raise ValidationError(
                "Độ tin cậy phải là LOW, MEDIUM hoặc HIGH", {"field": "confidence"}
            )
        rows.append(
            SymbolAnalysisSetup(
                direction=direction,
                entry_price=entry,
                sl=sl,
                tp=tp,
                confidence=confidence,
                note=(raw.get("note") or None),
            )
        )

    if item.strategy_id is None:
        rows = _best_per_direction(rows)

    # Ghi qua chính quan hệ `item.setups` chứ không `db.add` rời: bộ sưu tập đã nạp trên
    # `item` sẽ không tự thấy các dòng thêm bên ngoài, nên tầng gọi đọc `item.setups` ngay sau
    # đó vẫn nhận danh sách rỗng — và API trả về một bản phân tích không có kịch bản nào.
    #
    # `clear()` dựa vào `delete-orphan` ở quan hệ để xoá kịch bản của lượt chạy trước (hiếm,
    # nhưng có khi worker bị giết giữa chừng rồi việc được nhặt lại).
    item.setups.clear()
    db.flush()
    item.setups.extend(rows)

    item.title = (title or "").strip()[:255] or None
    # Bản tin này render bằng `dangerouslySetInnerHTML` phía khách. Lọc ở máy chủ **lúc lưu**:
    # lọc lúc hiển thị chỉ bảo vệ người chạy đúng mã của mình, ai gọi thẳng API vẫn nhận HTML gốc.
    item.summary = html_sanitizer.sanitize_html(summary) or None
    item.rationale = rationale or None
    item.evidence = _jsonable(evidence)
    item.status = SymbolAnalysisStatus.DONE
    item.completed_at = utcnow()
    item.error_message = None
    if item.started_at:
        # `as_utc` bắt buộc: cột là DATETIME không tz, nên MySQL trả `started_at` về dạng naive.
        # Tiến trình MCP đọc lại dòng này từ CSDL ở một phiên khác hẳn phiên đã ghi `started_at`,
        # nên nó luôn nhận bản naive — trừ đi `utcnow()` (aware) là ném TypeError, và toàn bộ
        # kết quả AI mất trắng ngay ở bước ghi cuối cùng.
        item.duration_seconds = max(
            int((item.completed_at - as_utc(item.started_at)).total_seconds()), 0
        )
    db.flush()
    return item


def fail(db: Session, analysis_id: int, reason: str) -> SymbolAnalysis | None:
    """Đánh dấu FAILED kèm lý do đọc được.

    Không xoá dòng: xoá đi thì lượt bấm kế tiếp lại khởi động một mẻ nữa và tiêu thêm một lượt
    hạn mức cho cùng một lỗi. Giữ lại thì khách thấy đúng chuyện gì đã xảy ra, và
    `retry_failed` là đường đi có chủ đích chứ không phải tai nạn.
    """
    item = db.get(SymbolAnalysis, analysis_id)
    if not item or item.status == SymbolAnalysisStatus.DONE:
        return item
    item.status = SymbolAnalysisStatus.FAILED
    item.error_message = (reason or "")[:2000] or "Không rõ lý do"
    item.completed_at = utcnow()
    db.flush()
    return item


def reset_for_retry(db: Session, item: SymbolAnalysis) -> SymbolAnalysis:
    """Đưa một bản FAILED về QUEUED để chạy lại."""
    item.status = SymbolAnalysisStatus.QUEUED
    item.error_message = None
    item.started_at = None
    item.completed_at = None
    db.flush()
    return item


def _jsonable(value):
    """Cột JSON không nhận Decimal/date — chuẩn hoá trước khi lưu."""
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Decimal):
        return float(value)
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return value


# ======================================================================
# Nến cho mô hình đọc
# ======================================================================
def candles_csv(db: Session, symbol: str, limit: int | None = None) -> str:
    """N phiên gần nhất dưới dạng CSV gọn.

    CSV chứ không JSON: cùng dữ liệu, JSON tốn khoảng gấp ba số token vì lặp lại tên khoá ở từng
    dòng — và phần token tiết kiệm được ở đây là phần tài liệu chiến lược giữ lại được.
    """
    rows = db.scalars(
        select(OhlcvDaily)
        .where(OhlcvDaily.symbol == symbol.upper())
        .order_by(OhlcvDaily.trade_date.desc())
        .limit(limit or settings.ai_candles_per_symbol)
    ).all()
    lines = ["date,open,high,low,close,volume"]
    for row in reversed(rows):
        lines.append(
            f"{row.trade_date.isoformat()},{row.open},{row.high},{row.low},{row.close},{row.volume}"
        )
    return "\n".join(lines)
