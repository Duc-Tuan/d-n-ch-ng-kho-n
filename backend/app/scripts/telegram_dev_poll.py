"""Thay webhook Telegram khi chạy máy local — `python -m app.scripts.telegram_dev_poll`

**Vì sao cần script này.** Telegram gọi webhook từ máy chủ của họ ra Internet, nên URL phải là
HTTPS công khai. Máy chạy dev không có địa chỉ như vậy: khách bấm "Bắt đầu" trong Telegram thì
chỉ Telegram biết, hệ thống không hay gì, kết nối đứng mãi ở `PENDING` và giao diện không bao giờ
đổi trạng thái. Không có script này thì cách duy nhất để thử luồng deep-link ở local là dựng
tunnel (ngrok/cloudflared) và `setWebhook` lại mỗi lần URL đổi.

Cách làm: khi **không** đăng ký webhook, Telegram giữ update lại 24 giờ để lấy về bằng
`getUpdates`. Script gọi vòng lặp long-poll rồi đưa từng update vào đúng
`telegram_service.handle_update` mà webhook dùng — không nhân bản logic, nên thêm lệnh bot mới
thì cả hai đường cùng có.

    python -m app.scripts.telegram_dev_poll            # chạy tới khi Ctrl+C
    python -m app.scripts.telegram_dev_poll --once     # xử lý những gì đang chờ rồi thoát

Chạy ở một cửa sổ riêng, song song với backend. Không cần backend đang chạy — script tự mở kết
nối cơ sở dữ liệu riêng — nhưng thường thì bạn muốn cả hai cùng bật để bấm nút trên web.

**Chỉ dùng cho dev.** `getUpdates` và webhook loại trừ nhau: Telegram từ chối `getUpdates` khi đã
đăng ký webhook, và ngược lại chạy script này sau khi `deleteWebhook` sẽ làm production ngừng
nhận kết nối mới. Script từ chối chạy khi `APP_ENV=production`.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

import httpx

from app.core.config import settings
from app.core.database import session_scope
from app.services import telegram_service

log = logging.getLogger(__name__)

API_BASE = "https://api.telegram.org/bot"

#: Long-poll: Telegram giữ kết nối tới khi có update hoặc hết ngần này giây. Rẻ hơn nhiều so với
#: hỏi liên tục, và tin tới gần như tức thì.
POLL_TIMEOUT_SECONDS = 25

#: Mạng chập chờn là chuyện thường khi giữ kết nối lâu. Chờ ngần này giây rồi hỏi lại.
RETRY_DELAY_SECONDS = 3


def out(msg: str = "") -> None:
    print(msg, flush=True)


def _setup_console() -> None:
    """Console Windows mặc định là cp1258, không in nổi tiếng Việt có dấu — ép UTF-8.

    Đồng thời hạ mức log của httpx: nó ghi nguyên URL mỗi request, mà bot token nằm ngay trong
    đường dẫn. Token là mật khẩu quản trị của cả kênh Telegram, không nên rơi vào scrollback hay
    file log chỉ vì bật chế độ INFO.
    """
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.getLogger("httpx").setLevel(logging.WARNING)


def _api(method: str, **params) -> dict:
    response = httpx.get(
        f"{API_BASE}{settings.telegram_bot_token}/{method}",
        params=params,
        # Nhỉnh hơn `timeout` của long-poll, nếu không httpx tự huỷ trước khi Telegram trả lời.
        timeout=POLL_TIMEOUT_SECONDS + 15,
    )
    data = response.json()
    if not data.get("ok"):
        raise RuntimeError(f"Telegram trả lỗi: {data.get('description', data)}")
    return data


def _preflight() -> None:
    """Dừng sớm với thông báo rõ ràng thay vì để vòng lặp lỗi khó hiểu."""
    if settings.is_production:
        out("[DUNG] APP_ENV=production. Script này chỉ dành cho máy dev — xem docstring.")
        sys.exit(2)

    if not settings.telegram_bot_token:
        out("[DUNG] Chưa đặt TELEGRAM_BOT_TOKEN trong backend/.env.")
        sys.exit(2)

    info = _api("getWebhookInfo").get("result", {})
    if info.get("url"):
        out(f"[DUNG] Bot đang đăng ký webhook tại: {info['url']}")
        out("       Telegram không cho dùng getUpdates khi còn webhook.")
        out("       Gỡ webhook rồi chạy lại — nhưng nhớ là thao tác đó cắt luôn")
        out("       đường nhận kết nối của môi trường đang dùng webhook đó:")
        out(f"       curl \"{API_BASE}<TOKEN>/deleteWebhook\"")
        sys.exit(2)


def poll(once: bool = False) -> int:
    """Vòng lặp long-poll. Trả về số update đã xử lý."""
    offset: int | None = None
    handled = 0

    while True:
        params = {"timeout": POLL_TIMEOUT_SECONDS}
        if offset is not None:
            params["offset"] = offset
        # `--once` không chờ: chỉ lấy những gì Telegram đang giữ sẵn.
        if once:
            params["timeout"] = 0

        try:
            updates = _api("getUpdates", **params).get("result", [])
        except httpx.TimeoutException:
            # Hết giờ chờ là kết quả *bình thường* của long-poll: không có update nào, hoặc
            # Telegram đóng kết nối trước khi httpx kịp đọc. Hỏi lại, đừng chết.
            if once:
                return handled
            continue
        except httpx.HTTPError as exc:
            # Rớt mạng, DNS hỏng, Telegram 502... Script dev không nên tắt vì mấy thứ tự khỏi này.
            out(f"  [MANG] {type(exc).__name__}: {exc} - thu lai sau {RETRY_DELAY_SECONDS}s")
            if once:
                return handled
            time.sleep(RETRY_DELAY_SECONDS)
            continue

        for update in updates:
            # Ghi nhận đã nhận **trước** khi xử lý. Telegram gửi lại mọi update chưa được xác
            # nhận, nên một update gây lỗi sẽ quay lại ở vòng sau và lỗi lại — vòng lặp vô tận
            # chặn đứng mọi update phía sau nó.
            offset = update["update_id"] + 1

            message = update.get("message") or update.get("edited_message") or {}
            text = (message.get("text") or "").strip()
            chat_id = (message.get("chat") or {}).get("id")
            out(f"  ← chat_id={chat_id}  {text[:60] or '(không có nội dung văn bản)'}")

            try:
                with session_scope() as db:
                    telegram_service.handle_update(db, update)
                handled += 1
            except Exception as exc:  # noqa: BLE001 — script dev, lỗi một update không được dừng cả vòng
                out(f"    [LOI] {exc}")
                log.exception("Không xử lý được update %s", update.get("update_id"))

        if once:
            return handled


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--once", action="store_true",
                        help="Xử lý các update đang chờ rồi thoát, không lặp")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    _setup_console()
    _preflight()

    out(f"Đang nghe update của @{settings.telegram_bot_username or '?'} qua getUpdates.")
    if args.once:
        count = poll(once=True)
        out(f"Đã xử lý {count} update đang chờ.")
        return

    out("Bấm Ctrl+C để dừng. Giờ hãy bấm \"Kết nối Telegram\" trên web rồi bấm Bắt đầu trong Telegram.")
    try:
        poll()
    except KeyboardInterrupt:
        out("\nĐã dừng.")


if __name__ == "__main__":
    main()
