"""Điểm kết nối WebSocket — YC16, YC17.

BR-000 — hai kênh tách biệt, xác thực bằng đúng cookie/secret của từng site. Token của khách
hàng không mở được kênh quản trị và ngược lại.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.database import SessionLocal
from app.core.deps import CUSTOMER_ACCESS_COOKIE, STAFF_ACCESS_COOKIE
from app.core.security import decode_token
from app.models.staff import Staff
from app.models.user import User
from app.services import rbac
from app.services.realtime import (
    Connection,
    customer_registry,
    staff_registry,
)

log = logging.getLogger(__name__)

router = APIRouter(prefix="/ws", tags=["websocket"])

#: Mã đóng chuẩn của WebSocket cho lỗi chính sách/xác thực.
CLOSE_UNAUTHORIZED = 1008


def _token_from(websocket: WebSocket, cookie_name: str) -> str | None:
    """Ưu tiên cookie. Chấp nhận query `?token=` cho client không gửi được cookie."""
    return websocket.cookies.get(cookie_name) or websocket.query_params.get("token")


@router.websocket("/customer")
async def customer_channel(websocket: WebSocket) -> None:
    """Khách hàng nhận cập nhật hỏi đáp của **chính mình** (BR-850)."""
    token = _token_from(websocket, CUSTOMER_ACCESS_COOKIE)
    payload = decode_token(token, "customer") if token else None
    if not payload or payload.get("typ") != "access":
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    db = SessionLocal()
    try:
        user = db.get(User, int(payload["sub"]))
        if not user or user.deleted_at:
            await websocket.close(code=CLOSE_UNAUTHORIZED)
            return
        user_id = user.id
    finally:
        db.close()

    await websocket.accept()
    connection = Connection(websocket=websocket, principal_id=user_id)
    customer_registry.add(connection)

    try:
        while True:
            # Không xử lý lệnh từ client — kênh chỉ một chiều máy chủ → client.
            # Vẫn phải đọc để phát hiện khi client ngắt kết nối.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("ws:customer đóng do lỗi: %s", exc)
    finally:
        customer_registry.remove(websocket)


@router.websocket("/admin")
async def staff_channel(websocket: WebSocket) -> None:
    """Nhân viên nhận sự kiện vận hành để hiện toast kèm âm thanh (YC17)."""
    token = _token_from(websocket, STAFF_ACCESS_COOKIE)
    payload = decode_token(token, "staff") if token else None
    if not payload or payload.get("typ") != "access":
        await websocket.close(code=CLOSE_UNAUTHORIZED)
        return

    db = SessionLocal()
    try:
        staff = db.get(Staff, int(payload["sub"]))
        if not staff or staff.status != "ACTIVE":
            await websocket.close(code=CLOSE_UNAUTHORIZED)
            return
        staff_id = staff.id
        permissions = set(rbac.effective_permissions(staff))
    finally:
        db.close()

    await websocket.accept()
    connection = Connection(websocket=websocket, principal_id=staff_id, permissions=permissions)
    staff_registry.add(connection)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.debug("ws:admin đóng do lỗi: %s", exc)
    finally:
        staff_registry.remove(websocket)
