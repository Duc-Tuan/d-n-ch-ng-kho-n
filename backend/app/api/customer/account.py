"""API tài khoản, gói dịch vụ và liên kết IB — Customer Site."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select

from app.core.config import settings
from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    IbLinkStatus,
    LegalDocType,
    NotificationChannel,
    NotificationCode,
    PaymentStatus,
)
from app.core.datetime_utils import utcnow
from app.core.deps import CurrentUser, DbSession, client_ip, user_agent
from app.core.exceptions import Conflict, NotFound, ValidationError
from app.core.pagination import PageParams, build_page, count_of, page_params
from app.models.nav import ComplianceEvent, NavDaily
from app.models.notification import LegalDocument, UserConsent
from app.models.user import Package, Subscription
from app.schemas.common import Message
from app.schemas.domain import (
    ComplianceEventOut,
    IbLinkRequest,
    NavPoint,
    PackageOut,
    PurchaseRequest,
    SubscriptionHistoryItem,
)
from app.services import notification_service, staff_notify, subscription_service

router = APIRouter(prefix="/account", tags=["customer-account"])

Pagination = Annotated[PageParams, Depends(page_params)]


@router.get("/packages", response_model=list[PackageOut])
def list_packages(db: DbSession) -> list[Package]:
    """Danh sách gói đang bán. Endpoint này KH bị chặn vẫn gọi được (để còn mua gia hạn)."""
    return list(
        db.scalars(
            select(Package)
            .where(Package.is_active.is_(True), Package.is_trial.is_(False))
            .order_by(Package.sort_order, Package.tier)
        ).all()
    )


@router.post("/purchase", response_model=dict)
def purchase(payload: PurchaseRequest, user: CurrentUser, request: Request, db: DbSession) -> dict:
    """Mua / gia hạn gói.

    Luồng thanh toán tự động (VNPay/MoMo) thuộc Giai đoạn 2 — hiện tạo đơn ở trạng thái
    `PENDING` và trả về hướng dẫn chuyển khoản; admin xác nhận thì gói mới kích hoạt.
    Với `MANUAL` (admin cấp tay) xem `api/admin/customers.py`.
    """
    package = subscription_service.validate_package_purchase(db, payload.package_id)

    if not payload.accept_refund_policy:
        # BR-305 — điều khoản hoàn tiền là văn bản duy nhất bảo vệ bạn khi KH bị khoá do NAV.
        raise ValidationError(
            "Bạn cần đồng ý với Chính sách thanh toán & hoàn tiền trước khi thanh toán",
            {"field": "accept_refund_policy"},
        )

    # BR-200 — tuyến IB bắt buộc khai số tài khoản chứng khoán khi mua gói.
    if user.customer_type == CustomerType.IB_LINKED:
        account_no = (payload.securities_account_no or user.securities_account_no or "").strip()
        if not account_no:
            raise ValidationError(
                "Vui lòng nhập số tài khoản chứng khoán mở dưới IB của chúng tôi",
                {"field": "securities_account_no"},
            )
        if account_no != user.securities_account_no:
            user.securities_account_no = account_no
            user.ib_link_status = IbLinkStatus.PENDING_LINK

    ref = f"SUB{utcnow():%y%m%d%H%M%S}{user.id}"
    sub = subscription_service.grant_package(
        db,
        user,
        package,
        payment_status=PaymentStatus.PENDING,
        payment_ref=ref,
        payment_method=payload.payment_method,
        created_by_type="self",
    )

    # BR-800 — lưu bằng chứng đồng ý chính sách hoàn tiền cho đúng phiên bản văn bản.
    refund_doc = db.scalar(
        select(LegalDocument).where(
            LegalDocument.type == LegalDocType.REFUND, LegalDocument.is_current.is_(True)
        )
    )
    if refund_doc:
        exists = db.scalar(
            select(UserConsent).where(
                UserConsent.user_id == user.id,
                UserConsent.legal_document_id == refund_doc.id,
            )
        )
        if not exists:
            db.add(
                UserConsent(
                    user_id=user.id, legal_document_id=refund_doc.id, consented_at=utcnow(),
                    ip=client_ip(request), user_agent=(user_agent(request) or "")[:400] or None,
                )
            )
    # YC17 — không có tín hiệu này thì đơn nằm im trong CSDL: khách đã chuyển tiền mà không ai
    # bên vận hành biết để đối soát, và họ chỉ phát hiện khi khách gọi điện phàn nàn.
    staff_notify.notify_staff(
        db,
        code=staff_notify.StaffNotifyCode.NEW_PAYMENT,
        title=f"Đơn nâng cấp gói mới: {package.name}",
        body=(
            f"{user.full_name} ({user.customer_code or user.email}) vừa tạo đơn "
            f"{float(sub.amount):,.0f}đ, nội dung chuyển khoản {ref}. "
            "Đối chiếu sao kê rồi xác nhận thanh toán để kích hoạt gói."
        ),
        link=f"/admin/customers/{user.id}?tab=subscriptions",
        level="warning",
        required_permission="customer.extend",
    )
    db.commit()

    return {
        "subscription_id": sub.id,
        "payment_ref": ref,
        "amount": float(sub.amount),
        "payment_status": sub.payment_status,
        "message": "Đơn hàng đã được tạo. Gói sẽ kích hoạt ngay sau khi thanh toán được xác nhận.",
        "instruction": {
            "method": payload.payment_method,
            "note": f"Nội dung chuyển khoản: {ref}",
        },
    }


@router.get("/subscriptions", response_model=dict)
def subscription_history(user: CurrentUser, db: DbSession, params: Pagination) -> dict:
    """BR-135 — lịch sử gói đầy đủ, phục vụ đối soát và khiếu nại."""
    stmt = (
        select(Subscription)
        .where(Subscription.user_id == user.id)
        .order_by(Subscription.id.desc())
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    packages = {p.id: p for p in db.scalars(select(Package)).all()}
    items = [
        SubscriptionHistoryItem(
            id=s.id,
            package_name=packages[s.package_id].name if s.package_id in packages else "",
            starts_at=s.starts_at,
            expires_at=s.expires_at,
            amount=s.amount,
            payment_status=s.payment_status,
            frozen_days=s.frozen_days or 0,
            created_by_type=s.created_by_type,
            note=s.note,
            created_at=s.created_at,
        )
        for s in rows
    ]
    return build_page(items, total, params)


@router.post("/ib-link", response_model=Message)
def link_ib_account(payload: IbLinkRequest, user: CurrentUser, db: DbSession) -> Message:
    """BR-200/201 — KH khai số TKCK; job đối chiếu với Google Sheet cuối ngày.

    Ô tick đồng ý dữ liệu NAV (BR-803) đã được gỡ khỏi site khách hàng theo yêu cầu, nên endpoint
    không còn đòi và cũng không còn ghi `UserConsent` cho loại NAV_CONSENT — không thể ghi nhận
    một đồng ý mà KH chưa từng bấm.
    """
    account_no = payload.securities_account_no.strip()
    user.securities_account_no = account_no
    # BR-201 — chưa xác nhận ngay; phải đối chiếu với dữ liệu nguồn mới có nghĩa.
    user.ib_link_status = IbLinkStatus.PENDING_LINK
    if user.compliance_status == ComplianceStatus.NOT_REQUIRED and user.customer_type == CustomerType.IB_LINKED:
        user.compliance_status = ComplianceStatus.PENDING_LINK
    if not user.ib_link_deadline:
        user.ib_link_deadline = utcnow() + timedelta(days=settings.ib_link_deadline_days)

    db.commit()

    return Message(
        message="Đã ghi nhận số tài khoản chứng khoán. Hệ thống sẽ đối chiếu vào cuối ngày giao dịch.",
        code="IB_LINK_PENDING",
    )


@router.get("/nav-history", response_model=list[NavPoint])
def nav_history(user: CurrentUser, db: DbSession, days: int = 90) -> list[NavPoint]:
    """Biểu đồ NAV của chính KH — cũng là bằng chứng khi KH khiếu nại về việc bị khoá."""
    rows = db.scalars(
        select(NavDaily)
        .where(NavDaily.user_id == user.id)
        .order_by(NavDaily.trade_date.desc())
        .limit(min(days, 365))
    ).all()
    return [
        NavPoint(trade_date=r.trade_date, nav=r.nav, last_trade_date=r.last_trade_date)
        for r in reversed(rows)
    ]


@router.get("/compliance", response_model=dict)
def compliance_detail(user: CurrentUser, db: DbSession) -> dict:
    """Màn "điều kiện duy trì tài khoản" — nêu rõ ngưỡng bằng số (yêu cầu của mục 9.2.2)."""
    from app.services import access_control, nav_sync_service

    nav_avg, sessions = nav_sync_service.nav_average(db, user.id)
    events = db.scalars(
        select(ComplianceEvent)
        .where(ComplianceEvent.user_id == user.id)
        .order_by(ComplianceEvent.id.desc())
        .limit(20)
    ).all()

    applicable = access_control.is_compliance_applicable(user)

    return {
        "applicable": applicable,
        "reason_not_applicable": (
            None if applicable
            else "Tài khoản của bạn không áp dụng điều kiện NAV/giao dịch "
                 "(gói dùng thử, tuyến trả phí thuần, hoặc được miễn áp dụng)"
        ),
        "compliance_status": user.compliance_status,
        "warning_until": user.warning_until,
        "suspended_reason": user.suspended_reason,
        "rules": {
            "nav_min": settings.compliance_nav_min,
            "nav_window_sessions": settings.compliance_nav_window,
            "no_trade_days": settings.compliance_no_trade_days,
            "warning_days": settings.compliance_warning_days,
            "description": (
                f"Tài khoản cần duy trì NAV trung bình {settings.compliance_nav_window} phiên "
                f"gần nhất từ {settings.compliance_nav_min:,.0f}đ trở lên, và có phát sinh "
                f"giao dịch trong vòng {settings.compliance_no_trade_days} ngày. "
                f"Khi chưa đạt, hệ thống cảnh báo trước "
                f"{settings.compliance_warning_days} ngày trước khi tạm dừng."
            ),
        },
        "current": {
            "nav_avg": float(nav_avg) if nav_avg is not None else None,
            "sessions_counted": sessions,
            "latest_nav": float(user.latest_nav) if user.latest_nav is not None else None,
            "latest_nav_date": user.latest_nav_date,
            "last_trade_date": user.last_trade_date,
            "has_data": nav_avg is not None,
        },
        "events": [ComplianceEventOut.model_validate(e) for e in events],
    }


@router.post("/request-deletion", response_model=Message)
def request_deletion(user: CurrentUser, db: DbSession) -> Message:
    """BR-804 — xoá mềm + ẩn danh hoá; giữ lại thanh toán và audit log theo nghĩa vụ kế toán."""
    if user.deleted_at:
        raise Conflict("Yêu cầu xoá tài khoản đã được ghi nhận trước đó", "ALREADY_REQUESTED")

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.ADMIN_BROADCAST,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"delete_req:{user.id}",
        context={
            "full_name": user.full_name,
            "message": "Chúng tôi đã nhận được yêu cầu xoá tài khoản của bạn và sẽ xử lý "
                       "trong vòng 7 ngày làm việc. Dữ liệu thanh toán được giữ lại theo "
                       "nghĩa vụ lưu trữ chứng từ kế toán.",
        },
    )
    db.commit()
    return Message(
        message="Đã ghi nhận yêu cầu xoá tài khoản. Bộ phận hỗ trợ sẽ liên hệ xác nhận.",
        code="DELETION_REQUESTED",
    )
