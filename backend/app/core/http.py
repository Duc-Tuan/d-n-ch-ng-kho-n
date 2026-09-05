"""HTTP client dùng chung cho mọi lời gọi ra ngoài (Telegram, nhà cung cấp dữ liệu giá).

Vì sao cần một chỗ duy nhất thay vì gọi thẳng `httpx.post(...)`:

* **Kết nối được tái sử dụng.** Mỗi `httpx.post` ở cấp module tự dựng một `Client`, bắt tay
  TCP + TLS rồi vứt đi. Worker Telegram gửi 25 tin mỗi giây, tức 25 lượt bắt tay TLS mỗi giây
  với cùng một máy chủ — tốn CPU, tốn socket, và mỗi socket còn nằm ở trạng thái `TIME_WAIT`
  khoảng 60 giây sau khi đóng. Chạy liên tục thì số cổng tạm cạn dần, và triệu chứng ngoài đời
  là "gửi tin lỗi ngẫu nhiên sau vài giờ chạy" — rất khó lần ra.
* **Timeout không bao giờ bị quên.** Lời gọi ra ngoài không đặt timeout sẽ treo luồng worker
  vô hạn nếu đầu kia không trả lời.
* **Giới hạn số kết nối.** Chặn trên rõ ràng thay vì để thư viện tự mở bao nhiêu tuỳ ý.
"""

from __future__ import annotations

import atexit
import threading

import httpx

#: Đủ rộng cho worker gửi tuần tự, đủ hẹp để không bao giờ là bên làm nghẽn máy chủ.
_LIMITS = httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=60.0)

#: Kết nối chậm thì bỏ và thử lại ở vòng sau, không giữ luồng worker.
_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=15.0, pool=5.0)

_client: httpx.Client | None = None
_lock = threading.Lock()


def client() -> httpx.Client:
    """Client dùng chung, khởi tạo lười và an toàn khi nhiều luồng cùng gọi."""
    global _client
    if _client is None:
        with _lock:
            if _client is None:
                _client = httpx.Client(limits=_LIMITS, timeout=_TIMEOUT, follow_redirects=False)
    return _client


def close_client() -> None:
    """Đóng pool khi tắt ứng dụng. Gọi từ `lifespan` và cả `atexit` cho script chạy tay."""
    global _client
    with _lock:
        if _client is not None:
            _client.close()
            _client = None


atexit.register(close_client)
