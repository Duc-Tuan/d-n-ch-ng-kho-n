"""Hệ thống thông báo (Phần 10) và văn bản pháp lý (Phần 9)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import NotificationStatus
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class NotificationTemplate(Base, IdMixin, TimestampMixin):
    """BR-811 — admin sửa nội dung email không cần deploy lại."""

    __tablename__ = "notification_templates"

    code: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(15), nullable=False)
    subject: Mapped[str | None] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(Text, nullable=False)
    #: Danh sách biến cho phép dùng trong template, để admin biết gõ gì.
    variables: Mapped[dict | None] = mapped_column(nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (UniqueConstraint("code", "channel", name="uq_template_code_channel"),)


class Notification(Base, IdMixin, CreatedAtMixin):
    """BR-812/813/814 — hàng đợi + idempotency + log đầy đủ."""

    __tablename__ = "notifications"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String(15), nullable=False, index=True)

    #: BR-813 — bộ ba (user_id, code, reference_id) chỉ gửi MỘT lần duy nhất.
    #: Dùng chuỗi rỗng thay cho NULL vì MySQL không áp UNIQUE lên giá trị NULL.
    reference_id: Mapped[str] = mapped_column(String(60), nullable=False, default="")

    subject: Mapped[str | None] = mapped_column(String(255))
    body: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(nullable=True)

    status: Mapped[str] = mapped_column(
        String(10), nullable=False, default=NotificationStatus.QUEUED, index=True
    )
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)  # BR-816 dồn giờ yên lặng
    sent_at: Mapped[datetime | None] = mapped_column(DateTime)
    read_at: Mapped[datetime | None] = mapped_column(DateTime)
    opened_at: Mapped[datetime | None] = mapped_column(DateTime)  # BR-819
    error: Mapped[str | None] = mapped_column(String(500))
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint("user_id", "code", "reference_id", "channel", name="uq_notification_once"),
        Index("ix_notif_user_unread", "user_id", "read_at"),
        Index("ix_notif_queue", "status", "scheduled_at"),
    )


class NotificationPreference(Base, IdMixin, TimestampMixin):
    """BR-815 — trung tâm tuỳ chọn; chỉ nhóm không bắt buộc mới tắt được."""

    __tablename__ = "notification_preferences"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    code: Mapped[str] = mapped_column(String(40), nullable=False)
    channel: Mapped[str] = mapped_column(String(15), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (UniqueConstraint("user_id", "code", "channel", name="uq_pref"),)


# ======================================================================
# VĂN BẢN PHÁP LÝ — BR-801
# ======================================================================
class LegalDocument(Base, IdMixin, TimestampMixin):
    __tablename__ = "legal_documents"

    type: Mapped[str] = mapped_column(String(25), nullable=False, index=True)
    version: Mapped[str] = mapped_column(String(20), nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    effective_from: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    is_current: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, index=True)
    #: BR-802 — thay đổi trọng yếu thì bắt KH đồng ý lại trước khi vào hệ thống.
    requires_reconsent: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    summary_of_changes: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int | None] = mapped_column(PKType)

    __table_args__ = (UniqueConstraint("type", "version", name="uq_legal_type_version"),)


class UserConsent(Base, IdMixin, CreatedAtMixin):
    """BR-800 — bằng chứng đồng ý: ai, phiên bản nào, lúc nào, từ IP nào."""

    __tablename__ = "user_consents"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    legal_document_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("legal_documents.id"), nullable=False, index=True
    )
    consented_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(400))

    __table_args__ = (UniqueConstraint("user_id", "legal_document_id", name="uq_consent_once"),)
