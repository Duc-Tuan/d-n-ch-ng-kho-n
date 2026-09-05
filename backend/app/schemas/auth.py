"""Schema xác thực — Customer Site và Admin Site."""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.core.constants import CustomerType
from app.schemas.common import AccessInfo, ORMModel


# ======================================================================
# KHÁCH HÀNG
# ======================================================================
class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    full_name: str = Field(min_length=2, max_length=150)
    phone: str = Field(min_length=9, max_length=15)
    customer_type: Literal[CustomerType.IB_LINKED, CustomerType.PAID_ONLY] = CustomerType.IB_LINKED
    referral_code: str | None = Field(default=None, max_length=50)

    #: BR-800 — checkbox không được tick sẵn; FE gửi lên đúng những gì KH đã tick.
    accept_tos: bool
    accept_privacy: bool

    @field_validator("accept_tos", "accept_privacy")
    @classmethod
    def _must_accept(cls, v: bool) -> bool:
        if not v:
            raise ValueError("Bạn phải đồng ý với Điều khoản sử dụng và Chính sách bảo mật")
        return v

    @field_validator("full_name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        return v.strip()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)
    remember_me: bool = False


class VerifyEmailRequest(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class ResendVerificationRequest(BaseModel):
    email: EmailStr


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    email: EmailStr
    otp: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")
    new_password: str = Field(min_length=8, max_length=128)


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class UserProfile(ORMModel):
    id: int
    email: str
    full_name: str
    phone: str | None = None
    customer_code: str | None = None
    customer_type: str
    securities_account_no: str | None = None
    ib_link_status: str
    ib_link_deadline: datetime | None = None
    subscription_status: str
    compliance_status: str
    compliance_exempt: bool
    warning_until: datetime | None = None
    email_verified_at: datetime | None = None
    last_login_at: datetime | None = None
    broker_name: str | None = None
    broker_code: str | None = None
    broker_phone: str | None = None
    latest_nav: float | None = None
    latest_nav_date: date | None = None
    last_trade_date: date | None = None
    created_at: datetime


class SubscriptionInfo(ORMModel):
    id: int
    package_code: str
    package_name: str
    package_tier: int
    starts_at: datetime
    expires_at: datetime
    days_remaining: int | None = None
    frozen_days: int
    is_frozen: bool = False
    payment_status: str


class SessionResponse(BaseModel):
    """Trả về sau khi đăng nhập. Token đặt trong cookie HttpOnly; body chỉ chứa dữ liệu hiển thị."""

    user: UserProfile
    subscription: SubscriptionInfo | None = None
    access: AccessInfo
    access_token: str | None = None  # chỉ trả khi client yêu cầu (mobile/PWA)


# ======================================================================
# NHÂN VIÊN
# ======================================================================
class StaffLoginRequest(BaseModel):
    """Đăng nhập Admin Site — username/email + password."""

    username: str = Field(min_length=3, max_length=190)
    password: str = Field(min_length=1, max_length=128)


class ConfirmPasswordChangeRequest(BaseModel):
    """Mã 6 số gửi về email ở bước 1 của luồng đổi mật khẩu quản trị."""

    code: str = Field(min_length=6, max_length=6, pattern=r"^\d{6}$")


class StaffProfile(ORMModel):
    id: int
    username: str
    email: str
    full_name: str
    phone: str | None = None
    status: str
    totp_enabled: bool
    must_change_password: bool
    last_login_at: datetime | None = None
    roles: list[str] = []
    permissions: list[str] = []


class StaffSessionResponse(BaseModel):
    staff: StaffProfile
    access_token: str | None = None
