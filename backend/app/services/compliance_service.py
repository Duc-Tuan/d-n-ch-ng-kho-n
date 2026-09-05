"""Job kiểm tra điều kiện duy trì — mục 2.6.

Điều kiện đóng (định nghĩa chính xác):
  * **C1** — không phát sinh giao dịch: số ngày kể từ `last_trade_date` > 90.
  * **C2** — NAV trung bình 20 phiên gần nhất < 100.000.000đ (BR-300).

Điều kiện "có NAV nhưng không giao dịch" trong bản mô tả gốc trùng với C1 nên không tách riêng.

BR-301 là quy tắc quan trọng nhất của cả module: *không có dữ liệu ≠ vi phạm*.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import (
    ComplianceEventType,
    ComplianceStatus,
    NotificationChannel,
    NotificationCode,
    SubscriptionStatus,
    SyncJobStatus,
    SyncJobType,
)
from app.core.datetime_utils import days_between, ensure_aware, local_today, utcnow
from app.models.nav import ComplianceEvent, SyncJob
from app.models.user import User
from app.services import access_control, nav_sync_service, notification_service, subscription_service

log = logging.getLogger(__name__)


@dataclass(slots=True)
class ComplianceCheck:
    """Kết quả đo cho một khách hàng."""

    has_data: bool
    nav_avg: Decimal | None = None
    sessions_counted: int = 0
    days_since_last_trade: int | None = None
    violate_nav: bool = False
    violate_no_trade: bool = False
    missing_reason: str | None = None

    @property
    def violated(self) -> bool:
        return self.violate_nav or self.violate_no_trade

    @property
    def reason_text(self) -> str:
        parts = []
        if self.violate_nav:
            parts.append(
                f"NAV trung bình {self.sessions_counted} phiên = "
                f"{self.nav_avg:,.0f}đ < {settings.compliance_nav_min:,.0f}đ (C2)"
            )
        if self.violate_no_trade:
            parts.append(
                f"Không phát sinh giao dịch {self.days_since_last_trade} ngày "
                f"> {settings.compliance_no_trade_days} ngày (C1)"
            )
        return " · ".join(parts)


@dataclass(slots=True)
class ComplianceRunResult:
    checked: int = 0
    warned: int = 0
    suspended: int = 0
    restored: int = 0
    skipped_no_data: int = 0
    skipped_not_applicable: int = 0
    ib_link_suspended: int = 0
    errors: list[str] = None

    def __post_init__(self) -> None:
        if self.errors is None:
            self.errors = []


# ======================================================================
# Đo lường
# ======================================================================
def measure(db: Session, user: User) -> ComplianceCheck:
    """Đo C1 và C2. Không thay đổi trạng thái — chỉ trả về số liệu."""
    from app.services import settings_service

    nav_min = settings_service.get_int(db, "compliance_nav_min", settings.compliance_nav_min)
    no_trade_days = settings_service.get_int(
        db, "compliance_no_trade_days", settings.compliance_no_trade_days
    )

    nav_avg, sessions = nav_sync_service.nav_average(db, user.id)

    if nav_avg is None:
        # BR-301 — thiếu dữ liệu NAV: KHÔNG kết luận vi phạm.
        return ComplianceCheck(
            has_data=False,
            missing_reason="Không tìm thấy dữ liệu NAV của tài khoản trong dữ liệu đã đồng bộ",
        )

    days_since = days_between(user.last_trade_date, local_today())

    check = ComplianceCheck(
        has_data=True,
        nav_avg=nav_avg,
        sessions_counted=sessions,
        days_since_last_trade=days_since,
        # Chốt 7.3 — dùng `<` (đúng 100 triệu là ĐẠT).
        violate_nav=nav_avg < Decimal(nav_min),
        # Thiếu `last_trade_date` cũng là thiếu dữ liệu → không kết luận vi phạm C1.
        violate_no_trade=(days_since is not None and days_since > no_trade_days),
    )
    return check


# ======================================================================
# Chuyển trạng thái
# ======================================================================
def _record_event(
    db: Session,
    user: User,
    event: str,
    from_status: str,
    to_status: str,
    reason: str,
    check: ComplianceCheck | None = None,
    triggered_by: str = "job",
    staff_id: int | None = None,
) -> None:
    db.add(
        ComplianceEvent(
            user_id=user.id,
            event=event,
            from_status=from_status,
            to_status=to_status,
            reason=reason[:255],
            nav_avg_20=check.nav_avg if check else None,
            days_since_last_trade=check.days_since_last_trade if check else None,
            triggered_by=triggered_by,
            staff_id=staff_id,
        )
    )


def to_warning(db: Session, user: User, check: ComplianceCheck) -> None:
    """BR-302 — vòng cảnh báo 7 ngày trước khi khoá.

    Đây vừa là nghĩa vụ với KH đã trả tiền, vừa là cơ hội để môi giới gọi điện.
    """
    old = user.compliance_status
    user.compliance_status = ComplianceStatus.WARNING
    from app.services import settings_service

    warning_days = settings_service.get_int(
        db, "compliance_warning_days", settings.compliance_warning_days
    )
    user.warning_until = utcnow() + timedelta(days=warning_days)
    _record_event(db, user, ComplianceEventType.WARNING, old, ComplianceStatus.WARNING,
                  check.reason_text, check)

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.COMPLIANCE_WARNING,
        # Cảnh báo sắp khoá tài khoản đáng gửi SMS — KH mất quyền lợi nếu bỏ lỡ (BR-810).
        channels=[NotificationChannel.EMAIL, NotificationChannel.SMS, NotificationChannel.IN_APP],
        reference_id=f"warn:{user.warning_until:%Y%m%d}",
        context={
            "full_name": user.full_name,
            "reason": check.reason_text,
            "days_left": warning_days,
            "nav_avg": f"{check.nav_avg:,.0f}" if check.nav_avg else "—",
            "nav_min": f"{settings.compliance_nav_min:,.0f}",
            "broker_name": user.broker_name or "",
            "broker_phone": user.broker_phone or "",
        },
    )


def to_suspended(db: Session, user: User, reason: str, check: ComplianceCheck | None = None,
                 triggered_by: str = "job", staff_id: int | None = None) -> None:
    """BR-304 — khi tạm khoá, đồng hồ gói dừng đếm."""
    old = user.compliance_status
    user.compliance_status = ComplianceStatus.SUSPENDED
    user.suspended_at = utcnow()
    user.suspended_reason = reason[:255]
    user.warning_until = None
    subscription_service.freeze_subscription(db, user)
    _record_event(db, user, ComplianceEventType.SUSPEND, old, ComplianceStatus.SUSPENDED,
                  reason, check, triggered_by, staff_id)

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.COMPLIANCE_SUSPENDED,
        channels=[NotificationChannel.EMAIL, NotificationChannel.SMS, NotificationChannel.IN_APP],
        reference_id=f"susp:{user.suspended_at:%Y%m%d}",
        context={
            "full_name": user.full_name,
            "reason": reason,
            "broker_name": user.broker_name or "",
            "broker_phone": user.broker_phone or "",
        },
    )


def to_ok(db: Session, user: User, check: ComplianceCheck | None = None,
          triggered_by: str = "job", staff_id: int | None = None) -> int:
    """BR-303 — tự khôi phục. Trả về số ngày gói được bù (BR-304)."""
    old = user.compliance_status
    frozen_days = 0
    if old == ComplianceStatus.SUSPENDED:
        frozen_days = subscription_service.unfreeze_subscription(db, user)

    user.compliance_status = ComplianceStatus.OK
    user.warning_until = None
    user.suspended_at = None
    user.suspended_reason = None
    _record_event(
        db, user, ComplianceEventType.RESTORE, old, ComplianceStatus.OK,
        f"Đã thoả mãn điều kiện duy trì. Bù {frozen_days} ngày bị đóng băng." if frozen_days
        else "Đã thoả mãn điều kiện duy trì.",
        check, triggered_by, staff_id,
    )

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.COMPLIANCE_RESTORED,
        channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
        reference_id=f"restore:{utcnow():%Y%m%d%H%M}",
        context={
            "full_name": user.full_name,
            "frozen_days": frozen_days,
            "nav_avg": f"{check.nav_avg:,.0f}" if check and check.nav_avg else "—",
        },
    )
    return frozen_days


# ======================================================================
# Điểm vào của job — mục 2.6
# ======================================================================
def can_run_today(db: Session, run_date: date) -> tuple[bool, str]:
    """BR-301/405 — chỉ chạy khi `sync_nav` cùng ngày đã SUCCESS.

    Nếu sync thất bại hoặc dùng dữ liệu cũ, job compliance **không chạy**.
    """
    if not nav_sync_service.is_trading_day(db, run_date):
        return False, "Không phải ngày giao dịch (BR-402)"

    sync = db.scalar(
        select(SyncJob)
        .where(SyncJob.job_type == SyncJobType.SYNC_NAV, SyncJob.run_date == run_date)
        .order_by(SyncJob.id.desc())
    )
    if not sync:
        return False, "Chưa có job sync_nav nào chạy hôm nay — không xét compliance (BR-301)"
    if sync.status == SyncJobStatus.FAILED:
        return False, "Job sync_nav hôm nay THẤT BẠI — không xét compliance (BR-405)"
    if sync.status == SyncJobStatus.SKIPPED:
        return False, "Job sync_nav hôm nay bị bỏ qua"
    if sync.status == SyncJobStatus.PARTIAL and (sync.summary or {}).get("stale_data"):
        return False, "Dữ liệu NAV là dữ liệu cũ — không dùng để xét compliance (BR-403.3)"
    return True, ""


def run_check_compliance(
    db: Session, *, run_date: date | None = None, triggered_by: str = "scheduler",
    force: bool = False
) -> SyncJob:
    """Job `check_compliance` — 16:30, sau khi đồng bộ NAV xong."""
    run_date = run_date or local_today()

    job = SyncJob(
        job_type=SyncJobType.CHECK_COMPLIANCE,
        run_date=run_date,
        status=SyncJobStatus.RUNNING,
        started_at=utcnow(),
        triggered_by=triggered_by,
    )
    db.add(job)
    db.commit()

    if not force:
        allowed, why = can_run_today(db, run_date)
        if not allowed:
            job.status = SyncJobStatus.SKIPPED
            job.error_message = why
            job.finished_at = utcnow()
            db.commit()
            log.warning("check_compliance bỏ qua: %s", why)
            if "THẤT BẠI" in why:
                notification_service.notify_admins(
                    "Job compliance không chạy", f"{why}\nKhông tài khoản nào bị đổi trạng thái."
                )
            return job

    result = ComplianceRunResult()

    # Chỉ xét KH đang OK / WARNING / SUSPENDED (SUSPENDED để có thể tự khôi phục — BR-303).
    candidates = db.scalars(
        select(User).where(
            User.deleted_at.is_(None),
            User.compliance_status.in_(
                [ComplianceStatus.OK, ComplianceStatus.WARNING, ComplianceStatus.SUSPENDED]
            ),
        )
    ).all()

    for user in candidates:
        try:
            _process_user(db, user, result)
        except Exception as exc:  # một KH lỗi không được làm chết cả job
            log.exception("Lỗi xét compliance user_id=%s", user.id)
            result.errors.append(f"user_id={user.id}: {exc}")

    # Xử lý riêng nhóm quá hạn liên kết IB (BR-210 phương án B).
    _process_ib_link_deadline(db, result)

    db.commit()

    job.status = SyncJobStatus.SUCCESS if not result.errors else SyncJobStatus.PARTIAL
    job.rows_read = result.checked
    job.summary = {
        "checked": result.checked,
        "warned": result.warned,
        "suspended": result.suspended,
        "restored": result.restored,
        "skipped_no_data": result.skipped_no_data,
        "skipped_not_applicable": result.skipped_not_applicable,
        "ib_link_suspended": result.ib_link_suspended,
        "errors": result.errors[:50],
    }
    job.finished_at = utcnow()
    db.commit()

    if result.skipped_no_data:
        # BR-301 — thiếu dữ liệu phải báo admin, không được im lặng.
        notification_service.notify_admins(
            f"Compliance: {result.skipped_no_data} tài khoản thiếu dữ liệu NAV",
            "Các tài khoản này KHÔNG bị thay đổi trạng thái (BR-301). "
            "Kiểm tra lại Google Sheet xem có thiếu dòng không.",
        )
    if result.errors:
        notification_service.notify_admins(
            f"Compliance ngày {run_date} có {len(result.errors)} lỗi",
            "\n".join(result.errors[:30]),
        )
    return job


def _process_user(db: Session, user: User, result: ComplianceRunResult) -> None:
    # Bước 1 — TRIAL và tuyến PAID_ONLY không áp điều kiện IB.
    if not access_control.is_compliance_applicable(user):
        result.skipped_not_applicable += 1
        return

    result.checked += 1
    check = measure(db, user)

    # Bước 3 — BR-301: thiếu dữ liệu thì GHI LOG, KHÔNG đổi trạng thái, cảnh báo admin.
    if not check.has_data:
        result.skipped_no_data += 1
        log.info("Bỏ qua user_id=%s: %s", user.id, check.missing_reason)
        return

    now = utcnow()

    if check.violated:
        if user.compliance_status == ComplianceStatus.OK:
            to_warning(db, user, check)
            result.warned += 1
        elif user.compliance_status == ComplianceStatus.WARNING:
            warning_until = user.warning_until
            if warning_until and ensure_aware(warning_until, now) <= now:
                to_suspended(db, user, check.reason_text, check)
                result.suspended += 1
        # Đang SUSPENDED mà vẫn vi phạm → giữ nguyên.
    else:
        if user.compliance_status in (ComplianceStatus.WARNING, ComplianceStatus.SUSPENDED):
            to_ok(db, user, check)
            result.restored += 1


def _process_ib_link_deadline(db: Session, result: ComplianceRunResult) -> None:
    """BR-210 phương án B — quá 15 ngày chưa liên kết TKCK thì SUSPENDED, đóng băng đồng hồ gói."""
    now = utcnow()
    pending = db.scalars(
        select(User).where(
            User.deleted_at.is_(None),
            User.compliance_status == ComplianceStatus.PENDING_LINK,
            User.ib_link_deadline.is_not(None),
        )
    ).all()

    for user in pending:
        deadline = user.ib_link_deadline
        if ensure_aware(deadline, now) > now:
            continue
        to_suspended(
            db, user,
            "IB_LINK: Chưa hoàn tất liên kết tài khoản chứng khoán trong thời hạn quy định",
        )
        result.ib_link_suspended += 1


# ======================================================================
# Thao tác thủ công của admin
# ======================================================================
def admin_suspend(db: Session, user: User, reason: str, staff_id: int) -> None:
    to_suspended(db, user, reason, triggered_by="staff", staff_id=staff_id)


def admin_restore(db: Session, user: User, reason: str, staff_id: int) -> int:
    old = user.compliance_status
    frozen_days = subscription_service.unfreeze_subscription(db, user)
    user.compliance_status = (
        ComplianceStatus.OK
        if user.subscription_status != SubscriptionStatus.TRIAL
        else ComplianceStatus.NOT_REQUIRED
    )
    user.suspended_at = None
    user.suspended_reason = None
    user.closed_at = None
    user.warning_until = None
    _record_event(
        db, user,
        ComplianceEventType.REOPEN if old == ComplianceStatus.CLOSED else ComplianceEventType.RESTORE,
        old, user.compliance_status, reason, triggered_by="staff", staff_id=staff_id,
    )
    db.flush()
    return frozen_days


def admin_close(db: Session, user: User, reason: str, staff_id: int) -> None:
    """CLOSED — chỉ Super Admin, và chỉ admin mới mở lại được (mục 1.2)."""
    old = user.compliance_status
    user.compliance_status = ComplianceStatus.CLOSED
    user.closed_at = utcnow()
    user.suspended_reason = reason[:255]
    subscription_service.freeze_subscription(db, user)
    _record_event(db, user, ComplianceEventType.CLOSE, old, ComplianceStatus.CLOSED,
                  reason, triggered_by="staff", staff_id=staff_id)
    db.flush()


def admin_set_exempt(db: Session, user: User, exempt: bool, reason: str, staff_id: int) -> None:
    """Mục 3.4 — miễn áp điều kiện IB cho KH VIP hoặc trường hợp đặc biệt."""
    old = user.compliance_status
    user.compliance_exempt = exempt
    user.compliance_exempt_reason = reason[:255] if exempt else None
    if exempt and user.compliance_status in (
        ComplianceStatus.WARNING, ComplianceStatus.SUSPENDED, ComplianceStatus.PENDING_LINK
    ):
        subscription_service.unfreeze_subscription(db, user)
        user.compliance_status = ComplianceStatus.NOT_REQUIRED
        user.warning_until = None
        user.suspended_at = None
        user.suspended_reason = None
    _record_event(db, user, ComplianceEventType.EXEMPT, old, user.compliance_status,
                  reason, triggered_by="staff", staff_id=staff_id)
    db.flush()
