"""Thông báo in-app, trung tâm tuỳ chọn và kết nối Telegram — Customer Site."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update

from app.core.constants import (
    OPTIONAL_NOTIFICATION_CODES,
    AlertType,
    NotificationChannel,
    NotificationCode,
    NotificationStatus,
    TelegramStatus,
)
from app.core.datetime_utils import utcnow
from app.core.deps import ActiveUser, CurrentUser, DbSession
from app.core.exceptions import Conflict, NotFound, ValidationError
from app.core.pagination import PageParams, build_page, count_of, page_params, paginate_page
from app.models.notification import Notification, NotificationPreference
from app.models.strategy import Strategy
from app.models.telegram import StrategyAlert, TelegramConnection
from app.schemas.common import Message, PageResponse
from app.schemas.domain import (
    AlertOut,
    AlertSubscribeRequest,
    NotificationOut,
    NotificationPreferenceItem,
    TelegramConnectResponse,
    TelegramManualRequest,
    TelegramStatusOut,
    TelegramVerifyRequest,
)
from app.services import telegram_service

router = APIRouter(tags=["customer-notifications"])

Pagination = Annotated[PageParams, Depends(page_params)]

#: Nhãn tiếng Việt cho trung tâm tuỳ chọn (BR-815).
NOTIFICATION_LABELS: dict[str, str] = {
    NotificationCode.NEW_ARTICLE: "Bài viết mới theo danh mục bạn theo dõi",
    NotificationCode.NEW_DOCUMENT: "Tài liệu mới trong kho tài liệu",
    NotificationCode.NEW_SIGNAL: "Chiến lược bạn theo dõi phát tín hiệu",
    NotificationCode.EXPIRY_T7: "Nhắc gói dịch vụ sắp hết hạn",
    NotificationCode.COMPLIANCE_WARNING: "Cảnh báo điều kiện duy trì tài khoản",
    NotificationCode.PASSWORD_CHANGED: "Thông báo bảo mật tài khoản",
    NotificationCode.NEW_DEVICE_LOGIN: "Đăng nhập từ thiết bị lạ",
}


# ======================================================================
# THÔNG BÁO IN-APP
# ======================================================================
@router.get("/notifications", response_model=PageResponse[NotificationOut])
def list_notifications(user: CurrentUser, db: DbSession, params: Pagination,
                       unread_only: bool = False) -> dict:
    stmt = select(Notification).where(
        Notification.user_id == user.id,
        Notification.channel == NotificationChannel.IN_APP,
    )
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    stmt = stmt.order_by(Notification.id.desc())

    return paginate_page(db, stmt, params, NotificationOut.model_validate)


@router.get("/notifications/unread-count", response_model=dict)
def unread_count(user: CurrentUser, db: DbSession) -> dict:
    count = db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user.id,
            Notification.channel == NotificationChannel.IN_APP,
            Notification.read_at.is_(None),
        )
    ) or 0
    return {"count": int(count)}


@router.post("/notifications/{notification_id}/read", response_model=Message)
def mark_read(notification_id: int, user: CurrentUser, db: DbSession) -> Message:
    notif = db.get(Notification, notification_id)
    if not notif or notif.user_id != user.id:
        raise NotFound("Thông báo không tồn tại")
    if not notif.read_at:
        notif.read_at = utcnow()
        db.commit()
    return Message(message="Đã đánh dấu đã đọc")


@router.post("/notifications/read-all", response_model=Message)
def mark_all_read(user: CurrentUser, db: DbSession) -> Message:
    db.execute(
        update(Notification)
        .where(
            Notification.user_id == user.id,
            Notification.channel == NotificationChannel.IN_APP,
            Notification.read_at.is_(None),
        )
        .values(read_at=utcnow())
    )
    db.commit()
    return Message(message="Đã đánh dấu tất cả là đã đọc")


# ======================================================================
# TRUNG TÂM TUỲ CHỌN — BR-815
# ======================================================================
@router.get("/notification-preferences", response_model=list[NotificationPreferenceItem])
def get_preferences(user: CurrentUser, db: DbSession) -> list[NotificationPreferenceItem]:
    """Nhóm giao dịch/bảo mật/compliance trả về `locked=True` — FE phải nêu rõ lý do không tắt được."""
    saved = {
        (p.code, p.channel): p.enabled
        for p in db.scalars(
            select(NotificationPreference).where(NotificationPreference.user_id == user.id)
        ).all()
    }

    items: list[NotificationPreferenceItem] = []
    for code in OPTIONAL_NOTIFICATION_CODES:
        for channel in (NotificationChannel.EMAIL, NotificationChannel.IN_APP):
            items.append(
                NotificationPreferenceItem(
                    code=str(code),
                    channel=str(channel),
                    enabled=saved.get((str(code), str(channel)), True),
                    locked=False,
                    label=NOTIFICATION_LABELS.get(code, str(code)),
                )
            )

    # Nhóm bắt buộc — hiển thị để KH biết mình sẽ nhận gì, nhưng không cho tắt.
    for code in (
        NotificationCode.COMPLIANCE_WARNING,
        NotificationCode.EXPIRY_T7,
        NotificationCode.NEW_DEVICE_LOGIN,
        NotificationCode.PASSWORD_CHANGED,
    ):
        items.append(
            NotificationPreferenceItem(
                code=str(code), channel=str(NotificationChannel.EMAIL), enabled=True,
                locked=True, label=NOTIFICATION_LABELS.get(code, str(code)),
            )
        )
    return items


@router.put("/notification-preferences", response_model=Message)
def update_preferences(
    items: list[NotificationPreferenceItem], user: CurrentUser, db: DbSession
) -> Message:
    for item in items:
        # BR-815 — nhóm bắt buộc thì bỏ qua, kể cả khi FE gửi lên.
        if item.code not in {str(c) for c in OPTIONAL_NOTIFICATION_CODES}:
            continue
        pref = db.scalar(
            select(NotificationPreference).where(
                NotificationPreference.user_id == user.id,
                NotificationPreference.code == item.code,
                NotificationPreference.channel == item.channel,
            )
        )
        if pref:
            pref.enabled = item.enabled
        else:
            db.add(
                NotificationPreference(
                    user_id=user.id, code=item.code, channel=item.channel, enabled=item.enabled
                )
            )
    db.commit()
    return Message(message="Đã lưu tuỳ chọn thông báo")


# ======================================================================
# TELEGRAM — Phần 15
# ======================================================================
@router.get("/telegram", response_model=TelegramStatusOut)
def telegram_status(user: ActiveUser, db: DbSession) -> TelegramStatusOut:
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    return TelegramStatusOut(
        status=conn.status if conn else "NOT_CONNECTED",
        chat_id=conn.chat_id if conn else None,
        telegram_username=conn.telegram_username if conn else None,
        verified_at=conn.verified_at if conn else None,
        last_error=conn.last_error if conn else None,
        usage=telegram_service.alert_usage(db, user),
    )


@router.post("/telegram/connect", response_model=TelegramConnectResponse)
def telegram_connect(user: ActiveUser, db: DbSession) -> TelegramConnectResponse:
    """BR-861 — luồng deep-link: KH chỉ bấm 2 nút, không phải tự đi tìm chat ID."""
    data = telegram_service.start_connect(db, user)
    db.commit()
    return TelegramConnectResponse(**data)


@router.post("/telegram/manual", response_model=Message)
def telegram_manual(payload: TelegramManualRequest, user: ActiveUser, db: DbSession) -> Message:
    """BR-862 — phương án dự phòng, bắt buộc có bước xác thực bằng mã 6 số."""
    if not payload.accept_telegram_consent:
        # BR-879 — checkbox đồng ý riêng, nêu rõ Telegram là dịch vụ bên thứ ba.
        raise ValidationError(
            "Bạn cần đồng ý việc hệ thống gửi thông tin tín hiệu qua nền tảng Telegram "
            "— một dịch vụ của bên thứ ba nằm ngoài kiểm soát của chúng tôi",
            {"field": "accept_telegram_consent"},
        )
    telegram_service.start_manual_verify(db, user, payload.chat_id)
    db.commit()
    return Message(
        message="Đã gửi mã xác thực 6 số tới Telegram của bạn. Vui lòng nhập lại mã để hoàn tất.",
        code="VERIFY_CODE_SENT",
    )


@router.post("/telegram/verify", response_model=Message)
def telegram_verify(payload: TelegramVerifyRequest, user: ActiveUser, db: DbSession) -> Message:
    conn = telegram_service.confirm_manual_verify(db, user, payload.code)
    conn.consent_at = utcnow()
    db.commit()
    return Message(message="Kết nối Telegram thành công", code="TELEGRAM_VERIFIED")


@router.post("/telegram/disconnect", response_model=Message)
def telegram_disconnect(user: ActiveUser, db: DbSession) -> Message:
    """BR-864 — dừng gửi ngay lập tức."""
    telegram_service.disconnect(db, user.id)
    db.commit()
    return Message(message="Đã ngắt kết nối Telegram")


@router.post("/telegram/test", response_model=Message)
def telegram_test(user: ActiveUser, db: DbSession) -> Message:
    """Nút "Gửi tin thử" (mục 15.7) — để KH tự kiểm tra thay vì gọi tổng đài."""
    conn = db.scalar(select(TelegramConnection).where(TelegramConnection.user_id == user.id))
    if not conn or conn.status != TelegramStatus.VERIFIED or not conn.chat_id:
        raise Conflict("Bạn chưa kết nối Telegram", "TELEGRAM_NOT_CONNECTED")

    try:
        telegram_service.send_raw_message(
            conn.chat_id,
            f"✅ Tin nhắn thử từ {user.full_name}.\n"
            "Kết nối Telegram của bạn đang hoạt động bình thường.",
        )
    except telegram_service.TelegramApiError as exc:
        if exc.is_permanent:
            telegram_service.mark_blocked(db, conn, exc.code, exc.message)
            db.commit()
        raise Conflict(
            f"Không gửi được tin nhắn: {exc.message}. "
            "Vui lòng kiểm tra bạn đã bấm Bắt đầu với bot và chưa chặn bot.",
            "TELEGRAM_SEND_FAILED",
        ) from exc

    conn.last_success_at = utcnow()
    db.commit()
    return Message(message="Đã gửi tin nhắn thử tới Telegram của bạn")


# ----------------------------------------------------------------------
# Đăng ký cặp (chiến lược × mã)
# ----------------------------------------------------------------------
@router.get("/telegram/alerts", response_model=dict)
def list_alerts(user: ActiveUser, db: DbSession, params: Pagination) -> dict:
    """Mục 15.7 — danh sách cặp đã đăng ký, nhóm theo chiến lược ở FE.

    Mỗi cặp (chiến lược × mã) là một bản ghi, nên khách theo dõi nhiều mã sẽ có danh sách rất dài.
    """
    stmt = (
        select(StrategyAlert)
        .where(StrategyAlert.user_id == user.id)
        .order_by(StrategyAlert.strategy_id, StrategyAlert.symbol)
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    strategies = {s.id: s.name for s in db.scalars(select(Strategy)).all()}
    result = []
    for row in rows:
        item = AlertOut.model_validate(row)
        item.strategy_name = strategies.get(row.strategy_id)
        result.append(item)
    return build_page(result, int(total), params)


@router.post("/telegram/alerts", response_model=dict, status_code=201)
def subscribe_alerts(payload: AlertSubscribeRequest, user: ActiveUser, db: DbSession) -> dict:
    """BR-858 — cho tick nhiều mã cùng lúc; dữ liệu vẫn sinh N bản ghi cặp riêng biệt."""
    created, errors = [], []
    for symbol in payload.symbols:
        try:
            alert = telegram_service.subscribe_pair(
                db, user, payload.strategy_id, symbol,
                [str(t) for t in payload.alert_types] if payload.alert_types else None,
            )
            created.append({"id": alert.id, "symbol": alert.symbol})
        except Exception as exc:
            detail = getattr(exc, "message", str(exc))
            errors.append({"symbol": symbol.upper(), "error": detail})
    db.commit()

    return {
        "created": created,
        "errors": errors,
        "usage": telegram_service.alert_usage(db, user),
    }


@router.delete("/telegram/alerts/{alert_id}", response_model=Message)
def unsubscribe_alert(alert_id: int, user: ActiveUser, db: DbSession) -> Message:
    alert = db.get(StrategyAlert, alert_id)
    if not alert or alert.user_id != user.id:
        raise NotFound("Đăng ký không tồn tại")
    db.delete(alert)
    db.commit()
    return Message(message="Đã huỷ đăng ký nhận tín hiệu cho cặp này")


@router.put("/telegram/alerts/{alert_id}", response_model=AlertOut)
def update_alert(alert_id: int, alert_types: list[str], user: ActiveUser,
                 db: DbSession) -> AlertOut:
    """BR-871 — KH bật/tắt từng loại thông báo cho từng cặp."""
    alert = db.get(StrategyAlert, alert_id)
    if not alert or alert.user_id != user.id:
        raise NotFound("Đăng ký không tồn tại")

    valid = {str(t) for t in (AlertType.ENTRY, AlertType.TP, AlertType.SL, AlertType.CANCELLED)}
    selected = [t for t in alert_types if t in valid]
    if not selected:
        raise ValidationError("Phải chọn ít nhất một loại thông báo", {"field": "alert_types"})

    alert.alert_types = {"types": selected}
    db.commit()
    return AlertOut.model_validate(alert)
