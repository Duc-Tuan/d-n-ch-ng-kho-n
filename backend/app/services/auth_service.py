"""Xác thực khách hàng — mục 2.1, 2.2, 2.3."""

from __future__ import annotations

import re
import uuid
from datetime import timedelta

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import (
    ComplianceStatus,
    LoginResult,
    NotificationChannel,
    NotificationCode,
    SubscriptionStatus,
)
from app.core.datetime_utils import ensure_aware, local_today, utcnow
from app.core.exceptions import Conflict, NotFound, TooManyRequests, Unauthorized, ValidationError
from app.core.security import (
    create_token,
    device_fingerprint,
    generate_numeric_otp,
    generate_url_token,
    hash_password,
    password_policy_errors,
    sha256_hash,
    verify_password,
)
from app.models.user import (
    EmailVerification,
    LoginLog,
    PasswordReset,
    TrialAbuseLog,
    User,
    UserSession,
)
from app.services import notification_service, subscription_service

PHONE_RE = re.compile(r"^(0|\+84)(3|5|7|8|9)\d{8}$")

#: BR-105 — chặn domain email dùng một lần.
DISPOSABLE_EMAIL_DOMAINS = {
    "mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com",
    "yopmail.com", "throwawaymail.com", "trashmail.com", "getnada.com",
    "temp-mail.org", "fakeinbox.com", "sharklasers.com", "dispostable.com",
}


# ======================================================================
# ĐĂNG KÝ — mục 2.1
# ======================================================================
def normalize_email(email: str) -> str:
    return email.strip().lower()


def normalize_phone(phone: str) -> str:
    p = re.sub(r"[\s.\-()]", "", phone.strip())
    return "0" + p[3:] if p.startswith("+84") else p


def validate_registration(db: Session, email: str, phone: str, password: str) -> None:
    email = normalize_email(email)
    phone = normalize_phone(phone)

    if not PHONE_RE.match(phone):
        raise ValidationError(
            "Số điện thoại không đúng định dạng Việt Nam", {"field": "phone"}
        )

    domain = email.rsplit("@", 1)[-1]
    if domain in DISPOSABLE_EMAIL_DOMAINS:
        raise ValidationError(
            "Hệ thống không chấp nhận email dùng một lần. Vui lòng dùng email thật.",
            {"field": "email"},
        )

    errors = password_policy_errors(password)
    if errors:
        raise ValidationError(errors[0], {"field": "password", "errors": errors})

    if db.scalar(select(func.count()).select_from(User).where(User.email == email)):
        raise Conflict("Email này đã được đăng ký", "EMAIL_EXISTS")

    # BR-105 — 1 SĐT chỉ gắn với 1 tài khoản.
    if db.scalar(select(func.count()).select_from(User).where(User.phone == phone)):
        raise Conflict("Số điện thoại này đã được đăng ký", "PHONE_EXISTS")


def check_ip_signup_quota(db: Session, ip: str | None) -> None:
    """BR-105 — tối đa 3 tài khoản trial mới trên cùng 1 IP mỗi ngày."""
    if not ip:
        return
    today = local_today()
    row = db.scalar(
        select(TrialAbuseLog).where(TrialAbuseLog.ip == ip, TrialAbuseLog.signup_date == today)
    )
    if row and row.count >= settings.trial_per_ip_per_day:
        raise TooManyRequests(
            "Đã đạt giới hạn số tài khoản đăng ký mới trong ngày từ địa chỉ này. "
            "Vui lòng thử lại vào ngày mai hoặc liên hệ hỗ trợ.",
            "SIGNUP_IP_LIMIT",
        )


def record_ip_signup(db: Session, ip: str | None) -> None:
    if not ip:
        return
    today = local_today()
    row = db.scalar(
        select(TrialAbuseLog).where(TrialAbuseLog.ip == ip, TrialAbuseLog.signup_date == today)
    )
    if row:
        row.count += 1
    else:
        db.add(TrialAbuseLog(ip=ip, signup_date=today, count=1))
    db.flush()


def generate_customer_code(user_id: int) -> str:
    """BR-869 — mã hiển thị ở chân tin nhắn Telegram để truy vết rò rỉ."""
    return f"KH-{user_id:05d}"


def create_user(
    db: Session,
    *,
    email: str,
    password: str,
    full_name: str,
    phone: str,
    customer_type: str,
    referral_code: str | None = None,
    ip: str | None = None,
) -> User:
    user = User(
        email=normalize_email(email),
        phone=normalize_phone(phone),
        password_hash=hash_password(password),
        full_name=full_name.strip(),
        customer_type=customer_type,
        # Mục 2.1 bước 4 — trạng thái khởi tạo.
        subscription_status=SubscriptionStatus.PENDING_VERIFY,
        compliance_status=ComplianceStatus.NOT_REQUIRED,
        signup_ip=ip,
    )
    db.add(user)
    db.flush()
    user.customer_code = generate_customer_code(user.id)
    if referral_code:
        db.add(
            LoginLog(
                user_id=user.id, result="SIGNUP", email_attempted=user.email, ip=ip,
                note=f"referral={referral_code}",
            )
        )
    db.flush()
    return user


