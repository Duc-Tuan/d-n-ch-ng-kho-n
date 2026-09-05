"""Audit log — mục 3.6.

Nguyên tắc: mọi hành động **thay đổi dữ liệu** trên Admin Site đều đi qua đây.
Các hành động bắt buộc có `reason`: gia hạn/cấp gói thủ công, khoá/mở tài khoản,
xoá bài viết, thay đổi phân quyền, miễn áp điều kiện IB.
"""

from __future__ import annotations

from decimal import Decimal
from datetime import date, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.core.constants import ActorType
from app.core.exceptions import ValidationError
from app.models.staff import AuditLog, Staff


class AuditAction:
    """Danh mục action — dùng hằng số để tra cứu log không bị lệch chính tả."""

    CUSTOMER_GRANT_PACKAGE = "customer.grant_package"
    CUSTOMER_SUSPEND = "customer.suspend"
    CUSTOMER_UNSUSPEND = "customer.unsuspend"
    CUSTOMER_CLOSE = "customer.close"
    CUSTOMER_REOPEN = "customer.reopen"
    CUSTOMER_RESET_PASSWORD = "customer.reset_password"
    CUSTOMER_EXEMPT = "customer.compliance_exempt"
    CUSTOMER_UPDATE = "customer.update"
    CUSTOMER_NOTE = "customer.note"
    CUSTOMER_IB_APPROVE = "customer.ib_approve"

    ARTICLE_CREATE = "article.create"
    ARTICLE_UPDATE = "article.update"
    ARTICLE_PUBLISH = "article.publish"
    ARTICLE_DELETE = "article.delete"

    DOCUMENT_UPLOAD = "document.upload"
    DOCUMENT_UPDATE = "document.update"
    DOCUMENT_DELETE = "document.delete"

    STAFF_CREATE = "staff.create"
    STAFF_UPDATE = "staff.update"
    STAFF_DEACTIVATE = "staff.deactivate"
    STAFF_ROLE_CHANGE = "staff.role_change"
    ROLE_UPDATE = "role.update"

    STRATEGY_CREATE = "strategy.create"
    STRATEGY_UPDATE = "strategy.update"
    SIGNAL_CREATE = "signal.create"
    SIGNAL_CANCEL = "signal.cancel"

    NEWS_CREATE = "news.create"
    NEWS_UPDATE = "news.update"
    NEWS_DELETE = "news.delete"

    LEGAL_PUBLISH = "legal.publish"
    NOTIFICATION_BROADCAST = "notification.broadcast"
    SYNC_RUN_MANUAL = "sync.run_manual"
    SYNC_JOB_CANCEL = "sync.job_cancel"
    SYNC_JOB_DELETE = "sync.job_delete"

    SYMBOL_CREATE = "symbol.create"
    SYMBOL_UPDATE = "symbol.update"
    SYMBOL_DELETE = "symbol.delete"


#: Các action bắt buộc phải nhập lý do (mục 3.4, 3.6).
REASON_REQUIRED = frozenset(
    {
        AuditAction.CUSTOMER_GRANT_PACKAGE,
        AuditAction.CUSTOMER_SUSPEND,
        AuditAction.CUSTOMER_UNSUSPEND,
        AuditAction.CUSTOMER_CLOSE,
        AuditAction.CUSTOMER_REOPEN,
        AuditAction.CUSTOMER_EXEMPT,
        AuditAction.ARTICLE_DELETE,
        AuditAction.DOCUMENT_DELETE,
        AuditAction.STAFF_ROLE_CHANGE,
        AuditAction.SIGNAL_CANCEL,
        # Xoá một tin đã dẫn: cần biết ai gỡ và vì sao, tin đã hiện ra với khách hàng rồi.
        AuditAction.NEWS_DELETE,
        # Xoá mã kéo theo toàn bộ giá lịch sử của nó — không phải thao tác làm cho vui.
        AuditAction.SYMBOL_DELETE,
    }
)


def _jsonable(value: Any) -> Any:
    """Chuẩn hoá giá trị để lưu vào cột JSON (Decimal/datetime không serialize được)."""
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def log_action(
    db: Session,
    *,
    action: str,
    actor: Staff | None = None,
    actor_type: str = ActorType.STAFF,
    target_type: str | None = None,
    target_id: str | int | None = None,
    old_value: dict[str, Any] | None = None,
    new_value: dict[str, Any] | None = None,
    reason: str | None = None,
    ip: str | None = None,
    user_agent: str | None = None,
    commit: bool = False,
) -> AuditLog:
    """Ghi một dòng audit log.

    Ném `ValidationError` nếu action thuộc nhóm bắt buộc có lý do mà không truyền `reason` —
    đây là kiểm soát ở tầng service, không phụ thuộc vào việc FE có bắt nhập hay không.
    """
    if action in REASON_REQUIRED and not (reason or "").strip():
        raise ValidationError(
            "Hành động này bắt buộc phải nhập lý do",
            {"field": "reason", "action": action},
        )

    entry = AuditLog(
        actor_id=actor.id if actor else None,
        actor_type=actor_type,
        actor_name=(actor.full_name or actor.username) if actor else None,
        action=action,
        target_type=target_type,
        target_id=str(target_id) if target_id is not None else None,
        old_value=_jsonable(old_value) if old_value else None,
        new_value=_jsonable(new_value) if new_value else None,
        reason=reason,
        ip=ip,
        user_agent=(user_agent or "")[:400] or None,
    )
    db.add(entry)
    db.flush()
    if commit:
        db.commit()
    return entry


def diff(before: dict[str, Any], after: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    """Chỉ giữ các trường thực sự thay đổi — audit log sạch và dễ đọc hơn nhiều."""
    old_changed, new_changed = {}, {}
    for key, new_val in after.items():
        old_val = before.get(key)
        if old_val != new_val:
            old_changed[key] = old_val
            new_changed[key] = new_val
    return old_changed, new_changed
