"""Nút Phân tích — Customer Site.

Một cặp (chiến lược, mã) chỉ được phân tích **một lần mỗi ngày**, và kết quả dùng chung cho mọi
khách hàng xem cặp đó. Ba endpoint:

* `GET  /analysis?strategy_id&symbol[&date]` — bản của hôm nay (hoặc của `date`), `null` nếu không có.
* `GET  /analysis/dates?strategy_id&symbol` — các ngày đã có bản để chọn xem lại.
* `POST /analysis?strategy_id&symbol`   — bấm nút. Trả bản đang chạy hoặc bản đã có.
* `GET  /analysis/quota`                — còn bao nhiêu lượt trong ngày.
* `GET|POST /analysis/market`           — phân tích theo biểu đồ ở màn bảng giá (xem `market_ai`).

Bản của mỗi ngày được giữ lại vĩnh viễn — khoá là `(analysis_date, strategy_id, symbol)` — nên
xem lại ngày cũ **không** tốn lượt và không chạy lại gì cả. Chỉ `POST` mới sinh việc, và luôn
sinh cho hôm nay: không có cách nào phân tích ngược một phiên đã đóng.

Giao diện gọi `POST` một lần rồi **hỏi lại** `GET` cho tới khi `status` rời khỏi QUEUED/RUNNING.
Không dùng WebSocket ở đây: một lượt kéo dài vài chục giây tới vài phút và người dùng đang mở
đúng màn hình đó, nên hỏi lại vài giây một lần rẻ hơn nhiều so với giữ một kênh mở.
"""

from __future__ import annotations

import json
from datetime import date as date_type

from fastapi import APIRouter, Query
from sqlalchemy import func, literal, select

from app.core.constants import ArticleStatus, StrategyOwnerType, StrategyStatus, SymbolAnalysisStatus
from app.core.datetime_utils import utcnow
from app.core.deps import ActiveUser, DbSession
from app.core.exceptions import Forbidden, NotFound, ValidationError
from app.models.analysis import SymbolAnalysis
from app.models.content import Article
from app.models.strategy import Strategy
from app.schemas.domain import (
    AnalysisDayOut,
    AnalysisOut,
    AnalysisRequestResult,
    MarketAnalysisRequest,
    RelatedArticleOut,
)
from app.services import subscription_service, user_strategy_service
from app.services.analysis import market_ai, ondemand, worker

#: Số bài gắn kèm tối đa. Đây là phần phụ dưới kết quả phân tích, không phải màn tin bài — dài
#: hơn thế thì nó lấn át chính thứ khách bấm nút để xem.
_RELATED_LIMIT = 5

router = APIRouter(prefix="/analysis", tags=["customer-analysis"])


def _resolve_strategy(db, user, strategy_id: int) -> Strategy:
    """Chiến lược mà khách này được phép phân tích — hệ thống hoặc cá nhân.

    Hai đường quyền hoàn toàn khác nhau và **không** được gộp: chiến lược hệ thống xét bậc gói
    (BR-847), chiến lược cá nhân xét quyền sở hữu / chia sẻ (BR-850). Dùng nhầm luật của bên này
    cho bên kia là hoặc chặn oan chủ sở hữu, hoặc phát chiến lược trả phí cho gói chưa mua.
    """
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")

    if strategy.owner_type == StrategyOwnerType.USER:
        user_strategy_service.get_for_user(db, user, strategy_id)
        return strategy

    if strategy.status != StrategyStatus.ACTIVE:
        raise NotFound("Chiến lược không tồn tại")
    if not subscription_service.can_access_min_package(db, user, strategy.min_package_id):
        raise Forbidden(
            "Chiến lược này thuộc gói cao hơn gói hiện tại của bạn.",
            "PACKAGE_TOO_LOW",
            {"min_package_id": strategy.min_package_id},
        )
    return strategy


