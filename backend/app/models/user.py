"""Khách hàng và vòng đời tài khoản (Phần 2)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    IbLinkStatus,
    PaymentStatus,
    SubscriptionStatus,
)
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class User(Base, IdMixin, TimestampMixin):
    """Tài khoản khách hàng — **tách hoàn toàn** khỏi bảng `staff` (BR-000)."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(190), unique=True, nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20), unique=True)  # BR-105
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)

    #: Chốt 7.1 — tuyến khách hàng quyết định có áp điều kiện IB hay không.
    customer_type: Mapped[str] = mapped_column(
        String(20), nullable=False, default=CustomerType.IB_LINKED, index=True
    )

    # ----- liên kết tài khoản chứng khoán (BR-200..202) -----
    securities_account_no: Mapped[str | None] = mapped_column(String(50), index=True)
    ib_link_status: Mapped[str] = mapped_column(String(20), nullable=False, default=IbLinkStatus.NONE)
    ib_link_deadline: Mapped[datetime | None] = mapped_column(DateTime)  # BR-210 phương án B
    ib_linked_at: Mapped[datetime | None] = mapped_column(DateTime)
    broker_name: Mapped[str | None] = mapped_column(String(150))   # F23
    broker_code: Mapped[str | None] = mapped_column(String(50))
    broker_phone: Mapped[str | None] = mapped_column(String(20))

    # ----- xác thực -----
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    phone_verified_at: Mapped[datetime | None] = mapped_column(DateTime)

    # ----- HAI TRỤC TRẠNG THÁI (mục 0.2) — không bao giờ gộp làm một cột -----
    subscription_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=SubscriptionStatus.PENDING_VERIFY, index=True
    )
    compliance_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ComplianceStatus.NOT_REQUIRED, index=True
    )

    current_subscription_id: Mapped[int | None] = mapped_column(PKType)
    trial_used: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    # ----- compliance -----
    compliance_exempt: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)  # mục 3.4
    compliance_exempt_reason: Mapped[str | None] = mapped_column(String(255))
    warning_until: Mapped[datetime | None] = mapped_column(DateTime)   # BR-302
    suspended_at: Mapped[datetime | None] = mapped_column(DateTime)
    suspended_reason: Mapped[str | None] = mapped_column(String(255))  # BR-112
    closed_at: Mapped[datetime | None] = mapped_column(DateTime)
    latest_nav: Mapped[Decimal | None] = mapped_column(Numeric(20, 2))
    latest_nav_date: Mapped[date | None] = mapped_column(Date)
    last_trade_date: Mapped[date | None] = mapped_column(Date)

    # ----- đăng nhập -----
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)  # BR-110
    signup_ip: Mapped[str | None] = mapped_column(String(45))

    #: Mã hiển thị trên tin nhắn Telegram để truy vết rò rỉ (BR-869).
    customer_code: Mapped[str | None] = mapped_column(String(20), unique=True)

    # ----- xoá mềm / ẩn danh hoá (BR-804) -----
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    subscriptions: Mapped[list["Subscription"]] = relationship(
        back_populates="user", cascade="all, delete-orphan", order_by="Subscription.id.desc()"
    )

    __table_args__ = (
        Index("ix_users_two_axis", "subscription_status", "compliance_status"),
        Index("ix_users_warning_until", "warning_until"),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.id} {self.email}>"


class Package(Base, IdMixin, TimestampMixin):
    """Gói dịch vụ — mục 2.4."""

    __tablename__ = "packages"

    code: Mapped[str] = mapped_column(String(30), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    duration_months: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    duration_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)  # dùng cho gói trial
    price: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=0)
    is_trial: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    description: Mapped[str | None] = mapped_column(Text)

    #: Hạn mức theo gói — BR-856 (số câu hỏi AI/ngày) và BR-860 (số cặp đăng ký Telegram).
    #: 0 = không cho dùng, -1 = không giới hạn.
    max_telegram_alerts: Mapped[int] = mapped_column(Integer, nullable=False, default=5)
    max_ai_questions_per_day: Mapped[int] = mapped_column(Integer, nullable=False, default=5)

    #: Thứ bậc gói dùng để so sánh `min_package` (BR-502/847). Số càng lớn càng cao cấp.
    tier: Mapped[int] = mapped_column(Integer, nullable=False, default=0, index=True)


