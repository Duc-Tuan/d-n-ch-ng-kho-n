"""Điều phối job — dùng chung cho scheduler và cho nút "chạy lại" trên Admin Site."""

from __future__ import annotations

import logging
from datetime import date
from typing import Callable

from app.core.constants import SyncJobType
from app.jobs import tasks
from app.services import notification_service

log = logging.getLogger(__name__)

JOB_REGISTRY: dict[str, Callable] = {
    SyncJobType.SYNC_NAV: tasks.job_sync_nav,
    SyncJobType.CHECK_COMPLIANCE: tasks.job_check_compliance,
    SyncJobType.CHECK_SUBSCRIPTION: tasks.job_check_subscription,
    SyncJobType.NOTIFY_EXPIRY: tasks.job_notify_expiry,
    SyncJobType.NOTIFY_WARNING: tasks.job_notify_warning,
    SyncJobType.CLOSE_SIGNALS: tasks.job_close_signals,
    SyncJobType.CLEANUP: tasks.job_cleanup,
    "sync_market": tasks.job_sync_market,
    SyncJobType.SYNC_NEWS: tasks.job_sync_news,
}


def run_job(job_type: str, run_date: date | None = None, triggered_by: str = "scheduler",
            force: bool = False) -> None:
    """BR-700 — bọc mọi job để lỗi ngoài dự kiến vẫn được cảnh báo, không chết âm thầm."""
    handler = JOB_REGISTRY.get(job_type)
    if not handler:
        log.error("Job không tồn tại: %s", job_type)
        return

    log.info("Bắt đầu job %s (run_date=%s, by=%s, force=%s)", job_type, run_date, triggered_by, force)
    try:
        handler(run_date=run_date, triggered_by=triggered_by, force=force)
        log.info("Hoàn tất job %s", job_type)
    except Exception as exc:
        log.exception("Job %s lỗi nghiêm trọng", job_type)
        notification_service.notify_admins(
            f"Job {job_type} lỗi nghiêm trọng",
            f"{type(exc).__name__}: {exc}\n\n"
            "Job đã dừng. Kiểm tra log ứng dụng để biết chi tiết.",
        )
