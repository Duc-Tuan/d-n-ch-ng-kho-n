"""Dependency dùng chung cho FastAPI.

BR-000 — hai luồng xác thực tách biệt: `current_user` (Customer Site) và
`current_staff` (Admin Site) dùng cookie khác nhau, secret khác nhau, bảng khác nhau.
BR-533 — `require_permission` là chốt chặn thật của phân quyền, không phải việc ẩn menu ở FE.
"""

from __future__ import annotations

from typing import Annotated, Callable

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import StaffStatus
from app.core.database import get_db
from app.core.datetime_utils import utcnow
from app.core.exceptions import AccessBlocked, Forbidden, Unauthorized
from app.core.security import decode_token
from app.models.staff import Staff, StaffSession
from app.models.user import User, UserSession
from app.services import access_control, rbac

CUSTOMER_ACCESS_COOKIE = "cst_at"
CUSTOMER_REFRESH_COOKIE = "cst_rt"
STAFF_ACCESS_COOKIE = "adm_at"
STAFF_REFRESH_COOKIE = "adm_rt"

DbSession = Annotated[Session, Depends(get_db)]


# ----------------------------------------------------------------------
# Tiện ích request
# ----------------------------------------------------------------------
def client_ip(request: Request) -> str | None:
    """Lấy IP thật khi chạy sau reverse proxy."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else None


def user_agent(request: Request) -> str | None:
    return request.headers.get("user-agent")


def _extract_token(request: Request, cookie_name: str) -> str | None:
    """Ưu tiên cookie (an toàn hơn), chấp nhận Bearer header cho client không dùng cookie."""
    token = request.cookies.get(cookie_name)
    if token:
        return token
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _session_payload(request: Request, cookie_name: str, audience: str) -> dict:
    """Giải mã token phiên, hoặc ném `Unauthorized`.

    Từ chối token mang claim `scope`. Những token đó (hiện có: link tải tài liệu) được cấp cho
    **một** hành động cụ thể và đi trong URL — tức là chúng bị ghi lại ở lịch sử trình duyệt,
    header `Referer` và log của reverse proxy. Nhận chúng làm token phiên biến mọi link tải bị
    lộ thành một lượt chiếm tài khoản trọn vẹn.
    """
    token = _extract_token(request, cookie_name)
    if not token:
        raise Unauthorized()

    payload = decode_token(token, audience)
    if not payload or payload.get("typ") != "access" or payload.get("scope"):
        raise Unauthorized()
    return payload


# ----------------------------------------------------------------------
# Khách hàng
# ----------------------------------------------------------------------
def current_user(request: Request, db: DbSession) -> User:
    """Đã đăng nhập, phiên còn hiệu lực. **Chưa** áp BR-001 — dùng cho các endpoint
    mà KH bị chặn vẫn phải gọi được (xem trạng thái, chọn gói, xác thực email)."""
    payload = _session_payload(request, CUSTOMER_ACCESS_COOKIE, "customer")

    user = db.get(User, int(payload["sub"]))
    if not user or user.deleted_at:
        raise Unauthorized()

    # BR-111 — phiên bị thu hồi (đăng nhập ở thiết bị khác) thì access token cũng hết hiệu lực.
    session_id = payload.get("sid")
    if session_id:
        session = db.scalar(select(UserSession).where(UserSession.session_id == session_id))
        if not session or session.revoked_at:
            raise Unauthorized(
                "Phiên đăng nhập đã kết thúc do tài khoản được đăng nhập trên thiết bị khác",
                "SESSION_REVOKED",
            )
        session.last_seen_at = utcnow()
        db.flush()

    return user


def active_user(user: Annotated[User, Depends(current_user)], db: DbSession) -> User:
    """Áp BR-001 — dùng cho toàn bộ endpoint nội dung/chức năng."""
    from app.services import subscription_service

    sub = subscription_service.get_current_subscription(db, user)
    decision = access_control.evaluate_access(user, sub.expires_at if sub else None)
    if not decision.allowed:
        raise AccessBlocked(decision.message, decision.reason, decision.action)
    return user


CurrentUser = Annotated[User, Depends(current_user)]
ActiveUser = Annotated[User, Depends(active_user)]


# ----------------------------------------------------------------------
# Nhân viên
# ----------------------------------------------------------------------
def current_staff(request: Request, db: DbSession) -> Staff:
    payload = _session_payload(request, STAFF_ACCESS_COOKIE, "staff")

    staff = db.get(Staff, int(payload["sub"]))
    if not staff:
        raise Unauthorized()
    if staff.status != StaffStatus.ACTIVE:
        raise Forbidden("Tài khoản đã ngừng hoạt động", "STAFF_INACTIVE")

    session_id = payload.get("sid")
    if session_id:
        session = db.scalar(select(StaffSession).where(StaffSession.session_id == session_id))
        if not session or session.revoked_at:
            raise Unauthorized("Phiên đăng nhập đã kết thúc", "SESSION_REVOKED")

    return staff


CurrentStaff = Annotated[Staff, Depends(current_staff)]


def require_permission(*permissions: str) -> Callable[..., Staff]:
    """BR-533 — kiểm tra quyền trên **từng API endpoint**.

    Truyền nhiều quyền nghĩa là "có ít nhất một trong số này".
    """
    def dependency(staff: CurrentStaff) -> Staff:
        if not rbac.has_any_permission(staff, list(permissions)):
            raise Forbidden(
                "Bạn không có quyền thực hiện thao tác này",
                "PERMISSION_DENIED",
                {"required": list(permissions)},
            )
        return staff

    return dependency


def require_super_admin(staff: CurrentStaff) -> Staff:
    """BR-531 — chỉ SUPER_ADMIN tạo/sửa/xoá tài khoản nhân viên và gán role.

    Cũng áp cho hành động đóng vĩnh viễn tài khoản KH (mục 3.4).
    """
    if not rbac.is_super_admin(staff):
        raise Forbidden("Chỉ Quản trị tối cao mới thực hiện được thao tác này", "SUPER_ADMIN_ONLY")
    return staff


SuperAdmin = Annotated[Staff, Depends(require_super_admin)]