def _related_articles(db, user, symbol: str) -> list[RelatedArticleOut]:
    """Bài viết đã xuất bản có **thẻ trùng mã** đang phân tích.

    Khớp trọn một thẻ, không khớp chuỗi con: chuẩn hoá `tags` thành `,thep,hpg,quy-2,` rồi tìm
    `,hpg,`. Nếu chỉ `LIKE '%HPG%'` thì bài gắn thẻ "SHPG" hay "HPG3" cũng bị vơ vào — đó là mã
    của doanh nghiệp khác, và gắn nhầm bài phân tích doanh nghiệp là sai nghiêm trọng hơn nhiều
    so với không gắn được bài nào.

    Lọc theo BR-501 (đã xuất bản, không phải bài hẹn giờ tương lai) ngay trong câu truy vấn; còn
    BR-502 chỉ **đánh dấu** `locked` chứ không loại bỏ — khách thấy có bài về doanh nghiệp này
    là một lý do nâng gói, giấu hẳn đi thì không.
    """
    code = symbol.strip().lower()
    if not code:
        return []

    normalized = literal(",").concat(
        func.lower(func.replace(Article.tags, " ", ""))
    ).concat(literal(","))

    rows = db.scalars(
        select(Article)
        .where(
            Article.status == ArticleStatus.PUBLISHED,
            Article.published_at.is_not(None),
            Article.published_at <= utcnow(),
            Article.tags.is_not(None),
            normalized.contains(f",{code},", autoescape=True),
        )
        .order_by(Article.published_at.desc())
        .limit(_RELATED_LIMIT)
    ).all()
    if not rows:
        return []

    allowed = subscription_service.package_gate(db, user)
    items = []
    for article in rows:
        item = RelatedArticleOut.model_validate(article)
        item.locked = not allowed(article.min_package_id)
        items.append(item)
    return items


def _to_out(db, user, item: SymbolAnalysis, strategy: Strategy | None) -> AnalysisOut:
    """Một bản phân tích ở dạng khách đọc.

    `strategy` để trống với bản phân tích theo biểu đồ: nó không thuộc chiến lược nào, và chỗ
    đó trên màn hình được thay bằng danh sách chỉ báo đã dùng.
    """
    out = AnalysisOut.model_validate(item)
    out.strategy_name = strategy.name if strategy else None
    out.used_indicators = market_ai.indicator_labels(item)
    out.note = market_ai.note_of(item)
    out.related_articles = _related_articles(db, user, item.symbol)
    return out


@router.get("/quota", response_model=dict)
def get_quota(user: ActiveUser, db: DbSession) -> dict:
    """Còn bao nhiêu lượt chạy AI hôm nay. Giao diện hiện số này ngay cạnh nút."""
    return ondemand.quota_state(db, user.id)


@router.get("/dates", response_model=list[AnalysisDayOut])
def list_analysis_dates(
    user: ActiveUser,
    db: DbSession,
    strategy_id: int = Query(...),
    symbol: str = Query(min_length=1, max_length=20),
    limit: int = Query(default=30, ge=1, le=180),
) -> list[AnalysisDayOut]:
    """Các ngày đã có bản phân tích cho cặp này — nguồn của ô chọn ngày trên giao diện.

    Không lọc theo người bấm: kết quả dùng chung cho mọi khách xem cùng chiến lược (mục 1.3),
    nên bản hôm qua do người khác chạy cũng là bản của người này. Lọc theo `requested_by` sẽ
    khiến hai người mở cùng một màn hình thấy hai danh sách ngày khác nhau trên cùng một dữ liệu.
    """
    strategy = _resolve_strategy(db, user, strategy_id)
    return [
        AnalysisDayOut(
            id=item.id,
            analysis_date=item.analysis_date,
            source=item.source,
            title=item.title,
            setup_count=len(item.setups),
        )
        for item in ondemand.history_for(db, strategy.id, symbol, limit)
    ]


@router.get("", response_model=dict)
def get_analysis(
    user: ActiveUser,
    db: DbSession,
    strategy_id: int = Query(...),
    symbol: str = Query(min_length=1, max_length=20),
    date: date_type | None = Query(default=None),
) -> dict:
    """Bản phân tích của một ngày cho cặp này. `analysis = null` nghĩa là ngày đó không có bản.

    `date` để trống là hôm nay. Truyền ngày cũ vào để đọc lại bản của phiên đó: nến của một
    phiên đã đóng là cố định, nên bản viết hôm ấy vẫn đúng với những gì có lúc ấy — đó là thứ
    khách cần khi đối chiếu nhận định cũ với diễn biến sau đó.

    Không tự khởi động lượt chạy: mở màn hình chiến lược không phải là yêu cầu phân tích, và nếu
    nó tự chạy thì hạn mức của khách bốc hơi chỉ vì họ bấm nhầm vào một mã.
    """
    strategy = _resolve_strategy(db, user, strategy_id)
    item = ondemand.find_for(db, strategy.id, symbol, date)
    return {
        "analysis": _to_out(db, user, item, strategy).model_dump() if item else None,
        "quota": ondemand.quota_state(db, user.id),
    }


