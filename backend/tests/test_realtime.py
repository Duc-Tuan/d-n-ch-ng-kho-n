"""Kiểm thử kênh real-time — YC16, YC17.

Trọng tâm là đường đi từ **mã đồng bộ sang vòng lặp sự kiện**. Endpoint FastAPI khai bằng `def`
chạy trong luồng phụ, ở đó không có vòng lặp asyncio nào; nếu `_dispatch` không xử lý được tình
huống này thì mọi sự kiện bị nuốt im lặng — giao diện không cập nhật mà log cũng không có gì để
lần ra. Đây đúng là loại lỗi cần một bài kiểm thử canh giữ.

Các kịch bản bất đồng bộ chạy qua `asyncio.run` thay vì `pytest-asyncio`: dự án không cài plugin
đó, và thêm phụ thuộc chỉ để chạy bốn bài kiểm thử là cái giá không đáng.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable, TypeVar

import pytest

from app.services import realtime

T = TypeVar("T")


class FakeWebSocket:
    """Chỉ cần đúng một phương thức mà `realtime._send` dùng tới."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_text(self, message: str) -> None:
        self.sent.append(json.loads(message))


def _connect(registry: realtime.ConnectionRegistry, principal_id: int,
             permissions: set[str] | None = None) -> FakeWebSocket:
    websocket = FakeWebSocket()
    registry.add(
        realtime.Connection(
            websocket=websocket,  # type: ignore[arg-type]
            principal_id=principal_id,
            permissions=permissions or set(),
        )
    )
    return websocket


def _run(scenario: Callable[[], Awaitable[T]]) -> T:
    return asyncio.run(scenario())


@pytest.fixture(autouse=True)
def _don_dep_danh_ba():
    """Danh bạ kết nối là biến toàn cục — không dọn thì test này rò sang test khác."""
    yield
    for registry in (realtime.customer_registry, realtime.staff_registry):
        for connection in list(registry.targets(None, None)):
            registry.remove(connection.websocket)
    realtime._event_loop = None


def test_su_kien_phat_tu_luong_phu_van_toi_duoc_client():
    """Endpoint `def` chạy ở luồng phụ; sự kiện vẫn phải sang được vòng lặp sự kiện."""

    async def scenario() -> FakeWebSocket:
        websocket = _connect(realtime.customer_registry, principal_id=7)
        # `to_thread` mô phỏng đúng chỗ FastAPI chạy endpoint đồng bộ.
        await asyncio.to_thread(
            realtime.broadcast_public_event,
            {"type": "content", "entity": "article", "action": "deleted", "slug": "bai-viet"},
        )
        await asyncio.sleep(0.05)  # nhường lượt cho task gửi
        return websocket

    websocket = _run(scenario)
    assert websocket.sent == [
        {"type": "content", "entity": "article", "action": "deleted", "slug": "bai-viet"}
    ]


def test_su_kien_noi_dung_cong_khai_toi_moi_khach_hang():
    async def scenario() -> tuple[FakeWebSocket, FakeWebSocket]:
        first = _connect(realtime.customer_registry, principal_id=1)
        second = _connect(realtime.customer_registry, principal_id=2)
        realtime.broadcast_public_event(
            {"type": "content", "entity": "article", "action": "updated"}
        )
        await asyncio.sleep(0.05)
        return first, second

    first, second = _run(scenario)
    assert len(first.sent) == 1
    assert len(second.sent) == 1


def test_du_lieu_rieng_chi_toi_dung_mot_khach_hang():
    """BR-850 — cách ly dữ liệu. `broadcast_customer_event` không được rò sang người khác."""

    async def scenario() -> tuple[FakeWebSocket, FakeWebSocket]:
        mine = _connect(realtime.customer_registry, principal_id=1)
        other = _connect(realtime.customer_registry, principal_id=2)
        realtime.broadcast_customer_event(1, {"type": "question_answered", "question_id": 9})
        await asyncio.sleep(0.05)
        return mine, other

    mine, other = _run(scenario)
    assert len(mine.sent) == 1
    assert other.sent == []


def test_su_kien_nhan_vien_loc_theo_quyen():
    """Nhân viên không có quyền tương ứng thì không nhận được sự kiện của nghiệp vụ đó."""

    async def scenario() -> tuple[FakeWebSocket, FakeWebSocket]:
        allowed = _connect(realtime.staff_registry, principal_id=1, permissions={"qa.answer"})
        denied = _connect(realtime.staff_registry, principal_id=2, permissions={"content.view"})
        realtime.broadcast_staff_event(
            {"type": "notification", "title": "Câu hỏi mới", "required_permission": "qa.answer"}
        )
        await asyncio.sleep(0.05)
        return allowed, denied

    allowed, denied = _run(scenario)
    assert len(allowed.sent) == 1
    assert denied.sent == []


def test_khong_co_vong_lap_thi_bo_qua_im_lang(monkeypatch):
    """Script chạy tay hoặc job ngoài máy chủ ASGI: real-time hỏng cũng không được làm hỏng nghiệp vụ."""
    websocket = FakeWebSocket()
    realtime.customer_registry.add(
        realtime.Connection(websocket=websocket, principal_id=1)  # type: ignore[arg-type]
    )
    monkeypatch.setattr(realtime, "_event_loop", None)

    realtime.broadcast_public_event({"type": "content"})  # không được ném lỗi
    assert websocket.sent == []
