"""Tạo hai bảng của phần đa khung thời gian trên một CSDL mà `alembic upgrade` không chạy được.

**Vì sao cần script này thay vì chạy `alembic upgrade head`.**

CSDL đang chạy có `alembic_version = '0018'`, nhưng ba revision 0016/0017/0018 — phần "master
brain" — **không nằm trong repo này**. Alembic không giải được mốc hiện tại nên mọi lệnh của nó
đều dừng ngay ở bước đầu::

    $ alembic current
    FAILED: Can't locate revision identified by '0018'

Hệ quả là bảng `ohlcv_bars` chưa bao giờ được tạo, nên mọi khung nhỏ hơn ngày không có chỗ để
ghi và biểu đồ 1 phút … 1 giờ trống trơn. Đây là lỗi có sẵn của CSDL, không phải của phần đa
khung — nhưng nó chặn đúng phần đó.

**Script này làm gì.**

1. Tạo `ohlcv_bars` và `symbol_timeframe_sync` nếu chưa có, bằng **chính metadata của model** —
   cùng một định nghĩa mà migration `mtf0001` dùng, nên không có đường nào lệch nhau.
2. Ghi thêm revision `mtf0001` vào `alembic_version` như một **head thứ hai**, giữ nguyên dòng
   `0018` của nhánh brain. Alembic cho phép nhiều head, và đây đúng là hai nhánh song song mọc
   từ 0015: một nhánh brain, một nhánh đa khung.

Cả hai bước đều **chỉ thêm, không sửa và không xoá gì**. Chạy lại nhiều lần cũng an toàn.

**Không dùng script này để thay cho migration.** Trên một CSDL alembic còn lành lặn thì
``alembic upgrade heads`` mới là đường đúng; script chỉ để gỡ đúng tình huống mắc kẹt ở trên.

Cách chạy::

    cd backend && python -m app.scripts.repair_timeframe_tables          # xem trước, không ghi
    cd backend && python -m app.scripts.repair_timeframe_tables --apply  # thực hiện
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import inspect, text

from app.core.database import engine
from app.models.market import OhlcvBar, SymbolTimeframeSync

#: Revision của nhánh đa khung. Phải khớp `alembic/versions/mtf0001_multi_timeframe_ohlcv.py`.
REVISION = "mtf0001"

TABLES = (OhlcvBar, SymbolTimeframeSync)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Thực hiện thay đổi. Bỏ trống thì chỉ in ra những gì sẽ làm.",
    )
    args = parser.parse_args()

    inspector = inspect(engine)
    existing = set(inspector.get_table_names())
    missing = [t for t in TABLES if t.__tablename__ not in existing]

    with engine.connect() as conn:
        heads = {row[0] for row in conn.execute(text("SELECT version_num FROM alembic_version"))}

    print(f"CSDL     : {engine.url.render_as_string(hide_password=True)}")
    print(f"alembic  : {', '.join(sorted(heads)) or '(trống)'}")
    print(f"cần tạo  : {', '.join(t.__tablename__ for t in missing) or '(không có — đã đủ bảng)'}")
    print(f"cần thêm : {REVISION if REVISION not in heads else '(không có — đã ghi nhận)'}")

    if not missing and REVISION in heads:
        print("\nKhông có gì để làm.")
        return 0

    if not args.apply:
        print("\nĐây là bản xem trước. Thêm --apply để thực hiện.")
        return 0

    for table in missing:
        table.__table__.create(bind=engine)
        print(f"đã tạo bảng {table.__tablename__}")

    if REVISION not in heads:
        with engine.begin() as conn:
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:rev)"),
                {"rev": REVISION},
            )
        print(f"đã ghi {REVISION} vào alembic_version (giữ nguyên các head sẵn có)")

    print("\nXong. Giờ chạy đồng bộ ở Admin Site → Dữ liệu thị trường → Đồng bộ giá tất cả mã.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
