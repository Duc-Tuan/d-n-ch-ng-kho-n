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


#: Id job chạy mẻ "Đồng bộ tất cả" theo chu kỳ. Đặt tên rõ ràng vì `reschedule_market_fullsync`
#: phải tìm lại đúng job này để gỡ hoặc đổi chu kỳ.
MARKET_FULLSYNC_JOB = "market_fullsync"

#: Chu kỳ cho phép đặt, tính bằng giờ. Dưới 1 giờ là vô nghĩa — một mẻ toàn danh mục chạy hàng
#: chục phút, đặt 30 phút thì mẻ sau luôn gặp mẻ trước còn đang chạy và bị bỏ qua.
FULLSYNC_MIN_HOURS = 1
FULLSYNC_MAX_HOURS = 24 * 14


def fullsync_interval_hours() -> int:
    """Chu kỳ tự đồng bộ toàn bộ nến, đọc từ bảng cấu hình chứ không phải từ `.env`.

    Cùng khuôn với `news_sync_trigger`: người vận hành sửa ở màn Cấu hình hệ thống,
    `reschedule_market_fullsync()` áp ngay, không phải khởi động lại backend. 0 nghĩa là tắt —
    chỉ chạy khi bấm nút.
    """
    from app.core.database import session_scope
    from app.services.settings_service import get_setting

    raw = settings.job_market_fullsync_interval_hours
    try:
        with session_scope() as db:
            raw = get_setting(db, "market_fullsync_interval_hours") or raw
    except Exception:
        log.warning("Không đọc được chu kỳ đồng bộ toàn bộ, dùng %s giờ", raw)

    try:
        hours = int(str(raw).strip() or 0)
    except (TypeError, ValueError):
        log.warning("Chu kỳ đồng bộ toàn bộ không hợp lệ (%r), coi như tắt", raw)
        return 0

    if hours <= 0:
        return 0
    return max(FULLSYNC_MIN_HOURS, min(hours, FULLSYNC_MAX_HOURS))


def reschedule_market_fullsync() -> dict:
    """Áp chu kỳ mới. Trả về trạng thái để hiện lại ngay cho người vừa bấm lưu."""
    if not _scheduler:
        return {"enabled": False, "interval_hours": 0, "next_run": None,
                "reason": "Scheduler đang tắt (ENABLE_SCHEDULER=false)"}

    hours = fullsync_interval_hours()
    existing = _scheduler.get_job(MARKET_FULLSYNC_JOB)

    if hours <= 0:
        if existing:
            _scheduler.remove_job(MARKET_FULLSYNC_JOB)
        return {"enabled": False, "interval_hours": 0, "next_run": None}

    _scheduler.add_job(
        tasks.job_market_fullsync,
        trigger=IntervalTrigger(hours=hours),
        id=MARKET_FULLSYNC_JOB,
        replace_existing=True,
        max_instances=1,
        # Mẻ chạy hàng chục phút. Bỏ lỡ vì backend tắt thì chạy bù ở lần khởi động sau là đúng,
        # nhưng đừng chạy bù một mẻ đã quá hạn cả ngày — chu kỳ tiếp theo cũng sắp tới rồi.
        misfire_grace_time=3600,
    )
    job = _scheduler.get_job(MARKET_FULLSYNC_JOB)
    return {
        "enabled": True,
        "interval_hours": hours,
        "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None,
    }


def market_fullsync_status() -> dict:
    """Lịch hiện tại của mẻ đồng bộ tự động — cho màn quản trị hiện "lần chạy kế tiếp"."""
    hours = fullsync_interval_hours()
    job = _scheduler.get_job(MARKET_FULLSYNC_JOB) if _scheduler else None
    return {
        "enabled": bool(job) and hours > 0,
        "interval_hours": hours,
        "next_run": job.next_run_time.isoformat() if job and job.next_run_time else None,
        "scheduler_running": bool(_scheduler and _scheduler.running),
    }


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

    # BR-831 — bộ lấy giá cho bảng giá. Nhịp dày nhất trong cả scheduler, nên `max_instances=1`
    # là bắt buộc: nhịp đầu tiên của phiên tốn 30–40 giây cho bắt tay TLS, và nếu cho chồng nhau
    # thì trong chừng ấy giây sẽ có hàng chục nhịp cùng gọi một endpoint.
    #
    # Bản thân job tự thoát ngay khi tính năng tắt, ngoài cửa sổ phiên, hoặc ngày nghỉ — rẻ hơn
    # nhiều so với gỡ và cắm lại job mỗi lần đổi cấu hình.
    scheduler.add_job(
        tasks.job_poll_quotes,
        trigger=IntervalTrigger(seconds=max(1, settings.market_realtime_interval_seconds)),
        id="quote_poller",
        replace_existing=True,
        max_instances=1,
        # Nhịp lỡ thì bỏ hẳn, không chạy bù: giá của 30 giây trước không còn giá trị gì.
        coalesce=True,
        misfire_grace_time=5,
    )

    # Bù nến trong ngày giữa phiên — xem `tasks.job_sync_intraday`.
    if settings.market_intraday_sync_minutes > 0:
        scheduler.add_job(
            tasks.job_sync_intraday,
            trigger=IntervalTrigger(minutes=settings.market_intraday_sync_minutes),
            id="intraday_sync",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
            misfire_grace_time=600,
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

    # Cắm sau khi scheduler chạy vì `reschedule_market_fullsync` đọc bảng cấu hình và thao tác
    # trên `_scheduler` — cùng đường mà nút Lưu ở màn Cấu hình đi, nên chỉ có một cách đăng ký
    # job này và không thể lệch nhau.
    try:
        state = reschedule_market_fullsync()
        if state["enabled"]:
            log.info("Đồng bộ toàn bộ nến tự động: mỗi %s giờ", state["interval_hours"])
    except Exception:
        log.warning("Không cắm được lịch đồng bộ toàn bộ nến", exc_info=True)

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
