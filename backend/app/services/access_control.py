"""BR-001 — quy tắc tổng hợp quyết định KH có được vào hệ thống hay không.

Thứ tự ưu tiên **không được đổi**: compliance chặn TRƯỚC subscription, để không bán gói
cho một tài khoản mà ngay sau đó bị khoá vì NAV.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from app.core.constants import (
    BlockReason,
    ComplianceStatus,
    SubscriptionStatus,
)
from app.core.datetime_utils import days_between, to_local, utcnow
from app.models.user import User


@dataclass(slots=True)
class AccessDecision:
    """Kết quả xét quyền truy cập.

    `message` và `action` phục vụ BR-112 — thông báo phải nêu đúng lý do và hành động tiếp theo,
    không dùng thông báo chung chung.
    """

    allowed: bool
    reason: str = BlockReason.NONE
    message: str = ""
    action: dict[str, Any] = field(default_factory=dict)
    #: Banner cảnh báo hiển thị khi vẫn cho vào (GRACE, WARNING).
    banner: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "allowed": self.allowed,
            "reason": self.reason,
            "message": self.message,
            "action": self.action,
            "banner": self.banner,
        }


def _fmt(dt: datetime | None) -> str:
    local = to_local(dt)
    return local.strftime("%d/%m/%Y") if local else "—"


def evaluate_access(user: User, expires_at: datetime | None = None) -> AccessDecision:
    """Áp BR-001 cho một khách hàng.

    `expires_at` là ngày hết hạn của subscription đang hiệu lực (nếu có) — truyền vào để
    thông báo BR-112 nêu được ngày cụ thể.
    """
    # ---- 1. Compliance chặn trước ------------------------------------
    if user.compliance_status == ComplianceStatus.CLOSED:
        return AccessDecision(
            allowed=False,
            reason=BlockReason.ACCOUNT_CLOSED,
            message=(
                "Tài khoản của bạn đã được đóng bởi quản trị viên. "
                "Vui lòng liên hệ bộ phận hỗ trợ để được giải đáp."
            ),
            action={"type": "CONTACT_SUPPORT"},
        )

    if user.compliance_status == ComplianceStatus.SUSPENDED:
        broker = user.broker_name or "bộ phận chăm sóc khách hàng"
        phone = user.broker_phone or ""
        reason_code = _suspend_reason_code(user)
        if reason_code == BlockReason.COMPLIANCE_IB_LINK:
            message = (
                "Tài khoản tạm dừng do chưa hoàn tất liên kết tài khoản chứng khoán "
                f"trong thời hạn quy định. Liên hệ: {broker} {phone}".strip()
            )
        elif reason_code == BlockReason.COMPLIANCE_NO_TRADE:
            message = (
                "Tài khoản tạm dừng do không phát sinh giao dịch trong 90 ngày. "
                f"Liên hệ: {broker} {phone}".strip()
            )
        else:
            message = (
                f"Tài khoản tạm dừng do NAV tại ngày {_fmt(user.suspended_at)} "
                f"dưới mức tối thiểu. Liên hệ môi giới: {broker} {phone}".strip()
            )
        return AccessDecision(
            allowed=False,
            reason=reason_code,
            message=message,
            # BR-303 — SUSPENDED do compliance là có thể tự khôi phục.
            action={
                "type": "RESTORE_COMPLIANCE",
                "self_recoverable": True,
                "broker_name": user.broker_name,
                "broker_phone": user.broker_phone,
                "detail": user.suspended_reason,
            },
        )

    # ---- 2. Subscription --------------------------------------------
    if user.subscription_status == SubscriptionStatus.PENDING_VERIFY:
        return AccessDecision(
            allowed=False,
            reason=BlockReason.EMAIL_NOT_VERIFIED,
            message="Bạn cần xác thực email trước khi sử dụng dịch vụ. Vui lòng kiểm tra hộp thư.",
            action={"type": "VERIFY_EMAIL", "email": user.email},
        )

    if user.subscription_status == SubscriptionStatus.TRIAL_EXPIRED:
        return AccessDecision(
            allowed=False,
            reason=BlockReason.TRIAL_EXPIRED,
            message="Thời gian dùng thử 7 ngày đã kết thúc. Chọn gói dịch vụ để tiếp tục sử dụng.",
            action={"type": "CHOOSE_PACKAGE", "url": "/pricing"},
        )

    if user.subscription_status == SubscriptionStatus.EXPIRED:
        return AccessDecision(
            allowed=False,
            reason=BlockReason.SUBSCRIPTION_EXPIRED,
            message=f"Gói dịch vụ của bạn đã hết hạn ngày {_fmt(expires_at)}.",
            action={"type": "RENEW", "url": "/pricing", "expired_at": expires_at},
        )

    # ---- 3. Cho vào, kèm banner cảnh báo nếu cần ---------------------
    banner = None
    if user.subscription_status == SubscriptionStatus.GRACE:
        banner = {
            "level": "danger",
            "code": "GRACE",
            "message": (
                f"Gói dịch vụ đã hết hạn ngày {_fmt(expires_at)}. "
                "Bạn đang trong thời gian ân hạn — gia hạn ngay để không bị gián đoạn."
            ),
            "action": {"label": "Gia hạn ngay", "url": "/pricing"},
        }
    elif user.compliance_status == ComplianceStatus.WARNING:
        remaining = days_between(utcnow(), user.warning_until)
        banner = {
            "level": "warning",
            "code": "COMPLIANCE_WARNING",
            "days_left": max(remaining, 0) if remaining is not None else None,
            "message": (
                "Tài khoản của bạn chưa thoả mãn điều kiện duy trì. "
                f"Còn {max(remaining, 0) if remaining is not None else '—'} ngày trước khi tạm dừng. "
                f"Liên hệ môi giới: {user.broker_name or ''} {user.broker_phone or ''}".strip()
            ),
            "action": {"label": "Xem chi tiết điều kiện", "url": "/account/compliance"},
        }
    elif user.compliance_status == ComplianceStatus.PENDING_LINK and user.ib_link_deadline:
        remaining = days_between(utcnow(), user.ib_link_deadline)
        banner = {
            "level": "warning",
            "code": "PENDING_IB_LINK",
            "days_left": max(remaining, 0) if remaining is not None else None,
            "message": (
                "Bạn cần hoàn tất liên kết tài khoản chứng khoán mở dưới IB. "
                f"Hạn chót: {_fmt(user.ib_link_deadline)}."
            ),
            "action": {"label": "Liên kết ngay", "url": "/account/ib-link"},
        }

    return AccessDecision(allowed=True, banner=banner)


def _suspend_reason_code(user: User) -> str:
    """Suy ra mã lý do từ `suspended_reason` để FE hiển thị đúng thông điệp BR-112."""
    raw = (user.suspended_reason or "").upper()
    if "IB" in raw or "LINK" in raw:
        return BlockReason.COMPLIANCE_IB_LINK
    if "TRADE" in raw or "GIAO DỊCH" in raw.upper():
        return BlockReason.COMPLIANCE_NO_TRADE
    if "NAV" in raw:
        return BlockReason.COMPLIANCE_NAV
    return BlockReason.COMPLIANCE_SUSPENDED


def is_compliance_applicable(user: User) -> bool:
    """Ai bị áp điều kiện NAV/giao dịch?

    - Chốt 7.1: chỉ tuyến ``IB_LINKED``. Tuyến ``PAID_ONLY`` trả phí thuần chỉ chịu trục thời hạn.
    - Job compliance bỏ qua KH đang TRIAL (mục 2.6 bước 1).
    - `compliance_exempt` cho KH VIP (mục 3.4).
    """
    from app.core.constants import CustomerType

    if user.compliance_exempt:
        return False
    if user.customer_type != CustomerType.IB_LINKED:
        return False
    if user.subscription_status == SubscriptionStatus.TRIAL:
        return False
    return True
