"""Cấu hình sửa được từ giao diện quản trị.

Vì sao cần bảng này thay vì chỉ dùng `.env`: đổi ID Google Sheet là việc vận hành bình thường
(đổi sheet, đổi kỳ, sửa sai), nhưng sửa `.env` đòi hỏi truy cập máy chủ và khởi động lại dịch vụ.
Người phụ trách vận hành thường không có quyền đó.

Thứ tự ưu tiên khi đọc cấu hình: **giá trị trong bảng này** → giá trị trong `.env`.
Nhờ vậy hệ thống vẫn chạy được khi chưa ai vào giao diện đặt gì.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, IdMixin, PKType, TimestampMixin


class AppSetting(Base, IdMixin, TimestampMixin):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(80), unique=True, nullable=False)
    value: Mapped[str | None] = mapped_column(Text)

    #: Nhóm để giao diện gom thành từng khối (google_sheet, telegram, smtp…).
    group: Mapped[str] = mapped_column(String(40), nullable=False, default="general", index=True)
    label: Mapped[str] = mapped_column(String(150), nullable=False)
    description: Mapped[str | None] = mapped_column(String(500))

    #: Giá trị nhạy cảm (token, mật khẩu) — API che bớt khi trả về.
    is_secret: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    value_type: Mapped[str] = mapped_column(String(15), nullable=False, default="text")

    updated_by: Mapped[int | None] = mapped_column(PKType)
    updated_at_by_staff: Mapped[datetime | None] = mapped_column(DateTime)
