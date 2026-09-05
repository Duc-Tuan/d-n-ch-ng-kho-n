"""Vòng đời gói dịch vụ — mục 2.4, BR-130..135, BR-304."""

from __future__ import annotations

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Callable

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    IbLinkStatus,
    PaymentStatus,
    SubscriptionStatus,
)
from app.core.datetime_utils import add_months, days_between, ensure_aware, utcnow
from app.core.exceptions import Conflict, NotFound, ValidationError
from app.models.user import Package, Subscription, User

TRIAL_PACKAGE_CODE = "TRIAL"


# ----------------------------------------------------------------------
# Truy vấn
# ----------------------------------------------------------------------
def get_current_subscription(db: Session, user: User) -> Subscription | None:
    if user.current_subscription_id:
        sub = db.get(Subscription, user.current_subscription_id)
        if sub:
            return sub
    return db.scalar(
        select(Subscription)
        .where(Subscription.user_id == user.id, Subscription.is_current.is_(True))
        .order_by(Subscription.id.desc())
    )


def get_package_tier(db: Session, user: User) -> int:
    """Bậc gói hiện tại — dùng để so với `min_package` (BR-502/847)."""
    sub = get_current_subscription(db, user)
    if not sub:
        return 0
    pkg = db.get(Package, sub.package_id)
    return pkg.tier if pkg else 0


def can_access_min_package(db: Session, user: User, min_package_id: int | None) -> bool:
    """`min_package_id = None` nghĩa là nội dung mở cho mọi gói."""
    return package_gate(db, user)(min_package_id)


def package_gate(db: Session, user: User) -> Callable[[int | None], bool]:
    """Trả về hàm kiểm tra quyền xem theo bậc gói, đã **tính sẵn bậc của khách hàng**.

    Màn danh sách gọi phép kiểm tra này một lần cho mỗi dòng. Gọi thẳng
    `can_access_min_package` trong vòng lặp thì mỗi dòng lại đi tìm subscription hiện tại —
    với khách chưa có `current_subscription_id`, đó là một truy vấn thật cho **mỗi** bài viết
    trên trang. Tính một lần rồi đóng gói vào closure giữ nguyên ngữ nghĩa mà bỏ hẳn vòng lặp đó.
    """
    tier = get_package_tier(db, user)
    tiers: dict[int, int] = {}

    def allowed(min_package_id: int | None) -> bool:
        if min_package_id is None:
            return True
        if min_package_id not in tiers:
            required = db.get(Package, min_package_id)
            # Gói bị xoá khỏi bảng giá: mở, không khoá — khoá nhầm nội dung đã bán còn tệ hơn.
            tiers[min_package_id] = required.tier if required else 0
        return tier >= tiers[min_package_id]

    return allowed


# ----------------------------------------------------------------------
# Cấp gói
# ----------------------------------------------------------------------
def _compute_expiry(base: datetime, package: Package) -> datetime:
    """BR-130 — cộng theo tháng lịch; gói trial tính theo ngày."""
    if package.duration_months:
        return add_months(base, package.duration_months)
    return base + timedelta(days=package.duration_days or settings.trial_days)


def start_trial(db: Session, user: User) -> Subscription:
    """BR-100 — đồng hồ 7 ngày **chỉ chạy sau khi xác thực email thành công**.

    Mỗi tài khoản chỉ được dùng thử một lần duy nhất (mục 2.4).
    """
    if user.trial_used:
        raise Conflict("Tài khoản này đã sử dụng gói dùng thử", "TRIAL_ALREADY_USED")

    package = db.scalar(select(Package).where(Package.code == TRIAL_PACKAGE_CODE))
    if not package:
        raise NotFound("Chưa cấu hình gói dùng thử trong hệ thống", "TRIAL_PACKAGE_MISSING")

    now = utcnow()
    sub = Subscription(
        user_id=user.id,
        package_id=package.id,
        starts_at=now,
        expires_at=_compute_expiry(now, package),
        amount=Decimal(0),
        payment_status=PaymentStatus.PAID,
        created_by_type="self",
        is_current=True,
        note="Gói dùng thử tự động khi xác thực email (BR-100)",
    )
    _demote_previous(db, user)
    db.add(sub)
    db.flush()

    user.current_subscription_id = sub.id
    user.subscription_status = SubscriptionStatus.TRIAL
    user.trial_used = True
    # Mục 1.2 — TRIAL chưa áp điều kiện IB.
    user.compliance_status = ComplianceStatus.NOT_REQUIRED
    db.flush()
    return sub


