"""Các job tự động — Phần 6.

BR-700: mọi job ghi kết quả vào `sync_jobs` và cảnh báo admin khi thất bại.
Job chạy âm thầm và fail âm thầm là nguyên nhân số một của sự cố dữ liệu.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import func, select, update

from app.core.config import settings
from app.core.constants import (
    AlertType,
    ComplianceStatus,
    NotificationChannel,
    NotificationCode,
    NotificationStatus,
    SignalExitReason,
    SignalResult,
    SubscriptionStatus,
    SyncJobStatus,
    SyncJobType,
    TelegramStatus,
)
from app.core.database import session_scope
from app.core.datetime_utils import days_between, local_today, utcnow
from app.models.nav import SyncJob
from app.models.notification import Notification
from app.models.strategy import Signal, Strategy
from app.models.telegram import AlertDelivery, StrategyAlert, TelegramConnection
from app.models.user import EmailVerification, Package, PasswordReset, Subscription, User, UserSession
from app.services import (
    compliance_service,
    nav_sync_service,
    notification_service,
    subscription_service,
    telegram_service,
)
from app.core.constants import DeliveryStatus

log = logging.getLogger(__name__)


def _start_job(db, job_type: str, run_date: date, triggered_by: str) -> SyncJob:
    job = SyncJob(
        job_type=job_type, run_date=run_date, status=SyncJobStatus.RUNNING,
        started_at=utcnow(), triggered_by=triggered_by,
    )
    db.add(job)
    db.flush()
    return job


def _finish_job(db, job: SyncJob, status: str, summary: dict | None = None,
                error: str | None = None) -> None:
    job.status = status
    job.summary = summary
    job.error_message = error
    job.finished_at = utcnow()
    db.flush()


# ======================================================================
# sync_nav — 15:15 ngày giao dịch
# ======================================================================
def job_sync_nav(run_date: date | None = None, triggered_by: str = "scheduler",
                 force: bool = False) -> None:
    with session_scope() as db:
        nav_sync_service.run_sync_nav(db, run_date=run_date, triggered_by=triggered_by, force=force)


# ======================================================================
# check_compliance — 16:30 ngày giao dịch
# ======================================================================
def job_check_compliance(run_date: date | None = None, triggered_by: str = "scheduler",
                         force: bool = False) -> None:
    with session_scope() as db:
        compliance_service.run_check_compliance(
            db, run_date=run_date, triggered_by=triggered_by, force=force
        )


# ======================================================================
# check_subscription — 00:05 hằng ngày
# ======================================================================
def job_check_subscription(run_date: date | None = None, triggered_by: str = "scheduler",
                           force: bool = False) -> None:
    """TRIAL→TRIAL_EXPIRED, ACTIVE→GRACE→EXPIRED. Không đụng tới trục compliance."""
    run_date = run_date or local_today()
    with session_scope() as db:
        job = _start_job(db, SyncJobType.CHECK_SUBSCRIPTION, run_date, triggered_by)
        changes: dict[str, int] = {}
        errors: list[str] = []

        users = db.scalars(
            select(User).where(
                User.deleted_at.is_(None),
                User.subscription_status.in_([
                    SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE
                ]),
            )
        ).all()

        for user in users:
            try:
                new_status = subscription_service.refresh_subscription_status(db, user)
                if not new_status:
                    continue
                changes[new_status] = changes.get(new_status, 0) + 1

                if new_status == SubscriptionStatus.TRIAL_EXPIRED:
                    notification_service.enqueue(
                        db, user=user, code=NotificationCode.TRIAL_EXPIRED,
                        channels=[NotificationChannel.EMAIL],
                        reference_id=f"trial_end:{user.id}",
                        context={"full_name": user.full_name},
                    )
                elif new_status == SubscriptionStatus.EXPIRED:
                    notification_service.enqueue(
                        db, user=user, code=NotificationCode.GRACE_END,
                        channels=[NotificationChannel.EMAIL, NotificationChannel.SMS],
                        reference_id=f"grace_end:{user.current_subscription_id}",
                        context={"full_name": user.full_name},
                    )
                    # BR-867 — gửi tin Telegram cuối cùng rồi tạm dừng đăng ký.
                    _notify_telegram_stopped(db, user, "gói dịch vụ đã hết hạn")
            except Exception as exc:
                log.exception("check_subscription lỗi user_id=%s", user.id)
                errors.append(f"user_id={user.id}: {exc}")

        _finish_job(
            db, job,
            SyncJobStatus.SUCCESS if not errors else SyncJobStatus.PARTIAL,
            {"checked": len(users), "changes": changes, "errors": errors[:50]},
        )
        if errors:
            notification_service.notify_admins(
                "Job check_subscription có lỗi", "\n".join(errors[:30])
            )


def _notify_telegram_stopped(db, user: User, reason: str) -> None:
    """BR-867 — báo lý do ngừng nhận tín hiệu kèm link gia hạn, không im lặng cắt."""
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id:
        return
    try:
        telegram_service.send_raw_message(
            conn.chat_id,
            f"⚠️ Bạn sẽ tạm ngừng nhận tín hiệu do {reason}.\n\n"
            f"Gia hạn để tiếp tục: {settings.frontend_base_url}/pricing\n\n"
            "Các đăng ký của bạn được giữ nguyên và sẽ tự hoạt động lại sau khi gia hạn.",
        )
    except Exception as exc:
        log.warning("Không gửi được tin Telegram ngừng nhận cho user_id=%s: %s", user.id, exc)


# ======================================================================
# notify_expiry — 09:00 hằng ngày (BR-133)
# ======================================================================
def job_notify_expiry(run_date: date | None = None, triggered_by: str = "scheduler",
                      force: bool = False) -> None:
    """Nhắc T-15, T-7, T-3, T-1 và ngày hết hạn — kênh gia hạn hiệu quả nhất."""
    run_date = run_date or local_today()
    milestones = {
        15: (NotificationCode.EXPIRY_T15, [NotificationChannel.EMAIL, NotificationChannel.IN_APP]),
        7: (NotificationCode.EXPIRY_T7, [NotificationChannel.EMAIL, NotificationChannel.IN_APP]),
        3: (NotificationCode.EXPIRY_T3,
            [NotificationChannel.EMAIL, NotificationChannel.IN_APP, NotificationChannel.SMS]),
        1: (NotificationCode.EXPIRY_T1,
            [NotificationChannel.EMAIL, NotificationChannel.IN_APP, NotificationChannel.SMS]),
        0: (NotificationCode.EXPIRY_T0, [NotificationChannel.EMAIL, NotificationChannel.IN_APP]),
    }

    with session_scope() as db:
        job = _start_job(db, SyncJobType.NOTIFY_EXPIRY, run_date, triggered_by)
        sent = 0

        rows = db.execute(
            select(User, Subscription, Package)
            .join(Subscription, Subscription.id == User.current_subscription_id)
            .join(Package, Package.id == Subscription.package_id)
            .where(
                User.deleted_at.is_(None),
                User.subscription_status.in_([
                    SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE, SubscriptionStatus.GRACE
                ]),
                Subscription.frozen_since.is_(None),  # BR-304 — đang đóng băng thì không nhắc
            )
        ).all()

        for user, sub, package in rows:
            remaining = days_between(utcnow(), sub.expires_at)
            if remaining is None or remaining not in milestones:
                continue

            code, channels = milestones[remaining]
            # BR-813 — reference_id gắn với subscription nên job chạy lại không gửi trùng.
            created = notification_service.enqueue(
                db, user=user, code=code, channels=channels,
                reference_id=f"sub:{sub.id}",
                context={
                    "full_name": user.full_name,
                    "package_name": package.name,
                    "expires_at": sub.expires_at.strftime("%d/%m/%Y"),
                    "days_left": remaining,
                    "renew_url": f"{settings.frontend_base_url}/pricing",
                },
            )
            sent += len(created)

        # Chuỗi onboarding 7 ngày dùng thử (mục 10.2).
        trial_codes = {5: NotificationCode.TRIAL_D5, 6: NotificationCode.TRIAL_D6,
                       7: NotificationCode.TRIAL_D7}
        trial_rows = db.execute(
            select(User, Subscription)
            .join(Subscription, Subscription.id == User.current_subscription_id)
            .where(
                User.deleted_at.is_(None),
                User.subscription_status == SubscriptionStatus.TRIAL,
            )
        ).all()
        for user, sub in trial_rows:
            elapsed = days_between(sub.starts_at, utcnow())
            if elapsed in trial_codes:
                created = notification_service.enqueue(
                    db, user=user, code=trial_codes[elapsed],
                    channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
                    reference_id=f"trial:{sub.id}",
                    context={
                        "full_name": user.full_name,
                        "days_left": settings.trial_days - elapsed,
                        "pricing_url": f"{settings.frontend_base_url}/pricing",
                    },
                )
                sent += len(created)

        _finish_job(db, job, SyncJobStatus.SUCCESS, {"queued": sent})


# ======================================================================
# notify_warning — 09:00 hằng ngày (BR-302)
# ======================================================================
def job_notify_warning(run_date: date | None = None, triggered_by: str = "scheduler",
                       force: bool = False) -> None:
    """Nhắc KH đang WARNING + đẩy danh sách cho môi giới."""
    run_date = run_date or local_today()
    with session_scope() as db:
        job = _start_job(db, SyncJobType.NOTIFY_WARNING, run_date, triggered_by)
        sent = 0

        users = db.scalars(
            select(User).where(
                User.deleted_at.is_(None),
                User.compliance_status == ComplianceStatus.WARNING,
                User.warning_until.is_not(None),
            )
        ).all()

        for user in users:
            remaining = days_between(utcnow(), user.warning_until)
            if remaining not in (3, 1):
                continue
            code = (
                NotificationCode.COMPLIANCE_WARNING_D3 if remaining == 3
                else NotificationCode.COMPLIANCE_WARNING_D1
            )
            created = notification_service.enqueue(
                db, user=user, code=code,
                channels=[NotificationChannel.SMS, NotificationChannel.IN_APP],
                reference_id=f"warn:{user.warning_until:%Y%m%d}",
                context={
                    "full_name": user.full_name,
                    "days_left": remaining,
                    "broker_name": user.broker_name or "",
                    "broker_phone": user.broker_phone or "",
                },
            )
            sent += len(created)

        # BR-302 — đẩy danh sách WARNING cho đội môi giới xử lý.
        if users:
            lines = [
                f"- {u.customer_code or u.id} | {u.full_name} | {u.phone or ''} | "
                f"còn {days_between(utcnow(), u.warning_until)} ngày | "
                f"NAV {u.latest_nav:,.0f}đ" if u.latest_nav else
                f"- {u.customer_code or u.id} | {u.full_name} | {u.phone or ''}"
                for u in users[:100]
            ]
            notification_service.notify_admins(
                f"Danh sách {len(users)} khách hàng đang cảnh báo (WARNING)",
                "Đội môi giới cần liên hệ trước khi tài khoản bị tạm dừng:\n" + "\n".join(lines),
            )

        _finish_job(db, job, SyncJobStatus.SUCCESS, {"warning_users": len(users), "queued": sent})


# ======================================================================
# close_signals — 16:00 ngày giao dịch
# ======================================================================
def job_close_signals(run_date: date | None = None, triggered_by: str = "scheduler",
                      force: bool = False) -> None:
    """Chốt kết quả tín hiệu theo dữ liệu giá.

    Chưa đấu nối nhà cung cấp dữ liệu giá (Phần 12 — quyết định cần chốt trước).
    Job hiện chỉ chốt các tín hiệu đã có `exit_price` do analyst nhập tay, và
    đánh dấu EXPIRE cho tín hiệu mở quá lâu. Khi có `MarketDataProvider` (BR-830),
    bổ sung bước lấy OHLCV và so với SL/TP tại đây.
    """
    run_date = run_date or local_today()
    with session_scope() as db:
        job = _start_job(db, SyncJobType.CLOSE_SIGNALS, run_date, triggered_by)

        if not force and not nav_sync_service.is_trading_day(db, run_date):
            _finish_job(db, job, SyncJobStatus.SKIPPED, None, "Không phải ngày giao dịch")
            return

        expired = 0
        # Tín hiệu mở quá 180 ngày coi như hết hiệu lực.
        cutoff = utcnow() - timedelta(days=180)
        stale = db.scalars(
            select(Signal).where(Signal.result == SignalResult.OPEN, Signal.entry_time < cutoff)
        ).all()
        for signal in stale:
            signal.result = SignalResult.BE
            signal.exit_reason = SignalExitReason.EXPIRE
            signal.exit_time = utcnow()
            expired += 1

        strategy_ids = {s.strategy_id for s in stale}
        for strategy_id in strategy_ids:
            from app.services import signal_service

            signal_service.refresh_stats_cache(db, strategy_id)

        _finish_job(
            db, job, SyncJobStatus.SUCCESS,
            {
                "expired": expired,
                "note": "Chưa đấu nối nguồn dữ liệu giá — xem BR-830, Phần 12",
            },
        )


# ======================================================================
# cleanup — 02:00 hằng ngày
# ======================================================================
def job_cleanup(run_date: date | None = None, triggered_by: str = "scheduler",
                force: bool = False) -> None:
    """Xoá OTP hết hạn, session hết hạn, tài khoản chưa verify quá 7 ngày (BR-101)."""
    run_date = run_date or local_today()
    now = utcnow()
    with session_scope() as db:
        job = _start_job(db, SyncJobType.CLEANUP, run_date, triggered_by)

        otps = db.query(PasswordReset).filter(PasswordReset.expires_at < now).delete()
        verifications = db.query(EmailVerification).filter(
            EmailVerification.expires_at < now - timedelta(days=30)
        ).delete()
        sessions = db.query(UserSession).filter(UserSession.expires_at < now).delete()

        # BR-101 — quá 7 ngày chưa xác thực: xoá mềm, giải phóng email.
        cutoff = now - timedelta(days=settings.unverified_purge_days)
        stale_users = db.scalars(
            select(User).where(
                User.email_verified_at.is_(None),
                User.created_at < cutoff,
                User.deleted_at.is_(None),
            )
        ).all()
        for user in stale_users:
            # Ẩn danh hoá để giải phóng unique index mà vẫn giữ bản ghi cho đối soát.
            user.deleted_at = now
            user.email = f"deleted_{user.id}@removed.local"
            user.phone = None

        # Bộ đếm Telegram cũ.
        from app.models.telegram import TelegramDailyCounter

        counters = db.query(TelegramDailyCounter).filter(
            TelegramDailyCounter.send_date < run_date - timedelta(days=60)
        ).delete()

        _finish_job(
            db, job, SyncJobStatus.SUCCESS,
            {
                "otps_deleted": otps,
                "verifications_deleted": verifications,
                "sessions_deleted": sessions,
                "unverified_purged": len(stale_users),
                "telegram_counters_deleted": counters,
            },
        )


# ======================================================================
# notification_worker — chạy mỗi phút (BR-812)
# ======================================================================
def job_process_notifications(batch_size: int = 100) -> None:
    """Worker gửi thông báo. Tách khỏi request để job nhắc 5.000 email không treo server."""
    now = utcnow()
    with session_scope() as db:
        pending = db.scalars(
            select(Notification)
            .where(
                Notification.status == NotificationStatus.QUEUED,
                Notification.retry_count < 3,
                (Notification.scheduled_at.is_(None)) | (Notification.scheduled_at <= now),
            )
            .order_by(Notification.id)
            .limit(batch_size)
        ).all()

        if not pending:
            return

        # Nạp người nhận một lượt thay vì một truy vấn cho mỗi thông báo.
        users = {
            u.id: u
            for u in db.scalars(
                select(User).where(User.id.in_({n.user_id for n in pending}))
            ).all()
        }

        # Một kết nối SMTP cho cả lô — xem `notification_service.smtp_session`.
        with notification_service.smtp_session() as send_email:
            _deliver_batch(db, pending, users, send_email)


def _deliver_batch(db, pending, users, send_email) -> None:
    """Gửi một lô thông báo đã nạp sẵn người nhận và kết nối SMTP."""
    for notif in pending:
        user = users.get(notif.user_id)
        if not user or user.deleted_at:
            notif.status = NotificationStatus.SKIPPED
            notif.error = "Tài khoản không tồn tại hoặc đã xoá"
            continue

        try:
            if notif.channel == NotificationChannel.IN_APP:
                pass  # in-app chỉ cần tồn tại bản ghi
            elif notif.channel == NotificationChannel.EMAIL:
                send_email(
                    user.email, notif.subject or settings.app_name, notif.body or ""
                )
            elif notif.channel == NotificationChannel.SMS:
                if not user.phone:
                    notif.status = NotificationStatus.SKIPPED
                    notif.error = "Khách hàng chưa có số điện thoại"
                    continue
                notification_service.send_sms(user.phone, notif.body or "")
            else:
                notif.status = NotificationStatus.SKIPPED
                notif.error = f"Kênh {notif.channel} chưa được cài đặt"
                continue

            notif.status = NotificationStatus.SENT
            notif.sent_at = utcnow()
        except Exception as exc:
            notif.retry_count += 1
            notif.error = str(exc)[:500]
            if notif.retry_count >= 3:
                notif.status = NotificationStatus.FAILED
                log.error("Gửi thông báo #%s thất bại vĩnh viễn: %s", notif.id, exc)


# ======================================================================
# telegram_worker — chạy mỗi 10 giây (BR-873, BR-875, BR-876)
# ======================================================================
def job_process_telegram_queue(batch_size: int | None = None) -> None:
    """Worker gửi Telegram với bộ điều tiết tốc độ.

    BR-873 — bot bị giới hạn ~30 tin/giây. Với 5.000 KH cùng đăng ký một chiến lược,
    một tín hiệu tạo 5.000 tin nhắn — bắt buộc gửi rải đều, không bắn đồng loạt.
    BR-875 — mục tiêu: tin cuối cùng tới KH dưới 60 giây kể từ khi ghi nhận tín hiệu.
    """
    import time

    now = utcnow()
    # Mỗi vòng gửi tối đa số tin bằng đúng hạn mức 1 giây × 10 giây giữa hai lần chạy.
    limit = batch_size or settings.telegram_send_rate_per_second * 10
    interval = 1.0 / max(settings.telegram_send_rate_per_second, 1)

    with session_scope() as db:
        pending = db.scalars(
            select(AlertDelivery)
            .where(
                AlertDelivery.status == DeliveryStatus.QUEUED,
                (AlertDelivery.next_retry_at.is_(None)) | (AlertDelivery.next_retry_at <= now),
            )
            # Giữ đúng thứ tự tin nhắn tới cùng một KH (BR-873).
            .order_by(AlertDelivery.user_id, AlertDelivery.id)
            .limit(limit)
        ).all()

        if not pending:
            return

        # Nạp sẵn mọi thứ vòng lặp cần, gộp theo lô.
        #
        # Bản cũ hỏi CSDL bốn lần cho **mỗi** tin nhắn (kết nối, tín hiệu, chiến lược, khách hàng)
        # cộng thêm phần bên trong `check_can_deliver`. Một lô 250 tin thành hơn một nghìn lượt
        # round-trip, xen kẽ với `sleep` — chúng chạy đúng vào lúc kết nối CSDL đang bị giữ và
        # transaction đang mở suốt mười giây. Nạp trước biến vòng lặp thành thuần tính toán.
        user_ids = {d.user_id for d in pending}
        signal_ids = {d.signal_id for d in pending}

        connections = telegram_service.connections_by_user(db, list(user_ids))
        users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids))).all()}
        signals = {s.id: s for s in db.scalars(select(Signal).where(Signal.id.in_(signal_ids))).all()}
        strategy_ids = {s.strategy_id for s in signals.values()}
        strategies = {
            s.id: s
            for s in db.scalars(select(Strategy).where(Strategy.id.in_(strategy_ids))).all()
        }

        # Dựng sẵn toàn bộ nội dung tin nhắn **trước khi** chạm mạng, rồi ghi nhận quyết định
        # bỏ qua ngay trong transaction này.
        # Giữ giá trị thuần (id, chat_id, nội dung) chứ không giữ đối tượng ORM: sau khi phiên
        # đóng, mọi truy cập thuộc tính của ORM là một quả mìn `DetachedInstanceError`.
        outbox: list[tuple[int, int, str]] = []
        for delivery in pending:
            conn = connections.get(delivery.user_id)
            if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id:
                delivery.status = DeliveryStatus.SKIPPED
                delivery.skip_reason = "TELEGRAM_NOT_VERIFIED"
                continue

            signal = signals.get(delivery.signal_id)
            strategy = strategies.get(signal.strategy_id) if signal else None
            user = users.get(delivery.user_id)
            if not (signal and strategy and user):
                delivery.status = DeliveryStatus.FAILED
                delivery.error_message = "Thiếu dữ liệu tín hiệu/chiến lược/khách hàng"
                continue

            # BR-866 — kiểm tra lại tại đúng thời điểm gửi, không tin vào lúc xếp hàng.
            skip = telegram_service.check_can_deliver(db, user, strategy, conn)
            if skip:
                delivery.status = DeliveryStatus.SKIPPED
                delivery.skip_reason = skip
                continue

            outbox.append(
                (delivery.id, conn.chat_id,
                 telegram_service.build_signal_message(signal, strategy, user, delivery.alert_type))
            )

        delivery_ids = [delivery_id for delivery_id, _, _ in outbox]

    # Ra khỏi transaction trước khi gọi mạng: phần gửi kéo dài `len(outbox) / rate` giây, và
    # worker này chạy mỗi 10 giây. Giữ kết nối CSDL suốt quãng đó nghĩa là chiếm một slot trong
    # pool gần như toàn thời gian, để rồi tranh chấp với chính request của người dùng.
    results: list[dict] = []
    for delivery_id, chat_id, text in outbox:
        try:
            message_id = telegram_service.send_raw_message(chat_id, text)
            results.append({"id": delivery_id, "message_id": message_id or None})
        except telegram_service.TelegramApiError as exc:
            results.append({"id": delivery_id, "error": exc})
        time.sleep(interval)

    if not results:
        return

    # Phiên thứ hai, ngắn: ghi lại kết quả gửi.
    with session_scope() as db:
        rows = {
            d.id: d
            for d in db.scalars(
                select(AlertDelivery).where(AlertDelivery.id.in_(delivery_ids))
            ).all()
        }
        for result in results:
            delivery = rows.get(result["id"])
            if not delivery:
                continue
            exc = result.get("error")
            if exc is None:
                delivery.status = DeliveryStatus.SENT
                delivery.sent_at = utcnow()
                delivery.telegram_message_id = result["message_id"]
                conn = db.scalar(
                    select(TelegramConnection).where(
                        TelegramConnection.user_id == delivery.user_id
                    )
                )
                if conn:
                    conn.last_success_at = utcnow()
                    conn.error_count = 0
                continue

            delivery.error_code = exc.code
            delivery.error_message = exc.message[:255]
            if exc.is_permanent:
                # BR-876 — 403/400 thì KHÔNG thử lại; xử lý theo BR-865.
                delivery.status = DeliveryStatus.FAILED
                conn = db.scalar(
                    select(TelegramConnection).where(
                        TelegramConnection.user_id == delivery.user_id
                    )
                )
                if conn:
                    telegram_service.mark_blocked(db, conn, exc.code, exc.message)
            else:
                delivery.retry_count += 1
                backoff = [5, 30, 120][min(delivery.retry_count - 1, 2)]
                delivery.next_retry_at = utcnow() + timedelta(seconds=backoff)
                if delivery.retry_count >= 3:
                    delivery.status = DeliveryStatus.FAILED


# ======================================================================
# telegram_digest — 16:00 (BR-872)
# ======================================================================
def job_telegram_digest(run_date: date | None = None, triggered_by: str = "scheduler",
                        force: bool = False) -> None:
    """Gom các tín hiệu vượt hạn mức trong ngày thành một tin tổng hợp cuối phiên."""
    from app.models.telegram import TelegramDailyCounter

    run_date = run_date or local_today()
    with session_scope() as db:
        counters = db.scalars(
            select(TelegramDailyCounter).where(TelegramDailyCounter.send_date == run_date)
        ).all()

        for counter in counters:
            payload = counter.deferred or {}
            signal_ids = payload.get("signal_ids") or []
            if not signal_ids:
                continue

            conn = db.scalar(
                select(TelegramConnection).where(TelegramConnection.user_id == counter.user_id)
            )
            user = db.get(User, counter.user_id)
            if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id or not user:
                continue

            signals = db.scalars(select(Signal).where(Signal.id.in_(signal_ids))).all()
            lines = [f"📋 TỔNG HỢP CUỐI PHIÊN — {run_date:%d/%m/%Y}", ""]
            for s in signals:
                strategy = db.get(Strategy, s.strategy_id)
                lines.append(
                    f"• {s.symbol} {'MUA' if s.direction == 'BUY' else 'BÁN'} @ "
                    f"{s.entry_price:,.0f} — {strategy.name if strategy else ''}"
                )
            lines += [
                "",
                f"Bạn có {len(signals)} tín hiệu vượt hạn mức {settings.telegram_max_msg_per_day} "
                "tin/ngày. Xem đầy đủ trên website:",
                f"{settings.frontend_base_url}/strategies",
                "",
                f"⚠️ Thông tin tham khảo, không phải khuyến nghị mua bán.",
                f"   Mã KH: {user.customer_code or f'KH-{user.id:05d}'}",
            ]

            try:
                telegram_service.send_raw_message(conn.chat_id, "\n".join(lines))
                counter.deferred = {"signal_ids": [], "digest_sent_at": utcnow().isoformat()}
            except Exception as exc:
                log.warning("Gửi digest thất bại user_id=%s: %s", counter.user_id, exc)


# ======================================================================
# sync_market — 16:00 thứ 2–6 (Phần 12)
# ======================================================================
def job_sync_market(run_date: date | None = None, triggered_by: str = "scheduler",
                    force: bool = False) -> None:
    """Cập nhật danh mục mã và giá cuối ngày cho toàn bộ mã trong danh mục theo dõi.

    Chạy 16:00 — sau giờ đóng cửa 15:00, đủ để sở công bố giá cuối phiên — và sau `sync_nav`
    (15:15) để không tranh băng thông với việc đọc Google Sheet: dữ liệu NAV quan trọng hơn vì
    nó quyết định trạng thái tài khoản khách hàng.

    Chỉ lấy 30 phiên gần nhất chứ không phải toàn bộ lịch sử: `sync_ohlcv_batch` đồng bộ tăng
    dần từ `last_ohlcv_date`, khoảng đệm 30 ngày là để bù những ngày máy chủ không chạy.
    Nạp lịch sử lần đầu là việc của `python -m app.scripts.backfill_ohlcv`.
    """
    from app.models.market import Symbol
    from app.services import market_data

    run_date = run_date or local_today()
    with session_scope() as db:
        job = _start_job(db, "sync_market", run_date, triggered_by)

        if not force and not nav_sync_service.is_trading_day(db, run_date):
            _finish_job(db, job, SyncJobStatus.SKIPPED, None, "Không phải ngày giao dịch")
            return

        try:
            symbol_result = market_data.sync_symbols(db)
        except Exception as exc:
            log.exception("sync_market: không cập nhật được danh mục mã")
            _finish_job(db, job, SyncJobStatus.FAILED, None, f"Danh mục mã: {exc}")
            notification_service.notify_admins(
                "Job sync_market thất bại", f"Không lấy được danh sách mã: {exc}"
            )
            return

        symbols = [
            s.symbol
            for s in db.scalars(select(Symbol).where(Symbol.is_active.is_(True))).all()
        ]

    # Tách phiên khác cho phần tải giá — vòng lặp dài, không nên giữ một transaction xuyên suốt.
    with session_scope() as db:
        price_result = market_data.sync_ohlcv_batch(
            db, symbols, days=30, delay_seconds=settings.market_sync_delay_seconds
        )

    with session_scope() as db:
        job = db.scalar(
            select(SyncJob).where(SyncJob.job_type == "sync_market", SyncJob.run_date == run_date)
            .order_by(SyncJob.id.desc())
        )
        if job:
            job.rows_read = price_result["total"]
            job.rows_written = price_result["rows_written"]
            job.summary = {"symbols": symbol_result, "prices": price_result}
            # Một vài mã lỗi là bình thường (mã mới, mã tạm ngừng) — chỉ cảnh báo khi lỗi diện rộng.
            failed_ratio = price_result["failed"] / max(price_result["total"], 1)
            job.status = SyncJobStatus.SUCCESS if failed_ratio < 0.1 else SyncJobStatus.PARTIAL
            job.finished_at = utcnow()

        if price_result["failed"] > price_result["total"] * 0.1:
            notification_service.notify_admins(
                "Đồng bộ giá có nhiều mã lỗi",
                f"{price_result['failed']}/{price_result['total']} mã không lấy được giá. "
                "Kiểm tra nhà cung cấp dữ liệu có đổi endpoint không.",
            )


# ======================================================================
# sync_news — giờ đặt ở cấu hình `news_sync_time` (mặc định 04:10)
# ======================================================================
def job_sync_news(run_date: date | None = None, triggered_by: str = "scheduler",
                  force: bool = False) -> None:
    """Kéo tin mới từ các trang nguồn đang bật.

    Chạy cả cuối tuần và ngày lễ, khác với `sync_market`: báo vẫn đăng bài những ngày đó, và job
    này không đọc dữ liệu thị trường nên không có khái niệm "ngày giao dịch" để bỏ qua.

    Một nguồn hỏng không làm hỏng lượt chạy — `news_sync_service.sync_all` bắt lỗi theo từng
    nguồn. Nhưng job **có** báo cho quản trị khi có nguồn hỏng: kiểu hỏng của bộ dò link là im
    lặng ngừng ra tin, nếu không ai báo thì vài tháng sau mới có người nhận ra.
    """
    from app.services import news_sync_service

    run_date = run_date or local_today()
    with session_scope() as db:
        job = _start_job(db, SyncJobType.SYNC_NEWS, run_date, triggered_by)

        try:
            totals = news_sync_service.sync_all(db)
        except Exception as exc:
            log.exception("sync_news lỗi ngoài dự kiến")
            _finish_job(db, job, SyncJobStatus.FAILED, None, f"{type(exc).__name__}: {exc}"[:500])
            notification_service.notify_admins(
                "Job sync_news thất bại", f"Không kéo được tin: {exc}"
            )
            return

        if not totals["sources"]:
            _finish_job(db, job, SyncJobStatus.SKIPPED, totals,
                        "Chưa khai báo nguồn tin nào ở màn Nguồn tin")
            return

        failed = totals["failed_sources"]
        if failed == 0:
            status = SyncJobStatus.SUCCESS
        elif failed == totals["sources"]:
            status = SyncJobStatus.FAILED
        else:
            status = SyncJobStatus.PARTIAL

        job.rows_read = sum(d["discovered"] for d in totals["details"])
        job.rows_written = totals["added"]
        _finish_job(db, job, status, totals)

        if failed:
            broken = "\n".join(
                f"- {d['source']}: {d['error']}"
                for d in totals["details"] if d["status"] == "FAILED"
            )
            notification_service.notify_admins(
                f"{failed} nguồn tin không kéo được bài",
                f"Đã thêm {totals['added']} tin mới. Các nguồn sau đang hỏng:\n\n{broken}\n\n"
                "Thường là trang nguồn đổi giao diện. Mở màn Nguồn tin để kiểm tra lại đường dẫn.",
            )