def issue_email_verification(db: Session, user: User) -> str:
    """Sinh token UUID, TTL 24 giờ (mục 2.1 bước 5). Trả về token gốc để nhét vào link."""
    token = generate_url_token()
    db.add(
        EmailVerification(
            user_id=user.id,
            token_hash=sha256_hash(token),
            expires_at=utcnow() + timedelta(hours=settings.email_verify_ttl_hours),
        )
    )
    db.flush()

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.VERIFY_EMAIL,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"verify:{token[:12]}",
        context={
            "full_name": user.full_name,
            "verify_url": f"{settings.frontend_base_url}/verify-email?token={token}",
            "ttl_hours": settings.email_verify_ttl_hours,
        },
    )
    return token


def resend_verification(db: Session, email: str) -> None:
    """BR-101 — cho gửi lại link, giới hạn 3 lần/ngày."""
    user = db.scalar(select(User).where(User.email == normalize_email(email)))
    # Không tiết lộ email có tồn tại hay không (cùng nguyên tắc mục 2.3).
    if not user or user.email_verified_at:
        return

    since = utcnow() - timedelta(days=1)
    sent_today = db.scalar(
        select(func.count())
        .select_from(EmailVerification)
        .where(EmailVerification.user_id == user.id, EmailVerification.created_at >= since)
    )
    if (sent_today or 0) >= 3:
        raise TooManyRequests(
            "Bạn đã yêu cầu gửi lại quá 3 lần trong ngày. Vui lòng thử lại vào ngày mai.",
            "RESEND_LIMIT",
        )
    issue_email_verification(db, user)


def verify_email(db: Session, token: str) -> User:
    """BR-100 — xác thực thành công mới bắt đầu chạy đồng hồ 7 ngày dùng thử."""
    record = db.scalar(
        select(EmailVerification).where(EmailVerification.token_hash == sha256_hash(token))
    )
    if not record:
        raise NotFound("Link xác thực không hợp lệ", "VERIFY_TOKEN_INVALID")
    if record.used_at:
        raise Conflict("Link xác thực đã được sử dụng", "VERIFY_TOKEN_USED")
    if ensure_aware(record.expires_at, utcnow()) < utcnow():
        raise Conflict(
            "Link xác thực đã hết hạn. Vui lòng yêu cầu gửi lại.", "VERIFY_TOKEN_EXPIRED"
        )

    user = db.get(User, record.user_id)
    if not user:
        raise NotFound("Tài khoản không tồn tại")

    record.used_at = utcnow()
    if not user.email_verified_at:
        user.email_verified_at = utcnow()
        subscription_service.start_trial(db, user)
        record_ip_signup(db, user.signup_ip)
        notification_service.enqueue(
            db,
            user=user,
            code=NotificationCode.WELCOME,
            channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
            reference_id=f"user:{user.id}",
            context={"full_name": user.full_name, "trial_days": settings.trial_days},
        )
    db.flush()
    return user


# ======================================================================
# ĐĂNG NHẬP — mục 2.2
# ======================================================================
def log_login(
    db: Session,
    *,
    user_id: int | None,
    email: str | None,
    result: str,
    ip: str | None,
    user_agent: str | None,
    actor_type: str = "USER",
    note: str | None = None,
) -> None:
    db.add(
        LoginLog(
            user_id=user_id,
            actor_type=actor_type,
            email_attempted=email,
            ip=ip,
            user_agent=(user_agent or "")[:400] or None,
            device_fingerprint=device_fingerprint(user_agent, ip),
            result=result,
            note=note,
        )
    )
    db.flush()


