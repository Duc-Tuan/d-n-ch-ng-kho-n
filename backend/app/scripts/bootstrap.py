"""Chuẩn bị môi trường trước khi khởi động — được `start.bat` gọi.

Việc script này làm:
  1. Tạo `.env` từ `.env.example` nếu chưa có, và **tự sinh hai JWT secret khác nhau**
     (BR-000) thay vì để giá trị mặc định trong file mẫu.
  2. Kiểm tra kết nối cơ sở dữ liệu.
  3. Tạo database nếu MySQL chạy được nhưng schema chưa tồn tại.

Mã thoát:
  0 — sẵn sàng chạy
  2 — không kết nối được cơ sở dữ liệu (start.bat sẽ hỏi có chuyển sang chế độ thử nghiệm không)
"""

from __future__ import annotations

import re
import secrets
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parents[2]
ENV_FILE = BASE_DIR / ".env"
ENV_EXAMPLE = BASE_DIR / ".env.example"


def out(message: str) -> None:
    print(message, flush=True)


def ensure_env_file() -> bool:
    """Trả về True nếu vừa tạo mới file .env."""
    if ENV_FILE.exists():
        return False

    if not ENV_EXAMPLE.exists():
        out("  [LOI] Khong tim thay .env.example")
        sys.exit(1)

    content = ENV_EXAMPLE.read_text(encoding="utf-8")

    # Sinh secret ngẫu nhiên, hai site hai giá trị khác nhau.
    content = re.sub(
        r"^JWT_SECRET_CUSTOMER=.*$",
        f"JWT_SECRET_CUSTOMER={secrets.token_urlsafe(64)}",
        content,
        flags=re.MULTILINE,
    )
    content = re.sub(
        r"^JWT_SECRET_STAFF=.*$",
        f"JWT_SECRET_STAFF={secrets.token_urlsafe(64)}",
        content,
        flags=re.MULTILINE,
    )

    ENV_FILE.write_text(content, encoding="utf-8")
    out("  Da tao file .env va sinh JWT secret ngau nhien cho hai site")
    return True


def check_database() -> bool:
    """Thử kết nối. Nếu MySQL sống nhưng thiếu database thì tạo giúp."""
    from sqlalchemy import create_engine, text

    from app.core.config import settings

    url = settings.database_url
    label = "SQLite" if url.startswith("sqlite") else f"MySQL {settings.db_host}:{settings.db_port}"

    try:
        engine = create_engine(url, pool_pre_ping=True)
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        out(f"  Ket noi {label} - OK")
        return True
    except Exception as first_error:
        if url.startswith("sqlite"):
            out(f"  [LOI] Khong mo duoc SQLite: {first_error}")
            return False

        # MySQL sống nhưng chưa có database — tạo giúp thay vì bắt người dùng tự làm.
        try:
            server_url = url.rsplit("/", 1)[0] + "/?charset=utf8mb4"
            engine = create_engine(server_url, pool_pre_ping=True)
            with engine.connect() as conn:
                conn.execute(
                    text(
                        f"CREATE DATABASE IF NOT EXISTS `{settings.db_name}` "
                        "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
                    )
                )
                conn.commit()
            out(f"  Da tao database `{settings.db_name}`")
            return True
        except Exception:
            out(f"  [LOI] Khong ket noi duoc {label}")
            out(f"        {type(first_error).__name__}: {str(first_error)[:160]}")
            return False


def main() -> int:
    out("  Kiem tra cau hinh...")
    created = ensure_env_file()

    if not check_database():
        out("")
        out("  Kiem tra lai cac muc sau trong file backend\\.env :")
        out("    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME")
        out("  Va bao dam dich vu MySQL dang chay.")
        return 2

    if created:
        out("")
        out("  LUU Y: mo backend\\.env de dien mat khau MySQL va cac cau hinh khac")
        out("         (Google Sheet, SMTP, Telegram) truoc khi dung that.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
