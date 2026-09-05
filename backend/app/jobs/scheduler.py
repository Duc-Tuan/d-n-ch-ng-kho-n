"""Lịch chạy job — Phần 6.

Dùng APScheduler in-process cho quy mô 1.000–10.000 user. Khi cần scale nhiều instance,
thay bằng Celery beat hoặc để một instance duy nhất bật `ENABLE_SCHEDULER=true`.
"""

from __future__ import annotations

import logging

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger

from app.core.config import settings
from app.core.constants import SyncJobType
from app.core.datetime_utils import parse_hhmm
from app.jobs import runner, tasks

log = logging.getLogger(__name__)

_scheduler: BackgroundScheduler | None = None


def _cron(expr: str) -> CronTrigger:
    minute, hour, day, month, day_of_week = expr.split()
    return CronTrigger(
        minute=minute, hour=hour, day=day, month=month, day_of_week=day_of_week,
        timezone=settings.tz,
    )


#: Giờ dự phòng khi cấu hình trong CSDL trống hoặc viết sai định dạng.
NEWS_SYNC_FALLBACK = "04:10"


def news_sync_trigger() -> CronTrigger:
    """Giờ chạy job kéo tin, đọc từ bảng cấu hình chứ không phải từ `.env`.

    Người vận hành sửa giờ ở màn Cấu hình hệ thống; `reschedule_news_sync()` áp giá trị mới
    ngay, không phải khởi động lại backend. Giá trị hỏng thì lùi về mặc định và ghi log, chứ
    không để scheduler chết lúc khởi động — mất cả những job còn lại.
    """
    from app.core.database import session_scope
    from app.services.settings_service import get_setting

    raw = settings.job_sync_news_time
    try:
        with session_scope() as db:
            raw = get_setting(db, "news_sync_time") or raw
    except Exception:
        log.warning("Không đọc được cấu hình giờ kéo tin, dùng %s", raw)

    try:
        at = parse_hhmm(raw)
    except (ValueError, AttributeError):
        log.warning("Giờ kéo tin không hợp lệ (%r), dùng %s", raw, NEWS_SYNC_FALLBACK)
        at = parse_hhmm(NEWS_SYNC_FALLBACK)
    return CronTrigger(hour=at.hour, minute=at.minute, timezone=settings.tz)


def reschedule_news_sync() -> str | None:
    """Áp giờ mới cho job kéo tin. Trả về mốc chạy kế tiếp để hiện lại cho người vừa sửa."""
    if not _scheduler or not _scheduler.get_job(SyncJobType.SYNC_NEWS):
        return None
    _scheduler.reschedule_job(SyncJobType.SYNC_NEWS, trigger=news_sync_trigger())
    job = _scheduler.get_job(SyncJobType.SYNC_NEWS)
    return job.next_run_time.isoformat() if job and job.next_run_time else None


def start_scheduler() -> BackgroundScheduler | None:
    global _scheduler
    if not settings.enable_scheduler:
        log.info("Scheduler bị tắt qua ENABLE_SCHEDULER=false")
        return None
    if _scheduler and _scheduler.running:
        return _scheduler

    scheduler = BackgroundScheduler(timezone=settings.tz)

    jobs = [
        (SyncJobType.SYNC_NAV, settings.job_sync_nav_cron),
        (SyncJobType.CHECK_COMPLIANCE, settings.job_check_compliance_cron),
        (SyncJobType.CHECK_SUBSCRIPTION, settings.job_check_subscription_cron),
        (SyncJobType.NOTIFY_EXPIRY, settings.job_notify_expiry_cron),
        (SyncJobType.NOTIFY_WARNING, settings.job_notify_warning_cron),
        (SyncJobType.CLOSE_SIGNALS, settings.job_close_signals_cron),
        (SyncJobType.CLEANUP, settings.job_cleanup_cron),
        ("sync_market", settings.job_sync_market_cron),
    ]
    for job_type, cron_expr in jobs:
        scheduler.add_job(
            runner.run_job,
            trigger=_cron(cron_expr),
            args=[job_type],
            id=job_type,
            replace_existing=True,
            # Job trùng lịch (sync_nav 15:15 và check_compliance 16:30) không được chồng nhau.
            max_instances=1,
            misfire_grace_time=3600,
        )

    # BR-812 — worker gửi thông báo, tách khỏi request.
    scheduler.add_job(
        tasks.job_process_notifications,
        trigger=IntervalTrigger(seconds=60),
        id="notification_worker",
        replace_existing=True,
        max_instances=1,
    )

    # BR-873/875 — worker Telegram chạy dày hơn để đạt mục tiêu dưới 60 giây.
    scheduler.add_job(
        tasks.job_process_telegram_queue,
        trigger=IntervalTrigger(seconds=10),
        id="telegram_worker",
        replace_existing=True,
        max_instances=1,
    )

    # Kéo tin dẫn nguồn. Giờ nằm ở cấu hình sửa được, không ở `.env`, nên đăng ký riêng thay
    # vì gộp vào danh sách cron phía trên.
    scheduler.add_job(
        runner.run_job,
        trigger=news_sync_trigger(),
        args=[SyncJobType.SYNC_NEWS],
        id=SyncJobType.SYNC_NEWS,
        replace_existing=True,
        max_instances=1,
        misfire_grace_time=3600,
    )

    # BR-872 — tin tổng hợp cuối phiên.
    digest_time = parse_hhmm(settings.telegram_digest_time)
    scheduler.add_job(
        tasks.job_telegram_digest,
        trigger=CronTrigger(hour=digest_time.hour, minute=digest_time.minute, timezone=settings.tz),
        id="telegram_digest",
        replace_existing=True,
        max_instances=1,
    )

    scheduler.start()
    _scheduler = scheduler
    log.info("Scheduler đã khởi động với %s job", len(scheduler.get_jobs()))
    return scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        log.info("Scheduler đã dừng")


def list_jobs() -> list[dict]:
    if not _scheduler:
        return []
    return [
        {
            "id": job.id,
            "next_run": job.next_run_time.isoformat() if job.next_run_time else None,
            "trigger": str(job.trigger),
        }
        for job in _scheduler.get_jobs()
    ]