def authenticate(
    db: Session, email: str, password: str, ip: str | None, user_agent: str | None
) -> User:
    """Trả về User nếu đúng mật khẩu. BR-110 — sai 5 lần liên tiếp thì khoá 15 phút.

    Chưa áp BR-001 ở đây; việc đó do `access_control.evaluate_access` làm sau, để log
    phân biệt được "sai mật khẩu" với "đúng mật khẩu nhưng bị chặn".
    """
    email = normalize_email(email)
    user = db.scalar(select(User).where(User.email == email, User.deleted_at.is_(None)))

    if not user:
        log_login(db, user_id=None, email=email, result=LoginResult.NOT_FOUND, ip=ip,
                  user_agent=user_agent)
        # Thông báo giống hệt trường hợp sai mật khẩu — không để dò được danh sách KH.
        raise Unauthorized("Email hoặc mật khẩu không đúng", "INVALID_CREDENTIALS")

    now = utcnow()
    if user.locked_until:
        locked = ensure_aware(user.locked_until, now)
        if locked > now:
            log_login(db, user_id=user.id, email=email, result=LoginResult.LOCKED, ip=ip,
                      user_agent=user_agent)
            minutes = max(int((locked - now).total_seconds() // 60) + 1, 1)
            raise TooManyRequests(
                f"Tài khoản tạm khoá do đăng nhập sai nhiều lần. Thử lại sau {minutes} phút.",
                "LOGIN_LOCKED",
                {"retry_after_minutes": minutes},
            )

    if not verify_password(password, user.password_hash):
        user.failed_login_count = (user.failed_login_count or 0) + 1
        note = None
        if user.failed_login_count >= settings.login_max_attempts:
            user.locked_until = now + timedelta(minutes=settings.login_lock_minutes)
            user.failed_login_count = 0
            note = "Khoá đăng nhập theo BR-110"
            notification_service.enqueue(
                db,
                user=user,
                code=NotificationCode.NEW_DEVICE_LOGIN,
                channels=[NotificationChannel.EMAIL],
                reference_id=f"lock:{now:%Y%m%d%H%M}",
                context={
                    "full_name": user.full_name,
                    "ip": ip or "không xác định",
                    "event": "Đăng nhập sai nhiều lần, tài khoản đã bị tạm khoá",
                    "time": now.isoformat(),
                },
            )
        log_login(db, user_id=user.id, email=email, result=LoginResult.WRONG_PASS, ip=ip,
                  user_agent=user_agent, note=note)
        db.flush()
        raise Unauthorized("Email hoặc mật khẩu không đúng", "INVALID_CREDENTIALS")

    user.failed_login_count = 0
    user.locked_until = None
    db.flush()
    return user


def create_session(
    db: Session, user: User, ip: str | None, user_agent: str | None
) -> tuple[str, str, UserSession]:
    """BR-111 — mặc định chỉ giữ 1 phiên hoạt động; thiết bị mới đăng nhập thì đá thiết bị cũ."""
    now = utcnow()
    fingerprint = device_fingerprint(user_agent, ip)

    known_device = db.scalar(
        select(func.count())
        .select_from(UserSession)
        .where(UserSession.user_id == user.id, UserSession.device_fingerprint == fingerprint)
    )

    if settings.single_session:
        revoked = db.execute(
            update(UserSession)
            .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
            .values(revoked_at=now, revoked_reason="NEW_DEVICE_LOGIN")
        )
        if revoked.rowcount:
            notification_service.enqueue(
                db,
                user=user,
                code=NotificationCode.NEW_DEVICE_LOGIN,
                channels=[NotificationChannel.EMAIL],
                reference_id=f"session:{now:%Y%m%d%H%M%S}",
                context={
                    "full_name": user.full_name,
                    "ip": ip or "không xác định",
                    "event": "Tài khoản của bạn vừa đăng nhập trên một thiết bị khác",
                    "time": now.isoformat(),
                },
            )

    session_id = uuid.uuid4().hex
    refresh_token = create_token(user.id, "customer", "refresh", session_id=session_id)
    access_token = create_token(user.id, "customer", "access", session_id=session_id)

    session = UserSession(
        user_id=user.id,
        session_id=session_id,
        refresh_token_hash=sha256_hash(refresh_token),
        device_fingerprint=fingerprint,
        ip=ip,
        user_agent=(user_agent or "")[:400] or None,
        expires_at=now + timedelta(days=settings.refresh_token_days),
        last_seen_at=now,
    )
    db.add(session)
    user.last_login_at = now
    db.flush()

    if not known_device:
        _check_device_spread(db, user)

    return access_token, refresh_token, session


def _check_device_spread(db: Session, user: User) -> None:
    """BR-111 — >5 thiết bị khác nhau trong 30 ngày thì cắm cờ đỏ lên dashboard admin."""
    since = utcnow() - timedelta(days=30)
    distinct_devices = db.scalar(
        select(func.count(func.distinct(UserSession.device_fingerprint))).where(
            UserSession.user_id == user.id, UserSession.created_at >= since
        )
    )
    if (distinct_devices or 0) > settings.device_alert_threshold:
        db.add(
            LoginLog(
                user_id=user.id,
                email_attempted=user.email,
                result="DEVICE_ALERT",
                note=f"{distinct_devices} thiết bị khác nhau trong 30 ngày — nghi ngờ chia sẻ tài khoản",
            )
        )
        db.flush()


def revoke_session(db: Session, session_id: str, reason: str = "LOGOUT") -> None:
    db.execute(
        update(UserSession)
        .where(UserSession.session_id == session_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
    )
    db.flush()


def revoke_all_sessions(db: Session, user_id: int, reason: str) -> None:
    """Dùng sau khi đổi mật khẩu — mục 2.3 bước 4."""
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow(), revoked_reason=reason)
    )
    db.flush()


# ======================================================================
# QUÊN MẬT KHẨU — mục 2.3
# ======================================================================
def request_password_reset(db: Session, email: str, ip: str | None) -> None:
    """Luôn trả về như nhau dù email có tồn tại hay không (chống dò danh sách KH)."""
    user = db.scalar(select(User).where(User.email == normalize_email(email),
                                        User.deleted_at.is_(None)))
    if not user:
        return

    # BR-120 — tối đa 3 yêu cầu/giờ/email.
    since = utcnow() - timedelta(hours=1)
    recent = db.scalar(
        select(func.count())
        .select_from(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.created_at >= since)
    )
    if (recent or 0) >= settings.otp_request_per_hour:
        raise TooManyRequests(
            "Bạn đã yêu cầu mã quá nhiều lần. Vui lòng thử lại sau một giờ.",
            "OTP_REQUEST_LIMIT",
        )

    # Vô hiệu hoá các mã cũ chưa dùng.
    db.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .values(used_at=utcnow())
    )

    otp = generate_numeric_otp(6)
    db.add(
        PasswordReset(
            user_id=user.id,
            otp_hash=sha256_hash(otp),
            expires_at=utcnow() + timedelta(minutes=settings.otp_ttl_minutes),
            request_ip=ip,
        )
    )
    db.flush()

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.PASSWORD_RESET_OTP,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"otp:{utcnow():%Y%m%d%H%M%S}",
        context={
            "full_name": user.full_name,
            "otp": otp,
            "ttl_minutes": settings.otp_ttl_minutes,
        },
    )


