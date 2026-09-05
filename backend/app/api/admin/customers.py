"""Quản lý tài khoản khách hàng — mục 3.4."""

from __future__ import annotations

import csv
import io
import secrets
from datetime import date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, or_, select

from app.core.config import settings
from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    IbLinkStatus,
    NotificationChannel,
    NotificationCode,
    PaymentStatus,
    SubscriptionStatus,
)
from app.core.datetime_utils import ensure_aware, utcnow
from app.core.deps import (
    CurrentStaff,
    DbSession,
    client_ip,
    require_permission,
    require_super_admin,
    user_agent,
)
from app.core.exceptions import Conflict, NotFound
from app.core.pagination import PageParams, build_page, count_of, page_params, paginate_page
from app.models.content import Document, DocumentDownload
from app.models.nav import ComplianceEvent, NavDaily
from app.models.staff import AuditLog, Staff
from app.models.user import (
    CustomerNote,
    LoginLog,
    Package,
    Subscription,
    User,
)
from app.schemas.common import Message
from app.schemas.domain import (
    ComplianceEventOut,
    CustomerListItem,
    CustomerNoteRequest,
    ExemptRequest,
    GrantPackageRequest,
    LoginLogOut,
    NavPoint,
    SubscriptionHistoryItem,
    SuspendRequest,
)
from app.services import (
    auth_service,
    compliance_service,
    notification_service,
    subscription_service,
)
from app.services.audit_service import AuditAction, log_action

router = APIRouter(prefix="/customers", tags=["admin-customers"])

Pagination = Annotated[PageParams, Depends(page_params)]
CanView = Annotated[Staff, Depends(require_permission("customer.view"))]
CanExtend = Annotated[Staff, Depends(require_permission("customer.extend"))]
CanSuspend = Annotated[Staff, Depends(require_permission("customer.suspend"))]
CanNote = Annotated[Staff, Depends(require_permission("customer.note"))]
CanResetPassword = Annotated[Staff, Depends(require_permission("customer.reset_password"))]
CanExempt = Annotated[Staff, Depends(require_permission("customer.exempt"))]
SuperOnly = Annotated[Staff, Depends(require_super_admin)]


def _base_query(
    q: str | None,
    subscription_status: list[str] | None,
    compliance_status: list[str] | None,
    package_id: int | None,
    nav_min: float | None,
    nav_max: float | None,
    expiring_in_days: int | None,
    never_logged_in: bool,
    customer_type: str | None,
):
    """Bộ lọc của mục 3.4 — theo gói, 2 trạng thái, khoảng NAV, sắp hết hạn, WARNING, chưa đăng nhập."""
    stmt = (
        select(User, Subscription, Package)
        .outerjoin(Subscription, Subscription.id == User.current_subscription_id)
        .outerjoin(Package, Package.id == Subscription.package_id)
        .where(User.deleted_at.is_(None))
    )

    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(
                User.email.like(pattern),
                User.full_name.like(pattern),
                User.phone.like(pattern),
                User.securities_account_no.like(pattern),
                User.customer_code.like(pattern),
            )
        )
    if subscription_status:
        stmt = stmt.where(User.subscription_status.in_(subscription_status))
    if compliance_status:
        stmt = stmt.where(User.compliance_status.in_(compliance_status))
    if customer_type:
        stmt = stmt.where(User.customer_type == customer_type)
    if package_id:
        stmt = stmt.where(Subscription.package_id == package_id)
    if nav_min is not None:
        stmt = stmt.where(User.latest_nav >= nav_min)
    if nav_max is not None:
        stmt = stmt.where(User.latest_nav <= nav_max)
    if expiring_in_days is not None:
        stmt = stmt.where(
            Subscription.expires_at.is_not(None),
            Subscription.expires_at <= utcnow() + timedelta(days=expiring_in_days),
            Subscription.expires_at >= utcnow(),
        )
    if never_logged_in:
        stmt = stmt.where(User.last_login_at.is_(None))

    return stmt


def _to_item(user: User, sub: Subscription | None, package: Package | None) -> CustomerListItem:
    item = CustomerListItem.model_validate(user)
    item.package_name = package.name if package else None
    item.expires_at = sub.expires_at if sub else None
    return item