@router.post("", response_model=AnalysisRequestResult)
def request_analysis(
    user: ActiveUser,
    db: DbSession,
    strategy_id: int = Query(...),
    symbol: str = Query(min_length=1, max_length=20),
) -> AnalysisRequestResult:
    """Bấm nút Phân tích.

    Ba tình huống, và giao diện phân biệt được bằng `started` + `analysis.status`:

    1. Chưa ai phân tích cặp này hôm nay → tạo việc, xếp hàng, `started=true`. Chỉ tình huống
       này mới trừ lượt, và chỉ khi chiến lược thuộc loại chạy bằng AI.
    2. Có người vừa bấm và việc đang chạy → trả đúng việc đó, `started=false`. Người này chờ
       cùng, không tốn lượt nào và **không** khởi động thêm một lượt chạy thứ hai.
    3. Đã có kết quả → trả kết quả ngay, `started=false`.
    """
    strategy = _resolve_strategy(db, user, strategy_id)
    item, started = ondemand.request_analysis(
        db, user_id=user.id, strategy=strategy, symbol=symbol
    )
    analysis_id = item.id
    payload = _to_out(db, user, item, strategy)
    quota = ondemand.quota_state(db, user.id)
    db.commit()

    # Xếp hàng **sau** `commit`: worker chạy ở luồng khác và mở phiên riêng, nên nếu giao việc
    # trước khi commit thì nó có thể đi tìm một dòng chưa tồn tại trong CSDL.
    if started:
        worker.submit(analysis_id)

    return AnalysisRequestResult(analysis=payload, started=started, quota=quota)


def _parse_indicators(raw: str) -> list[dict]:
    """Bộ chỉ báo đang bật, đọc từ tham số truy vấn.

    Ném `ValidationError` thay vì lặng lẽ coi như rỗng: bộ rỗng là một bộ **có nghĩa** (phân
    tích thuần nến), nên nuốt lỗi ở đây sẽ đem bản của bộ rỗng ra hiện dưới một biểu đồ đang
    bật đầy chỉ báo — đúng cái nhầm căn cứ mà lớp lọc này sinh ra để chặn.
    """
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValidationError(f"Danh sách chỉ báo không phải JSON hợp lệ: {exc}",
                              {"field": "indicators"}) from exc
    if not isinstance(parsed, list) or any(not isinstance(item, dict) for item in parsed):
        raise ValidationError("Danh sách chỉ báo phải là mảng các đối tượng",
                              {"field": "indicators"})
    return parsed


@router.get("/market", response_model=dict)
def get_market_analysis(
    user: ActiveUser,
    db: DbSession,
    symbol: str = Query(min_length=1, max_length=20),
    indicators: str = Query(default="[]", max_length=4000),
    note: str = Query(default="", max_length=1000),
) -> dict:
    """Bản phân tích của **đúng bộ chỉ báo đang bật** trên biểu đồ, của chính người này.

    Hai lớp lọc, mỗi lớp trả lời một câu hỏi khác nhau:

    * **Theo người bấm** — không dùng chung như bên chiến lược, vì căn cứ là bộ chỉ báo người đó
      tự chọn, nên bản của người khác trả lời một câu hỏi khác.
    * **Theo vân tay bộ chỉ báo** — màn này chỉ hiện nhận định sinh ra từ đúng những đường đang
      vẽ trên biểu đồ ngay phía trên. Bật RSI rồi đọc một nhận định viết khi chưa bật gì là đọc
      nhầm căn cứ, mà trên màn hình thì không có gì tố cáo điều đó.

    `indicators` là danh sách rút gọn `[{"id", "params"}]` — vừa đủ để dựng lại vân tay, không
    kèm giá trị từng phiên (chúng chỉ cần khi thật sự chạy, và sẽ làm địa chỉ dài quá mức).
    Rỗng nghĩa là người dùng chưa bật chỉ báo nào, và đó cũng là một bộ: nó khớp với bản phân
    tích thuần nến, không khớp với mọi bản.

    `note` là lời dặn đang nằm trong ô nhập, và nó cũng thuộc câu hỏi: cùng bộ chỉ báo mà hỏi
    "vào được chưa" hay hỏi "cắt lỗ ở đâu" là hai bản khác nhau.
    """
    item = market_ai.find_for_indicators(
        db, user.id, symbol, _parse_indicators(indicators), note
    )
    return {
        "analysis": _to_out(db, user, item, None).model_dump() if item else None,
        "quota": ondemand.quota_state(db, user.id),
    }