def reset_password(db: Session, email: str, otp: str, new_password: str) -> User:
    """BR-121 — mã dùng một lần; BR-122 — gửi email thông báo sau khi đổi thành công."""
    errors = password_policy_errors(new_password)
    if errors:
        raise ValidationError(errors[0], {"field": "new_password", "errors": errors})

    user = db.scalar(select(User).where(User.email == normalize_email(email),
                                        User.deleted_at.is_(None)))
    if not user:
        raise ValidationError("Mã xác thực không đúng hoặc đã hết hạn", {"field": "otp"})

    record = db.scalar(
        select(PasswordReset)
        .where(PasswordReset.user_id == user.id, PasswordReset.used_at.is_(None))
        .order_by(PasswordReset.id.desc())
    )
    now = utcnow()
    if not record or ensure_aware(record.expires_at, now) < now:
        raise ValidationError("Mã xác thực không đúng hoặc đã hết hạn", {"field": "otp"})

    if record.attempts >= settings.otp_max_attempts:
        record.used_at = now
        db.flush()
        raise TooManyRequests(
            "Bạn đã nhập sai mã quá số lần cho phép. Vui lòng yêu cầu mã mới.",
            "OTP_ATTEMPTS_EXCEEDED",
        )

    if record.otp_hash != sha256_hash(otp):
        record.attempts += 1
        db.flush()
        remaining = settings.otp_max_attempts - record.attempts
        raise ValidationError(
            f"Mã xác thực không đúng. Còn {max(remaining, 0)} lần thử.",
            {"field": "otp", "remaining_attempts": max(remaining, 0)},
        )

    record.used_at = now
    user.password_hash = hash_password(new_password)
    user.failed_login_count = 0
    user.locked_until = None
    revoke_all_sessions(db, user.id, "PASSWORD_RESET")
    db.flush()

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.PASSWORD_CHANGED,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"pwd:{now:%Y%m%d%H%M%S}",
        context={"full_name": user.full_name, "time": now.isoformat()},
    )
    return user


def change_password(db: Session, user: User, current_password: str, new_password: str) -> None:
    if not verify_password(current_password, user.password_hash):
        raise ValidationError("Mật khẩu hiện tại không đúng", {"field": "current_password"})
    errors = password_policy_errors(new_password)
    if errors:
        raise ValidationError(errors[0], {"field": "new_password", "errors": errors})

    user.password_hash = hash_password(new_password)
    revoke_all_sessions(db, user.id, "PASSWORD_CHANGED")
    db.flush()

    notification_service.enqueue(
        db,
        user=user,
        code=NotificationCode.PASSWORD_CHANGED,
        channels=[NotificationChannel.EMAIL],
        reference_id=f"pwd:{utcnow():%Y%m%d%H%M%S}",
        context={"full_name": user.full_name, "time": utcnow().isoformat()},
    )