@router.get("", response_model=dict)
def list_customers(
    staff: CanView,
    db: DbSession,
    params: Pagination,
    q: str | None = Query(default=None, max_length=100),
    subscription_status: list[str] | None = Query(default=None),
    compliance_status: list[str] | None = Query(default=None),
    customer_type: str | None = None,
    package_id: int | None = None,
    nav_min: float | None = None,
    nav_max: float | None = None,
    expiring_in_days: int | None = None,
    never_logged_in: bool = False,
) -> dict:
    stmt = _base_query(q, subscription_status, compliance_status, package_id, nav_min, nav_max,
                       expiring_in_days, never_logged_in, customer_type)
    stmt = stmt.order_by(User.id.desc())

    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()
    items = [_to_item(u, s, p) for u, s, p in rows]
    return build_page(items, total, params)


#: Ký tự mở đầu khiến Excel/LibreOffice/Sheets coi ô là **công thức** thay vì văn bản.
_CSV_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")


def _csv_cell(value) -> str:
    """Vô hiệu hoá công thức trước khi ghi vào CSV (CSV / formula injection).

    Dữ liệu trong file này do **khách hàng tự nhập**: họ tên, tên môi giới, số tài khoản. Một
    người đăng ký với họ tên `=cmd|'/c calc'!A1` sẽ khiến ô đó chạy như công thức ngay khi
    nhân viên mở file bằng Excel — mã chạy trên máy nội bộ với quyền của người đang xem, không
    phải trên máy chủ. Hệ thống không bị gì, nhưng máy của đội chăm sóc khách hàng thì có.

    Cách xử lý chuẩn: thêm dấu nháy đơn ở đầu để ứng dụng bảng tính hiểu đây là chuỗi.
    """
    text = "" if value is None else str(value)
    if text.startswith(_CSV_FORMULA_PREFIXES):
        return "'" + text
    return text


def _csv_row(values: list) -> list[str]:
    return [_csv_cell(v) for v in values]


