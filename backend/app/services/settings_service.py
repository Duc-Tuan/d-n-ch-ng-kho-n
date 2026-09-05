"""Đọc/ghi cấu hình vận hành sửa được từ giao diện.

Thứ tự ưu tiên: **bảng `app_settings`** → `.env`. Ai cũng đọc qua `get_setting()` chứ không đọc
thẳng `settings.google_sheet_id`, nếu không thì giá trị đặt trên giao diện sẽ bị bỏ qua.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.datetime_utils import utcnow
from app.models.setting import AppSetting

log = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SettingDef:
    key: str
    label: str
    group: str
    description: str = ""
    is_secret: bool = False
    value_type: str = "text"
    #: Tên thuộc tính tương ứng trong `.env` để lấy giá trị dự phòng.
    env_attr: str | None = None


#: Danh mục cấu hình hiển thị trên giao diện quản trị.
SETTING_DEFS: tuple[SettingDef, ...] = (
    SettingDef(
        "google_sheet_id", "ID Google Sheet", "google_sheet",
        "Chuỗi ID nằm giữa /d/ và /edit trong URL của sheet.",
        env_attr="google_sheet_id",
    ),
    SettingDef(
        "google_sheet_range", "Vùng dữ liệu", "google_sheet",
        "Ví dụ NAV!A2:G — bắt đầu từ dòng 2 để bỏ dòng tiêu đề.",
        env_attr="google_sheet_range",
    ),
    SettingDef(
        "google_service_account_file", "Đường dẫn file service account", "google_sheet",
        "File JSON tải từ Google Cloud. Nhớ chia sẻ sheet cho email của service account "
        "ở quyền Viewer — không dùng link công khai vì NAV là dữ liệu tài chính cá nhân.",
        env_attr="google_service_account_file",
    ),
    SettingDef(
        "nav_sync_max_row_drop_pct", "Ngưỡng cảnh báo sụt số dòng (%)", "google_sheet",
        "Số dòng hôm nay giảm quá mức này so với lần đồng bộ trước thì job dừng và báo lỗi, "
        "để tránh ghi đè khi sheet bị xoá nhầm.",
        value_type="number", env_attr="nav_sync_max_row_drop_pct",
    ),
    SettingDef(
        "compliance_nav_min", "Ngưỡng NAV tối thiểu (VND)", "compliance",
        "Dưới ngưỡng này thì tài khoản bị cảnh báo. Đúng bằng ngưỡng vẫn được coi là đạt.",
        value_type="number", env_attr="compliance_nav_min",
    ),
    SettingDef(
        "compliance_nav_window", "Số phiên tính NAV trung bình", "compliance",
        "Dùng trung bình nhiều phiên thay vì NAV cuối ngày để khách hàng rút tiền tạm vài "
        "ngày không bị khoá oan.",
        value_type="number", env_attr="compliance_nav_window",
    ),
    SettingDef(
        "compliance_no_trade_days", "Số ngày không giao dịch tối đa", "compliance",
        value_type="number", env_attr="compliance_no_trade_days",
    ),
    SettingDef(
        "compliance_warning_days", "Số ngày cảnh báo trước khi tạm dừng", "compliance",
        "Không khoá đột ngột — đây vừa là nghĩa vụ với khách đã trả tiền, vừa là khoảng thời "
        "gian để môi giới gọi điện.",
        value_type="number", env_attr="compliance_warning_days",
    ),
    SettingDef(
        "telegram_bot_token", "Bot token Telegram", "telegram",
        "Lấy từ @BotFather. Tương đương mật khẩu quản trị của toàn bộ kênh Telegram.",
        is_secret=True, env_attr="telegram_bot_token",
    ),
    SettingDef(
        "telegram_bot_username", "Tên bot Telegram", "telegram",
        "Không kèm dấu @. Dùng để sinh link kết nối cho khách hàng.",
        env_attr="telegram_bot_username",
    ),
    SettingDef(
        "telegram_webhook_secret", "Secret xác thực webhook", "telegram",
        "Bắt buộc có, nếu không bất kỳ ai cũng gửi được lệnh giả để chiếm kết nối của khách hàng.",
        is_secret=True, env_attr="telegram_webhook_secret",
    ),
    SettingDef(
        "news_sync_time", "Giờ kéo tin hằng ngày", "news",
        "Định dạng HH:MM theo giờ Việt Nam, ví dụ 04:10. Đổi giờ có hiệu lực ngay, không cần "
        "khởi động lại. Máy chủ phải đang bật vào đúng giờ này thì job mới chạy.",
        env_attr="job_sync_news_time",
    ),
    SettingDef(
        "smtp_host", "Máy chủ SMTP", "email", env_attr="smtp_host",
    ),
    SettingDef(
        "smtp_port", "Cổng SMTP", "email", value_type="number", env_attr="smtp_port",
    ),
    SettingDef(
        "smtp_user", "Tài khoản SMTP", "email", env_attr="smtp_user",
    ),
    SettingDef(
        "smtp_password", "Mật khẩu SMTP", "email", is_secret=True, env_attr="smtp_password",
    ),
    SettingDef(
        "smtp_from_email", "Email người gửi", "email", env_attr="smtp_from_email",
    ),
)

DEFS_BY_KEY = {d.key: d for d in SETTING_DEFS}

GROUP_LABELS = {
    "google_sheet": "Đồng bộ NAV từ Google Sheet",
    "compliance": "Điều kiện duy trì tài khoản",
    "telegram": "Telegram",
    "news": "Tin tức dẫn nguồn",
    "email": "Gửi email (SMTP)",
}


def get_setting(db: Session, key: str) -> str | None:
    """Giá trị đang có hiệu lực: ưu tiên bảng cấu hình, không có thì lấy từ `.env`."""
    row = db.scalar(select(AppSetting).where(AppSetting.key == key))
    if row and row.value not in (None, ""):
        return row.value

    definition = DEFS_BY_KEY.get(key)
    if definition and definition.env_attr:
        value = getattr(settings, definition.env_attr, None)
        return str(value) if value not in (None, "") else None
    return None


def get_int(db: Session, key: str, default: int) -> int:
    value = get_setting(db, key)
    try:
        return int(value) if value is not None else default
    except (TypeError, ValueError):
        log.warning("Cấu hình %s không phải số (%r), dùng mặc định %s", key, value, default)
        return default


def list_settings(db: Session, group: str | None = None) -> list[dict]:
    """Danh sách cấu hình để dựng giao diện, kèm nguồn giá trị đang dùng."""
    rows = {r.key: r for r in db.scalars(select(AppSetting)).all()}

    result = []
    for definition in SETTING_DEFS:
        if group and definition.group != group:
            continue

        row = rows.get(definition.key)
        stored = row.value if row else None
        env_value = (
            str(getattr(settings, definition.env_attr, "") or "")
            if definition.env_attr
            else ""
        )
        effective = stored if stored not in (None, "") else env_value

        result.append(
            {
                "key": definition.key,
                "label": definition.label,
                "group": definition.group,
                "group_label": GROUP_LABELS.get(definition.group, definition.group),
                "description": definition.description or None,
                "value_type": definition.value_type,
                "is_secret": definition.is_secret,
                # Giá trị nhạy cảm chỉ trả về dạng che, tránh lộ token qua API hay log trình duyệt.
                "value": _mask(effective) if definition.is_secret else effective,
                "has_value": bool(effective),
                "source": "database" if stored not in (None, "") else ("env" if env_value else "none"),
                "updated_at": row.updated_at_by_staff if row else None,
            }
        )
    return result


def _mask(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 8:
        return "•" * len(value)
    return f"{value[:4]}{'•' * 8}{value[-4:]}"


def update_settings(db: Session, values: dict[str, str], staff_id: int) -> list[str]:
    """Lưu giá trị mới. Trả về danh sách khoá đã đổi (để ghi audit log)."""
    changed: list[str] = []

    for key, raw in values.items():
        definition = DEFS_BY_KEY.get(key)
        if not definition:
            continue

        value = (raw or "").strip()
        # Ô nhập giá trị nhạy cảm để trống nghĩa là "giữ nguyên", không phải "xoá đi".
        if definition.is_secret and not value:
            continue

        row = db.scalar(select(AppSetting).where(AppSetting.key == key))
        if row:
            if row.value == value:
                continue
            row.value = value
            row.updated_by = staff_id
            row.updated_at_by_staff = utcnow()
        else:
            db.add(
                AppSetting(
                    key=key,
                    value=value,
                    group=definition.group,
                    label=definition.label,
                    description=definition.description or None,
                    is_secret=definition.is_secret,
                    value_type=definition.value_type,
                    updated_by=staff_id,
                    updated_at_by_staff=utcnow(),
                )
            )
        changed.append(key)

    db.flush()
    return changed
