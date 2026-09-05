"""Kiểm tra đã có khách hàng nào chưa — `start.bat` dùng để quyết định có hỏi tạo dữ liệu mẫu không.

Mã thoát:
  0 — đã có khách hàng, không cần hỏi
  1 — chưa có khách hàng nào
"""

from __future__ import annotations

import sys

from sqlalchemy import func, select

from app.core.database import session_scope
from app.models.user import User


def main() -> int:
    try:
        with session_scope() as db:
            count = db.scalar(
                select(func.count()).select_from(User).where(User.deleted_at.is_(None))
            ) or 0
        return 0 if count > 0 else 1
    except Exception:
        # Không đọc được thì coi như đã có dữ liệu, tránh hỏi nhầm rồi ghi đè.
        return 0


if __name__ == "__main__":
    sys.exit(main())
