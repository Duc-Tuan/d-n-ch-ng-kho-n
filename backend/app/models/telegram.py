"""Kết nối Telegram và đăng ký nhận tín hiệu (Phần 15)."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import DeliveryStatus, TelegramStatus
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class TelegramConnection(Base, IdMixin, TimestampMixin):
    """BR-861/862 — chat_id lấy trực tiếp từ Telegram qua deep-link, không để KH tự gõ."""

    __tablename__ = "telegram_connections"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False
    )
    #: chat_id âm là nhóm/kênh — BR-863 chặn ở v1.
    chat_id: Mapped[int | None] = mapped_column(BigInteger, unique=True, index=True)
    telegram_username: Mapped[str | None] = mapped_column(String(100))
    telegram_first_name: Mapped[str | None] = mapped_column(String(150))

    status: Mapped[str] = mapped_column(
        String(15), nullable=False, default=TelegramStatus.PENDING, index=True
    )

    connect_token: Mapped[str | None] = mapped_column(String(64), index=True)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    #: Phương án dự phòng BR-862 — mã 6 số gửi tới chat_id để xác thực quyền sở hữu.
    verify_code_hash: Mapped[str | None] = mapped_column(String(64))
    verify_code_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    verify_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    verified_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(String(255))
    error_code: Mapped[int | None] = mapped_column(Integer)
    error_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    #: BR-879 — checkbox đồng ý riêng cho việc gửi dữ liệu qua Telegram.
    consent_at: Mapped[datetime | None] = mapped_column(DateTime)


class StrategyAlert(Base, IdMixin, CreatedAtMixin):
    """BR-858b — đơn vị đăng ký là **cặp (chiến lược × mã)**, `symbol` không cho NULL.

    Thay thế bảng `strategy_follows` ở mục 13.5.
    """

    __tablename__ = "strategy_alerts"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    strategy_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("strategies.id", ondelete="CASCADE"), nullable=False
    )
    symbol: Mapped[str] = mapped_column(String(20), nullable=False)

    #: BR-871 — KH bật/tắt từng loại: ["ENTRY","TP","SL","CANCELLED"]
    alert_types: Mapped[dict | None] = mapped_column(nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    #: BR-860c — không xoá âm thầm khi admin gỡ mã khỏi phạm vi chiến lược.
    inactive_reason: Mapped[str | None] = mapped_column(String(30))
    inactive_at: Mapped[datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint("user_id", "strategy_id", "symbol", name="uq_alert_pair"),
        # Truy vấn nóng nhất của hệ thống (mục 15.9).
        Index("ix_alert_hot", "strategy_id", "symbol", "is_active"),
    )


class AlertDelivery(Base, IdMixin):
    """BR-874 — idempotency; BR-883 — luôn ghi lý do SKIPPED."""

    __tablename__ = "alert_deliveries"

    signal_id: Mapped[int] = mapped_column(PKType, ForeignKey("signals.id"), nullable=False, index=True)
    user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    alert_type: Mapped[str] = mapped_column(String(15), nullable=False)
    channel: Mapped[str] = mapped_column(String(15), nullable=False, default="TELEGRAM")

    status: Mapped[str] = mapped_column(
        String(10), nullable=False, default=DeliveryStatus.QUEUED, index=True
    )
    skip_reason: Mapped[str | None] = mapped_column(String(40))
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    error_code: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(String(255))

    queued_at: Mapped[datetime | None] = mapped_column(DateTime)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (
        UniqueConstraint("signal_id", "user_id", "alert_type", name="uq_delivery_once"),
    )


class TelegramDailyCounter(Base, IdMixin):
    """BR-872 — đếm số tin tín hiệu đã gửi trong ngày cho từng KH."""

    __tablename__ = "telegram_daily_counters"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    send_date: Mapped[date] = mapped_column(Date, nullable=False)
    sent_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    #: Tín hiệu vượt hạn mức được gom vào tin tổng hợp cuối phiên.
    deferred: Mapped[dict | None] = mapped_column(nullable=True)

    __table_args__ = (UniqueConstraint("user_id", "send_date", name="uq_tg_counter"),)