class Subscription(Base, IdMixin, CreatedAtMixin):
    """BR-135 — mỗi lần mua/gia hạn là **một bản ghi mới**, không sửa đè."""

    __tablename__ = "subscriptions"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    package_id: Mapped[int] = mapped_column(PKType, ForeignKey("packages.id"), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)

    #: BR-304 — số ngày bị khoá, đã được cộng bù vào `expires_at`.
    frozen_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Mốc bắt đầu bị đóng băng; NULL nghĩa là đồng hồ đang chạy.
    frozen_since: Mapped[datetime | None] = mapped_column(DateTime)

    amount: Mapped[Decimal] = mapped_column(Numeric(15, 2), nullable=False, default=0)
    payment_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=PaymentStatus.PENDING, index=True
    )
    payment_ref: Mapped[str | None] = mapped_column(String(100))
    payment_method: Mapped[str | None] = mapped_column(String(30))
    paid_at: Mapped[datetime | None] = mapped_column(DateTime)

    #: 'self' khi KH tự mua, hoặc id nhân viên cấp tay (mục 3.4 — bắt buộc có lý do).
    created_by_type: Mapped[str] = mapped_column(String(10), nullable=False, default="self")
    created_by_staff_id: Mapped[int | None] = mapped_column(PKType)
    note: Mapped[str | None] = mapped_column(Text)

    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    user: Mapped[User] = relationship(back_populates="subscriptions")
    package: Mapped[Package] = relationship()

    __table_args__ = (Index("ix_sub_user_current", "user_id", "is_current"),)


class EmailVerification(Base, IdMixin, CreatedAtMixin):
    """Token xác thực email — BR-100/101."""

    __tablename__ = "email_verifications"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class PasswordReset(Base, IdMixin, CreatedAtMixin):
    """Quên mật khẩu — mục 2.3, BR-120/121."""

    __tablename__ = "password_resets"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    otp_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    request_ip: Mapped[str | None] = mapped_column(String(45))


class UserSession(Base, IdMixin, CreatedAtMixin):
    """BR-111 — mặc định chỉ 1 phiên hoạt động cùng lúc."""

    __tablename__ = "user_sessions"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    device_fingerprint: Mapped[str | None] = mapped_column(String(64), index=True)
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(400))
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)
    revoked_reason: Mapped[str | None] = mapped_column(String(50))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)


class LoginLog(Base, IdMixin, CreatedAtMixin):
    """BR-110 — dữ liệu để admin theo dõi lịch sử truy cập của KH."""

    __tablename__ = "login_logs"

    user_id: Mapped[int | None] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), index=True)
    actor_type: Mapped[str] = mapped_column(String(10), nullable=False, default="USER")
    email_attempted: Mapped[str | None] = mapped_column(String(190), index=True)
    ip: Mapped[str | None] = mapped_column(String(45), index=True)
    user_agent: Mapped[str | None] = mapped_column(String(400))
    device_fingerprint: Mapped[str | None] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    note: Mapped[str | None] = mapped_column(String(255))


class CustomerNote(Base, IdMixin, TimestampMixin):
    """Nhật ký chăm sóc của môi giới — mục 3.4."""

    __tablename__ = "customer_notes"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    staff_id: Mapped[int] = mapped_column(PKType, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)


class TrialAbuseLog(Base, IdMixin, CreatedAtMixin):
    """BR-105 — đếm số tài khoản trial mới theo IP mỗi ngày."""

    __tablename__ = "trial_abuse_logs"

    ip: Mapped[str] = mapped_column(String(45), nullable=False)
    signup_date: Mapped[date] = mapped_column(Date, nullable=False)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    __table_args__ = (UniqueConstraint("ip", "signup_date", name="uq_trial_abuse_ip_date"),)
