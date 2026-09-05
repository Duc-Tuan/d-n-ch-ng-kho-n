"""API xác thực Admin Site — BR-000 (tách hoàn toàn khỏi Customer).

Đăng nhập chỉ còn một bước: username/email + mật khẩu. Bước nhập mã 6 số (2FA TOTP)
đã được gỡ theo yêu cầu vận hành.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from sqlalchemy import select

from app.core.config import settings
from app.core.deps import (
    STAFF_ACCESS_COOKIE,
    STAFF_REFRESH_COOKIE,
    CurrentStaff,
    DbSession,
    client_ip,
    user_agent,
)
from app.core.exceptions import Unauthorized
from app.core.security import create_token, decode_token, sha256_hash
from app.core.datetime_utils import ensure_aware, utcnow
from app.models.staff import Staff, StaffSession
from app.schemas.auth import (
    ChangePasswordRequest,
    ConfirmPasswordChangeRequest,
    StaffLoginRequest,
    StaffProfile,
    StaffSessionResponse,
)
from app.schemas.common import Message
from app.services import notification_service, rbac, staff_auth_service

router = APIRouter(prefix="/auth", tags=["admin-auth"])


def _build_profile(staff: Staff) -> StaffProfile:
    # Dựng thủ công vì `Staff.roles` là quan hệ tới object Role, còn schema cần list mã role.
    return StaffProfile(
        id=staff.id,
        username=staff.username,
        email=staff.email,
        full_name=staff.full_name,
        phone=staff.phone,
        status=staff.status,
        totp_enabled=staff.totp_enabled,
        must_change_password=staff.must_change_password,
        last_login_at=staff.last_login_at,
        roles=[r.code for r in staff.roles],
        # BR-533 — danh sách này chỉ để FE ẩn/hiện menu, không phải chốt chặn.
        permissions=rbac.effective_permissions(staff),
    )


def _set_cookies(response: Response, access: str, refresh: str) -> None:
    secure = settings.is_production
    response.set_cookie(
        STAFF_ACCESS_COOKIE, access, httponly=True, secure=secure, samesite="strict",
        max_age=settings.access_token_minutes * 60, path="/",
    )
    response.set_cookie(
        STAFF_REFRESH_COOKIE, refresh, httponly=True, secure=secure, samesite="strict",
        max_age=settings.refresh_token_days * 86400, path="/",
    )


@router.post("/login", response_model=StaffSessionResponse)
def login(payload: StaffLoginRequest, request: Request, response: Response,
          db: DbSession) -> StaffSessionResponse:
    """Mật khẩu đúng là cấp session ngay — không còn bước nhập mã 6 số."""
    ip, ua = client_ip(request), user_agent(request)
    staff = staff_auth_service.authenticate_staff(db, payload.username, payload.password, ip, ua)

    access, refresh_token = staff_auth_service.create_staff_session(db, staff, ip, ua)
    db.commit()

    _set_cookies(response, access, refresh_token)
    return StaffSessionResponse(staff=_build_profile(staff))


@router.post("/refresh", response_model=StaffSessionResponse)
def refresh(request: Request, response: Response, db: DbSession) -> StaffSessionResponse:
    token = request.cookies.get(STAFF_REFRESH_COOKIE)
    if not token:
        raise Unauthorized()

    payload = decode_token(token, "staff")
    if not payload or payload.get("typ") != "refresh":
        raise Unauthorized()

    session = db.scalar(
        select(StaffSession).where(
            StaffSession.session_id == payload.get("sid"),
            StaffSession.refresh_token_hash == sha256_hash(token),
        )
    )
    if not session or session.revoked_at:
        raise Unauthorized("Phiên đăng nhập đã kết thúc", "SESSION_REVOKED")
    if ensure_aware(session.expires_at, utcnow()) < utcnow():
        raise Unauthorized("Phiên đăng nhập đã hết hạn", "SESSION_EXPIRED")

    staff = db.get(Staff, int(payload["sub"]))
    if not staff:
        raise Unauthorized()

    access = create_token(staff.id, "staff", "access", session_id=session.session_id)
    response.set_cookie(
        STAFF_ACCESS_COOKIE, access, httponly=True, secure=settings.is_production,
        samesite="strict", max_age=settings.access_token_minutes * 60, path="/",
    )
    return StaffSessionResponse(staff=_build_profile(staff))


@router.post("/logout", response_model=Message)
def logout(request: Request, response: Response, db: DbSession) -> Message:
    token = request.cookies.get(STAFF_ACCESS_COOKIE)
    if token:
        payload = decode_token(token, "staff")
        if payload and payload.get("sid"):
            staff_auth_service.revoke_staff_session(db, payload["sid"])
            db.commit()
    response.delete_cookie(STAFF_ACCESS_COOKIE, path="/")
    response.delete_cookie(STAFF_REFRESH_COOKIE, path="/")
    return Message(message="Đã đăng xuất")


@router.get("/me", response_model=StaffProfile)
def me(staff: CurrentStaff) -> StaffProfile:
    """Trả kèm danh sách quyền để FE ẩn/hiện menu.

    Lưu ý BR-533: đây chỉ là tiện ích giao diện — chặn thật nằm ở từng endpoint.
    """
    return _build_profile(staff)


@router.post("/change-password/request", response_model=Message)
def request_change_password(payload: ChangePasswordRequest, staff: CurrentStaff, request: Request,
                            db: DbSession) -> Message:
    """Bước 1 — kiểm tra mật khẩu rồi gửi mã xác nhận về email của chính nhân viên.

    Mật khẩu chưa đổi ở bước này. Email đi tới hòm thư đã đăng ký, nên nếu ai đó chiếm được phiên
    đang mở và cố đổi mật khẩu, chủ tài khoản thật vẫn nhận được thư và biết ngay.
    """
    code = staff_auth_service.request_password_change(
        db, staff, payload.current_password, payload.new_password, client_ip(request)
    )
    db.commit()

    ttl = staff_auth_service.PASSWORD_CHANGE_TTL_MINUTES
    notification_service.send_email(
        staff.email,
        "Mã xác nhận đổi mật khẩu quản trị",
        (
            f"Xin chào {staff.full_name},\n\n"
            f"Mã xác nhận đổi mật khẩu tài khoản quản trị của bạn là: {code}\n"
            f"Mã có hiệu lực trong {ttl} phút.\n\n"
            "Nếu bạn không thực hiện thao tác này, hãy đổi mật khẩu ngay và báo cho quản trị viên: "
            "có người đang truy cập được vào phiên làm việc của bạn."
        ),
    )

    masked = _mask_email(staff.email)
    return Message(
        message=f"Đã gửi mã xác nhận tới {masked}. Mã có hiệu lực {ttl} phút.",
        code="CHANGE_PASSWORD_CODE_SENT",
    )


@router.post("/change-password/confirm", response_model=Message)
def confirm_change_password(payload: ConfirmPasswordChangeRequest, staff: CurrentStaff,
                            response: Response, db: DbSession) -> Message:
    """Bước 2 — xác nhận đúng mã thì mật khẩu mới có hiệu lực và mọi phiên bị thu hồi."""
    staff_auth_service.confirm_password_change(db, staff, payload.code)
    db.commit()

    response.delete_cookie(STAFF_ACCESS_COOKIE, path="/")
    response.delete_cookie(STAFF_REFRESH_COOKIE, path="/")
    return Message(message="Đổi mật khẩu thành công. Vui lòng đăng nhập lại.")


def _mask_email(email: str) -> str:
    """Che bớt email khi hiển thị lại — đủ để người dùng nhận ra hòm thư của mình."""
    name, _, domain = email.partition("@")
    if len(name) <= 2:
        return f"{name[:1]}***@{domain}"
    return f"{name[:2]}{'*' * max(len(name) - 3, 1)}{name[-1]}@{domain}"
