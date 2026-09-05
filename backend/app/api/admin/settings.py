"""Cấu hình vận hành sửa được từ giao diện — YC8."""

from __future__ import annotations

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from app.core.datetime_utils import parse_hhmm, to_local
from app.core.deps import DbSession, client_ip, require_super_admin, user_agent
from app.core.exceptions import ValidationError
from app.models.staff import Staff
from app.schemas.common import Message
from app.services import settings_service
from app.services.audit_service import log_action

router = APIRouter(prefix="/settings", tags=["admin-settings"])


def _validate_time(values: dict[str, str], key: str) -> None:
    """Chặn giờ sai định dạng ngay tại cửa.

    Lưu được một giá trị hỏng thì scheduler lùi về mặc định và chỉ ghi log — người sửa vẫn thấy
    "đã lưu" và tưởng job chạy vào giờ mình đặt.
    """
    raw = (values.get(key) or "").strip()
    if not raw:
        return
    try:
        parse_hhmm(raw)
    except (ValueError, AttributeError):
        raise ValidationError(f"Giờ phải viết dạng HH:MM (ví dụ 04:10), nhận được {raw!r}")

# Cấu hình chạm tới bí mật hệ thống (bot token, mật khẩu SMTP) và ngưỡng khoá tài khoản
# khách hàng — chỉ Quản trị tối cao được sửa.
SuperOnly = Annotated[Staff, Depends(require_super_admin)]


class UpdateSettingsRequest(BaseModel):
    values: dict[str, str]
    reason: str = Field(min_length=3, max_length=500)


@router.get("", response_model=dict)
def list_settings(staff: SuperOnly, db: DbSession, group: str | None = None) -> dict:
    items = settings_service.list_settings(db, group)
    groups: dict[str, dict] = {}
    for item in items:
        bucket = groups.setdefault(
            item["group"], {"group": item["group"], "label": item["group_label"], "items": []}
        )
        bucket["items"].append(item)
    return {"groups": list(groups.values())}


@router.put("", response_model=Message)
def update_settings(
    payload: UpdateSettingsRequest, staff: SuperOnly, request: Request, db: DbSession
) -> Message:
    _validate_time(payload.values, "news_sync_time")

    changed = settings_service.update_settings(db, payload.values, staff.id)

    if changed:
        log_action(
            db, action="settings.update", actor=staff, target_type="settings",
            target_id=",".join(changed[:5]),
            # Không ghi giá trị vào nhật ký — trong đó có token và mật khẩu.
            new_value={"changed_keys": changed},
            reason=payload.reason, ip=client_ip(request), user_agent=user_agent(request),
        )
    db.commit()

    message = (
        f"Đã cập nhật {len(changed)} cấu hình" if changed else "Không có cấu hình nào thay đổi"
    )

    if "news_sync_time" in changed:
        # Scheduler đọc giờ này lúc khởi động; không đặt lại ở đây thì giá trị mới chỉ có hiệu
        # lực sau lần khởi động backend kế tiếp — người vừa sửa sẽ tưởng mình đặt hỏng.
        from app.jobs import scheduler as job_scheduler

        next_run = job_scheduler.reschedule_news_sync()
        if next_run:
            message += f". Lượt kéo tin kế tiếp: {to_local(datetime.fromisoformat(next_run)):%H:%M %d/%m}"

    return Message(message=message)


@router.post("/test-google-sheet", response_model=dict)
def test_google_sheet(staff: SuperOnly, db: DbSession) -> dict:
    """Thử đọc sheet với cấu hình đang lưu — kiểm tra trước khi để job tự chạy."""
    from app.services import nav_sync_service

    try:
        rows = nav_sync_service.fetch_sheet_rows()
    except Exception as exc:
        return {
            "ok": False,
            "message": f"{type(exc).__name__}: {str(exc)[:300]}",
            "hint": (
                "Kiểm tra: ID sheet đúng chưa · file service account có tồn tại không · "
                "đã chia sẻ sheet cho email của service account ở quyền Viewer chưa."
            ),
        }

    valid, invalid = nav_sync_service.parse_rows(rows)
    return {
        "ok": True,
        "message": f"Đọc được {len(rows)} dòng, {len(valid)} dòng hợp lệ.",
        "rows_read": len(rows),
        "rows_valid": len(valid),
        "invalid": invalid[:10],
        "sample": [
            {"email": r.email, "account_no": r.account_no, "nav": float(r.nav)}
            for r in valid[:5]
        ],
    }