def grant_package(
    db: Session,
    user: User,
    package: Package,
    *,
    amount: Decimal | None = None,
    payment_status: str = PaymentStatus.PAID,
    payment_ref: str | None = None,
    payment_method: str | None = None,
    created_by_type: str = "self",
    created_by_staff_id: int | None = None,
    note: str | None = None,
) -> Subscription:
    """Mua mới / gia hạn / nâng cấp.

    BR-131 — gia hạn khi gói **chưa hết hạn**: cộng dồn vào `expires_at` hiện tại.
              Gia hạn khi **đã hết hạn**: tính từ thời điểm thanh toán.
    BR-132 — nâng cấp giữa chừng: cộng dồn thời hạn gói mới, không hoàn tiền.
    BR-135 — luôn tạo bản ghi mới, không sửa đè.
    """
    now = utcnow()
    current = get_current_subscription(db, user)

    base = now
    if (
        current
        and current.payment_status == PaymentStatus.PAID
        and current.expires_at
        and ensure_aware(current.expires_at, now) > now
        and user.subscription_status in (SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE,
                                         SubscriptionStatus.GRACE)
    ):
        # Không cộng dồn phần còn lại của gói dùng thử — trial là quà, không phải thời hạn đã mua.
        current_pkg = db.get(Package, current.package_id)
        if current_pkg and not current_pkg.is_trial:
            base = current.expires_at if current.expires_at.tzinfo else current.expires_at.replace(
                tzinfo=now.tzinfo
            )

    sub = Subscription(
        user_id=user.id,
        package_id=package.id,
        starts_at=now,
        expires_at=_compute_expiry(base, package),
        amount=amount if amount is not None else package.price,
        payment_status=payment_status,
        payment_ref=payment_ref,
        payment_method=payment_method,
        paid_at=now if payment_status == PaymentStatus.PAID else None,
        created_by_type=created_by_type,
        created_by_staff_id=created_by_staff_id,
        note=note,
        is_current=payment_status == PaymentStatus.PAID,
    )

    if payment_status == PaymentStatus.PAID:
        _demote_previous(db, user)

    db.add(sub)
    db.flush()

    if payment_status == PaymentStatus.PAID:
        user.current_subscription_id = sub.id
        user.subscription_status = SubscriptionStatus.ACTIVE
        _apply_ib_requirement(user)
        db.flush()

    return sub


def confirm_payment(db: Session, user: User, sub: Subscription) -> Subscription:
    """Xác nhận đã nhận tiền cho một đơn `PENDING` — đây mới là lúc gói được kích hoạt.

    `grant_package` với `payment_status=PENDING` cố tình **không** bật `is_current` và không đổi
    trạng thái tài khoản: đơn mới tạo chưa phải là quyền sử dụng. Hàm này làm nốt phần đó.

    Hạn dùng được **tính lại tại thời điểm xác nhận**, không dùng lại `expires_at` ghi lúc đặt
    đơn. Khách chuyển khoản sau vài ngày mà vẫn lấy mốc cũ thì họ mất đúng số ngày chờ xác nhận.
    """
    if sub.payment_status == PaymentStatus.PAID:
        return sub

    package = db.get(Package, sub.package_id)
    if not package:
        raise ValidationError("Gói của đơn hàng không còn tồn tại", {"field": "package_id"})

    now = utcnow()
    current = get_current_subscription(db, user)

    base = now
    if (
        current
        and current.id != sub.id
        and current.payment_status == PaymentStatus.PAID
        and current.expires_at
        and ensure_aware(current.expires_at, now) > now
        and user.subscription_status in (SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE,
                                         SubscriptionStatus.GRACE)
    ):
        current_pkg = db.get(Package, current.package_id)
        if current_pkg and not current_pkg.is_trial:
            base = current.expires_at if current.expires_at.tzinfo else current.expires_at.replace(
                tzinfo=now.tzinfo
            )

    _demote_previous(db, user)

    sub.payment_status = PaymentStatus.PAID
    sub.paid_at = now
    sub.starts_at = now
    sub.expires_at = _compute_expiry(base, package)
    sub.is_current = True
    db.flush()

    user.current_subscription_id = sub.id
    user.subscription_status = SubscriptionStatus.ACTIVE
    _apply_ib_requirement(user)
    db.flush()
    return sub


def reject_payment(db: Session, sub: Subscription, status: str) -> Subscription:
    """Đánh dấu đơn không thành công (huỷ / thất bại / hoàn tiền).

    Không đụng tới trạng thái tài khoản: đơn `PENDING` chưa từng cấp quyền gì, nên bỏ nó đi không
    lấy lại gì cả. Bản ghi vẫn giữ để đối soát (BR-135).
    """
    sub.payment_status = status
    sub.is_current = False
    db.flush()
    return sub


