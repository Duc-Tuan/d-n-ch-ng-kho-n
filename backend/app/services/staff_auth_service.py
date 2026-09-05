"""Xác thực Admin Site — đăng nhập một bước bằng mật khẩu.

Luồng tách hoàn toàn khỏi `auth_service` của khách hàng (BR-000).
Bước 2FA TOTP đã được gỡ theo yêu cầu vận hành.
"""

from __future__ import annotations

import uuid
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import LoginResult, StaffStatus
from app.core.datetime_utils import ensure_aware, utcnow
from app.core.exceptions import Forbidden, TooManyRequests, Unauthorized, ValidationError
from app.core.security import (
    create_token,
    generate_numeric_otp,
    hash_password,
    password_policy_errors,
    sha256_hash,
    verify_password,
)
from app.models.staff import Staff, StaffPasswordChange, StaffSession
from app.models.user import LoginLog


def _log(db: Session, staff_id: int | None, username: str, result: str,
         ip: str | None, ua: str | None, note: str | None = None) -> None:
    db.add(
        LoginLog(
            user_id=staff_id,
            actor_type="STAFF",
            email_attempted=username,
            ip=ip,
            user_agent=(ua or "")[:400] or None,
            result=result,
            note=note,
        )
    )
    db.flush()


def authenticate_staff(
    db: Session, identifier: str, password: str, ip: str | None, user_agent: str | None
) -> Staff:
    """Kiểm tra username/email + password; qua được là đủ điều kiện cấp session."""
    ident = identifier.strip().lower()
    staff = db.scalar(select(Staff).where((Staff.username == ident) | (Staff.email == ident)))

    if not staff:
        _log(db, None, ident, LoginResult.NOT_FOUND, ip, user_agent)
        raise Unauthorized("Thông tin đăng nhập không đúng", "INVALID_CREDENTIALS")

    # BR-534 — nhân viên nghỉ việc đặt INACTIVE, bản ghi vẫn giữ nhưng không đăng nhập được.
    if staff.status != StaffStatus.ACTIVE:
        _log(db, staff.id, ident, LoginResult.BLOCKED, ip, user_agent, "Tài khoản INACTIVE")
        raise Forbidden("Tài khoản đã ngừng hoạt động", "STAFF_INACTIVE")

    now = utcnow()
    if staff.locked_until:
        locked = ensure_aware(staff.locked_until, now)
        if locked > now:
            _log(db, staff.id, ident, LoginResult.LOCKED, ip, user_agent)
            minutes = max(int((locked - now).total_seconds() // 60) + 1, 1)
            raise TooManyRequests(
                f"Tài khoản tạm khoá. Thử lại sau {minutes} phút.", "LOGIN_LOCKED"
            )

    if not verify_password(password, staff.password_hash):
        staff.failed_login_count = (staff.failed_login_count or 0) + 1
        if staff.failed_login_count >= settings.login_max_attempts:
            staff.locked_until = now + timedelta(minutes=settings.login_lock_minutes)
            staff.failed_login_count = 0
        _log(db, staff.id, ident, LoginResult.WRONG_PASS, ip, user_agent)
        db.flush()
        raise Unauthorized("Thông tin đăng nhập không đúng", "INVALID_CREDENTIALS")

    staff.failed_login_count = 0
    staff.locked_until = None
    db.flush()
    return staff


def create_staff_session(
    db: Session, staff: Staff, ip: str | None, user_agent: str | None
) -> tuple[str, str]:
    now = utcnow()
    session_id = uuid.uuid4().hex
    refresh_token = create_token(staff.id, "staff", "refresh", session_id=session_id)
    access_token = create_token(staff.id, "staff", "access", session_id=session_id)

    db.add(
        StaffSession(
            staff_id=staff.id,
            session_id=session_id,
            refresh_token_hash=sha256_hash(refresh_token),
            ip=ip,
            user_agent=(user_agent or "")[:400] or None,
            expires_at=now + timedelta(days=settings.refresh_token_days),
        )
    )
    staff.last_login_at = now
    db.flush()
    _log(db, staff.id, staff.username, LoginResult.SUCCESS, ip, user_agent)
    return access_token, refresh_token


def revoke_staff_session(db: Session, session_id: str) -> None:
    db.execute(
        update(StaffSession)
        .where(StaffSession.session_id == session_id, StaffSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    db.flush()


#: Mã xác nhận đổi mật khẩu sống 5 phút. Ngắn hơn OTP quên mật khẩu của khách hàng vì đây là
#: thao tác người dùng đang chủ động làm, hòm thư đang mở sẵn — không cần cửa sổ rộng.
PASSWORD_CHANGE_TTL_MINUTES = 5

#: Sai quá số lần này thì huỷ yêu cầu, bắt làm lại từ đầu.
PASSWORD_CHANGE_MAX_ATTEMPTS = 5


def _apply_new_password(db: Session, staff: Staff, password_hash: str) -> None:
    """Đặt mật khẩu mới và **thu hồi mọi phiên** — kể cả phiên đang thao tác.

    Đổi mật khẩu thường là phản ứng khi nghi ngờ bị lộ. Giữ lại các phiên cũ nghĩa là kẻ đang
    dùng trộm vẫn ở nguyên trong hệ thống, và đó đúng là thứ thao tác này nhằm cắt đứt.
    """
    staff.password_hash = password_hash
    staff.must_change_password = False
    db.execute(
        update(StaffSession)
        .where(StaffSession.staff_id == staff.id, StaffSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    db.flush()


def request_password_change(
    db: Session, staff: Staff, current: str, new: str, ip: str | None
) -> str:
    """Bước 1 — kiểm tra mật khẩu cũ/mới rồi sinh mã xác nhận gửi email.

    Trả về mã ở dạng thô để tầng API gửi đi; **không** lưu bản thô ở đâu cả.
    """
    if not verify_password(current, staff.password_hash):
        raise ValidationError("Mật khẩu hiện tại không đúng", {"field": "current_password"})

    errors = password_policy_errors(new)
    if errors:
        raise ValidationError(errors[0], {"field": "new_password", "errors": errors})

    if verify_password(new, staff.password_hash):
        raise ValidationError(
            "Mật khẩu mới phải khác mật khẩu hiện tại", {"field": "new_password"}
        )

    # Mỗi lần yêu cầu mới thì bỏ yêu cầu cũ: nếu không, mã cũ vẫn dùng được và người dùng bấm
    # "Gửi lại mã" sẽ có nhiều mã cùng hiệu lực — mở rộng cửa sổ tấn công mà chẳng để làm gì.
    db.execute(
        update(StaffPasswordChange)
        .where(
            StaffPasswordChange.staff_id == staff.id,
            StaffPasswordChange.used_at.is_(None),
        )
        .values(used_at=utcnow())
    )

    otp = generate_numeric_otp(6)
    db.add(
        StaffPasswordChange(
            staff_id=staff.id,
            # Băm ngay tại đây — bảng chờ không bao giờ giữ mật khẩu dạng thô.
            new_password_hash=hash_password(new),
            otp_hash=sha256_hash(otp),
            expires_at=utcnow() + timedelta(minutes=PASSWORD_CHANGE_TTL_MINUTES),
            request_ip=ip,
        )
    )
    db.flush()
    return otp


def confirm_password_change(db: Session, staff: Staff, code: str) -> None:
    """Bước 2 — xác nhận mã rồi mới thực sự đổi mật khẩu."""
    record = db.scalar(
        select(StaffPasswordChange)
        .where(
            StaffPasswordChange.staff_id == staff.id,
            StaffPasswordChange.used_at.is_(None),
        )
        .order_by(StaffPasswordChange.id.desc())
        .limit(1)
    )
    if not record:
        raise ValidationError(
            "Không có yêu cầu đổi mật khẩu nào đang chờ. Vui lòng bắt đầu lại.",
            {"field": "code", "code": "NO_PENDING_REQUEST"},
        )

    now = utcnow()
    expires = ensure_aware(record.expires_at, now)
    if expires < now:
        record.used_at = now
        db.flush()
        raise ValidationError(
            f"Mã xác nhận đã hết hạn sau {PASSWORD_CHANGE_TTL_MINUTES} phút. Vui lòng yêu cầu mã mới.",
            {"field": "code", "code": "CODE_EXPIRED"},
        )

    if record.attempts >= PASSWORD_CHANGE_MAX_ATTEMPTS:
        record.used_at = now
        db.flush()
        raise ValidationError(
            "Bạn đã nhập sai quá số lần cho phép. Vui lòng yêu cầu mã mới.",
            {"field": "code", "code": "CODE_ATTEMPTS_EXCEEDED"},
        )

    if record.otp_hash != sha256_hash(code.strip()):
        record.attempts += 1
        db.flush()
        remaining = PASSWORD_CHANGE_MAX_ATTEMPTS - record.attempts
        raise ValidationError(
            "Mã xác nhận không đúng",
            {"field": "code", "code": "CODE_INVALID", "remaining_attempts": max(remaining, 0)},
        )

    record.used_at = now
    _apply_new_password(db, staff, record.new_password_hash)


def change_staff_password(db: Session, staff: Staff, current: str, new: str) -> None:
    """Đổi mật khẩu một bước — giữ lại cho luồng bắt buộc đổi mật khẩu lần đầu."""
    if not verify_password(current, staff.password_hash):
        raise ValidationError("Mật khẩu hiện tại không đúng", {"field": "current_password"})
    errors = password_policy_errors(new)
    if errors:
        raise ValidationError(errors[0], {"field": "new_password", "errors": errors})
    _apply_new_password(db, staff, hash_password(new))
