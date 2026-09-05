"""Vận hành: đồng bộ NAV, chiến lược/tín hiệu, hỏi đáp, thông báo, văn bản pháp lý, Telegram."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from sqlalchemy import String, and_, cast, delete, func, or_, select, update

from app.core.constants import (
    AnswerType,
    ComplianceStatus,
    DeliveryStatus,
    NotificationChannel,
    NotificationCode,
    QuestionStatus,
    SignalType,
    StrategyOwnerType,
    StrategyKind,
    StrategyStatus,
    SubscriptionStatus,
    SyncJobStatus,
    SyncJobType,
    TelegramStatus,
)
from app.core.config import settings
from app.core.datetime_utils import ensure_aware, local_today, to_local, utcnow
from app.core.deps import (
    CurrentStaff,
    DbSession,
    client_ip,
    require_permission,
    user_agent,
)
from app.core.exceptions import Conflict, Forbidden, NotFound, ValidationError
from app.core.pagination import (
    PageParams,
    build_page,
    count_of,
    page_params,
    paginate_page,
    paginate_rows,
)
from app.models.nav import SyncJob, SyncUnmatched
from app.models.content import Document
from app.models.notification import LegalDocument, Notification
from app.models.staff import Staff
from app.models.strategy import (
    Signal,
    Strategy,
    StrategyFaq,
    StrategyKbDoc,
    StrategyQuestion,
    StrategySymbol,
)
from app.models.telegram import AlertDelivery, StrategyAlert, TelegramConnection
from app.models.user import Subscription, User
from app.schemas.common import IdResponse, Message
from app.schemas.domain import (
    BroadcastRequest,
    LegalDocumentCreateRequest,
    LegalDocumentOut,
    QuestionAnswerRequest,
    QuestionOut,
    SignalCreateRequest,
    StrategyCreateRequest,
    StrategyDocumentRequest,
    StrategyRulesRequest,
    StrategyTryRequest,
    SyncJobOut,
)
from app.services import (
    compliance_service,
    nav_sync_service,
    notification_service,
    rbac,
    realtime,
    signal_service,
    strategy_run_service,
    telegram_service,
)
from app.services.audit_service import AuditAction, log_action

router = APIRouter(tags=["admin-operations"])

Pagination = Annotated[PageParams, Depends(page_params)]
CanViewSync = Annotated[Staff, Depends(require_permission("sync.view"))]
CanRunSync = Annotated[Staff, Depends(require_permission("sync.run"))]
CanManageStrategy = Annotated[Staff, Depends(require_permission("strategy.manage"))]
CanCreateSignal = Annotated[Staff, Depends(require_permission("signal.create"))]
CanAnswer = Annotated[Staff, Depends(require_permission("qa.answer"))]
CanSendNotification = Annotated[Staff, Depends(require_permission("notification.send"))]
CanManageLegal = Annotated[Staff, Depends(require_permission("legal.manage"))]
CanViewTelegram = Annotated[Staff, Depends(require_permission("telegram.view"))]


# ======================================================================
# ĐỒNG BỘ NAV — mục 3.1 "trạng thái job đồng bộ lần cuối"
# ======================================================================
@router.get("/sync/jobs", response_model=dict)
def list_sync_jobs(staff: CanViewSync, db: DbSession, params: Pagination,
                   job_type: str | None = None) -> dict:
    stmt = select(SyncJob)
    if job_type:
        stmt = stmt.where(SyncJob.job_type == job_type)
    stmt = stmt.order_by(SyncJob.id.desc())

    return paginate_page(db, stmt, params, SyncJobOut.model_validate)


@router.get("/sync/status", response_model=dict)
def sync_status(staff: CanViewSync, db: DbSession) -> dict:
    """Trạng thái tổng quan — job nào chạy lần cuối lúc nào, có chạy được compliance không."""
    last_nav = nav_sync_service.get_last_sync_job(db, SyncJobType.SYNC_NAV)
    last_compliance = nav_sync_service.get_last_sync_job(db, SyncJobType.CHECK_COMPLIANCE)
    today = local_today()
    can_run, why = compliance_service.can_run_today(db, today)

    return {
        "today": today,
        "is_trading_day": nav_sync_service.is_trading_day(db, today),
        "last_sync_nav": SyncJobOut.model_validate(last_nav).model_dump() if last_nav else None,
        "last_check_compliance": (
            SyncJobOut.model_validate(last_compliance).model_dump() if last_compliance else None
        ),
        "compliance_can_run_today": can_run,
        "compliance_blocked_reason": why or None,
        "google_sheet_configured": bool(nav_sync_service.settings.google_sheet_id),
    }


@router.post("/sync/run/{job_type}", response_model=Message)
def run_job_manually(job_type: str, staff: CanRunSync, request: Request,
                     background: BackgroundTasks, db: DbSession,
                     run_date: date | None = None, force: bool = False) -> Message:
    """Chạy lại job thủ công. `force=true` bỏ qua kiểm tra ngày giao dịch.

    Không bao giờ bỏ qua BR-301: job compliance vẫn tự kiểm tra `sync_nav` cùng ngày,
    trừ khi `force` — và khi đó audit log ghi lại rõ ai đã ép chạy.
    """
    allowed = {SyncJobType.SYNC_NAV, SyncJobType.CHECK_COMPLIANCE,
               SyncJobType.CHECK_SUBSCRIPTION, SyncJobType.NOTIFY_EXPIRY,
               SyncJobType.NOTIFY_WARNING, SyncJobType.CLOSE_SIGNALS, SyncJobType.CLEANUP,
               # Job đồng bộ thị trường đã đăng ký trong `jobs/runner.py`; thiếu ở đây thì màn
               # Dữ liệu thị trường không chạy lại được cả mẻ.
               "sync_market",
               # Nút "Kéo tin ngay" ở màn Nguồn tin gọi thẳng endpoint này.
               SyncJobType.SYNC_NEWS,
               # Tập này là bản sao thủ công của `JOB_REGISTRY` — mọi job mới phải thêm ở cả hai
               # chỗ, nếu không nút "chạy tay" trả 400 dù job vẫn chạy đúng theo lịch.
               }
    if job_type not in allowed:
        raise ValidationError(f"Job không hợp lệ. Chọn một trong: {', '.join(sorted(allowed))}")

    # Một lượt nữa chồng lên lượt đang chạy là **đắt**, không chỉ thừa: hai lượt `sync_market`
    # song song cùng quét một nhà cung cấp giá. Cửa 6 tiếng để một dòng kẹt RUNNING (backend
    # chết giữa chừng) không khoá vĩnh viễn nút chạy tay; kẹt sớm hơn thì dùng nút Huỷ.
    running = db.scalar(
        select(SyncJob)
        .where(
            SyncJob.job_type == job_type,
            SyncJob.status == SyncJobStatus.RUNNING,
            SyncJob.started_at >= utcnow() - timedelta(hours=6),
        )
        .order_by(SyncJob.id.desc())
    )
    if running:
        raise Conflict(
            f"Job {job_type} đang chạy (bắt đầu lúc "
            f"{to_local(running.started_at):%H:%M %d/%m}). Đợi nó xong, hoặc bấm Huỷ ở tab "
            f"“Lần chạy job” nếu chắc chắn tiến trình đã chết.",
            "JOB_ALREADY_RUNNING",
        )

    if force and not rbac.is_super_admin(staff):
        raise Forbidden(
            "Chỉ Quản trị tối cao mới được ép chạy job bỏ qua kiểm tra an toàn",
            "FORCE_REQUIRES_SUPER_ADMIN",
        )

    log_action(
        db, action=AuditAction.SYNC_RUN_MANUAL, actor=staff, target_type="job",
        target_id=job_type, new_value={"run_date": run_date, "force": force},
        reason=f"Chạy thủ công bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    from app.jobs import runner

    background.add_task(runner.run_job, job_type, run_date, "manual", force)
    return Message(
        message=f"Đã đưa job {job_type} vào hàng đợi chạy nền. Theo dõi kết quả ở màn Đồng bộ dữ liệu.",
        code="JOB_QUEUED",
    )


@router.post("/sync/jobs/{job_id}/cancel", response_model=Message)
def cancel_sync_job(job_id: int, staff: CanRunSync, request: Request, db: DbSession) -> Message:
    """Đóng một dòng job đang kẹt ở "Đang chạy".

    **Không giết được tiến trình.** Job chạy trong luồng nền của chính tiến trình web, ở đây chỉ
    đóng được dòng nhật ký. Nếu tiến trình thật vẫn sống thì nó vẫn ghi kết quả như thường — nút
    này dành cho lúc đã biết chắc job chết (backend khởi động lại giữa chừng, máy mất điện).

    """
    job = db.get(SyncJob, job_id)
    if not job:
        raise NotFound("Không tìm thấy job")
    if job.status != SyncJobStatus.RUNNING:
        raise Conflict("Job này đã kết thúc rồi, không cần huỷ", "JOB_NOT_RUNNING")

    job.status = SyncJobStatus.FAILED
    job.finished_at = utcnow()
    job.error_message = f"Đã huỷ thủ công bởi {staff.username}"

    log_action(
        db, action=AuditAction.SYNC_JOB_CANCEL, actor=staff, target_type="job",
        target_id=job.id, new_value={"job_type": job.job_type, "run_date": job.run_date},
        reason=f"Huỷ thủ công bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    return Message(
        message=f"Đã đóng job {job.job_type}. Thao tác này không dừng tiến trình đang chạy.",
        code="JOB_CANCELLED",
    )


def _unmatched_count(db, job_id: int) -> int:
    """Số dòng `sync_unmatched` còn trỏ vào job. Khoá ngoại không có `ON DELETE`, xoá bừa là lỗi 500."""
    return db.scalar(
        select(func.count()).select_from(SyncUnmatched).where(SyncUnmatched.sync_job_id == job_id)
    ) or 0


@router.delete("/sync/jobs/{job_id}", response_model=Message)
def delete_sync_job(job_id: int, staff: CanRunSync, request: Request, db: DbSession) -> Message:
    """Xoá một dòng nhật ký job.

    Chỉ là nhật ký vận hành, không phải bằng chứng nghiệp vụ — thao tác xoá vẫn được ghi vào
    nhật ký hệ thống (`audit_logs`), nên vẫn truy được ai đã dọn cái gì.
    """
    job = db.get(SyncJob, job_id)
    if not job:
        raise NotFound("Không tìm thấy job")
    if job.status == SyncJobStatus.RUNNING:
        raise Conflict("Job đang chạy — huỷ trước rồi mới xoá được", "JOB_RUNNING")

    pending_rows = _unmatched_count(db, job.id)
    if pending_rows:
        raise Conflict(
            f"Job này còn {pending_rows} dòng chưa khớp gắn vào nó. Xử lý ở tab "
            f"“Dòng chưa khớp” trước rồi mới xoá được.",
            "JOB_HAS_UNMATCHED",
        )

    log_action(
        db, action=AuditAction.SYNC_JOB_DELETE, actor=staff, target_type="job",
        target_id=job.id,
        old_value={"job_type": job.job_type, "run_date": job.run_date, "status": job.status,
                   "error_message": job.error_message},
        reason=f"Xoá nhật ký job bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.delete(job)
    db.commit()
    return Message(message="Đã xoá dòng nhật ký job", code="JOB_DELETED")


@router.delete("/sync/jobs", response_model=Message)
def clear_sync_jobs(staff: CanRunSync, request: Request, db: DbSession,
                    job_type: str | None = None, status: str | None = None) -> Message:
    """Dọn hàng loạt nhật ký job **đã kết thúc**.

    Hai thứ không bao giờ bị dọn, kể cả khi bộ lọc trỏ trúng chúng:

    * job đang RUNNING — dọn mất thì không còn gì để mà huỷ;
    * job còn dòng `sync_unmatched` trỏ vào — khoá ngoại không có `ON DELETE`, và những dòng đó
      là hàng chờ xử lý thật, không phải rác.
    """
    keep = select(SyncUnmatched.sync_job_id).distinct()
    stmt = delete(SyncJob).where(
        SyncJob.status != SyncJobStatus.RUNNING,
        SyncJob.id.not_in(keep),
    )
    if job_type:
        stmt = stmt.where(SyncJob.job_type == job_type)
    if status:
        stmt = stmt.where(SyncJob.status == status)

    removed = db.execute(stmt).rowcount or 0
    log_action(
        db, action=AuditAction.SYNC_JOB_DELETE, actor=staff, target_type="job",
        target_id=None, new_value={"job_type": job_type, "status": status, "removed": removed},
        reason=f"Dọn nhật ký job bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message=f"Đã xoá {removed} dòng nhật ký job", code="JOBS_CLEARED")


@router.get("/sync/unmatched", response_model=dict)
def list_unmatched(staff: CanViewSync, db: DbSession, params: Pagination,
                   only_open: bool = True) -> dict:
    """BR-403.5 — dòng trong sheet không khớp tài khoản nào, cần admin xử lý."""
    stmt = select(SyncUnmatched)
    if only_open:
        stmt = stmt.where(SyncUnmatched.resolved_at.is_(None))
    stmt = stmt.order_by(SyncUnmatched.id.desc())

    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    items = [
        {
            "id": r.id, "sync_job_id": r.sync_job_id, "email_in_sheet": r.email_in_sheet,
            "account_no": r.account_no, "nav": float(r.nav) if r.nav else None,
            "row_number": r.row_number, "note": r.note, "resolved_at": r.resolved_at,
            "created_at": r.created_at,
        }
        for r in rows
    ]
    return build_page(items, total, params)


@router.post("/sync/unmatched/{row_id}/resolve", response_model=Message)
def resolve_unmatched(row_id: int, staff: CanRunSync, db: DbSession) -> Message:
    row = db.get(SyncUnmatched, row_id)
    if not row:
        raise NotFound("Bản ghi không tồn tại")
    row.resolved_at = utcnow()
    row.resolved_by = staff.id
    db.commit()
    return Message(message="Đã đánh dấu đã xử lý")


# ======================================================================
# CHIẾN LƯỢC & TÍN HIỆU — Phần 13
# ======================================================================
@router.get("/strategies", response_model=dict)
def list_strategies(staff: CurrentStaff, db: DbSession, params: Pagination,
                    owner_type: str | None = None,
                    q: str | None = Query(default=None, max_length=100),
                    status: str | None = None,
                    school: str | None = None,
                    kind: str | None = None) -> dict:
    """Danh sách chiến lược kèm **nhãn chủ sở hữu** và **trạng thái hiển thị với khách hàng**.

    Bảng `strategies` chứa cả chiến lược cá nhân do khách hàng tự tạo (`owner_type=USER`). Loại
    này không bao giờ lên site khách hàng ngoài chính chủ, dù trạng thái là ACTIVE. Không gắn nhãn
    thì nhân viên nhìn màn hình thấy N chiến lược "Đang hoạt động" và tưởng cả N đã hiển thị công
    khai — đúng câu hỏi "sao đăng 3 mà khách chỉ thấy 1".

    `visible_to_customers` gộp cả ba điều kiện của bộ lọc bên site khách hàng vào một cờ, để giao
    diện không phải tự suy luận rồi suy sai.

    `kind` là loại chiến lược — RULE (bộ điều kiện) hay DOCUMENT (tài liệu). Nó quyết định
    nút Phân tích bên site khách hàng sẽ chạy bộ điều kiện tại chỗ hay gọi AI đọc tài liệu, nên
    phải nhìn thấy ngay trên danh sách: hai loại trông giống hệt nhau nếu không gắn nhãn.
    """
    stmt = select(Strategy)
    if owner_type:
        stmt = stmt.where(Strategy.owner_type == owner_type)
    if status:
        stmt = stmt.where(Strategy.status == status)
    if school:
        stmt = stmt.where(Strategy.school == school)
    if kind:
        stmt = stmt.where(Strategy.kind == kind)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(Strategy.name.like(pattern), Strategy.code.like(pattern)))
    stmt = stmt.order_by(Strategy.id.desc())

    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    owner_ids = {s.owner_id for s in rows if s.owner_type == StrategyOwnerType.USER and s.owner_id}
    owners = {
        u.id: u for u in db.scalars(select(User).where(User.id.in_(owner_ids))).all()
    } if owner_ids else {}

    # Gộp cho cả trang: nếu không, mỗi dòng tốn một COUNT người đăng ký và một lượt quét
    # toàn bộ lịch sử tín hiệu của chiến lược đó.
    strategy_ids = [s.id for s in rows]
    stats = signal_service.compute_stats_bulk(db, strategy_ids, [SignalType.LIVE])
    subscriber_counts = _subscriber_counts(db, strategy_ids)
    doc_counts = _document_counts(db, strategy_ids)

    result = []
    for s in rows:
        symbols = [x.symbol for x in s.symbols]
        owner = owners.get(s.owner_id) if s.owner_type == StrategyOwnerType.USER else None
        result.append({
            "id": s.id, "code": s.code, "name": s.name, "school": s.school,
            "timeframe": s.timeframe, "status": s.status, "is_public": s.is_public,
            "owner_type": s.owner_type,
            "owner_id": s.owner_id,
            "owner_name": owner.full_name if owner else None,
            "owner_code": owner.customer_code if owner else None,
            "visible_to_customers": (
                s.owner_type == StrategyOwnerType.SYSTEM
                and s.status == StrategyStatus.ACTIVE
                and bool(s.is_public)
            ),
            "min_package_id": s.min_package_id, "analyst_id": s.analyst_id,
            "document_count": doc_counts.get(s.id, 0),
            "kind": s.kind,
            "has_rules": s.rules_json is not None,
            "symbols": symbols,
            "subscribers": subscriber_counts.get(s.id, 0),
            "stats_live": stats[(s.id, SignalType.LIVE)].as_dict(),
        })
    return build_page(result, total, params)


def _has_rules_sql():
    """“Có bộ lọc thật” diễn đạt bằng SQL — phải lọc trước khi phân trang nên không thể xét ở Python.

    `rules_json IS NOT NULL` **không đủ**. Kiểu `JSON` của SQLAlchemy ghi `None` thành JSON `null`
    chứ không phải SQL NULL, nên “không có bộ lọc” nằm ở **hai** dạng tuỳ đường ghi: cột bỏ trống
    lúc INSERT ra SQL NULL, còn gán thẳng `rules_json=None` ra JSON `null`. Cả hai đều đọc lên
    Python thành `None`, nên chỉ nhìn `IS NOT NULL` sẽ xếp nhầm nhóm thứ hai vào “có bộ lọc” —
    trong CSDL dev hiện có đúng một bản ghi như vậy.

    So sánh trên chuỗi thay vì dùng `JSON_TYPE`: MySQL trả `'NULL'` còn SQLite (dùng trong test)
    trả `'null'`, mỗi bên một kiểu.
    """
    as_text = cast(Strategy.rules_json, String)
    return and_(Strategy.rules_json.is_not(None), as_text != "null", as_text != "{}")


def _document_counts(db, strategy_ids: list[int]) -> dict[int, int]:
    """Số tài liệu đính kèm, cho nhiều chiến lược trong một truy vấn."""
    if not strategy_ids:
        return {}
    rows = db.execute(
        select(StrategyKbDoc.strategy_id, func.count())
        .where(StrategyKbDoc.strategy_id.in_(strategy_ids))
        .group_by(StrategyKbDoc.strategy_id)
    ).all()
    return {strategy_id: int(count) for strategy_id, count in rows}


def _subscriber_counts(db, strategy_ids: list[int]) -> dict[int, int]:
    """Số khách hàng đang đăng ký nhận tín hiệu, cho nhiều chiến lược trong một truy vấn."""
    if not strategy_ids:
        return {}
    rows = db.execute(
        select(StrategyAlert.strategy_id, func.count())
        .where(StrategyAlert.strategy_id.in_(strategy_ids), StrategyAlert.is_active.is_(True))
        .group_by(StrategyAlert.strategy_id)
    ).all()
    return {strategy_id: int(count) for strategy_id, count in rows}


@router.post("/strategies", response_model=IdResponse, status_code=201)
def create_strategy(payload: StrategyCreateRequest, staff: CanManageStrategy, request: Request,
                    db: DbSession) -> IdResponse:
    if db.scalar(select(Strategy).where(Strategy.code == payload.code)):
        raise Conflict("Mã chiến lược đã tồn tại", "STRATEGY_CODE_EXISTS")

    strategy = Strategy(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        school=payload.school,
        kind=payload.kind,
        # Khung thời gian không còn là lựa chọn: toàn hệ thống chạy trên nến ngày. Đặt cứng ở
        # đây chứ không chỉ bỏ ô chọn trên giao diện — ai gọi thẳng API vẫn phải theo.
        timeframe=FIXED_TIMEFRAME,
        description=payload.description,
        rules_summary=payload.rules_summary,
        min_package_id=payload.min_package_id,
        analyst_id=payload.analyst_id or staff.id,
        status=StrategyStatus.DRAFT,
        created_by=staff.id,
    )
    db.add(strategy)
    db.flush()

    for symbol in {s.strip().upper() for s in payload.symbols if s.strip()}:
        db.add(StrategySymbol(strategy_id=strategy.id, symbol=symbol))

    log_action(
        db, action=AuditAction.STRATEGY_CREATE, actor=staff, target_type="strategy",
        target_id=strategy.id, new_value={"code": strategy.code, "name": strategy.name},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    label = "theo tài liệu" if strategy.kind == StrategyKind.DOCUMENT else "theo điều kiện"
    return IdResponse(id=strategy.id,
                      message=f"Đã tạo chiến lược {label} ở trạng thái Nháp")


#: Toàn hệ thống chạy trên nến ngày. Không còn ô chọn khung thời gian ở bất kỳ đâu.
FIXED_TIMEFRAME = "D1"


def _require_kind(strategy: Strategy, kind: str, what: str) -> None:
    """Chặn thao tác không thuộc loại của chiến lược.

    Đây là chỗ hai loại thực sự tách nhau. Không chặn ở đây thì một chiến lược vẫn có thể
    mang cả bộ điều kiện lẫn tài liệu — đúng tình trạng cũ, nơi người tạo không biết bấm
    Phân tích sẽ chạy cái nào.
    """
    if strategy.kind != kind:
        raise Conflict(
            f"Chiến lược này không phải loại {what}. "
            "Hai loại tách riêng: muốn đổi thì tạo chiến lược mới.",
            "STRATEGY_KIND_MISMATCH",
        )


def _system_strategy(db, strategy_id: int) -> Strategy:
    """Lấy chiến lược **của hệ thống**; chiến lược cá nhân của khách hàng thì từ chối.

    Chặn ở API chứ không chỉ ẩn nút trên giao diện (BR-533). Nhân viên nhập một tín hiệu hay đổi
    phạm vi mã trên chiến lược riêng của khách hàng là can thiệp vào tài sản của họ — và khách
    hàng không có cách nào biết chuyện đó đã xảy ra.
    """
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")
    if strategy.owner_type == StrategyOwnerType.USER:
        raise Forbidden(
            "Đây là chiến lược cá nhân của khách hàng, không thuộc quyền quản lý của nhân viên.",
            "PERSONAL_STRATEGY",
        )
    return strategy


@router.put("/strategies/{strategy_id}/symbols", response_model=Message)
def update_symbols(strategy_id: int, symbols: list[str], staff: CanManageStrategy,
                   db: DbSession) -> Message:
    """BR-860c — gỡ mã khỏi phạm vi thì đăng ký liên quan chuyển INACTIVE_BY_SYSTEM + báo KH."""
    strategy = _system_strategy(db, strategy_id)

    new_set = {s.strip().upper() for s in symbols if s.strip()}
    current = {s.symbol for s in strategy.symbols}

    removed = current - new_set
    for symbol in removed:
        telegram_service.deactivate_alerts_for_symbol(db, strategy_id, symbol)
        db.execute(
            StrategySymbol.__table__.delete().where(
                StrategySymbol.strategy_id == strategy_id, StrategySymbol.symbol == symbol
            )
        )
    for symbol in new_set - current:
        db.add(StrategySymbol(strategy_id=strategy_id, symbol=symbol))

    db.commit()
    return Message(
        message=f"Đã cập nhật phạm vi mã. Thêm {len(new_set - current)}, gỡ {len(removed)}. "
                f"Khách hàng đăng ký các mã bị gỡ đã được thông báo."
    )


@router.get("/strategies/catalog", response_model=dict)
def strategy_rule_catalog(staff: CurrentStaff) -> dict:
    """Danh mục chỉ báo và toán tử để dựng bộ lọc — cùng nguồn với site khách hàng."""
    return strategy_run_service.catalog()


@router.get("/strategies/{strategy_id}/rules", response_model=dict)
def get_strategy_rules(strategy_id: int, staff: CanManageStrategy, db: DbSession) -> dict:
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")
    # `kind` đi kèm ở đây để màn sửa hỏi đúng thứ loại đó cần — giống màn tạo. Thiếu nó thì giao
    # diện phải hiện cả bộ điều kiện lẫn tài liệu rồi để API từ chối một nửa số thao tác.
    return {
        "strategy_id": strategy.id,
        "name": strategy.name,
        "kind": strategy.kind,
        "rules": strategy.rules_json,
        "symbols": [s.symbol for s in strategy.symbols],
    }


@router.put("/strategies/{strategy_id}/rules", response_model=Message)
def update_strategy_rules(
    strategy_id: int,
    payload: StrategyRulesRequest,
    staff: CanManageStrategy,
    request: Request,
    db: DbSession,
) -> Message:
    """YC10 — lưu bộ điều kiện của chiến lược hệ thống loại RULE."""
    strategy = _system_strategy(db, strategy_id)
    _require_kind(strategy, StrategyKind.RULE, "bộ điều kiện")

    if payload.rules is None:
        strategy.rules_json = None
        message = "Đã gỡ bộ lọc. Chiến lược này trở lại chế độ phát tín hiệu thủ công."
    else:
        rules = strategy_run_service.parse_or_400(payload.rules)
        strategy.rules_json = payload.rules
        # Ghi lại câu mô tả để danh sách chiến lược đọc được ngay mà không phải dựng lại bộ lọc.
        strategy.rules_summary = rules.summary()
        message = "Đã lưu bộ lọc phân tích"

    log_action(
        db, action=AuditAction.STRATEGY_UPDATE, actor=staff, target_type="strategy",
        target_id=strategy.id, new_value={"has_rules": payload.rules is not None},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message=message)


@router.post("/strategies/{strategy_id}/run", response_model=dict)
def run_strategy(
    strategy_id: int,
    staff: CanManageStrategy,
    db: DbSession,
    symbol: str = Query(min_length=1, max_length=20),
    from_date: date | None = None,
) -> dict:
    """Chạy chiến lược đã lưu lên một mã để kiểm tra trước khi phát hành."""
    strategy = _system_strategy(db, strategy_id)
    # Quản trị viên là tác giả bộ lọc nên xem được toàn bộ nội dung.
    return strategy_run_service.run_strategy(db, strategy, symbol, reveal_rules=True,
                                             from_date=from_date)


@router.post("/strategies/try", response_model=dict)
def try_strategy_rules(
    payload: StrategyTryRequest, staff: CanManageStrategy, db: DbSession
) -> dict:
    """Chạy thử bộ lọc chưa lưu — vòng sửa/xem kết quả ngay trong màn dựng chiến lược."""
    rules = strategy_run_service.parse_or_400(payload.rules)
    return strategy_run_service.run_rules(
        db, rules, payload.symbol, reveal_rules=True, from_date=payload.from_date
    )


@router.post("/strategies/{strategy_id}/status", response_model=Message)
def set_strategy_status(strategy_id: int, status: str, staff: CanManageStrategy,
                        db: DbSession) -> Message:
    strategy = _system_strategy(db, strategy_id)
    if status not in (StrategyStatus.DRAFT, StrategyStatus.ACTIVE, StrategyStatus.ARCHIVED):
        raise ValidationError("Trạng thái không hợp lệ", {"field": "status"})
    strategy.status = status
    db.commit()
    return Message(message="Đã cập nhật trạng thái chiến lược")


@router.post("/signals", response_model=IdResponse, status_code=201)
def create_signal(payload: SignalCreateRequest, staff: CanCreateSignal, request: Request,
                  db: DbSession) -> IdResponse:
    """Analyst nhập tín hiệu tay — đủ để hiển thị marker trên biểu đồ mà chưa cần bot.

    BR-840 — sau khi ghi, tín hiệu là bất biến.
    """
    # Tín hiệu là bất biến, nên bắn nhầm vào chiến lược cá nhân của khách hàng là không gỡ lại được.
    _system_strategy(db, payload.strategy_id)

    signal = signal_service.create_signal(
        db,
        strategy_id=payload.strategy_id,
        symbol=payload.symbol,
        direction=payload.direction,
        entry_time=payload.entry_time,
        entry_price=payload.entry_price,
        sl=payload.sl,
        tp=payload.tp,
        timeframe=payload.timeframe,
        signal_type=payload.signal_type,
        reason_text=payload.reason_text,
        created_by=staff.id,
    )
    log_action(
        db, action=AuditAction.SIGNAL_CREATE, actor=staff, target_type="signal",
        target_id=signal.id,
        new_value={"symbol": signal.symbol, "direction": signal.direction,
                   "type": signal.signal_type, "entry": float(signal.entry_price)},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(id=signal.id, message="Đã ghi nhận tín hiệu và đẩy thông báo tới khách hàng")


@router.post("/signals/{signal_id}/cancel", response_model=Message)
def cancel_signal(signal_id: int, reason: str, staff: Annotated[
    Staff, Depends(require_permission("signal.cancel"))], request: Request,
    db: DbSession) -> Message:
    """BR-840 — huỷ = đánh dấu, bản ghi gốc giữ nguyên, kể cả Super Admin cũng không xoá được."""
    signal = signal_service.cancel_signal(db, signal_id, reason, staff.id)
    log_action(
        db, action=AuditAction.SIGNAL_CANCEL, actor=staff, target_type="signal",
        target_id=signal.id, new_value={"result": signal.result}, reason=reason,
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    telegram_service.enqueue_signal_alerts(db, signal, "CANCELLED")
    return Message(message="Đã huỷ tín hiệu (bản ghi gốc được giữ nguyên)")


# ======================================================================
# HỎI ĐÁP — mô hình A (Phần 14)
# ======================================================================
@router.get("/questions", response_model=dict)
def list_questions(staff: CanAnswer, db: DbSession, params: Pagination,
                   status: str | None = None, overdue_only: bool = False,
                   mine_only: bool = False, strategy_id: int | None = None,
                   q: str | None = Query(default=None, max_length=200)) -> dict:
    """Hàng chờ câu hỏi. BR-857 — dashboard theo dõi số câu quá hạn SLA."""
    stmt = select(StrategyQuestion, Strategy.name, User.customer_code)
    stmt = stmt.join(Strategy, Strategy.id == StrategyQuestion.strategy_id)
    stmt = stmt.outerjoin(User, User.id == StrategyQuestion.user_id)

    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                StrategyQuestion.question.like(pattern),
                StrategyQuestion.answer.like(pattern),
                User.customer_code.like(pattern),
            )
        )
    if strategy_id:
        stmt = stmt.where(StrategyQuestion.strategy_id == strategy_id)
    if status:
        stmt = stmt.where(StrategyQuestion.status == status)
    if overdue_only:
        stmt = stmt.where(
            StrategyQuestion.status == QuestionStatus.PENDING,
            StrategyQuestion.sla_due_at < utcnow(),
        )
    if mine_only:
        stmt = stmt.where(StrategyQuestion.assigned_to == staff.id)
    stmt = stmt.order_by(StrategyQuestion.sla_due_at.asc())

    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()

    now = utcnow()
    items = []
    for question, strategy_name, customer_code in rows:
        data = QuestionOut.model_validate(question).model_dump()
        data["strategy_name"] = strategy_name
        # BR-850 — hiển thị mã KH thay vì email để hạn chế phơi bày dữ liệu cá nhân.
        data["customer_code"] = customer_code
        data["overdue"] = bool(
            question.sla_due_at
            and question.status == QuestionStatus.PENDING
            and ensure_aware(question.sla_due_at, now) < now
        )
        items.append(data)
    return build_page(items, total, params)


@router.post("/questions/{question_id}/answer", response_model=Message)
def answer_question(question_id: int, payload: QuestionAnswerRequest, staff: CanAnswer,
                    db: DbSession) -> Message:
    question = db.get(StrategyQuestion, question_id)
    if not question:
        raise NotFound("Câu hỏi không tồn tại")

    question.answer = payload.answer.strip()
    question.answer_type = AnswerType.HUMAN
    question.answered_by = staff.id
    question.answered_at = utcnow()
    question.status = QuestionStatus.ANSWERED

    if payload.make_public:
        # BR-858 — một câu trả lời vội, khi công khai, thành nội dung tư vấn phát ra toàn bộ KH.
        if not rbac.has_permission(staff, "content.publish"):
            raise Forbidden(
                "Chỉ người có quyền xuất bản nội dung mới được công khai câu trả lời thành FAQ",
                "PUBLISH_DENIED",
            )
        question.is_public = True
        question.approved_by = staff.id
        question.approved_at = utcnow()
        db.add(
            StrategyFaq(
                strategy_id=question.strategy_id,
                question=question.question,   # BR-850 — ẩn danh, không kèm thông tin người hỏi
                answer=question.answer,
                source_question_id=question.id,
            )
        )

    user = db.get(User, question.user_id)
    if user:
        notification_service.enqueue(
            db, user=user, code=NotificationCode.QA_ANSWERED,
            channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
            reference_id=f"qa:{question.id}",
            context={"full_name": user.full_name, "question": question.question[:200]},
        )
        # YC16 — khách hàng đang mở màn hỏi đáp thấy câu trả lời ngay, không phải tải lại trang.
        realtime.broadcast_customer_event(
            user.id,
            {
                "type": "question_answered",
                "question_id": question.id,
                "strategy_id": question.strategy_id,
                "answer": question.answer,
                "answered_at": question.answered_at,
            },
        )
    db.commit()
    return Message(message="Đã trả lời câu hỏi")


# ======================================================================
# THÔNG BÁO THỦ CÔNG — BR-818
# ======================================================================
def _broadcast_query(payload: BroadcastRequest):
    stmt = select(User).where(User.deleted_at.is_(None))
    if payload.filter_subscription_status:
        stmt = stmt.where(User.subscription_status.in_(payload.filter_subscription_status))
    if payload.filter_compliance_status:
        stmt = stmt.where(User.compliance_status.in_(payload.filter_compliance_status))
    if payload.filter_expiring_in_days is not None:
        stmt = stmt.join(Subscription, Subscription.id == User.current_subscription_id).where(
            Subscription.expires_at.between(
                utcnow(), utcnow() + timedelta(days=payload.filter_expiring_in_days)
            )
        )
    return stmt


@router.post("/notifications/preview", response_model=dict)
def preview_broadcast(payload: BroadcastRequest, staff: CanSendNotification,
                      db: DbSession) -> dict:
    """BR-818 — bước xem trước bắt buộc, trả về số người nhận để admin xác nhận."""
    stmt = _broadcast_query(payload)
    count = count_of(db, stmt)
    sample = db.scalars(stmt.limit(10)).all()
    return {
        "recipient_count": int(count),
        "sample": [{"email": u.email, "full_name": u.full_name,
                    "subscription_status": u.subscription_status} for u in sample],
        "channels": payload.channels,
        "subject": payload.subject,
    }


@router.post("/notifications/send", response_model=Message)
def send_broadcast(payload: BroadcastRequest, staff: CanSendNotification, request: Request,
                   db: DbSession) -> Message:
    if not payload.confirm:
        raise ValidationError(
            "Bạn phải xem trước và xác nhận số người nhận trước khi gửi", {"field": "confirm"}
        )

    stmt = _broadcast_query(payload)
    recipients = list(db.scalars(stmt).all())

    # Chốt chặn chống gửi nhầm hàng loạt: số người nhận phải khớp với con số admin đã xác nhận.
    if (
        payload.confirmed_recipient_count is not None
        and payload.confirmed_recipient_count != len(recipients)
    ):
        raise Conflict(
            f"Số người nhận đã thay đổi ({payload.confirmed_recipient_count} → {len(recipients)}). "
            "Vui lòng xem trước lại trước khi gửi.",
            "RECIPIENT_COUNT_CHANGED",
        )

    reference = f"broadcast:{utcnow():%Y%m%d%H%M%S}"
    for user in recipients:
        notification_service.enqueue(
            db, user=user, code=NotificationCode.ADMIN_BROADCAST,
            channels=[str(c) for c in payload.channels],
            reference_id=reference,
            context={"full_name": user.full_name, "subject": payload.subject,
                     "message": payload.body},
        )

    log_action(
        db, action=AuditAction.NOTIFICATION_BROADCAST, actor=staff, target_type="notification",
        target_id=reference,
        new_value={"recipients": len(recipients), "channels": payload.channels,
                   "subject": payload.subject},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(
        message=f"Đã đưa thông báo vào hàng đợi cho {len(recipients)} khách hàng.",
        code="BROADCAST_QUEUED",
    )


@router.get("/notifications/stats", response_model=dict)
def notification_stats(staff: CanSendNotification, db: DbSession, days: int = 30) -> dict:
    """BR-819 — theo dõi hiệu quả từng mã thông báo."""
    since = utcnow() - timedelta(days=days)
    rows = db.execute(
        select(Notification.code, Notification.channel, Notification.status, func.count())
        .where(Notification.created_at >= since)
        .group_by(Notification.code, Notification.channel, Notification.status)
    ).all()

    summary: dict[str, dict] = {}
    for code, channel, status, count in rows:
        key = f"{code}|{channel}"
        entry = summary.setdefault(key, {"code": code, "channel": channel, "total": 0})
        entry[status.lower()] = int(count)
        entry["total"] += int(count)

    read_counts = dict(
        db.execute(
            select(Notification.code, func.count())
            .where(Notification.created_at >= since, Notification.read_at.is_not(None))
            .group_by(Notification.code)
        ).all()
    )
    for entry in summary.values():
        if entry["channel"] == NotificationChannel.IN_APP:
            entry["read"] = int(read_counts.get(entry["code"], 0))
            entry["read_rate"] = (
                round(entry["read"] / entry["total"] * 100, 1) if entry["total"] else None
            )

    return {"period_days": days, "items": list(summary.values())}


# ======================================================================
# TELEGRAM — mục 15.7
# ======================================================================
@router.get("/telegram/overview", response_model=dict)
def telegram_overview(staff: CanViewTelegram, db: DbSession) -> dict:
    total_users = int(
        db.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))) or 0
    )
    connected = int(
        db.scalar(
            select(func.count()).select_from(TelegramConnection)
            .where(TelegramConnection.status == TelegramStatus.VERIFIED)
        ) or 0
    )
    today_start = utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    delivery_rows = dict(
        db.execute(
            select(AlertDelivery.status, func.count())
            .where(AlertDelivery.queued_at >= today_start)
            .group_by(AlertDelivery.status)
        ).all()
    )
    # BR-883 — bản ghi SKIPPED kèm lý do là dữ liệu để trả lời khiếu nại
    # "sao tôi không nhận được tín hiệu".
    skip_rows = dict(
        db.execute(
            select(AlertDelivery.skip_reason, func.count())
            .where(AlertDelivery.status == DeliveryStatus.SKIPPED)
            .group_by(AlertDelivery.skip_reason)
        ).all()
    )

    # Bảng xếp hạng cặp được đăng ký nhiều nhất — dữ liệu cho biết KH thực sự quan tâm gì.
    top_pairs = db.execute(
        select(Strategy.name, StrategyAlert.symbol, func.count())
        .join(Strategy, Strategy.id == StrategyAlert.strategy_id)
        .where(StrategyAlert.is_active.is_(True))
        .group_by(Strategy.name, StrategyAlert.symbol)
        .order_by(func.count().desc())
        .limit(20)
    ).all()

    # BR-865 — danh sách KH đã chặn bot để đội chăm sóc liên hệ.
    blocked = db.execute(
        select(TelegramConnection, User.email, User.full_name, User.phone)
        .join(User, User.id == TelegramConnection.user_id)
        .where(TelegramConnection.status == TelegramStatus.BLOCKED)
        .limit(100)
    ).all()

    return {
        "connected": connected,
        "total_users": total_users,
        "connection_rate": round(connected / total_users * 100, 1) if total_users else 0,
        "deliveries_today": {k: int(v) for k, v in delivery_rows.items()},
        "skip_reasons": {k or "UNKNOWN": int(v) for k, v in skip_rows.items()},
        "top_pairs": [
            {"strategy": name, "symbol": symbol, "subscribers": int(count)}
            for name, symbol, count in top_pairs
        ],
        "blocked_users": [
            {"user_id": c.user_id, "email": email, "full_name": name, "phone": phone,
             "last_error": c.last_error, "error_count": c.error_count}
            for c, email, name, phone in blocked
        ],
    }


@router.post("/telegram/test/{user_id}", response_model=Message)
def telegram_test_send(user_id: int, staff: CanViewTelegram, db: DbSession) -> Message:
    """Chức năng gửi thử tới một KH cụ thể để hỗ trợ khi có sự cố (mục 15.7)."""
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user_id))
    if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id:
        raise Conflict("Khách hàng chưa kết nối Telegram", "TELEGRAM_NOT_CONNECTED")

    try:
        telegram_service.send_raw_message(
            conn.chat_id, "🔧 Tin nhắn kiểm tra kết nối từ bộ phận hỗ trợ. Bạn không cần phản hồi."
        )
    except telegram_service.TelegramApiError as exc:
        if exc.is_permanent:
            telegram_service.mark_blocked(db, conn, exc.code, exc.message)
            db.commit()
        raise Conflict(f"Gửi thất bại: {exc.message}", "TELEGRAM_SEND_FAILED") from exc

    conn.last_success_at = utcnow()
    db.commit()
    return Message(message="Đã gửi tin nhắn kiểm tra")


# ======================================================================
# VĂN BẢN PHÁP LÝ — BR-805
# ======================================================================
@router.get("/legal", response_model=dict)
def list_legal(staff: CanManageLegal, db: DbSession, params: Pagination,
               type: str | None = None) -> dict:
    """Mỗi lần ban hành là một phiên bản mới được giữ lại, nên danh sách chỉ dài thêm theo thời gian."""
    stmt = select(LegalDocument)
    if type:
        stmt = stmt.where(LegalDocument.type == type)
    stmt = stmt.order_by(LegalDocument.type, LegalDocument.id.desc())

    return paginate_page(db, stmt, params, LegalDocumentOut.model_validate)


@router.post("/legal", response_model=IdResponse, status_code=201)
def create_legal(payload: LegalDocumentCreateRequest, staff: CanManageLegal, request: Request,
                 db: DbSession) -> IdResponse:
    """Soạn phiên bản mới. Chỉ khi bấm "Ban hành" mới thay thế bản hiện hành."""
    existing = db.scalar(
        select(LegalDocument).where(
            LegalDocument.type == payload.type, LegalDocument.version == payload.version
        )
    )
    if existing:
        raise Conflict("Phiên bản này đã tồn tại", "VERSION_EXISTS")

    doc = LegalDocument(
        type=payload.type,
        version=payload.version,
        title=payload.title,
        content=payload.content,
        effective_from=payload.effective_from,
        requires_reconsent=payload.requires_reconsent,
        summary_of_changes=payload.summary_of_changes,
        is_current=False,
        created_by=staff.id,
    )
    db.add(doc)
    db.commit()
    return IdResponse(id=doc.id, message="Đã tạo phiên bản mới (chưa ban hành)")


@router.post("/legal/{doc_id}/publish", response_model=Message)
def publish_legal(doc_id: int, staff: CanManageLegal, request: Request, db: DbSession) -> Message:
    """BR-802 — bản mới có thay đổi trọng yếu thì KH phải đồng ý lại trước khi vào hệ thống."""
    doc = db.get(LegalDocument, doc_id)
    if not doc:
        raise NotFound("Văn bản không tồn tại")

    db.execute(
        update(LegalDocument)
        .where(LegalDocument.type == doc.type, LegalDocument.id != doc.id)
        .values(is_current=False)
    )
    doc.is_current = True

    log_action(
        db, action=AuditAction.LEGAL_PUBLISH, actor=staff, target_type="legal_document",
        target_id=doc.id,
        new_value={"type": doc.type, "version": doc.version,
                   "requires_reconsent": doc.requires_reconsent},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(
        message=f"Đã ban hành {doc.type} phiên bản {doc.version}"
                + (". Khách hàng sẽ được yêu cầu đồng ý lại." if doc.requires_reconsent else "")
    )


@router.get("/legal/{doc_id}/consents", response_model=dict)
def legal_consent_stats(doc_id: int, staff: CanManageLegal, db: DbSession) -> dict:
    """BR-805 — thống kê bao nhiêu KH đã đồng ý phiên bản nào."""
    from app.models.notification import UserConsent

    consented = int(
        db.scalar(
            select(func.count()).select_from(UserConsent)
            .where(UserConsent.legal_document_id == doc_id)
        ) or 0
    )
    total = int(
        db.scalar(select(func.count()).select_from(User).where(User.deleted_at.is_(None))) or 0
    )
    return {
        "document_id": doc_id,
        "consented": consented,
        "total_users": total,
        "rate": round(consented / total * 100, 1) if total else 0,
    }


# ======================================================================
# TÀI LIỆU ĐÍNH KÈM CHIẾN LƯỢC — YC14
# ======================================================================
@router.get("/strategies/{strategy_id}/documents", response_model=list[dict])
def list_strategy_documents(strategy_id: int, staff: CanManageStrategy, db: DbSession) -> list[dict]:
    rows = db.execute(
        select(StrategyKbDoc, Document)
        .join(Document, Document.id == StrategyKbDoc.document_id)
        .where(StrategyKbDoc.strategy_id == strategy_id)
        .order_by(StrategyKbDoc.id.desc())
    ).all()
    return [
        {
            "link_id": link.id,
            "document_id": doc.id,
            "title": doc.title,
            "description": doc.description,
            "original_name": doc.original_name,
            "file_size": doc.file_size,
            "mime_type": doc.mime_type,
            "min_package_id": doc.min_package_id,
            "is_active": doc.is_active,
            "attached_at": link.created_at,
        }
        for link, doc in rows
    ]


@router.post("/strategies/{strategy_id}/documents", response_model=Message, status_code=201)
def attach_strategy_document(
    strategy_id: int,
    payload: StrategyDocumentRequest,
    staff: CanManageStrategy,
    request: Request,
    db: DbSession,
) -> Message:
    """Gắn một tài liệu đã có trong kho vào chiến lược.

    Không tải file trực tiếp ở đây mà dùng lại kho tài liệu: tài liệu chiến lược cần đúng bộ bảo
    vệ của `documents` (kiểm tra gói, đóng dấu chìm theo từng khách, ghi nhật ký từng lượt tải —
    BR-511, 512, 513). Làm một đường tải riêng cho chiến lược sẽ là một đường vòng bỏ qua toàn bộ
    những thứ đó.
    """
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")
    _require_kind(strategy, StrategyKind.DOCUMENT, "tài liệu")

    document = db.get(Document, payload.document_id)
    if not document or not document.is_active:
        raise NotFound("Tài liệu không tồn tại hoặc đã bị gỡ")

    existing = db.scalar(
        select(StrategyKbDoc).where(
            StrategyKbDoc.strategy_id == strategy_id,
            StrategyKbDoc.document_id == payload.document_id,
        )
    )
    if existing:
        raise Conflict("Tài liệu này đã được gắn vào chiến lược", "DOCUMENT_ALREADY_ATTACHED")

    db.add(StrategyKbDoc(strategy_id=strategy_id, document_id=payload.document_id))
    log_action(
        db, action=AuditAction.STRATEGY_UPDATE, actor=staff, target_type="strategy",
        target_id=strategy_id, new_value={"attached_document": document.title},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message=f"Đã gắn tài liệu “{document.title}” vào chiến lược")


@router.delete("/strategies/{strategy_id}/documents/{document_id}", response_model=Message)
def detach_strategy_document(
    strategy_id: int, document_id: int, staff: CanManageStrategy, db: DbSession
) -> Message:
    link = db.scalar(
        select(StrategyKbDoc).where(
            StrategyKbDoc.strategy_id == strategy_id, StrategyKbDoc.document_id == document_id
        )
    )
    if not link:
        raise NotFound("Tài liệu chưa được gắn vào chiến lược này")

    # Chỉ gỡ liên kết, không xoá tài liệu — tài liệu có thể đang gắn ở chiến lược khác.
    db.delete(link)
    db.commit()
    return Message(message="Đã gỡ tài liệu khỏi chiến lược. Tài liệu vẫn còn trong kho.")
