"""Chiến lược, biểu đồ điểm mua/bán và hỏi đáp — Customer Site (Phần 13, 14)."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select

from app.core.constants import (
    DISCLAIMER_TEXT,
    QuestionStatus,
    SignalType,
    StrategyStatus,
)
from app.core.datetime_utils import utcnow
from app.core.deps import ActiveUser, DbSession
from app.core.exceptions import Forbidden, NotFound
from app.core.pagination import PageParams, build_page, count_of, page_params, paginate_page
from app.models.staff import Staff
from app.models.strategy import (
    Signal,
    Strategy,
    StrategyFaq,
    StrategyQuestion,
    StrategySymbol,
)
from app.schemas.common import Message, PageResponse
from app.schemas.domain import (
    MarkerResponse,
    QuestionCreateRequest,
    QuestionOut,
    SignalOut,
    StrategyDetail,
    StrategyListItem,
)
from app.services import (
    signal_service,
    staff_notify,
    strategy_run_service,
    subscription_service,
)

router = APIRouter(prefix="/strategies", tags=["customer-strategies"])

Pagination = Annotated[PageParams, Depends(page_params)]

#: BR-857 — cam kết trả lời trong 24 giờ làm việc.
SLA_HOURS = 24


def _symbols_of(db, strategy_id: int) -> list[str]:
    return list(
        db.scalars(
            select(StrategySymbol.symbol)
            .where(StrategySymbol.strategy_id == strategy_id)
            .order_by(StrategySymbol.symbol)
        ).all()
    )


def _symbols_by_strategy(db, strategy_ids: list[int]) -> dict[int, list[str]]:
    """Phạm vi mã của nhiều chiến lược trong một truy vấn — dùng cho màn danh sách."""
    if not strategy_ids:
        return {}
    result: dict[int, list[str]] = {sid: [] for sid in strategy_ids}
    rows = db.execute(
        select(StrategySymbol.strategy_id, StrategySymbol.symbol)
        .where(StrategySymbol.strategy_id.in_(strategy_ids))
        .order_by(StrategySymbol.strategy_id, StrategySymbol.symbol)
    ).all()
    for strategy_id, symbol in rows:
        result[strategy_id].append(symbol)
    return result


@router.get("", response_model=dict)
def list_strategies(user: ActiveUser, db: DbSession, params: Pagination,
                    school: str | None = None,
                    q: str | None = Query(default=None, max_length=100)) -> dict:
    """Mục 13.2 bước 1 — danh sách kèm thẻ thống kê.

    Phân trang ở máy chủ chứ không cắt ở trình duyệt: mỗi chiến lược trong danh sách phải chạy hai
    truy vấn thống kê (LIVE và BACKTEST). Trả về cả trăm chiến lược để rồi chỉ hiện mười cái là
    tính thừa gần hết.
    """
    stmt = select(Strategy).where(
        Strategy.status == StrategyStatus.ACTIVE,
        Strategy.is_public.is_(True),
    )
    if school:
        stmt = stmt.where(Strategy.school == school)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(Strategy.name.like(pattern), Strategy.description.like(pattern)))
    stmt = stmt.order_by(Strategy.name)

    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    # Ba lượt đọc gộp cho cả trang thay vì bốn lượt cho mỗi dòng.
    ids = [s.id for s in rows]
    symbols = _symbols_by_strategy(db, ids)
    stats = signal_service.compute_stats_bulk(db, ids)
    allowed = subscription_service.package_gate(db, user)

    result: list[StrategyListItem] = []
    for strategy in rows:
        item = StrategyListItem.model_validate(strategy)
        item.symbols = symbols.get(strategy.id, [])
        # BR-847 — chiến lược cao cấp chỉ hiện đầy đủ với gói dài hạn.
        item.locked = not allowed(strategy.min_package_id)
        # BR-841 — hai loại thống kê luôn tách riêng, không bao giờ gộp.
        item.stats_live = stats[(strategy.id, SignalType.LIVE)].as_dict()
        item.stats_backtest = stats[(strategy.id, SignalType.BACKTEST)].as_dict()
        result.append(item)
    return build_page(result, total, params)


def _require_strategy_access(db, user, strategy_id: int) -> Strategy:
    strategy = db.get(Strategy, strategy_id)
    if not strategy or strategy.status != StrategyStatus.ACTIVE:
        raise NotFound("Chiến lược không tồn tại")
    if not subscription_service.can_access_min_package(db, user, strategy.min_package_id):
        raise Forbidden(
            "Chiến lược này thuộc gói cao hơn gói hiện tại của bạn.",
            "PACKAGE_TOO_LOW",
            {"min_package_id": strategy.min_package_id},
        )
    return strategy


@router.get("/{strategy_id}", response_model=StrategyDetail)
def get_strategy(strategy_id: int, user: ActiveUser, db: DbSession) -> StrategyDetail:
    strategy = _require_strategy_access(db, user, strategy_id)
    detail = StrategyDetail.model_validate(strategy)
    detail.symbols = _symbols_of(db, strategy.id)

    # YC11 / BR-848 — quy tắc bên trong chiến lược của hệ thống là chất xám của công ty.
    # Khách hàng nhận kết quả (tín hiệu, điểm mua/bán, thống kê) chứ không nhận công thức.
    # Che ở tầng API chứ không chỉ ẩn trên giao diện: giấu ngoài màn hình mà API vẫn trả thì
    # chỉ cần mở tab mạng của trình duyệt là đọc được.
    detail.rules_summary = None

    detail.stats_live = signal_service.compute_stats(
        db, strategy.id, signal_type=SignalType.LIVE
    ).as_dict()
    detail.stats_backtest = signal_service.compute_stats(
        db, strategy.id, signal_type=SignalType.BACKTEST
    ).as_dict()
    return detail


@router.post("/{strategy_id}/run", response_model=dict)
def run_strategy_on_symbol(
    strategy_id: int,
    user: ActiveUser,
    db: DbSession,
    symbol: str = Query(min_length=1, max_length=20),
    from_date: date | None = None,
) -> dict:
    """YC12 — áp chiến lược của hệ thống lên một mã bất kỳ để khách tự đánh giá.

    Đây là chỗ khách hàng thấy được giá trị của chiến lược một cách khách quan: điểm mua, điểm
    bán, lãi lỗ từng lệnh trên chính mã họ quan tâm. `reveal_rules=False` — trả kết quả, không
    trả công thức (BR-848).
    """
    strategy = _require_strategy_access(db, user, strategy_id)
    return strategy_run_service.run_strategy(
        db, strategy, symbol, reveal_rules=False, from_date=from_date
    )


@router.get("/{strategy_id}/markers", response_model=MarkerResponse)
def get_markers(
    strategy_id: int,
    symbol: str,
    user: ActiveUser,
    db: DbSession,
    signal_type: str | None = Query(default=None, description="LIVE | BACKTEST | bỏ trống = cả hai"),
    date_from: date | None = None,
    date_to: date | None = None,
) -> MarkerResponse:
    """Mục 13.2 bước 3 — dữ liệu vẽ marker mua/bán lên biểu đồ.

    BR-843 — mặc định là **toàn bộ lịch sử**; chỉ lọc khi người dùng chủ động chọn khoảng.
    """
    _require_strategy_access(db, user, strategy_id)
    data = signal_service.get_markers(
        db, strategy_id, symbol, signal_type=signal_type, date_from=date_from, date_to=date_to
    )
    return MarkerResponse(
        total=data["total"],
        returned=data["returned"],
        truncated=data["truncated"],
        max_markers=data["max_markers"],
        signals=[SignalOut.model_validate(s) for s in data["signals"]],
        disclaimer=DISCLAIMER_TEXT,
    )


@router.get("/{strategy_id}/signals", response_model=PageResponse[SignalOut])
def list_signals(
    strategy_id: int,
    user: ActiveUser,
    db: DbSession,
    params: Pagination,
    symbol: str | None = None,
    signal_type: str | None = None,
) -> dict:
    """Mục 13.2 bước 5 — bảng danh sách lệnh liên kết hai chiều với biểu đồ."""
    _require_strategy_access(db, user, strategy_id)

    stmt = select(Signal).where(Signal.strategy_id == strategy_id)
    if symbol:
        stmt = stmt.where(Signal.symbol == symbol.upper())
    if signal_type:
        stmt = stmt.where(Signal.signal_type == signal_type)
    stmt = stmt.order_by(Signal.entry_time.desc())

    return paginate_page(db, stmt, params, SignalOut.model_validate)


@router.get("/{strategy_id}/stats", response_model=dict)
def get_stats(
    strategy_id: int,
    user: ActiveUser,
    db: DbSession,
    symbol: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
) -> dict:
    """BR-843 — luôn trả kèm khoảng thời gian được tính, và tách LIVE/BACKTEST."""
    _require_strategy_access(db, user, strategy_id)
    return {
        "live": signal_service.compute_stats(
            db, strategy_id, symbol=symbol, signal_type=SignalType.LIVE,
            period_from=date_from, period_to=date_to,
        ).as_dict(),
        "backtest": signal_service.compute_stats(
            db, strategy_id, symbol=symbol, signal_type=SignalType.BACKTEST,
            period_from=date_from, period_to=date_to,
        ).as_dict(),
        "note": (
            "Thống kê tín hiệu thực (LIVE) và tín hiệu mô phỏng (BACKTEST) được tính riêng "
            "và không bao giờ gộp chung."
        ),
        "disclaimer": DISCLAIMER_TEXT,
    }


# ======================================================================
# HỎI ĐÁP — mô hình A (Phần 14)
# ======================================================================
@router.post("/{strategy_id}/questions", response_model=QuestionOut, status_code=201)
def ask_question(
    strategy_id: int, payload: QuestionCreateRequest, user: ActiveUser, db: DbSession
) -> QuestionOut:
    """Mục 14.2 mô hình A — câu hỏi gắn với `strategy_id`, tuỳ chọn gắn `signal_id`."""
    strategy = _require_strategy_access(db, user, strategy_id)

    question = StrategyQuestion(
        strategy_id=strategy_id,
        signal_id=payload.signal_id,
        user_id=user.id,
        question=payload.question.strip(),
        is_private=True,  # BR-850 — mặc định riêng tư
        status=QuestionStatus.PENDING,
        sla_due_at=utcnow() + timedelta(hours=SLA_HOURS),
        assigned_to=strategy.analyst_id,  # tự phân cho analyst phụ trách chiến lược
    )
    db.add(question)
    db.flush()

    # YC17 — người trực trang quản trị phải biết ngay, không phải ngồi bấm làm mới.
    #
    # Gửi cho **cả nhóm có quyền trả lời**, không chỉ analyst được phân công. Nếu chỉ gửi đích
    # danh, analyst nghỉ phép là câu hỏi nằm im tới lúc quá hạn mà không ai biết — trong khi
    # BR-857 buộc phải theo dõi được số câu quá hạn ở cấp đội.
    assignee = db.get(Staff, strategy.analyst_id) if strategy.analyst_id else None
    staff_notify.notify_staff(
        db,
        code=staff_notify.StaffNotifyCode.NEW_QUESTION,
        title=f"Câu hỏi mới về {strategy.name}",
        body=(
            payload.question.strip()[:160]
            + (
                f"\n\nPhụ trách: {assignee.full_name}"
                if assignee
                else "\n\nChưa phân công người trả lời"
            )
        ),
        link=f"/admin/questions?highlight={question.id}",
        level="info",
        staff_id=None,
        required_permission="qa.answer",
    )
    db.commit()
    return QuestionOut.model_validate(question)


@router.get("/{strategy_id}/questions", response_model=dict)
def my_questions(strategy_id: int, user: ActiveUser, db: DbSession, params: Pagination) -> dict:
    """BR-850 — chỉ trả về câu hỏi của **chính KH đó**. Cách ly tuyệt đối giữa các khách."""
    stmt = (
        select(StrategyQuestion)
        .where(
            StrategyQuestion.strategy_id == strategy_id,
            StrategyQuestion.user_id == user.id,
        )
        .order_by(StrategyQuestion.id.desc())
    )
    return paginate_page(db, stmt, params, QuestionOut.model_validate)


# Tài liệu của chiến lược hệ thống **không có endpoint nào ở đây**, và đó là chủ ý.
#
# Đó là tài liệu nội bộ nhân viên tải lên làm căn cứ cho AI đọc khi phân tích — chất xám
# công ty (BR-848), khách nhận kết quả chứ không nhận tài liệu nguồn. Chỉ ẩn nút trên giao
# diện là không đủ: còn endpoint thì mở tab mạng là lấy được danh sách, và từ đó là phiếu tải.
#
# Tài liệu của chiến lược **cá nhân** là chuyện khác hẳn — của chính khách, phục vụ ở
# `my_strategies.py::list_strategy_documents`.


@router.get("/{strategy_id}/faq", response_model=dict)
def strategy_faq(strategy_id: int, user: ActiveUser, db: DbSession, params: Pagination) -> dict:
    """FAQ công khai — đã được duyệt (BR-858) và **ẩn danh người hỏi** (BR-850)."""
    _require_strategy_access(db, user, strategy_id)
    stmt = (
        select(StrategyFaq)
        .where(StrategyFaq.strategy_id == strategy_id)
        .order_by(StrategyFaq.sort_order, StrategyFaq.id)
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    items = [
        {
            "id": r.id,
            "question": r.question,
            "answer": r.answer,
            "view_count": r.view_count,
        }
        for r in rows
    ]
    return build_page(items, total, params)


@router.post("/questions/{question_id}/helpful", response_model=Message)
def mark_helpful(question_id: int, user: ActiveUser, db: DbSession) -> Message:
    """Mục 14.2 bước 5 — KH xếp hạng FAQ."""
    question = db.get(StrategyQuestion, question_id)
    if not question or not question.is_public:
        raise NotFound("Câu hỏi không tồn tại")
    question.helpful_count = (question.helpful_count or 0) + 1
    db.commit()
    return Message(message="Cảm ơn phản hồi của bạn")
