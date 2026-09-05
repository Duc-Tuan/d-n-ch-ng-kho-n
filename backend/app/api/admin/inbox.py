"""Hộp thông báo của nhân viên — phục vụ menu chuông trên header Admin Site."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, or_, select, update

from app.core.datetime_utils import utcnow
from app.core.deps import CurrentStaff, DbSession
from app.core.exceptions import NotFound
from app.core.pagination import PageParams, build_page, count_of, page_params
from app.models.staff import StaffNotification
from app.schemas.common import Message
from app.services import rbac

router = APIRouter(prefix="/notifications-inbox", tags=["admin-inbox"])

Pagination = Annotated[PageParams, Depends(page_params)]


def _visible_filter(staff):
    """Thông báo gửi đích danh, hoặc thông báo chung mà nhân viên có quyền đọc.

    Quyền được xét ở đây chứ không chỉ ở giao diện — nhân viên chăm sóc không nên thấy thông báo
    dành cho đội phân tích và ngược lại.
    """
    codes = rbac.effective_permissions(staff)
    return or_(
        StaffNotification.staff_id == staff.id,
        (StaffNotification.staff_id.is_(None))
        & (
            StaffNotification.required_permission.is_(None)
            | StaffNotification.required_permission.in_(codes)
        ),
    )


@router.get("/unread-count", response_model=dict)
def unread_count(staff: CurrentStaff, db: DbSession) -> dict:
    count = db.scalar(
        select(func.count())
        .select_from(StaffNotification)
        .where(_visible_filter(staff), StaffNotification.read_at.is_(None))
    ) or 0
    return {"count": int(count)}


@router.get("", response_model=dict)
def list_inbox(
    staff: CurrentStaff,
    db: DbSession,
    params: Pagination,
    unread_only: bool = Query(default=False),
) -> dict:
    stmt = select(StaffNotification).where(_visible_filter(staff))
    if unread_only:
        stmt = stmt.where(StaffNotification.read_at.is_(None))
    stmt = stmt.order_by(StaffNotification.id.desc())

    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    items = [
        {
            "id": n.id,
            "code": n.code,
            "channel": "IN_APP",
            "subject": n.title,
            "body": n.body,
            "status": "SENT",
            "read_at": n.read_at,
            "created_at": n.created_at,
            "link": n.link,
            "level": n.level,
        }
        for n in rows
    ]
    return build_page(items, total, params)


@router.post("/{notification_id}/read", response_model=Message)
def mark_read(notification_id: int, staff: CurrentStaff, db: DbSession) -> Message:
    notification = db.get(StaffNotification, notification_id)
    if not notification:
        raise NotFound("Thông báo không tồn tại")
    if not notification.read_at:
        notification.read_at = utcnow()
        db.commit()
    return Message(message="Đã đánh dấu đã đọc")


@router.post("/read-all", response_model=Message)
def mark_all_read(staff: CurrentStaff, db: DbSession) -> Message:
    db.execute(
        update(StaffNotification)
        .where(_visible_filter(staff), StaffNotification.read_at.is_(None))
        .values(read_at=utcnow())
    )
    db.commit()
    return Message(message="Đã đánh dấu tất cả là đã đọc")
