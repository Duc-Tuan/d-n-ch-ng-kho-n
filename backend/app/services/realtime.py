"""Kênh real-time bằng WebSocket — YC16, YC17.

Hai kênh tách biệt, giữ đúng nguyên tắc BR-000:
  * `/ws/customer` — khách hàng nhận cập nhật hỏi đáp của **chính mình**.
  * `/ws/admin`    — nhân viên nhận sự kiện vận hành để hiện toast kèm âm thanh.

Cài đặt trong tiến trình (in-process). Khi chạy nhiều instance cần đổi sang Redis pub/sub —
điểm thay thế duy nhất là hai hàm `broadcast_*` bên dưới.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)


@dataclass
class Connection:
    websocket: WebSocket
    #: id khách hàng hoặc id nhân viên tuỳ kênh.
    principal_id: int
    permissions: set[str] = field(default_factory=set)


#: Vòng lặp sự kiện của máy chủ, ghi lại khi có kết nối WebSocket đầu tiên.
_event_loop: asyncio.AbstractEventLoop | None = None


def bind_event_loop() -> None:
    """Ghi nhớ vòng lặp đang chạy để mã đồng bộ đẩy được sự kiện sang.

    Endpoint khai bằng `def` (không phải `async def`) được FastAPI chạy trong **luồng phụ**, ở đó
    `asyncio.get_running_loop()` báo lỗi. Không giữ sẵn tham chiếu này thì mọi sự kiện phát ra từ
    endpoint đồng bộ đều rơi vào im lặng — kênh real-time coi như không tồn tại, mà lại không có
    lỗi nào để lần ra.
    """
    global _event_loop
    try:
        _event_loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover — chỉ xảy ra ngoài máy chủ ASGI
        _event_loop = None


class ConnectionRegistry:
    """Danh bạ kết nối đang mở. Ghi/đọc từ vòng lặp sự kiện nên không cần khoá."""

    def __init__(self, name: str) -> None:
        self.name = name
        self._connections: list[Connection] = []

    def add(self, connection: Connection) -> None:
        # `add` luôn được gọi từ handler WebSocket, tức là đang ở trên vòng lặp sự kiện.
        bind_event_loop()
        self._connections.append(connection)
        log.info("%s: +1 kết nối (tổng %s)", self.name, len(self._connections))

    def remove(self, websocket: WebSocket) -> None:
        before = len(self._connections)
        self._connections = [c for c in self._connections if c.websocket is not websocket]
        if len(self._connections) != before:
            log.info("%s: -1 kết nối (còn %s)", self.name, len(self._connections))

    def targets(self, principal_id: int | None, required_permission: str | None) -> list[Connection]:
        result = []
        for connection in self._connections:
            if principal_id is not None and connection.principal_id != principal_id:
                continue
            if required_permission and required_permission not in connection.permissions:
                continue
            result.append(connection)
        return result

    @property
    def count(self) -> int:
        return len(self._connections)


customer_registry = ConnectionRegistry("ws:customer")
staff_registry = ConnectionRegistry("ws:admin")


async def _send(connections: list[Connection], payload: dict[str, Any]) -> None:
    message = json.dumps(payload, default=str, ensure_ascii=False)
    dead: list[WebSocket] = []
    for connection in connections:
        try:
            await connection.websocket.send_text(message)
        except Exception:
            # Kết nối đã đóng phía client — dọn khỏi danh bạ thay vì thử lại.
            dead.append(connection.websocket)
    for websocket in dead:
        customer_registry.remove(websocket)
        staff_registry.remove(websocket)


def _dispatch(registry: ConnectionRegistry, payload: dict[str, Any],
              principal_id: int | None, required_permission: str | None) -> None:
    """Gửi từ mã đồng bộ (service/job) sang vòng lặp bất đồng bộ của máy chủ.

    Hai đường vào: đang ở trên vòng lặp thì tạo task thẳng; đang ở luồng phụ (endpoint `def`,
    job nền) thì đẩy qua `run_coroutine_threadsafe`.

    Nếu không có vòng lặp nào (script chạy tay, test), bỏ qua im lặng — real-time là tiện ích
    bổ sung, không được phép làm hỏng nghiệp vụ chính.
    """
    targets = registry.targets(principal_id, required_permission)
    if not targets:
        return

    coroutine = _send(targets, payload)
    try:
        asyncio.get_running_loop().create_task(coroutine)
        return
    except RuntimeError:
        pass  # không ở trên vòng lặp — thử tham chiếu đã ghi nhớ

    loop = _event_loop
    if loop is None or loop.is_closed():
        coroutine.close()  # đóng tường minh, nếu không Python cảnh báo "never awaited"
        return
    asyncio.run_coroutine_threadsafe(coroutine, loop)


def broadcast_staff_event(payload: dict[str, Any]) -> None:
    """Đẩy sự kiện tới nhân viên. YC17 — trang quản trị sẽ hiện toast kèm âm thanh."""
    _dispatch(
        staff_registry,
        payload,
        payload.get("staff_id"),
        payload.get("required_permission"),
    )


def broadcast_customer_event(user_id: int, payload: dict[str, Any]) -> None:
    """Đẩy sự kiện tới đúng một khách hàng.

    BR-850 — cách ly dữ liệu: không bao giờ phát tán cho toàn bộ khách hàng.
    """
    _dispatch(customer_registry, payload, user_id, None)


# ======================================================================
# KÊNH GIÁ — mô hình đăng ký theo mã
# ======================================================================
@dataclass
class MarketConnection:
    """Một trình duyệt đang mở bảng giá, kèm danh sách mã nó quan tâm."""

    websocket: WebSocket
    symbols: set[str] = field(default_factory=set)


class MarketRegistry:
    """Danh bạ kênh giá.

    Vì sao tách hẳn khỏi `customer_registry` thay vì thêm một loại sự kiện: kênh khách hàng lọc
    theo `principal_id` và **một chiều theo thiết kế** (BR-850). Giá là dữ liệu công khai, ai
    cũng đọc được, nhưng lại cần chiều ngược lại — client phải nói được nó đang xem mã nào.
    Nhét hai mô hình khác nhau vào một danh bạ là cách chắc chắn để một hôm nào đó gửi nhầm dữ
    liệu riêng của khách này sang khách khác.
    """

    def __init__(self) -> None:
        self._connections: list[MarketConnection] = []

    def add(self, connection: MarketConnection) -> None:
        bind_event_loop()
        self._connections.append(connection)
        log.info("ws:market: +1 kết nối (tổng %s)", len(self._connections))

    def remove(self, websocket: WebSocket) -> None:
        before = len(self._connections)
        self._connections = [c for c in self._connections if c.websocket is not websocket]
        if len(self._connections) != before:
            log.info("ws:market: -1 kết nối (còn %s)", len(self._connections))

    def find(self, websocket: WebSocket) -> MarketConnection | None:
        for connection in self._connections:
            if connection.websocket is websocket:
                return connection
        return None

    @property
    def connections(self) -> list[MarketConnection]:
        return list(self._connections)

    @property
    def count(self) -> int:
        return len(self._connections)

    @property
    def subscribed_symbols(self) -> set[str]:
        result: set[str] = set()
        for connection in self._connections:
            result |= connection.symbols
        return result


market_registry = MarketRegistry()


async def _send_quotes(items: list[tuple[MarketConnection, list[dict]]]) -> None:
    dead: list[WebSocket] = []
    for connection, quotes in items:
        message = json.dumps(
            {"type": "quotes", "quotes": quotes}, default=str, ensure_ascii=False
        )
        try:
            await connection.websocket.send_text(message)
        except Exception:
            dead.append(connection.websocket)
    for websocket in dead:
        market_registry.remove(websocket)


def broadcast_quotes(quotes: list[dict[str, Any]]) -> None:
    """Đẩy các mã **vừa đổi giá** tới những kết nối đã đăng ký đúng mã đó.

    Hai tầng lọc, cả hai đều cần: bộ poll đã bỏ những mã không đổi so với nhịp trước, và ở đây
    bỏ tiếp những mã kết nối này không xem. Một bảng giá mở 60 dòng nhận vài trăm byte mỗi nhịp
    thay vì 143 KB.
    """
    if not quotes:
        return

    by_symbol = {q["symbol"]: q for q in quotes}
    items: list[tuple[MarketConnection, list[dict]]] = []
    for connection in market_registry.connections:
        if not connection.symbols:
            continue
        selected = [by_symbol[s] for s in connection.symbols if s in by_symbol]
        if selected:
            items.append((connection, selected))

    if not items:
        return

    coroutine = _send_quotes(items)
    try:
        asyncio.get_running_loop().create_task(coroutine)
        return
    except RuntimeError:
        pass

    loop = _event_loop
    if loop is None or loop.is_closed():
        coroutine.close()
        return
    asyncio.run_coroutine_threadsafe(coroutine, loop)


def broadcast_public_event(payload: dict[str, Any]) -> None:
    """Đẩy sự kiện **nội dung công khai** tới mọi khách hàng đang mở trang.

    Không mâu thuẫn với BR-850: hàm này chỉ dùng cho thay đổi của nội dung mà ai cũng đọc được
    (bài viết đã xuất bản), và gói tin chỉ mang định danh bài viết — không kèm dữ liệu của bất kỳ
    khách hàng nào. Dữ liệu riêng của từng người vẫn phải đi qua `broadcast_customer_event`.
    """
    _dispatch(customer_registry, payload, None, None)
