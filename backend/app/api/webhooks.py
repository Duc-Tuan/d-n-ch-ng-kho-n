"""Webhook Telegram — BR-861 (deep-link), BR-864 (/stop), BR-882 (xác thực webhook).

Endpoint này chỉ lo phần **vận chuyển**: chứng minh rằng update thật sự đến từ Telegram. Phần
hiểu nội dung update nằm ở `telegram_service.handle_update` để script chạy local
(`app.scripts.telegram_dev_poll`) dùng lại nguyên vẹn — xem docstring của hàm đó.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Header, Request

from app.core.config import settings
from app.core.deps import DbSession
from app.core.exceptions import Forbidden
from app.core.security import constant_time_equals
from app.services import telegram_service

log = logging.getLogger(__name__)

router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.post("/telegram")
async def telegram_webhook(
    request: Request,
    db: DbSession,
    x_telegram_bot_api_secret_token: str | None = Header(default=None),
) -> dict:
    """Nhận update từ Telegram.

    BR-882 — bắt buộc kiểm tra header bí mật. Nếu để ngỏ, bất kỳ ai cũng gửi được
    `/start <token>` giả để chiếm kết nối của khách hàng khác.
    """
    if not settings.telegram_webhook_secret:
        raise Forbidden(
            "Webhook chưa được cấu hình secret. Từ chối xử lý.", "WEBHOOK_NOT_CONFIGURED"
        )
    if not constant_time_equals(x_telegram_bot_api_secret_token or "",
                                settings.telegram_webhook_secret):
        log.warning("Webhook Telegram bị gọi với secret sai từ %s",
                    request.client.host if request.client else "?")
        raise Forbidden("Secret không hợp lệ", "WEBHOOK_SECRET_INVALID")

    telegram_service.handle_update(db, await request.json())
    return {"ok": True}
