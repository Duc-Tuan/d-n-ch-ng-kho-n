"""Tiện ích thời gian.

Quy ước (BR-130): lưu mọi mốc thời gian ở **UTC**, chỉ đổi sang Asia/Ho_Chi_Minh khi hiển thị
hoặc khi cần xác định "ngày giao dịch".
"""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta, timezone

from app.core.config import settings


def utcnow() -> datetime:
    """Thời điểm hiện tại, UTC, có tzinfo."""
    return datetime.now(timezone.utc)


def as_utc(dt: datetime | None) -> datetime | None:
    """Chuẩn hoá về UTC-aware. MySQL trả về datetime naive nên phải gắn lại tz."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def ensure_aware(dt: datetime | None, reference: datetime | None = None) -> datetime | None:
    """Gắn tzinfo cho mốc thời gian đọc từ CSDL trước khi đem so sánh.

    MySQL trả `DATETIME` không kèm múi giờ; so một giá trị naive với `utcnow()` ném
    `TypeError: can't compare offset-naive and offset-aware datetimes` — lỗi chỉ lộ ra khi
    chạy thật với MySQL, còn test dùng SQLite thì qua. Mọi chỗ kiểm tra hạn (token, OTP, phiên,
    khoá đăng nhập) phải đi qua đây.

    `reference` để tương thích cách gọi cũ; mặc định coi giá trị trong CSDL là UTC (BR-130).
    """
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt
    return dt.replace(tzinfo=(reference.tzinfo if reference and reference.tzinfo else timezone.utc))


def is_expired(dt: datetime | None, *, now: datetime | None = None, default: bool = True) -> bool:
    """`dt` đã qua chưa. Thiếu mốc hạn thì trả `default` (mặc định: coi như hết hạn).

    Mặc định nghiêng về phía an toàn: một token không có `expires_at` là dữ liệu hỏng, và
    coi dữ liệu hỏng là "còn hiệu lực" thì token đó sống vĩnh viễn.
    """
    if dt is None:
        return default
    now = now or utcnow()
    return ensure_aware(dt, now) < now


def to_local(dt: datetime | None) -> datetime | None:
    d = as_utc(dt)
    return d.astimezone(settings.tz) if d else None


def local_today() -> date:
    """Ngày hiện tại theo múi giờ Việt Nam — mốc để xác định ngày giao dịch."""
    return datetime.now(settings.tz).date()


def local_now() -> datetime:
    return datetime.now(settings.tz)


def start_of_local_day(d: date) -> datetime:
    """00:00 giờ VN của ngày d, quy về UTC."""
    return datetime.combine(d, time.min, tzinfo=settings.tz).astimezone(timezone.utc)


def end_of_local_day(d: date) -> datetime:
    return datetime.combine(d, time.max, tzinfo=settings.tz).astimezone(timezone.utc)


def add_months(dt: datetime, months: int) -> datetime:
    """BR-130 — cộng theo **tháng lịch**, không dùng 30 ngày.

    31/01 + 3 tháng = 30/04 (kẹp về ngày cuối tháng nếu tháng đích ngắn hơn).
    """
    if months == 0:
        return dt
    month_index = dt.month - 1 + months
    year = dt.year + month_index // 12
    month = month_index % 12 + 1
    day = min(dt.day, calendar.monthrange(year, month)[1])
    return dt.replace(year=year, month=month, day=day)


def days_between(earlier: datetime | date | None, later: datetime | date | None) -> int | None:
    """Số ngày lịch (theo giờ VN) giữa hai mốc. None nếu thiếu dữ liệu."""
    if earlier is None or later is None:
        return None
    a = to_local(earlier).date() if isinstance(earlier, datetime) else earlier
    b = to_local(later).date() if isinstance(later, datetime) else later
    return (b - a).days


def parse_hhmm(value: str) -> time:
    hh, mm = value.split(":")
    return time(int(hh), int(mm))


def in_quiet_hours(now_local: datetime | None = None) -> bool:
    """BR-816 — 22:00–07:00 không gửi SMS/push (trừ thông báo bảo mật)."""
    now_local = now_local or local_now()
    h = now_local.hour
    start, end = settings.quiet_hours_start, settings.quiet_hours_end
    if start > end:  # khoảng vắt qua nửa đêm
        return h >= start or h < end
    return start <= h < end


def next_quiet_hours_end(now_local: datetime | None = None) -> datetime:
    """BR-816 — thông báo bị dồn sẽ gửi vào 07:30."""
    now_local = now_local or local_now()
    target = now_local.replace(hour=settings.quiet_hours_end, minute=30, second=0, microsecond=0)
    if target <= now_local:
        target += timedelta(days=1)
    return target.astimezone(timezone.utc)