def _demote_previous(db: Session, user: User) -> None:
    db.execute(
        update(Subscription)
        .where(Subscription.user_id == user.id, Subscription.is_current.is_(True))
        .values(is_current=False)
    )


def _apply_ib_requirement(user: User) -> None:
    """BR-200/210 — sau khi trả tiền, tuyến IB phải liên kết TKCK trong 15 ngày.

    Phương án B: cho vào ngay, đặt hạn; quá hạn chưa liên kết → SUSPENDED (đóng băng đồng hồ gói).
    """
    if user.customer_type != CustomerType.IB_LINKED or user.compliance_exempt:
        user.compliance_status = ComplianceStatus.NOT_REQUIRED
        return

    if user.ib_link_status == IbLinkStatus.OK:
        user.compliance_status = ComplianceStatus.OK
        return

    if user.compliance_status in (ComplianceStatus.NOT_REQUIRED, ComplianceStatus.PENDING_LINK):
        user.compliance_status = ComplianceStatus.PENDING_LINK
        if not user.ib_link_deadline:
            user.ib_link_deadline = utcnow() + timedelta(days=settings.ib_link_deadline_days)
        if user.ib_link_status == IbLinkStatus.NONE:
            user.ib_link_status = IbLinkStatus.PENDING_LINK


# ----------------------------------------------------------------------
# BR-304 — đóng băng thời hạn khi bị tạm khoá
# ----------------------------------------------------------------------
def freeze_subscription(db: Session, user: User) -> None:
    """Bắt đầu đóng băng đồng hồ gói (khi chuyển sang SUSPENDED).

    KH đã trả tiền cho 365 **ngày sử dụng**, không phải 365 ngày lịch.
    """
    sub = get_current_subscription(db, user)
    if sub and sub.frozen_since is None:
        sub.frozen_since = utcnow()
        db.flush()


def unfreeze_subscription(db: Session, user: User) -> int:
    """Kết thúc đóng băng, đẩy `expires_at` thêm đúng số ngày bị khoá. Trả về số ngày bù."""
    sub = get_current_subscription(db, user)
    if not sub or sub.frozen_since is None:
        return 0

    frozen_days = days_between(sub.frozen_since, utcnow()) or 0
    if frozen_days > 0:
        sub.expires_at = sub.expires_at + timedelta(days=frozen_days)
        sub.frozen_days = (sub.frozen_days or 0) + frozen_days
    sub.frozen_since = None
    db.flush()
    return frozen_days


# ----------------------------------------------------------------------
# Job check_subscription — Phần 6
# ----------------------------------------------------------------------
def refresh_subscription_status(db: Session, user: User, now: datetime | None = None) -> str | None:
    """TRIAL→TRIAL_EXPIRED, ACTIVE→GRACE→EXPIRED. Trả về trạng thái mới nếu có đổi.

    **Không đụng tới** `compliance_status` — hai trục hoàn toàn độc lập (mục 0.2).
    """
    now = now or utcnow()
    if user.subscription_status in (
        SubscriptionStatus.PENDING_VERIFY,
        SubscriptionStatus.TRIAL_EXPIRED,
        SubscriptionStatus.EXPIRED,
    ):
        return None

    sub = get_current_subscription(db, user)
    if not sub:
        return None

    # BR-304 — đồng hồ đang bị đóng băng thì không tính hết hạn.
    if sub.frozen_since is not None:
        return None

    expires = sub.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=now.tzinfo)
    if expires > now:
        return None

    overdue_days = (now - expires).days
    old = user.subscription_status

    if user.subscription_status == SubscriptionStatus.TRIAL:
        user.subscription_status = SubscriptionStatus.TRIAL_EXPIRED
    elif overdue_days < settings.grace_days:
        # BR-134 — ân hạn 3 ngày, vẫn truy cập được kèm banner đỏ.
        user.subscription_status = SubscriptionStatus.GRACE
    else:
        user.subscription_status = SubscriptionStatus.EXPIRED

    if old == user.subscription_status:
        return None
    db.flush()
    return user.subscription_status


def validate_package_purchase(db: Session, package_id: int) -> Package:
    package = db.get(Package, package_id)
    if not package or not package.is_active:
        raise NotFound("Gói dịch vụ không tồn tại hoặc đã ngừng bán", "PACKAGE_NOT_FOUND")
    if package.is_trial:
        raise ValidationError("Không thể tự mua gói dùng thử", {"field": "package_id"})
    return package
