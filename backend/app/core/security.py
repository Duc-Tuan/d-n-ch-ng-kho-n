"""Hash mật khẩu, JWT, OTP, token dùng một lần.

BR-000: hai site dùng hai secret khác nhau, token chéo site không verify được.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Literal

from jose import JWTError, jwt
from passlib.context import CryptContext

from app.core.config import settings

Audience = Literal["customer", "staff"]

pwd_context = CryptContext(
    schemes=["bcrypt"],
    deprecated="auto",
    bcrypt__rounds=settings.bcrypt_rounds,
)


# ----------------------------------------------------------------------
# Mật khẩu
# ----------------------------------------------------------------------
def hash_password(plain: str) -> str:
    # bcrypt chỉ dùng 72 byte đầu; cắt trước để không ném lỗi với mật khẩu dài.
    return pwd_context.hash(plain[:72])


def verify_password(plain: str, hashed: str) -> bool:
    if not hashed:
        return False
    try:
        return pwd_context.verify(plain[:72], hashed)
    except ValueError:
        return False


def password_policy_errors(password: str) -> list[str]:
    """Mục 2.1 — tối thiểu 8 ký tự, có chữ và số."""
    errors: list[str] = []
    if len(password) < 8:
        errors.append("Mật khẩu phải có tối thiểu 8 ký tự")
    if not any(c.isalpha() for c in password):
        errors.append("Mật khẩu phải chứa ít nhất một chữ cái")
    if not any(c.isdigit() for c in password):
        errors.append("Mật khẩu phải chứa ít nhất một chữ số")
    return errors


# ----------------------------------------------------------------------
# JWT
# ----------------------------------------------------------------------
def _secret_for(audience: Audience) -> str:
    return settings.jwt_secret_customer if audience == "customer" else settings.jwt_secret_staff


def create_token(
    subject: int | str,
    audience: Audience,
    token_type: Literal["access", "refresh"] = "access",
    extra: dict[str, Any] | None = None,
    session_id: str | None = None,
    expires_in: timedelta | None = None,
) -> str:
    """`expires_in` ghi đè thời hạn mặc định — dùng cho token phạm vi hẹp như link tải tài liệu."""
    now = datetime.now(timezone.utc)
    ttl = expires_in or (
        timedelta(minutes=settings.access_token_minutes)
        if token_type == "access"
        else timedelta(days=settings.refresh_token_days)
    )
    payload: dict[str, Any] = {
        "sub": str(subject),
        "aud": audience,
        "typ": token_type,
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
        "jti": uuid.uuid4().hex,
    }
    if session_id:
        payload["sid"] = session_id
    if extra:
        payload.update(extra)
    return jwt.encode(payload, _secret_for(audience), algorithm=settings.jwt_algorithm)


def decode_token(token: str, audience: Audience) -> dict[str, Any] | None:
    """Trả về payload, hoặc None nếu token sai/hết hạn/sai audience."""
    try:
        return jwt.decode(
            token,
            _secret_for(audience),
            algorithms=[settings.jwt_algorithm],
            audience=audience,
        )
    except JWTError:
        return None


# ----------------------------------------------------------------------
# Token / OTP dùng một lần
# ----------------------------------------------------------------------
def generate_url_token() -> str:
    """Token đặt trong link (xác thực email, deep-link Telegram)."""
    return secrets.token_urlsafe(32)


def generate_numeric_otp(length: int = 6) -> str:
    """BR-120 — mã 6 chữ số ngẫu nhiên."""
    return "".join(secrets.choice("0123456789") for _ in range(length))


def sha256_hash(value: str) -> str:
    """Dùng để lưu bản hash của token/OTP thay vì lưu giá trị gốc."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def constant_time_equals(a: str, b: str) -> bool:
    return hmac.compare_digest(a or "", b or "")


def device_fingerprint(user_agent: str | None, ip: str | None) -> str:
    """BR-111 — dấu vân tay thiết bị đơn giản, đủ để đếm số thiết bị."""
    raw = f"{user_agent or ''}|{(ip or '').rsplit('.', 1)[0]}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