@router.post("/market", response_model=AnalysisRequestResult)
def request_market_analysis(
    payload: MarketAnalysisRequest, user: ActiveUser, db: DbSession
) -> AnalysisRequestResult:
    """Bấm nút Phân tích trên màn bảng giá.

    Giao diện gửi kèm bộ chỉ báo đang bật cùng giá trị gần nhất của chúng. Bấm lại đúng bộ đó
    trong ngày thì `started=false` và không tốn thêm lượt — xem `market_ai.request_analysis`.
    """
    item, started = market_ai.request_analysis(
        db,
        user_id=user.id,
        symbol=payload.symbol,
        indicators=[ind.model_dump() for ind in payload.indicators],
        note=payload.note,
    )
    analysis_id = item.id
    out = _to_out(db, user, item, None)
    quota = ondemand.quota_state(db, user.id)
    db.commit()

    # Xếp hàng **sau** `commit`, cùng lý do như nút bên chiến lược: worker mở phiên riêng ở
    # luồng khác và sẽ đi tìm một dòng chưa tồn tại nếu giao việc sớm hơn.
    if started:
        worker.submit(analysis_id)

    return AnalysisRequestResult(analysis=out, started=started, quota=quota)


@router.post("/{analysis_id}/retry", response_model=AnalysisRequestResult)
def retry_analysis(analysis_id: int, user: ActiveUser, db: DbSession) -> AnalysisRequestResult:
    """Chạy lại một bản đã FAILED.

    Lỗi thường gặp nhất là lỗi hạ tầng (không gọi được CLI, chạm hạn mức gói thuê bao) chứ không
    phải lỗi dữ liệu, nên thử lại là việc hợp lý. Vẫn đi qua đúng cổng hạn mức như một lượt mới:
    một bản hỏng không phải giấy phép chạy AI miễn phí không giới hạn.
    """
    item = db.get(SymbolAnalysis, analysis_id)
    if not item:
        raise NotFound("Bản phân tích không tồn tại")

    if item.strategy_id is None:
        # Bản theo biểu đồ: không có chiến lược để xét quyền theo gói, quyền ở đây là quyền sở
        # hữu. Trả `NotFound` chứ không `Forbidden` — người lạ không cần biết bản này có tồn tại.
        if item.requested_by != user.id:
            raise NotFound("Bản phân tích không tồn tại")
        strategy = None
    else:
        strategy = _resolve_strategy(db, user, item.strategy_id)

    if item.status != SymbolAnalysisStatus.FAILED:
        # Đang chạy hoặc đã xong thì không có gì để thử lại — trả nguyên trạng thái hiện tại.
        return AnalysisRequestResult(
            analysis=_to_out(db, user, item, strategy),
            started=False,
            quota=ondemand.quota_state(db, user.id),
        )

    from app.core.constants import AnalysisSource
    from app.models.analysis import AnalysisQuotaUsage
    from app.core.datetime_utils import local_today

    if item.source == AnalysisSource.AI:
        state = ondemand.quota_state(db, user.id)
        if state["remaining"] <= 0:
            from app.core.exceptions import TooManyRequests

            raise TooManyRequests(
                f"Bạn đã dùng hết {state['limit']} lượt phân tích của hôm nay.",
                "ANALYSIS_QUOTA_EXCEEDED",
            )
        db.add(
            AnalysisQuotaUsage(user_id=user.id, usage_date=local_today(), analysis_id=item.id)
        )

    ondemand.reset_for_retry(db, item)
    payload = _to_out(db, user, item, strategy)
    quota = ondemand.quota_state(db, user.id)
    db.commit()
    worker.submit(analysis_id)
    return AnalysisRequestResult(analysis=payload, started=True, quota=quota)


@router.get("/history", response_model=list[dict])
def my_history(user: ActiveUser, db: DbSession, limit: int = Query(default=20, le=100)) -> list[dict]:
    """Các lượt phân tích do chính tài khoản này khởi động — để đối chiếu khi thắc mắc hạn mức.

    `outerjoin` chứ không `join`: bản phân tích theo biểu đồ không gắn chiến lược nào, và một
    phép nối trong sẽ lặng lẽ bỏ chúng ra khỏi danh sách. Chúng vẫn tiêu hạn mức như mọi lượt
    khác, nên thiếu chúng thì đây trả lời sai đúng câu hỏi nó sinh ra để trả lời.
    """
    rows = db.execute(
        select(SymbolAnalysis, Strategy.name)
        .outerjoin(Strategy, Strategy.id == SymbolAnalysis.strategy_id)
        .where(SymbolAnalysis.requested_by == user.id)
        .order_by(SymbolAnalysis.id.desc())
        .limit(limit)
    ).all()
    return [
        {
            "id": item.id,
            "analysis_date": item.analysis_date,
            "strategy_id": item.strategy_id,
            "strategy_name": name,
            # Bản theo biểu đồ không có tên chiến lược để hiện — thay bằng bộ chỉ báo đã dùng.
            "used_indicators": market_ai.indicator_labels(item),
            "symbol": item.symbol,
            "source": item.source,
            "status": item.status,
            "title": item.title,
            "created_at": item.created_at,
        }
        for item, name in rows
    ]
