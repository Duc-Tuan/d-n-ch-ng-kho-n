"""Gửi thông báo vận hành tới nhân viên — YC17.

Mọi sự kiện real-time từ phía khách hàng đều đi qua đây, để người trực trang quản trị biết ngay
mà không phải ngồi bấm F5.
"""

from __future__ import annotations

import logging

from sqlalchemy.orm import Session

from app.models.staff import StaffNotification

log = logging.getLogger(__name__)


class StaffNotifyCode:
    NEW_QUESTION = "NEW_QUESTION"
    NEW_CUSTOMER = "NEW_CUSTOMER"
    NEW_PAYMENT = "NEW_PAYMENT"
    COMPLIANCE_ALERT = "COMPLIANCE_ALERT"
    JOB_FAILED = "JOB_FAILED"
    IB_LINK_REQUEST = "IB_LINK_REQUEST"


def notify_staff(
    db: Session,
    *,
    code: str,
    title: str,
    body: str | None = None,
    link: str | None = None,
    level: str = "info",
    staff_id: int | None = None,
    required_permission: str | None = None,
) -> StaffNotification:
    """Tạo một thông báo cho nhân viên.

    `staff_id=None` + `required_permission` nghĩa là gửi cho mọi nhân viên có quyền đó —
    dùng cho việc theo nhóm (ví dụ câu hỏi mới gửi cho ai có quyền `qa.answer`).
    """
    notification = StaffNotification(
        staff_id=staff_id,
        required_permission=required_permission,
        code=code,
        title=title[:255],
        body=body,
        link=link,
        level=level,
    )
    db.add(notification)
    db.flush()

    # Đẩy tiếp qua WebSocket để trang quản trị hiện toast kèm âm thanh ngay lập tức.
    try:
        from app.services.realtime import broadcast_staff_event

        broadcast_staff_event(
            {
                "type": "notification",
                "code": code,
                "title": title,
                "body": body,
                "link": link,
                "level": level,
                "required_permission": required_permission,
                "staff_id": staff_id,
            }
        )
    except Exception as exc:  # không để lỗi kênh real-time làm hỏng nghiệp vụ chính
        log.debug("Không đẩy được sự kiện real-time: %s", exc)

    return notification
