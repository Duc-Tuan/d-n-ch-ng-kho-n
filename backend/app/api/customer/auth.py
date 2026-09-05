"""API xác thực Customer Site — mục 2.1, 2.2, 2.3."""

from __future__ import annotations

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import select

from app.core.config import settings
from app.core.constants import LegalDocType, LoginResult
from app.core.datetime_utils import days_between, utcnow
from app.core.deps import (
    CUSTOMER_ACCESS_COOKIE,
    CUSTOMER_REFRESH_COOKIE,
    CurrentUser,
    DbSession,
    client_ip,
    user_agent,
)
from app.core.exceptions import Unauthorized
from app.core.security import create_token, decode_token, sha256_hash
from app.models.notification import LegalDocument, UserConsent
from app.models.user import Package, UserSession
from app.schemas.auth import (
    ChangePasswordRequest,
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    SessionResponse,
    SubscriptionInfo,
    UserProfile,
    VerifyEmailRequest,
)
from app.schemas.common import Message
from app.services import access_control, auth_service, subscription_service

router = APIRouter(prefix="/auth", tags=["customer-auth"])


# ----------------------------------------------------------------------
# Tiện ích
# ----------------------------------------------------------------------
def _set_auth_cookies(response: Response, access: str, refresh: str) -> None:
    """Cookie HttpOnly, tên riêng cho Customer Site (BR-000)."""
    secure = settings.is_production
    response.set_cookie(
        CUSTOMER_ACCESS_COOKIE, access, httponly=True, secure=secure, samesite="lax",
        max_age=settings.access_token_minutes * 60, path="/",
    )
    response.set_cookie(
        CUSTOMER_REFRESH_COOKIE, refresh, httponly=True, secure=secure, samesite="lax",
        max_age=settings.refresh_token_days * 86400, path="/",
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(CUSTOMER_ACCESS_COOKIE, path="/")
    response.delete_cookie(CUSTOMER_REFRESH_COOKIE, path="/")


def _build_subscription_info(db, user) -> SubscriptionInfo | None:
    sub = subscription_service.get_current_subscription(db, user)
    if not sub:
        return None
    package = db.get(Package, sub.package_id)
    return SubscriptionInfo(
        id=sub.id,
        package_code=package.code if package else "",
        package_name=package.name if package else "",
        package_tier=package.tier if package else 0,
        starts_at=sub.starts_at,
        expires_at=sub.expires_at,
        days_remaining=days_between(utcnow(), sub.expires_at),
        frozen_days=sub.frozen_days or 0,
        is_frozen=sub.frozen_since is not None,
        payment_status=sub.payment_status,
    )


def _build_session_response(db, user, include_token: str | None = None) -> SessionResponse:
    sub = subscription_service.get_current_subscription(db, user)
    decision = access_control.evaluate_access(user, sub.expires_at if sub else None)
    return SessionResponse(
        user=UserProfile.model_validate(user),
        subscription=_build_subscription_info(db, user),
        access=decision.as_dict(),
        access_token=include_token,
    )


def _record_consents(db, user, ip: str | None, ua: str | None) -> None:
    """BR-800 — lưu bằng chứng đồng ý: user, đúng phiên bản văn bản, timestamp, IP."""
    docs = db.scalars(
        select(LegalDocument).where(
            LegalDocument.is_current.is_(True),
            LegalDocument.type.in_([LegalDocType.TOS, LegalDocType.PRIVACY]),
        )
    ).all()
    for doc in docs:
        db.add(
            UserConsent(
                user_id=user.id,
                legal_document_id=doc.id,
                consented_at=utcnow(),
                ip=ip,
                user_agent=(ua or "")[:400] or None,
            )
        )
    db.flush()


# ----------------------------------------------------------------------
# Đăng ký
# ----------------------------------------------------------------------
@router.post("/register", response_model=Message, status_code=status.HTTP_201_CREATED)
def register(payload: RegisterRequest, request: Request, db: DbSession) -> Message:
    """Mục 2.1 — kết thúc bằng màn 'Vui lòng kiểm tra email', chưa cho đăng nhập."""
    ip = client_ip(request)
    auth_service.check_ip_signup_quota(db, ip)
    auth_service.validate_registration(db, payload.email, payload.phone, payload.password)

    user = auth_service.create_user(
        db,
        email=payload.email,
        password=payload.password,
        full_name=payload.full_name,
        phone=payload.phone,
        customer_type=payload.customer_type,
        referral_code=payload.referral_code,
        ip=ip,
    )
    _record_consents(db, user, ip, user_agent(request))
    auth_service.issue_email_verification(db, user)
    db.commit()

    return Message(
        message="Đăng ký thành công. Vui lòng kiểm tra email để xác thực tài khoản.",
        code="VERIFICATION_SENT",
    )


@router.post("/verify-email", response_model=SessionResponse)
def verify_email(payload: VerifyEmailRequest, request: Request, response: Response,
                 db: DbSession) -> SessionResponse:
    """BR-100 — xác thực xong mới bắt đầu đếm 7 ngày dùng thử, và đăng nhập luôn."""
    user = auth_service.verify_email(db, payload.token)
    access, refresh, _ = auth_service.create_session(
        db, user, client_ip(request), user_agent(request)
    )
    db.commit()
    _set_auth_cookies(response, access, refresh)
    return _build_session_response(db, user)


@router.post("/resend-verification", response_model=Message)
def resend_verification(payload: ResendVerificationRequest, db: DbSession) -> Message:
    """BR-101 — giới hạn 3 lần/ngày."""
    auth_service.resend_verification(db, payload.email)
    db.commit()
    return Message(
        message="Nếu tài khoản tồn tại và chưa xác thực, link mới đã được gửi tới email của bạn."
    )


# ----------------------------------------------------------------------
# Đăng nhập
# ----------------------------------------------------------------------
@router.post("/login", response_model=SessionResponse)
def login(payload: LoginRequest, request: Request, response: Response,
          db: DbSession) -> SessionResponse:
    """Mục 2.2 — trả về 200 kể cả khi bị BR-001 chặn.

    Lý do: FE cần biết **lý do chặn và hành động tiếp theo** (BR-112) để hiển thị đúng màn
    (gia hạn / xác thực email / liên hệ môi giới). Nếu trả 403 trống thì KH chỉ thấy
    "không đăng nhập được" và sẽ gọi tổng đài.
    """
    ip, ua = client_ip(request), user_agent(request)
    user = auth_service.authenticate(db, payload.email, payload.password, ip, ua)

    sub = subscription_service.get_current_subscription(db, user)
    decision = access_control.evaluate_access(user, sub.expires_at if sub else None)

    if not decision.allowed:
        auth_service.log_login(
            db, user_id=user.id, email=user.email, result=LoginResult.BLOCKED,
            ip=ip, user_agent=ua, note=decision.reason,
        )
        db.commit()
        return _build_session_response(db, user)

    access, refresh, _ = auth_service.create_session(db, user, ip, ua)
    auth_service.log_login(
        db, user_id=user.id, email=user.email, result=LoginResult.SUCCESS, ip=ip, user_agent=ua
    )
    db.commit()
    _set_auth_cookies(response, access, refresh)
    return _build_session_response(db, user)


@router.post("/refresh", response_model=SessionResponse)
def refresh_token(request: Request, response: Response, db: DbSession) -> SessionResponse:
    token = request.cookies.get(CUSTOMER_REFRESH_COOKIE)
    if not token:
        raise Unauthorized()

    payload = decode_token(token, "customer")
    if not payload or payload.get("typ") != "refresh":
        raise Unauthorized()

    session = db.scalar(
        select(UserSession).where(
            UserSession.session_id == payload.get("sid"),
            UserSession.refresh_token_hash == sha256_hash(token),
        )
    )
    if not session or session.revoked_at:
        _clear_auth_cookies(response)
        raise Unauthorized("Phiên đăng nhập đã kết thúc", "SESSION_REVOKED")

    from app.models.user import User

    user = db.get(User, int(payload["sub"]))
    if not user or user.deleted_at:
        raise Unauthorized()

    access = create_token(user.id, "customer", "access", session_id=session.session_id)
    session.last_seen_at = utcnow()
    db.commit()

    response.set_cookie(
        CUSTOMER_ACCESS_COOKIE, access, httponly=True, secure=settings.is_production,
        samesite="lax", max_age=settings.access_token_minutes * 60, path="/",
    )
    return _build_session_response(db, user)


@router.post("/logout", response_model=Message)
def logout(request: Request, response: Response, db: DbSession) -> Message:
    token = request.cookies.get(CUSTOMER_ACCESS_COOKIE)
    if token:
        payload = decode_token(token, "customer")
        if payload and payload.get("sid"):
            auth_service.revoke_session(db, payload["sid"], "LOGOUT")
            db.commit()
    _clear_auth_cookies(response)
    return Message(message="Đã đăng xuất")


@router.get("/me", response_model=SessionResponse)
def me(user: CurrentUser, db: DbSession) -> SessionResponse:
    """Trả cả trạng thái BR-001 để FE hiển thị banner GRACE/WARNING trên mọi trang."""
    return _build_session_response(db, user)


# ----------------------------------------------------------------------
# Quên / đổi mật khẩu
# ----------------------------------------------------------------------
@router.post("/forgot-password", response_model=Message)
def forgot_password(payload: ForgotPasswordRequest, request: Request, db: DbSession) -> Message:
    """Mục 2.3 — **luôn** trả về cùng một thông báo dù email có tồn tại hay không."""
    auth_service.request_password_reset(db, payload.email, client_ip(request))
    db.commit()
    return Message(message="Nếu email tồn tại, mã xác thực đã được gửi.", code="OTP_SENT")


@router.post("/reset-password", response_model=Message)
def reset_password(payload: ResetPasswordRequest, response: Response, db: DbSession) -> Message:
    """BR-121/122 — mã dùng một lần, huỷ toàn bộ session, gửi email thông báo."""
    auth_service.reset_password(db, payload.email, payload.otp, payload.new_password)
    db.commit()
    _clear_auth_cookies(response)
    return Message(
        message="Đổi mật khẩu thành công. Vui lòng đăng nhập lại.", code="PASSWORD_RESET"
    )


@router.post("/change-password", response_model=Message)
def change_password(payload: ChangePasswordRequest, user: CurrentUser, response: Response,
                    db: DbSession) -> Message:
    auth_service.change_password(db, user, payload.current_password, payload.new_password)
    db.commit()
    _clear_auth_cookies(response)
    return Message(message="Đổi mật khẩu thành công. Vui lòng đăng nhập lại.")
