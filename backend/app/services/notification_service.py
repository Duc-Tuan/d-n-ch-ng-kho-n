"""Hệ thống thông báo — Phần 10.

Nguyên tắc cốt lõi:
  * BR-812 — **không gửi đồng bộ trong request**. `enqueue()` chỉ ghi vào bảng `notifications`;
    worker (`app/jobs/notification_worker.py`) mới thực sự gửi đi.
  * BR-813 — idempotency bằng UNIQUE (user_id, code, reference_id, channel).
  * BR-814 — log đầy đủ để trả lời được câu "tôi không nhận được thông báo nào".
  * BR-815 — chỉ nhóm không bắt buộc mới cho KH tắt.
  * BR-816 — SMS/push bị dồn trong giờ yên lặng, gửi lại lúc 07:30.
"""

from __future__ import annotations

import logging
import smtplib
from collections.abc import Iterator
from contextlib import contextmanager
from email.message import EmailMessage
from typing import Any, Callable

from jinja2 import BaseLoader, Environment, StrictUndefined
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.constants import (
    OPTIONAL_NOTIFICATION_CODES,
    SECURITY_NOTIFICATION_CODES,
    NotificationChannel,
    NotificationStatus,
)
from app.core.datetime_utils import in_quiet_hours, next_quiet_hours_end, utcnow
from app.models.notification import Notification, NotificationPreference, NotificationTemplate
from app.models.user import User

log = logging.getLogger(__name__)

_jinja = Environment(loader=BaseLoader(), undefined=StrictUndefined, autoescape=False)


# ----------------------------------------------------------------------
# Render template
# ----------------------------------------------------------------------
def render_template(
    db: Session, code: str, channel: str, context: dict[str, Any]
) -> tuple[str | None, str]:
    """Trả về (subject, body). Nếu chưa có template trong DB thì dùng bản dự phòng."""
    tpl = db.scalar(
        select(NotificationTemplate).where(
            NotificationTemplate.code == code,
            NotificationTemplate.channel == channel,
            NotificationTemplate.is_active.is_(True),
        )
    )
    ctx = {"site_url": settings.frontend_base_url, "app_name": settings.app_name, **context}

    if not tpl:
        return (f"[{settings.app_name}] {code}", _fallback_body(code, ctx))

    try:
        subject = _jinja.from_string(tpl.subject).render(**ctx) if tpl.subject else None
        body = _jinja.from_string(tpl.body).render(**ctx)
    except Exception as exc:  # template do admin sửa — không được để lỗi làm chết job
        log.warning("Template %s/%s render lỗi: %s", code, channel, exc)
        return (tpl.subject, _fallback_body(code, ctx))
    return subject, body


def _fallback_body(code: str, ctx: dict[str, Any]) -> str:
    lines = [f"Thông báo: {code}"]
    for key, value in ctx.items():
        if key in {"site_url", "app_name"}:
            continue
        lines.append(f"- {key}: {value}")
    return "\n".join(lines)


# ----------------------------------------------------------------------
# Tuỳ chọn của khách hàng — BR-815
# ----------------------------------------------------------------------
def is_channel_enabled(db: Session, user_id: int, code: str, channel: str) -> bool:
    """Nhóm giao dịch/bảo mật/compliance không cho tắt."""
    if code not in OPTIONAL_NOTIFICATION_CODES:
        return True
    pref = db.scalar(
        select(NotificationPreference).where(
            NotificationPreference.user_id == user_id,
            NotificationPreference.code == code,
            NotificationPreference.channel == channel,
        )
    )
    return pref.enabled if pref else True


# ----------------------------------------------------------------------
# Đưa vào hàng đợi
# ----------------------------------------------------------------------
def enqueue(
    db: Session,
    *,
    user: User | int,
    code: str,
    channels: list[str],
    context: dict[str, Any] | None = None,
    reference_id: str | None = None,
    commit: bool = False,
) -> list[Notification]:
    """Đưa thông báo vào hàng đợi cho từng kênh.

    `reference_id` là khoá idempotency (BR-813) — ví dụ ``f"sub:{subscription_id}"`` cho
    nhắc hết hạn, ``f"signal:{signal_id}"`` cho tín hiệu. Nếu đã tồn tại, bỏ qua im lặng.
    """
    user_id = user.id if isinstance(user, User) else user
    context = context or {}
    ref = reference_id or ""
    created: list[Notification] = []

    for channel in channels:
        if not is_channel_enabled(db, user_id, code, channel):
            continue

        subject, body = render_template(db, code, channel, context)

        scheduled_at = None
        # BR-816 — giờ yên lặng chỉ áp cho SMS/push, và không áp cho thông báo bảo mật.
        if (
            channel in (NotificationChannel.SMS, NotificationChannel.PUSH)
            and code not in SECURITY_NOTIFICATION_CODES
            and in_quiet_hours()
        ):
            scheduled_at = next_quiet_hours_end()

        notif = Notification(
            user_id=user_id,
            code=code,
            channel=channel,
            reference_id=ref,
            subject=subject,
            body=body,
            payload=_jsonable(context),
            status=NotificationStatus.QUEUED,
            scheduled_at=scheduled_at,
        )
        # SAVEPOINT: đụng UNIQUE của BR-813 thì chỉ huỷ **một dòng INSERT này**.
        #
        # `db.rollback()` trần sẽ cuốn theo toàn bộ transaction đang mở. Ở job
        # `check_subscription`, nó xoá luôn phần đổi trạng thái gói của tất cả khách hàng đã xử lý
        # trước đó trong cùng vòng lặp — mất dữ liệu âm thầm, không có lỗi nào được ném ra, và
        # kích hoạt bởi đúng thứ vốn được coi là bình thường: một thông báo đã gửi rồi.
        try:
            with db.begin_nested():
                db.add(notif)
                db.flush()
            created.append(notif)
        except IntegrityError:
            # BR-813 — đã gửi rồi; job chạy lại không được tạo bản trùng.
            # SAVEPOINT khi rollback đã tự gỡ `notif` khỏi phiên, không cần expunge thêm.
            log.debug("Bỏ qua thông báo trùng: user=%s code=%s ref=%s", user_id, code, ref)

    if commit and created:
        db.commit()
    return created


