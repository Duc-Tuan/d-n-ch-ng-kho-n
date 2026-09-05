"""NAV, đồng bộ dữ liệu và compliance (mục 2.6, 2.7)."""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.constants import SyncJobStatus
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType


class NavDaily(Base, IdMixin, CreatedAtMixin):
    """BR-404 — một dòng/user/ngày, **không ghi đè** giá trị lên bảng users.

    Đây là dữ liệu để (a) tính NAV trung bình 20 phiên và (b) chứng minh khi KH khiếu nại.
    """

    __tablename__ = "nav_daily"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    trade_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    nav: Mapped[Decimal] = mapped_column(Numeric(20, 2), nullable=False)
    last_trade_date: Mapped[date | None] = mapped_column(Date)
    order_count_30d: Mapped[int | None] = mapped_column(Integer)
    account_no: Mapped[str | None] = mapped_column(String(50))
    source: Mapped[str] = mapped_column(String(30), nullable=False, default="GOOGLE_SHEET")
    sync_job_id: Mapped[int | None] = mapped_column(PKType)

    __table_args__ = (
        UniqueConstraint("user_id", "trade_date", name="uq_nav_user_date"),
        Index("ix_nav_user_date_desc", "user_id", "trade_date"),
    )


class SyncJob(Base, IdMixin):
    """BR-700 — mọi job đều ghi kết quả vào đây; job fail âm thầm là nguyên nhân sự cố số một."""

    __tablename__ = "sync_jobs"

    job_type: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    run_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=SyncJobStatus.RUNNING, index=True
    )
    rows_read: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_matched: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_unmatched: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rows_written: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error_message: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[dict | None] = mapped_column(nullable=True)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    triggered_by: Mapped[str] = mapped_column(String(20), nullable=False, default="scheduler")

    __table_args__ = (Index("ix_syncjob_type_date", "job_type", "run_date"),)


class SyncUnmatched(Base, IdMixin, CreatedAtMixin):
    """BR-403.5 — email trong sheet không khớp `users`: ghi lại cho admin xử lý, không bỏ qua âm thầm."""

    __tablename__ = "sync_unmatched"

    sync_job_id: Mapped[int] = mapped_column(PKType, ForeignKey("sync_jobs.id"), nullable=False, index=True)
    email_in_sheet: Mapped[str | None] = mapped_column(String(190), index=True)
    account_no: Mapped[str | None] = mapped_column(String(50))
    nav: Mapped[Decimal | None] = mapped_column(Numeric(20, 2))
    row_number: Mapped[int | None] = mapped_column(Integer)
    note: Mapped[str | None] = mapped_column(String(255))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime)
    resolved_by: Mapped[int | None] = mapped_column(PKType)


class ComplianceEvent(Base, IdMixin, CreatedAtMixin):
    """Nhật ký thay đổi trạng thái compliance — bằng chứng khi KH khiếu nại."""

    __tablename__ = "compliance_events"

    user_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    event: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str | None] = mapped_column(String(20))
    reason: Mapped[str | None] = mapped_column(String(255))
    nav_avg_20: Mapped[Decimal | None] = mapped_column(Numeric(20, 2))
    days_since_last_trade: Mapped[int | None] = mapped_column(Integer)
    triggered_by: Mapped[str] = mapped_column(String(10), nullable=False, default="job")
    staff_id: Mapped[int | None] = mapped_column(PKType)


class TradingCalendar(Base):
    """BR-402 — lịch nghỉ giao dịch. Không có bảng này thì job sẽ chạy nhầm vào ngày lễ."""

    __tablename__ = "trading_calendar"

    trade_date: Mapped[date] = mapped_column(Date, primary_key=True)
    is_trading_day: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    note: Mapped[str | None] = mapped_column(String(150))