@router.get("/export")
def export_customers(
    staff: Annotated[Staff, Depends(require_permission("customer.export"))],
    db: DbSession,
    subscription_status: list[str] | None = Query(default=None),
    compliance_status: list[str] | None = Query(default=None),
    expiring_in_days: int | None = None,
):
    """Nút "Xuất danh sách" cho đội chăm sóc (mục 3.1)."""
    stmt = _base_query(None, subscription_status, compliance_status, None, None, None,
                       expiring_in_days, False, None).order_by(User.id)
    rows = db.execute(stmt).all()

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "Mã KH", "Email", "Họ tên", "SĐT", "Số TKCK", "Gói", "Ngày hết hạn",
        "NAV mới nhất", "Ngày GD gần nhất", "Trạng thái gói", "Trạng thái compliance",
        "Môi giới", "SĐT môi giới", "Đăng nhập lần cuối",
    ])
    for user, sub, package in rows:
        writer.writerow(_csv_row([
            user.customer_code or "", user.email, user.full_name, user.phone or "",
            user.securities_account_no or "", package.name if package else "",
            sub.expires_at.strftime("%d/%m/%Y") if sub and sub.expires_at else "",
            f"{user.latest_nav:.0f}" if user.latest_nav is not None else "",
            user.last_trade_date.strftime("%d/%m/%Y") if user.last_trade_date else "",
            user.subscription_status, user.compliance_status,
            user.broker_name or "", user.broker_phone or "",
            user.last_login_at.strftime("%d/%m/%Y %H:%M") if user.last_login_at else "",
        ]))

    buffer.seek(0)
    filename = f"khach-hang-{date.today():%Y%m%d}.csv"
    return StreamingResponse(
        # BOM để Excel trên Windows đọc đúng tiếng Việt.
        io.BytesIO(b"\xef\xbb\xbf" + buffer.getvalue().encode("utf-8")),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/warning-list", response_model=dict)
def warning_list(staff: CanView, db: DbSession, params: Pagination) -> dict:
    """BR-302 — **màn hình tác nghiệp chính của đội môi giới**.

    Kèm số ngày còn lại trước khi khoá để ưu tiên gọi điện đúng người trước.
    """
    stmt = (
        select(User, Subscription, Package)
        .outerjoin(Subscription, Subscription.id == User.current_subscription_id)
        .outerjoin(Package, Package.id == Subscription.package_id)
        .where(
            User.deleted_at.is_(None),
            User.compliance_status == ComplianceStatus.WARNING,
        )
        .order_by(User.warning_until.asc())
    )
    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()

    now = utcnow()
    items = []
    for user, sub, package in rows:
        item = _to_item(user, sub, package).model_dump()
        remaining = None
        if user.warning_until:
            wu = ensure_aware(user.warning_until, now)
            remaining = max((wu - now).days, 0)
        item["days_until_suspend"] = remaining
        item["broker_name"] = user.broker_name
        item["broker_phone"] = user.broker_phone
        items.append(item)

    return build_page(items, total, params)


# ======================================================================
# CHI TIẾT KHÁCH HÀNG — 7 tab của mục 3.4
# ======================================================================
def _get_customer(db, user_id: int) -> User:
    user = db.get(User, user_id)
    if not user or user.deleted_at:
        raise NotFound("Khách hàng không tồn tại")
    return user


@router.get("/{user_id}", response_model=dict)
def customer_detail(user_id: int, staff: CanView, db: DbSession) -> dict:
    """Tab 1 — thông tin & gói hiện tại."""
    user = _get_customer(db, user_id)
    sub = subscription_service.get_current_subscription(db, user)
    package = db.get(Package, sub.package_id) if sub else None

    from app.services import access_control, nav_sync_service

    nav_avg, sessions = nav_sync_service.nav_average(db, user.id)

    return {
        "customer": _to_item(user, sub, package),
        "subscription": {
            "id": sub.id if sub else None,
            "package_name": package.name if package else None,
            "starts_at": sub.starts_at if sub else None,
            "expires_at": sub.expires_at if sub else None,
            "frozen_days": sub.frozen_days if sub else 0,
            "is_frozen": bool(sub and sub.frozen_since),
            "payment_status": sub.payment_status if sub else None,
        },
        "compliance": {
            "applicable": access_control.is_compliance_applicable(user),
            "status": user.compliance_status,
            "exempt": user.compliance_exempt,
            "exempt_reason": user.compliance_exempt_reason,
            "warning_until": user.warning_until,
            "suspended_at": user.suspended_at,
            "suspended_reason": user.suspended_reason,
            "nav_avg": float(nav_avg) if nav_avg is not None else None,
            "nav_sessions": sessions,
            "has_nav_data": nav_avg is not None,
        },
        "ib": {
            "account_no": user.securities_account_no,
            "link_status": user.ib_link_status,
            "deadline": user.ib_link_deadline,
            "linked_at": user.ib_linked_at,
            "broker_name": user.broker_name,
            "broker_code": user.broker_code,
            "broker_phone": user.broker_phone,
        },
    }


class PaymentDecisionRequest(BaseModel):
    """Kết quả đối soát một đơn hàng khách tự tạo."""

    status: str = Field(pattern="^(PAID|FAILED|CANCELLED|REFUNDED)$")
    note: str | None = Field(default=None, max_length=500)


@router.post("/{user_id}/subscriptions/{subscription_id}/payment", response_model=Message)
def decide_payment(user_id: int, subscription_id: int, payload: PaymentDecisionRequest,
                   staff: CanExtend, request: Request, db: DbSession) -> Message:
    """Xác nhận (hoặc từ chối) thanh toán cho đơn khách hàng tự tạo ở màn Gói dịch vụ.

    Khách chuyển khoản tay nên không có cổng thanh toán nào tự báo về — phải có người đối chiếu
    sao kê rồi bấm xác nhận. Trước khi có endpoint này, đơn `PENDING` nằm lại vĩnh viễn: khách đã
    trả tiền mà gói không bao giờ kích hoạt.
    """
    user = _get_customer(db, user_id)
    sub = db.get(Subscription, subscription_id)
    if not sub or sub.user_id != user.id:
        raise NotFound("Đơn hàng không tồn tại")
    if sub.payment_status == PaymentStatus.PAID:
        raise Conflict("Đơn hàng này đã được xác nhận thanh toán", "ALREADY_PAID")

    old_status = sub.payment_status
    if payload.status == PaymentStatus.PAID:
        subscription_service.confirm_payment(db, user, sub)
        message = "Đã xác nhận thanh toán và kích hoạt gói cho khách hàng."
    else:
        subscription_service.reject_payment(db, sub, payload.status)
        message = "Đã cập nhật trạng thái đơn hàng."

    if payload.note:
        sub.note = payload.note

    log_action(
        db, action=AuditAction.CUSTOMER_GRANT_PACKAGE, actor=staff, target_type="user",
        target_id=user.id,
        old_value={"subscription_id": sub.id, "payment_status": old_status},
        new_value={
            "subscription_id": sub.id,
            "payment_status": sub.payment_status,
            "expires_at": sub.expires_at,
        },
        reason=payload.note or f"Đối soát thanh toán đơn {sub.payment_ref or sub.id}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    # Khách hàng phải biết kết quả — họ đang chờ gói kích hoạt sau khi chuyển tiền.
    # Chỉ gửi cho trường hợp thành công: các mã còn lại chưa có mẫu email, gửi bừa thì khách nhận
    # được một email trống rỗng, còn tệ hơn không gửi.
    if payload.status == PaymentStatus.PAID:
        notification_service.enqueue(
            db, user=user, code=NotificationCode.PAYMENT_SUCCESS,
            channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
            reference_id=f"payment:{sub.id}",
            context={
                "full_name": user.full_name,
                "package_name": (db.get(Package, sub.package_id).name if sub.package_id else ""),
                "expires_at": sub.expires_at,
            },
        )
        db.commit()

    return Message(message=message)


@router.get("/{user_id}/subscriptions", response_model=dict)
def customer_subscriptions(user_id: int, staff: CanView, db: DbSession,
                           params: Pagination) -> dict:
    """Tab 2 — lịch sử gói và thanh toán (BR-135)."""
    _get_customer(db, user_id)
    stmt = select(Subscription).where(Subscription.user_id == user_id).order_by(
        Subscription.id.desc()
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    packages = {p.id: p for p in db.scalars(select(Package)).all()}
    items = [
        SubscriptionHistoryItem(
            id=s.id,
            package_name=packages[s.package_id].name if s.package_id in packages else "",
            starts_at=s.starts_at, expires_at=s.expires_at, amount=s.amount,
            payment_status=s.payment_status, frozen_days=s.frozen_days or 0,
            created_by_type=s.created_by_type, note=s.note, created_at=s.created_at,
        )
        for s in rows
    ]
    return build_page(items, total, params)


@router.get("/{user_id}/nav-history", response_model=list[NavPoint])
def customer_nav_history(user_id: int, staff: CanView, db: DbSession, days: int = 180) -> list[NavPoint]:
    """Tab 3 — biểu đồ NAV theo thời gian (từ `nav_daily`)."""
    _get_customer(db, user_id)
    rows = db.scalars(
        select(NavDaily)
        .where(NavDaily.user_id == user_id)
        .order_by(NavDaily.trade_date.desc())
        .limit(min(days, 730))
    ).all()
    return [
        NavPoint(trade_date=r.trade_date, nav=r.nav, last_trade_date=r.last_trade_date)
        for r in reversed(rows)
    ]


@router.get("/{user_id}/login-logs", response_model=dict)
def customer_login_logs(user_id: int, staff: CanView, db: DbSession, params: Pagination) -> dict:
    """Tab 4 — lịch sử đăng nhập (IP, thiết bị, thời điểm) — BR-110."""
    _get_customer(db, user_id)
    stmt = (
        select(LoginLog)
        .where(LoginLog.user_id == user_id, LoginLog.actor_type == "USER")
        .order_by(LoginLog.id.desc())
    )
    return paginate_page(db, stmt, params, LoginLogOut.model_validate)


@router.get("/{user_id}/activity", response_model=dict)
def customer_activity(user_id: int, staff: CanView, db: DbSession) -> dict:
    """Tab 5 — lịch sử tải tài liệu / xem bài viết."""
    _get_customer(db, user_id)
    downloads = db.execute(
        select(DocumentDownload, Document.title)
        .join(Document, Document.id == DocumentDownload.document_id)
        .where(DocumentDownload.user_id == user_id)
        .order_by(DocumentDownload.id.desc())
        .limit(50)
    ).all()
    return {
        "downloads": [
            {
                "id": d.id, "document_title": title, "ip": d.ip,
                "watermarked": d.watermarked, "created_at": d.created_at,
            }
            for d, title in downloads
        ]
    }


@router.get("/{user_id}/compliance-events", response_model=dict)
def customer_compliance_events(user_id: int, staff: CanView, db: DbSession,
                               params: Pagination) -> dict:
    """Tab 6 — nhật ký thay đổi trạng thái (ai đổi, khi nào, vì sao)."""
    _get_customer(db, user_id)
    stmt = (
        select(ComplianceEvent)
        .where(ComplianceEvent.user_id == user_id)
        .order_by(ComplianceEvent.id.desc())
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    return build_page(
        [ComplianceEventOut.model_validate(r) for r in rows], int(total), params
    )


@router.get("/{user_id}/notes", response_model=dict)
def customer_notes(user_id: int, staff: CanView, db: DbSession, params: Pagination) -> dict:
    """Tab 7 — nhật ký chăm sóc của môi giới."""
    _get_customer(db, user_id)
    stmt = select(CustomerNote).where(CustomerNote.user_id == user_id).order_by(
        CustomerNote.id.desc()
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    staff_names = {s.id: s.full_name for s in db.scalars(select(Staff)).all()}
    return build_page(
        [
            {
                "id": n.id, "content": n.content, "staff_id": n.staff_id,
                "staff_name": staff_names.get(n.staff_id), "created_at": n.created_at,
            }
            for n in rows
        ],
        int(total),
        params,
    )


@router.post("/{user_id}/notes", response_model=Message, status_code=201)
def add_note(user_id: int, payload: CustomerNoteRequest, staff: CanNote, db: DbSession) -> Message:
    _get_customer(db, user_id)
    db.add(CustomerNote(user_id=user_id, staff_id=staff.id, content=payload.content.strip()))
    db.commit()
    return Message(message="Đã lưu ghi chú chăm sóc")


# ======================================================================
# HÀNH ĐỘNG — mọi thao tác đều ghi audit log kèm lý do (mục 3.4, 3.6)
# ======================================================================
@router.post("/{user_id}/grant-package", response_model=Message)
def grant_package(user_id: int, payload: GrantPackageRequest, staff: CanExtend,
                  request: Request, db: DbSession) -> Message:
    """Gia hạn / cấp gói thủ công — **bắt buộc nhập lý do**, ghi audit log."""
    user = _get_customer(db, user_id)
    package = db.get(Package, payload.package_id)
    if not package:
        raise NotFound("Gói dịch vụ không tồn tại")

    before = {
        "subscription_status": user.subscription_status,
        "current_subscription_id": user.current_subscription_id,
    }
    sub = subscription_service.grant_package(
        db, user, package,
        amount=payload.amount if payload.amount is not None else package.price,
        payment_status=PaymentStatus.PAID,
        payment_method="MANUAL",
        created_by_type="staff",
        created_by_staff_id=staff.id,
        note=payload.note or f"Cấp thủ công bởi {staff.username}",
    )

    log_action(
        db, action=AuditAction.CUSTOMER_GRANT_PACKAGE, actor=staff,
        target_type="user", target_id=user.id,
        old_value=before,
        new_value={
            "package": package.code, "subscription_id": sub.id,
            "expires_at": sub.expires_at, "amount": sub.amount,
        },
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )

    notification_service.enqueue(
        db, user=user, code=NotificationCode.PAYMENT_SUCCESS,
        channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
        reference_id=f"sub:{sub.id}",
        context={
            "full_name": user.full_name, "package_name": package.name,
            "expires_at": sub.expires_at.strftime("%d/%m/%Y"),
        },
    )
    db.commit()
    return Message(
        message=f"Đã cấp gói {package.name}, hết hạn {sub.expires_at:%d/%m/%Y}",
        code="PACKAGE_GRANTED",
    )


@router.post("/{user_id}/suspend", response_model=Message)
def suspend(user_id: int, payload: SuspendRequest, staff: CanSuspend, request: Request,
            db: DbSession) -> Message:
    """Tạm khoá — bắt buộc nhập lý do. Đồng hồ gói dừng đếm (BR-304)."""
    user = _get_customer(db, user_id)
    if user.compliance_status == ComplianceStatus.SUSPENDED:
        raise Conflict("Tài khoản đang ở trạng thái tạm khoá", "ALREADY_SUSPENDED")

    before = {"compliance_status": user.compliance_status}
    compliance_service.admin_suspend(db, user, payload.reason, staff.id)
    log_action(
        db, action=AuditAction.CUSTOMER_SUSPEND, actor=staff, target_type="user", target_id=user.id,
        old_value=before, new_value={"compliance_status": user.compliance_status},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã tạm khoá tài khoản")


@router.post("/{user_id}/unsuspend", response_model=Message)
def unsuspend(user_id: int, payload: SuspendRequest, staff: CanSuspend, request: Request,
              db: DbSession) -> Message:
    """Mở khoá — bù đúng số ngày bị đóng băng vào `expires_at` (BR-304)."""
    user = _get_customer(db, user_id)
    before = {"compliance_status": user.compliance_status}
    frozen_days = compliance_service.admin_restore(db, user, payload.reason, staff.id)
    log_action(
        db, action=AuditAction.CUSTOMER_UNSUSPEND, actor=staff, target_type="user",
        target_id=user.id, old_value=before,
        new_value={"compliance_status": user.compliance_status, "frozen_days_added": frozen_days},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(
        message=f"Đã mở khoá tài khoản. Gói được bù thêm {frozen_days} ngày bị đóng băng."
    )


@router.post("/{user_id}/close", response_model=Message)
def close_account(user_id: int, payload: SuspendRequest, staff: SuperOnly, request: Request,
                  db: DbSession) -> Message:
    """Đóng vĩnh viễn (`CLOSED`) — **chỉ Super Admin** (mục 3.4)."""
    user = _get_customer(db, user_id)
    before = {"compliance_status": user.compliance_status}
    compliance_service.admin_close(db, user, payload.reason, staff.id)
    log_action(
        db, action=AuditAction.CUSTOMER_CLOSE, actor=staff, target_type="user", target_id=user.id,
        old_value=before, new_value={"compliance_status": ComplianceStatus.CLOSED},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã đóng vĩnh viễn tài khoản")


@router.post("/{user_id}/reopen", response_model=Message)
def reopen_account(user_id: int, payload: SuspendRequest, staff: SuperOnly, request: Request,
                   db: DbSession) -> Message:
    user = _get_customer(db, user_id)
    before = {"compliance_status": user.compliance_status}
    compliance_service.admin_restore(db, user, payload.reason, staff.id)
    log_action(
        db, action=AuditAction.CUSTOMER_REOPEN, actor=staff, target_type="user", target_id=user.id,
        old_value=before, new_value={"compliance_status": user.compliance_status},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã mở lại tài khoản")


@router.post("/{user_id}/exempt", response_model=Message)
def set_exempt(user_id: int, payload: ExemptRequest, staff: CanExempt, request: Request,
               db: DbSession) -> Message:
    """Miễn áp điều kiện IB — bắt buộc ghi audit log (mục 3.6)."""
    user = _get_customer(db, user_id)
    before = {"compliance_exempt": user.compliance_exempt,
              "compliance_status": user.compliance_status}
    compliance_service.admin_set_exempt(db, user, payload.exempt, payload.reason, staff.id)
    log_action(
        db, action=AuditAction.CUSTOMER_EXEMPT, actor=staff, target_type="user", target_id=user.id,
        old_value=before,
        new_value={"compliance_exempt": user.compliance_exempt,
                   "compliance_status": user.compliance_status},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(
        message="Đã bật miễn áp điều kiện IB" if payload.exempt else "Đã tắt miễn áp điều kiện IB"
    )


@router.post("/{user_id}/reset-password", response_model=Message)
def reset_customer_password(user_id: int, staff: CanResetPassword, request: Request,
                            db: DbSession) -> Message:
    """BR-520 — admin **không được xem/đặt** mật khẩu KH; chỉ gửi mã về email của KH."""
    user = _get_customer(db, user_id)
    auth_service.request_password_reset(db, user.email, client_ip(request))
    log_action(
        db, action=AuditAction.CUSTOMER_RESET_PASSWORD, actor=staff, target_type="user",
        target_id=user.id, new_value={"sent_to": user.email},
        reason=f"Yêu cầu hỗ trợ đặt lại mật khẩu bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(
        message=f"Đã gửi mã đặt lại mật khẩu tới email {user.email}. "
                "Quản trị viên không xem được mật khẩu của khách hàng."
    )


@router.post("/{user_id}/approve-ib", response_model=Message)
def approve_ib_link(user_id: int, payload: SuspendRequest, staff: CanExtend, request: Request,
                    db: DbSession) -> Message:
    """BR-202 — duyệt tay khi job đối chiếu không tìm thấy sau 7 ngày."""
    user = _get_customer(db, user_id)
    before = {"ib_link_status": user.ib_link_status, "compliance_status": user.compliance_status}

    user.ib_link_status = IbLinkStatus.OK
    user.ib_linked_at = utcnow()
    user.ib_link_deadline = None
    if user.compliance_status == ComplianceStatus.PENDING_LINK:
        user.compliance_status = ComplianceStatus.OK
    elif user.compliance_status == ComplianceStatus.SUSPENDED and "IB_LINK" in (
        user.suspended_reason or ""
    ):
        compliance_service.admin_restore(db, user, payload.reason, staff.id)

    log_action(
        db, action=AuditAction.CUSTOMER_IB_APPROVE, actor=staff, target_type="user",
        target_id=user.id, old_value=before,
        new_value={"ib_link_status": user.ib_link_status,
                   "compliance_status": user.compliance_status},
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã duyệt liên kết tài khoản chứng khoán")


@router.get("/{user_id}/audit-logs", response_model=dict)
def customer_audit_logs(user_id: int, staff: CanView, db: DbSession, params: Pagination) -> dict:
    """Tab 6 (phần admin) — mọi thao tác admin đã thực hiện lên tài khoản này.

    Trước đây cắt cứng 200 dòng gần nhất: dòng thứ 201 trở đi **không có cách nào xem được**, mà
    đây lại đúng là dữ liệu cần khi đối soát khiếu nại cũ. Phân trang thay cho cắt cứng.
    """
    _get_customer(db, user_id)
    stmt = (
        select(AuditLog)
        .where(AuditLog.target_type == "user", AuditLog.target_id == str(user_id))
        .order_by(AuditLog.id.desc())
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    return build_page(
        [
            {
                "id": r.id, "action": r.action, "actor_name": r.actor_name,
                "old_value": r.old_value, "new_value": r.new_value,
                "reason": r.reason, "ip": r.ip, "created_at": r.created_at,
            }
            for r in rows
        ],
        int(total),
        params,
    )


# ======================================================================
# YC7 — Admin tạo tài khoản khách hàng
# ======================================================================
class CreateCustomerRequest(BaseModel):
    """Khách hàng liên hệ trực tiếp, nhân viên tạo tài khoản hộ."""

    email: EmailStr
    full_name: str = Field(min_length=2, max_length=150)
    phone: str = Field(min_length=9, max_length=15)
    customer_type: Literal[CustomerType.IB_LINKED, CustomerType.PAID_ONLY] = CustomerType.IB_LINKED
    securities_account_no: str | None = Field(default=None, max_length=50)

    #: Thông tin môi giới phụ trách — hiển thị cho khách hàng ở màn tài khoản (F23).
    broker_name: str | None = Field(default=None, max_length=150)
    broker_code: str | None = Field(default=None, max_length=50)
    broker_phone: str | None = Field(default=None, max_length=20)

    #: Cấp luôn gói khi tạo. Bỏ trống thì tài khoản chưa có gói, khách hàng tự mua sau.
    package_id: int | None = None
    #: Bỏ qua bước xác thực email — dùng khi nhân viên đã xác minh danh tính trực tiếp.
    skip_email_verification: bool = True
    reason: str = Field(min_length=3, max_length=500)


@router.post("/create", response_model=dict, status_code=201)
def create_customer(
    payload: CreateCustomerRequest,
    staff: Annotated[Staff, Depends(require_permission("customer.create"))],
    request: Request,
    db: DbSession,
) -> dict:
    """Tạo tài khoản khách hàng và gửi email kèm thông tin đăng nhập.

    Mật khẩu do hệ thống sinh ngẫu nhiên, **không cho nhân viên tự đặt**: nhân viên đặt mật
    khẩu nghĩa là nhân viên biết mật khẩu của khách hàng, vi phạm nguyên tắc BR-520. Khách hàng
    bắt buộc đổi ở lần đăng nhập đầu tiên.
    """
    # Mật khẩu tạm đủ mạnh, gửi qua email rồi buộc đổi ngay.
    temp_password = f"{secrets.token_urlsafe(6)}{secrets.randbelow(90) + 10}"

    # Dùng chung bộ kiểm tra với luồng khách hàng tự đăng ký: email/SĐT chưa tồn tại,
    # đúng định dạng, không phải email dùng một lần.
    auth_service.validate_registration(db, str(payload.email), payload.phone, temp_password)

    user = auth_service.create_user(
        db,
        email=str(payload.email),
        password=temp_password,
        full_name=payload.full_name,
        phone=payload.phone,
        customer_type=payload.customer_type,
        ip=client_ip(request),
    )
    user.broker_name = payload.broker_name
    user.broker_code = payload.broker_code
    user.broker_phone = payload.broker_phone
    if payload.securities_account_no:
        user.securities_account_no = payload.securities_account_no.strip()
        user.ib_link_status = IbLinkStatus.PENDING_LINK

    if payload.skip_email_verification:
        # Nhân viên đã xác minh danh tính trực tiếp khi khách hàng liên hệ, nên bỏ qua
        # bước xác thực email — khách hàng đăng nhập được ngay khi nhận mail.
        user.email_verified_at = utcnow()
    else:
        # Vẫn muốn khách hàng tự xác thực thì gửi link như luồng tự đăng ký (BR-100).
        auth_service.issue_email_verification(db, user)

    granted_package = None
    if payload.package_id:
        package = db.get(Package, payload.package_id)
        if not package:
            raise NotFound("Gói dịch vụ không tồn tại")
        subscription_service.grant_package(
            db, user, package,
            payment_status=PaymentStatus.PAID,
            payment_method="MANUAL",
            created_by_type="staff",
            created_by_staff_id=staff.id,
            note=f"Cấp khi tạo tài khoản — {payload.reason}",
        )
        granted_package = package.name
    elif payload.skip_email_verification and not user.trial_used:
        # Không cấp gói thì cho dùng thử luôn, để khách hàng vào được ngay sau khi nhận email.
        subscription_service.start_trial(db, user)

    db.flush()

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.ACCOUNT_CREATED,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"created:{user.id}",
        context={
            "full_name": user.full_name,
            "email": user.email,
            "password": temp_password,
            "login_url": f"{settings.frontend_base_url}/login",
            "staff_name": staff.full_name,
            "package_name": granted_package or "Gói dùng thử",
        },
    )

    log_action(
        db, action="customer.create", actor=staff, target_type="user", target_id=user.id,
        new_value={
            "email": user.email,
            "customer_type": user.customer_type,
            "package": granted_package,
        },
        reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    return {
        "id": user.id,
        "email": user.email,
        "customer_code": user.customer_code,
        "message": f"Đã tạo tài khoản và gửi thông tin đăng nhập tới {user.email}",
        # Nhân viên đọc để đọc cho khách qua điện thoại nếu email chưa tới.
        "temp_password": temp_password,
        "note": "Nhắc khách hàng đổi mật khẩu ngay sau lần đăng nhập đầu tiên.",
    }
