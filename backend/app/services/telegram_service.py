"""Telegram — Phần 15.

Nguyên tắc bất di bất dịch:
  * BR-859 — mỗi tin nhắn gửi tới **đúng một `chat_id`** của đúng một KH. Không dùng channel chung.
  * BR-866 — kiểm tra trạng thái tài khoản **tại thời điểm gửi**, không phải lúc đăng ký.
  * BR-874 — idempotency: mỗi bộ (signal_id, user_id, alert_type) chỉ gửi một lần.
  * BR-881 — bot token chỉ nằm trong biến môi trường.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from decimal import Decimal

import httpx
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import http
from app.core.config import settings
from app.core.constants import (
    COMPLIANCE_BLOCKING,
    SUBSCRIPTION_ALLOWED,
    DEFAULT_ALERT_TYPES,
    AlertInactiveReason,
    AlertType,
    DeliverySkipReason,
    DeliveryStatus,
    DISCLAIMER_TEXT,
    TelegramStatus,
)
from app.core.datetime_utils import ensure_aware, local_now, local_today, parse_hhmm, to_local, utcnow
from app.core.exceptions import Conflict, Forbidden, NotFound, ValidationError
from app.core.security import generate_numeric_otp, generate_url_token, sha256_hash
from app.models.strategy import Signal, Strategy
from app.models.telegram import (
    AlertDelivery,
    StrategyAlert,
    TelegramConnection,
    TelegramDailyCounter,
)
from app.models.user import Package, Subscription, User
from app.services import subscription_service

log = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org/bot"


class TelegramApiError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message

    @property
    def is_permanent(self) -> bool:
        """BR-876 — 403 (bị chặn) và 400 (chat không tồn tại) thì KHÔNG thử lại."""
        return self.code in (400, 403)


# ======================================================================
# Gọi API
# ======================================================================
def send_raw_message(chat_id: int, text: str, *, protect_content: bool = True,
                     parse_mode: str | None = None) -> int:
    """Gửi tới đúng một chat_id (BR-859). Trả về message_id.

    `protect_content` (BR-869) chặn chuyển tiếp và lưu tin nhắn — không tuyệt đối
    (vẫn chụp màn hình được) nhưng loại bỏ kiểu rò rỉ dễ nhất.
    """
    if not settings.telegram_bot_token:
        log.info("[TELEGRAM-DEV] chat_id=%s\n%s", chat_id, text)
        return 0

    payload: dict = {"chat_id": chat_id, "text": text, "protect_content": protect_content}
    if parse_mode:
        payload["parse_mode"] = parse_mode

    try:
        response = http.client().post(
            f"{API_BASE}{settings.telegram_bot_token}/sendMessage", json=payload
        )
    except httpx.HTTPError as exc:
        raise TelegramApiError(0, f"Lỗi mạng: {exc}") from exc

    data = response.json()
    if not data.get("ok"):
        raise TelegramApiError(
            data.get("error_code", response.status_code), data.get("description", "unknown")
        )
    return data["result"]["message_id"]


# ======================================================================
# Kết nối — BR-861 deep-link
# ======================================================================
def start_connect(db: Session, user: User) -> dict:
    """Bước 1–3 của luồng deep-link: sinh token dùng một lần, trả về link + dữ liệu QR."""
    if not settings.telegram_bot_username:
        raise Conflict(
            "Hệ thống chưa cấu hình bot Telegram. Vui lòng liên hệ quản trị viên.",
            "TELEGRAM_NOT_CONFIGURED",
        )

    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    if not conn:
        conn = TelegramConnection(user_id=user.id)
        db.add(conn)

    token = generate_url_token()[:40]
    conn.connect_token = token
    conn.token_expires_at = utcnow() + timedelta(minutes=settings.telegram_connect_token_ttl_minutes)
    conn.status = TelegramStatus.PENDING
    db.flush()

    return {
        "deep_link": f"https://t.me/{settings.telegram_bot_username}?start={token}",
        "bot_username": settings.telegram_bot_username,
        "expires_at": conn.token_expires_at,
        "ttl_minutes": settings.telegram_connect_token_ttl_minutes,
    }


def complete_connect(db: Session, token: str, chat_id: int, username: str | None,
                     first_name: str | None) -> TelegramConnection:
    """Bước 5–7: webhook nhận `/start <token>` kèm chat_id thật."""
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.connect_token == token))
    if not conn:
        raise NotFound("Mã kết nối không hợp lệ", "CONNECT_TOKEN_INVALID")

    now = utcnow()
    if not conn.token_expires_at or ensure_aware(conn.token_expires_at, now) < now:
        raise Conflict("Mã kết nối đã hết hạn. Vui lòng bấm Kết nối lại.", "CONNECT_TOKEN_EXPIRED")

    # BR-863 — chat_id âm là nhóm/kênh; đẩy tín hiệu trả phí vào nhóm chính là chia sẻ tài khoản.
    if chat_id < 0 and not settings.telegram_allow_group_chat:
        raise Forbidden(
            "Hệ thống chỉ hỗ trợ kết nối với tài khoản Telegram cá nhân, không hỗ trợ nhóm/kênh.",
            "GROUP_CHAT_NOT_ALLOWED",
        )

    # Một chat_id chỉ gắn với một tài khoản.
    existing = db.scalar(
        select(TelegramConnection).where(
            TelegramConnection.chat_id == chat_id, TelegramConnection.user_id != conn.user_id
        )
    )
    if existing:
        raise Conflict(
            "Tài khoản Telegram này đã được kết nối với một tài khoản khác.",
            "CHAT_ID_ALREADY_LINKED",
        )

    conn.chat_id = chat_id
    conn.telegram_username = username
    conn.telegram_first_name = first_name
    conn.status = TelegramStatus.VERIFIED
    conn.verified_at = now
    conn.connect_token = None
    conn.token_expires_at = None
    conn.error_count = 0
    conn.last_error = None
    db.flush()
    return conn


def start_manual_verify(db: Session, user: User, chat_id: int) -> None:
    """BR-862 — phương án dự phòng: gửi mã 6 số tới chat_id để xác thực quyền sở hữu.

    Không có bước này, tính năng trở thành công cụ spam người khác qua bot của bạn.
    """
    if chat_id < 0 and not settings.telegram_allow_group_chat:
        raise Forbidden("Không hỗ trợ kết nối nhóm/kênh Telegram.", "GROUP_CHAT_NOT_ALLOWED")

    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    if not conn:
        conn = TelegramConnection(user_id=user.id)
        db.add(conn)

    code = generate_numeric_otp(6)
    conn.chat_id = chat_id
    conn.status = TelegramStatus.PENDING
    conn.verify_code_hash = sha256_hash(code)
    conn.verify_code_expires_at = utcnow() + timedelta(minutes=10)
    conn.verify_attempts = 0
    db.flush()

    send_raw_message(
        chat_id,
        f"Mã xác thực kết nối {settings.app_name}: {code}\n"
        f"Mã có hiệu lực trong 10 phút. Nếu bạn không yêu cầu, hãy bỏ qua tin nhắn này.",
    )


def confirm_manual_verify(db: Session, user: User, code: str) -> TelegramConnection:
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    now = utcnow()
    if not conn or not conn.verify_code_hash:
        raise ValidationError("Chưa có yêu cầu xác thực nào", {"field": "code"})
    if conn.verify_code_expires_at and ensure_aware(conn.verify_code_expires_at, now) < now:
        raise ValidationError("Mã xác thực đã hết hạn", {"field": "code"})
    if conn.verify_attempts >= 5:
        raise ValidationError("Nhập sai quá số lần cho phép. Vui lòng yêu cầu mã mới.",
                              {"field": "code"})
    if conn.verify_code_hash != sha256_hash(code.strip()):
        conn.verify_attempts += 1
        db.flush()
        raise ValidationError("Mã xác thực không đúng", {"field": "code"})

    conn.status = TelegramStatus.VERIFIED
    conn.verified_at = now
    conn.verify_code_hash = None
    conn.verify_code_expires_at = None
    db.flush()
    return conn


def disconnect(db: Session, user_id: int, reason: str = "USER") -> None:
    """BR-864 — nút Ngắt kết nối trên web và lệnh /stop trong Telegram, cả hai dừng gửi ngay."""
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user_id))
    if conn:
        conn.status = TelegramStatus.DISCONNECTED
        conn.connect_token = None
        db.flush()


def mark_blocked(db: Session, conn: TelegramConnection, error_code: int, message: str) -> None:
    """BR-865 — KH chặn bot: đánh dấu INACTIVE, ngừng gửi, báo KH qua email/in-app.

    Không xử lý thì hệ thống sẽ gọi API lỗi hàng nghìn lần mỗi ngày và bị Telegram hạn chế bot.
    """
    from app.core.constants import NotificationChannel, NotificationCode

    from app.services import notification_service

    conn.status = TelegramStatus.BLOCKED
    conn.error_code = error_code
    conn.last_error = message[:255]
    conn.error_count = (conn.error_count or 0) + 1
    db.flush()

    user = db.get(User, conn.user_id)
    if user:
        notification_service.enqueue(
            db,
            user=user,
            code=NotificationCode.ADMIN_BROADCAST,
            channels=[NotificationChannel.EMAIL, NotificationChannel.IN_APP],
            reference_id=f"tg_blocked:{utcnow():%Y%m%d}",
            context={
                "full_name": user.full_name,
                "message": "Kết nối Telegram của bạn đã ngừng hoạt động do bot bị chặn. "
                           "Vui lòng bỏ chặn bot và kết nối lại trong phần Cài đặt thông báo.",
            },
        )


# ======================================================================
# Đăng ký cặp (chiến lược × mã) — mục 15.1
# ======================================================================
def _alert_quota(db: Session, user: User) -> int:
    """BR-860 — hạn mức số cặp theo gói. -1 = không giới hạn."""
    sub = subscription_service.get_current_subscription(db, user)
    if not sub:
        return 0
    pkg = db.get(Package, sub.package_id)
    return pkg.max_telegram_alerts if pkg else 0


def alert_usage(db: Session, user: User) -> dict:
    """Bộ đếm "Đã dùng 16/20 lượt đăng ký" trên màn Cài đặt thông báo (BR-860)."""
    used = db.scalar(
        select(func.count())
        .select_from(StrategyAlert)
        .where(StrategyAlert.user_id == user.id, StrategyAlert.is_active.is_(True))
    ) or 0
    quota = _alert_quota(db, user)
    return {"used": int(used), "quota": quota, "unlimited": quota < 0}


def subscribe_pair(db: Session, user: User, strategy_id: int, symbol: str,
                   alert_types: list[str] | None = None) -> StrategyAlert:
    """Tạo một cặp đăng ký. Áp BR-860, BR-860b, BR-860c."""
    symbol = symbol.strip().upper()
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")

    # BR-860b — chỉ đăng ký được chiến lược mà gói hiện tại cho phép xem.
    if not subscription_service.can_access_min_package(db, user, strategy.min_package_id):
        raise Forbidden(
            "Gói dịch vụ hiện tại của bạn chưa bao gồm chiến lược này. Nâng cấp gói để đăng ký nhận tín hiệu.",
            "PACKAGE_TOO_LOW",
        )

    # BR-860c — mã phải nằm trong phạm vi chiến lược.
    in_scope = any(s.symbol.upper() == symbol for s in strategy.symbols)
    if not in_scope:
        raise ValidationError(
            f"Mã {symbol} không nằm trong phạm vi áp dụng của chiến lược này",
            {"field": "symbol"},
        )

    existing = db.scalar(
        select(StrategyAlert).where(
            StrategyAlert.user_id == user.id,
            StrategyAlert.strategy_id == strategy_id,
            StrategyAlert.symbol == symbol,
        )
    )
    if existing:
        existing.is_active = True
        existing.inactive_reason = None
        existing.inactive_at = None
        if alert_types:
            existing.alert_types = {"types": alert_types}
        db.flush()
        return existing

    # BR-860 — hạn mức theo gói.
    usage = alert_usage(db, user)
    if not usage["unlimited"] and usage["used"] >= usage["quota"]:
        raise Forbidden(
            f"Bạn đã dùng hết {usage['quota']} lượt đăng ký của gói hiện tại. "
            "Nâng cấp gói để đăng ký thêm.",
            "ALERT_QUOTA_EXCEEDED",
            {"used": usage["used"], "quota": usage["quota"]},
        )

    alert = StrategyAlert(
        user_id=user.id,
        strategy_id=strategy_id,
        symbol=symbol,
        alert_types={"types": alert_types or [str(t) for t in DEFAULT_ALERT_TYPES]},
        is_active=True,
    )
    db.add(alert)
    db.flush()
    return alert


def deactivate_alerts_for_symbol(db: Session, strategy_id: int, symbol: str) -> int:
    """BR-860c — admin gỡ mã khỏi phạm vi chiến lược: chuyển INACTIVE_BY_SYSTEM, **không xoá âm thầm**.

    KH nhận thông báo giải thích, nếu không họ sẽ tưởng hệ thống lỗi khi bỗng dưng
    không nhận được tín hiệu nữa.
    """
    from app.core.constants import NotificationChannel, NotificationCode

    from app.services import notification_service

    alerts = db.scalars(
        select(StrategyAlert).where(
            StrategyAlert.strategy_id == strategy_id,
            StrategyAlert.symbol == symbol.upper(),
            StrategyAlert.is_active.is_(True),
        )
    ).all()

    strategy = db.get(Strategy, strategy_id)
    for alert in alerts:
        alert.is_active = False
        alert.inactive_reason = AlertInactiveReason.SYSTEM_SCOPE_CHANGED
        alert.inactive_at = utcnow()
        user = db.get(User, alert.user_id)
        if user:
            notification_service.enqueue(
                db,
                user=user,
                code=NotificationCode.ADMIN_BROADCAST,
                channels=[NotificationChannel.IN_APP, NotificationChannel.EMAIL],
                reference_id=f"scope:{strategy_id}:{symbol}",
                context={
                    "full_name": user.full_name,
                    "message": (
                        f"Mã {symbol.upper()} đã được gỡ khỏi phạm vi áp dụng của chiến lược "
                        f"'{strategy.name if strategy else strategy_id}'. Đăng ký nhận tín hiệu "
                        "cho cặp này đã tạm dừng."
                    ),
                },
            )
    db.flush()
    return len(alerts)


# ======================================================================
# BR-866 — kiểm tra tại thời điểm gửi
# ======================================================================
def _prefetch_subscriptions(db: Session, users) -> None:
    """Nạp sẵn gói hiện tại của cả lô để phần kiểm tra bậc gói không phải đi tìm từng người.

    `can_access_min_package` tra gói bằng `Session.get()`, mà `get()` **có** tra identity map
    trước khi phát SQL. Nạp trước bằng một truy vấn `IN (...)` khiến mọi lượt tra sau đó thành
    tra bộ nhớ, giữ nguyên đường đi của logic nghiệp vụ.
    """
    sub_ids = {u.current_subscription_id for u in users if u.current_subscription_id}
    if not sub_ids:
        return
    subs = db.scalars(select(Subscription).where(Subscription.id.in_(sub_ids))).all()
    package_ids = {s.package_id for s in subs if s.package_id}
    if package_ids:
        db.scalars(select(Package).where(Package.id.in_(package_ids))).all()


def connections_by_user(db: Session, user_ids: list[int]) -> dict[int, TelegramConnection]:
    """Kết nối Telegram của nhiều khách hàng trong một truy vấn."""
    if not user_ids:
        return {}
    return {
        c.user_id: c
        for c in db.scalars(
            select(TelegramConnection).where(TelegramConnection.user_id.in_(set(user_ids)))
        ).all()
    }


#: Giá trị đánh dấu "chưa tra kết nối" — phân biệt với "đã tra và không có" (`None`).
_UNSET = object()


def check_can_deliver(
    db: Session, user: User, strategy: Strategy, conn: TelegramConnection | None = _UNSET
) -> str | None:
    """Trả về mã lý do SKIP, hoặc None nếu được gửi.

    Đây là chốt chặn quan trọng nhất của Phần 15: nếu chỉ kiểm tra lúc đăng ký, một KH
    hết hạn gói 8 tháng trước vẫn tiếp tục nhận tín hiệu trả phí mà không cần đăng nhập lại.

    Truyền sẵn `conn` khi đang duyệt một lô (xem `connections_by_user`) để hàm không tự đi tìm
    kết nối cho từng khách — `select()` luôn phát ra SQL, kể cả khi bản ghi đã nằm trong phiên.
    """
    if user.subscription_status not in SUBSCRIPTION_ALLOWED:
        return DeliverySkipReason.SUBSCRIPTION_INACTIVE
    if user.compliance_status in COMPLIANCE_BLOCKING:
        return DeliverySkipReason.COMPLIANCE_BLOCKED

    if conn is _UNSET:
        conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id:
        return DeliverySkipReason.TELEGRAM_NOT_VERIFIED

    if not subscription_service.can_access_min_package(db, user, strategy.min_package_id):
        return DeliverySkipReason.PACKAGE_TOO_LOW

    return None


def in_send_window(now=None) -> bool:
    """BR-877 — chỉ gửi tín hiệu trong khung 08:45–15:15 ngày giao dịch."""
    now = now or local_now()
    start = parse_hhmm(settings.telegram_send_window_start)
    end = parse_hhmm(settings.telegram_send_window_end)
    return start <= now.time() <= end


def bump_daily_counter(db: Session, user_id: int) -> tuple[bool, int]:
    """BR-872 — tối đa N tin/ngày/KH. Trả về (được_gửi, số_đã_gửi)."""
    today = local_today()
    counter = db.scalar(
        select(TelegramDailyCounter).where(
            TelegramDailyCounter.user_id == user_id, TelegramDailyCounter.send_date == today
        )
    )
    if not counter:
        counter = TelegramDailyCounter(user_id=user_id, send_date=today, sent_count=0)
        db.add(counter)
        db.flush()

    if counter.sent_count >= settings.telegram_max_msg_per_day:
        return False, counter.sent_count
    counter.sent_count += 1
    db.flush()
    return True, counter.sent_count


def defer_to_digest(db: Session, user_id: int, signal_id: int) -> None:
    """Tín hiệu vượt hạn mức được gom vào tin tổng hợp cuối phiên (BR-872)."""
    today = local_today()
    counter = db.scalar(
        select(TelegramDailyCounter).where(
            TelegramDailyCounter.user_id == user_id, TelegramDailyCounter.send_date == today
        )
    )
    if not counter:
        counter = TelegramDailyCounter(user_id=user_id, send_date=today, sent_count=0)
        db.add(counter)
        db.flush()
    payload = counter.deferred or {"signal_ids": []}
    ids = payload.get("signal_ids", [])
    if signal_id not in ids:
        ids.append(signal_id)
    counter.deferred = {"signal_ids": ids}
    db.flush()


# ======================================================================
# Nội dung tin nhắn — mục 15.4
# ======================================================================
def _pct(entry: Decimal, target: Decimal | None) -> str:
    if target is None or not entry:
        return ""
    change = (target - entry) / entry * 100
    return f"  ({change:+.1f}%)"


def build_signal_message(signal: Signal, strategy: Strategy, user: User,
                         alert_type: str = AlertType.ENTRY) -> str:
    """BR-868 — chỉ tóm tắt + link quay lại website, không gửi toàn bộ phân tích.

    BR-869 — mã KH ở chân tin để truy vết khi nội dung bị rò rỉ.
    BR-870 — disclaimer trong **mọi** tin nhắn, không phải chỉ tin đầu tiên.
    """
    headers = {
        AlertType.ENTRY: f"🔔 TÍN HIỆU {'MUA' if signal.direction == 'BUY' else 'BÁN'} — {signal.symbol}",
        AlertType.TP: f"✅ CHẠM CHỐT LỜI — {signal.symbol}",
        AlertType.SL: f"🛑 CHẠM CẮT LỖ — {signal.symbol}",
        AlertType.CANCELLED: f"⚪ TÍN HIỆU BỊ HUỶ — {signal.symbol}",
    }
    entry_local = to_local(signal.entry_time)
    base = settings.frontend_base_url

    lines = [
        headers.get(alert_type, f"🔔 {signal.symbol}"),
        f"Chiến lược: {strategy.name} ({signal.timeframe})",
        "",
        f"Giá vào:     {signal.entry_price:,.0f}",
    ]
    if signal.sl is not None:
        lines.append(f"Cắt lỗ:      {signal.sl:,.0f}{_pct(signal.entry_price, signal.sl)}")
    if signal.tp is not None:
        lines.append(f"Chốt lời:    {signal.tp:,.0f}{_pct(signal.entry_price, signal.tp)}")
    lines.append(f"Thời điểm:   {entry_local:%d/%m/%Y %H:%M}" if entry_local else "")

    if signal.reason_text:
        lines += ["", f"Lý do: {signal.reason_text}"]
    if alert_type == AlertType.CANCELLED and signal.cancel_reason:
        lines += ["", f"Lý do huỷ: {signal.cancel_reason}"]

    lines += [
        "",
        f"📊 Xem trên biểu đồ → {base}/strategies/{strategy.id}?symbol={signal.symbol}",
        f"❓ Hỏi về tín hiệu này → {base}/strategies/{strategy.id}/questions?signal={signal.id}",
        "",
        f"⚠️ {DISCLAIMER_TEXT}",
        f"   Mã KH: {user.customer_code or f'KH-{user.id:05d}'}",
    ]
    return "\n".join(line for line in lines if line is not None)


# ======================================================================
# Xếp hàng đợi khi có tín hiệu — mục 15.9
# ======================================================================
def enqueue_signal_alerts(db: Session, signal: Signal, alert_type: str = AlertType.ENTRY) -> dict:
    """Lấy danh sách KH đăng ký ĐÚNG CẶP (chiến lược, mã) rồi xếp vào hàng đợi.

    Đây là truy vấn nóng nhất của hệ thống — chạy mỗi lần có tín hiệu.
    Index tổ hợp `(strategy_id, symbol, is_active)` phục vụ đúng truy vấn này.
    """
    strategy = db.get(Strategy, signal.strategy_id)
    if not strategy:
        return {"queued": 0, "skipped": 0}

    alerts = db.scalars(
        select(StrategyAlert).where(
            StrategyAlert.strategy_id == signal.strategy_id,
            StrategyAlert.symbol == signal.symbol.upper(),
            StrategyAlert.is_active.is_(True),
        )
    ).all()

    # Nạp trước khách hàng và kết nối Telegram cho cả lô.
    #
    # Đây là truy vấn nóng nhất của hệ thống: một tín hiệu của chiến lược phổ biến chạm tới
    # hàng nghìn người đăng ký. Đọc từng người trong vòng lặp biến một lần phát tín hiệu thành
    # hàng chục nghìn round-trip tới CSDL, chạy ngay giữa giờ giao dịch.
    user_ids = [a.user_id for a in alerts]
    users_by_id = {
        u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids))).all()
    } if user_ids else {}
    conns_by_user = connections_by_user(db, user_ids)
    _prefetch_subscriptions(db, users_by_id.values())

    queued = skipped = 0
    now = utcnow()

    for alert in alerts:
        # BR-871 — KH tắt riêng từng loại thông báo.
        enabled_types = (alert.alert_types or {}).get("types") or [str(t) for t in DEFAULT_ALERT_TYPES]
        if alert_type not in enabled_types:
            _record_delivery(db, signal, alert.user_id, alert_type, DeliveryStatus.SKIPPED,
                             DeliverySkipReason.ALERT_TYPE_DISABLED)
            skipped += 1
            continue

        user = users_by_id.get(alert.user_id)
        if not user or user.deleted_at:
            continue

        skip_reason = check_can_deliver(db, user, strategy, conns_by_user.get(user.id))
        if skip_reason:
            _record_delivery(db, signal, user.id, alert_type, DeliveryStatus.SKIPPED, skip_reason)
            skipped += 1
            continue

        if not in_send_window():
            _record_delivery(db, signal, user.id, alert_type, DeliveryStatus.SKIPPED,
                             DeliverySkipReason.OUTSIDE_WINDOW)
            skipped += 1
            continue

        allowed, _ = bump_daily_counter(db, user.id)
        if not allowed:
            defer_to_digest(db, user.id, signal.id)
            _record_delivery(db, signal, user.id, alert_type, DeliveryStatus.SKIPPED,
                             DeliverySkipReason.DAILY_LIMIT)
            skipped += 1
            continue

        if _record_delivery(db, signal, user.id, alert_type, DeliveryStatus.QUEUED,
                            None, queued_at=now):
            queued += 1

    db.commit()
    return {"queued": queued, "skipped": skipped, "total_subscribers": len(alerts)}


def _record_delivery(db: Session, signal: Signal, user_id: int, alert_type: str,
                     status: str, skip_reason: str | None, queued_at=None) -> bool:
    """BR-874 — UNIQUE (signal_id, user_id, alert_type) đảm bảo không gửi trùng.

    Trả về False nếu bản ghi đã tồn tại (job chạy lại do lỗi mạng).
    """
    from sqlalchemy.exc import IntegrityError

    existing = db.scalar(
        select(AlertDelivery).where(
            AlertDelivery.signal_id == signal.id,
            AlertDelivery.user_id == user_id,
            AlertDelivery.alert_type == alert_type,
        )
    )
    if existing:
        return False

    delivery = AlertDelivery(
        signal_id=signal.id,
        user_id=user_id,
        alert_type=alert_type,
        status=status,
        skip_reason=skip_reason,
        queued_at=queued_at,
    )
    # SAVEPOINT vì lý do như ở `notification_service.enqueue`: một tín hiệu gửi cho 5.000 khách,
    # chỉ cần một bản ghi trùng là `db.rollback()` trần sẽ xoá sạch phần đã xếp hàng trước đó.
    try:
        with db.begin_nested():
            db.add(delivery)
            db.flush()
        return True
    except IntegrityError:
        # SAVEPOINT khi rollback đã gỡ `delivery` khỏi phiên.
        return False


# ======================================================================
# Xử lý update đến từ Telegram — mục 15.2
# ======================================================================
def mask_email(email: str) -> str:
    """Che email trong tin nhắn xác nhận: chat Telegram không phải nơi hiện đủ danh tính."""
    name, _, domain = email.partition("@")
    visible = name[:2] if len(name) > 2 else name
    return f"{visible}{'*' * max(len(name) - len(visible), 0)}@{domain}"


def handle_update(db: Session, update: dict) -> None:
    """Xử lý một update (`/start <token>`, `/stop`, `/help`) và tự commit.

    Tách khỏi endpoint webhook để `app.scripts.telegram_dev_poll` chạy **đúng cùng một đường đi**.
    Máy chạy local không có URL công khai nên Telegram không gọi webhook được; nếu script dev tự
    viết lại phần xử lý thì hai nhánh sẽ trôi xa nhau, và thứ được kiểm thử ở dev không còn là thứ
    chạy ở production — đúng loại khác biệt chỉ lộ ra sau khi phát hành.

    Phần xác thực (BR-882) **không** nằm ở đây: nó thuộc về lớp vận chuyển. Webhook kiểm tra
    header bí mật trước khi gọi hàm này, còn script dev lấy dữ liệu thẳng từ `getUpdates` bằng
    bot token nên bản thân nguồn đã đáng tin.
    """
    message = update.get("message") or update.get("edited_message") or {}
    chat = message.get("chat") or {}
    chat_id = chat.get("id")
    text = (message.get("text") or "").strip()

    if not chat_id or not text:
        return

    from_user = message.get("from") or {}
    username = from_user.get("username")
    first_name = from_user.get("first_name")

    # --- /start <token> — bước 5 của luồng deep-link ---
    if text.startswith("/start"):
        parts = text.split(maxsplit=1)
        token = parts[1].strip() if len(parts) > 1 else ""
        if not token:
            send_raw_message(
                chat_id,
                "Xin chào! Để nhận tín hiệu, vui lòng bấm nút \"Kết nối Telegram\" "
                "trên website thay vì mở bot trực tiếp.",
                protect_content=False,
            )
            return

        try:
            conn = complete_connect(db, token, chat_id, username, first_name)
            db.commit()
        except Exception as exc:
            db.rollback()
            detail = getattr(exc, "message", str(exc))
            send_raw_message(
                chat_id, f"❌ Không kết nối được: {detail}", protect_content=False
            )
            return

        user = db.get(User, conn.user_id)
        masked = mask_email(user.email) if user else ""
        # Bước 7 — tin nhắn xác nhận.
        send_raw_message(
            chat_id,
            f"✅ Đã kết nối thành công với tài khoản {masked}.\n\n"
            "Bạn sẽ nhận được tín hiệu của các cặp (chiến lược × mã) đã đăng ký trên website.\n"
            "Gõ /stop bất cứ lúc nào để ngừng nhận.",
            protect_content=False,
        )
        return

    # --- /stop — BR-864 ---
    if text.startswith("/stop"):
        conn = db.scalar(select(TelegramConnection).where(TelegramConnection.chat_id == chat_id))
        if conn:
            disconnect(db, conn.user_id, "TELEGRAM_STOP")
            db.commit()
        send_raw_message(
            chat_id,
            "Đã ngừng gửi tín hiệu. Bạn có thể kết nối lại bất cứ lúc nào "
            "trong phần Cài đặt thông báo trên website.",
            protect_content=False,
        )
        return

    if text.startswith("/help"):
        send_raw_message(
            chat_id,
            "Các lệnh khả dụng:\n"
            "/start — kết nối tài khoản (dùng link từ website)\n"
            "/stop — ngừng nhận tín hiệu\n"
            "/help — xem hướng dẫn",
            protect_content=False,
        )