def _jsonable(value: Any) -> Any:
    from datetime import date, datetime
    from decimal import Decimal

    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


# ----------------------------------------------------------------------
# Gửi thật — do worker gọi
# ----------------------------------------------------------------------
def _build_message(to: str, subject: str, body: str) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email}>"
    msg["To"] = to
    msg["Subject"] = subject or settings.app_name
    msg.set_content(body)
    return msg


def _connect_smtp() -> smtplib.SMTP:
    server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=20)
    if settings.smtp_tls:
        server.starttls()
    if settings.smtp_user:
        server.login(settings.smtp_user, settings.smtp_password)
    return server


@contextmanager
def smtp_session() -> Iterator[Callable[[str, str, str], None]]:
    """Mở **một** kết nối SMTP rồi trả về hàm gửi dùng cho cả lô.

    Vì sao cần: `send_email` tự mở và đóng kết nối cho từng thư. Worker gửi 100 thư một lượt
    nghĩa là 100 lần bắt tay TCP, 100 lần thương lượng TLS và 100 lần đăng nhập SMTP — phần
    lớn thời gian của job nằm ở đấy, không phải ở việc gửi. Nhiều nhà cung cấp SMTP còn giới hạn
    số lần đăng nhập mỗi phút và sẽ chặn tạm thời khi thấy kiểu truy cập này.

    Chưa cấu hình SMTP (môi trường dev) thì trả về hàm ghi log, không mở kết nối nào.
    """
    if not settings.smtp_host:
        yield lambda to, subject, body: log.info(
            "[EMAIL-DEV] to=%s | %s\n%s", to, subject, body
        )
        return

    server = _connect_smtp()
    try:
        def send(to: str, subject: str, body: str) -> None:
            server.send_message(_build_message(to, subject, body))

        yield send
    finally:
        try:
            server.quit()
        except Exception:  # kết nối đã rơi — không có gì để dọn thêm
            pass


def send_email(to: str, subject: str, body: str) -> None:
    """Gửi **một** email qua SMTP. Ném exception để worker ghi lỗi và thử lại.

    Gửi nhiều thư liên tiếp thì dùng `smtp_session()` để tái sử dụng kết nối.
    """
    with smtp_session() as send:
        send(to, subject, body)


def send_sms(phone: str, body: str) -> None:
    """Điểm cắm nhà cung cấp SMS/Zalo ZNS.

    Chưa đấu nối nhà cung cấp thật — ghi log để không chặn luồng nghiệp vụ ở môi trường dev.
    """
    if settings.sms_provider == "none" or not settings.sms_api_key:
        log.info("[SMS-DEV] to=%s | %s", phone, body)
        return
    raise NotImplementedError(
        f"Chưa cài đặt nhà cung cấp SMS '{settings.sms_provider}'. "
        "Bổ sung tại app/services/notification_service.send_sms()."
    )


def notify_admins(subject: str, body: str) -> None:
    """BR-700/301 — cảnh báo vận hành khi job thất bại."""
    recipients = settings.admin_alert_email_list
    if recipients:
        try:
            with smtp_session() as send:
                for email in recipients:
                    try:
                        send(email, f"[CẢNH BÁO] {subject}", body)
                    except Exception as exc:  # một người nhận lỗi không chặn những người còn lại
                        log.error("Không gửi được cảnh báo tới %s: %s", email, exc)
        except Exception as exc:  # không để lỗi gửi mail làm chết job
            log.error("Không mở được kết nối SMTP để gửi cảnh báo: %s", exc)

    if settings.admin_alert_telegram_chat_id and settings.telegram_bot_token:
        from app.services.telegram_service import send_raw_message

        try:
            send_raw_message(int(settings.admin_alert_telegram_chat_id), f"⚠️ {subject}\n\n{body}")
        except Exception as exc:
            log.error("Không gửi được cảnh báo Telegram: %s", exc)
