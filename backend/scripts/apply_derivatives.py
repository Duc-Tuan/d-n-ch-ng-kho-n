# -*- coding: utf-8 -*-
"""Áp thay đổi của migration `deriv0001` mà **không cần alembic chạy được**.

Vì sao cần script này
---------------------
Bảng `alembic_version` của cơ sở dữ liệu đang chạy mang revision `0018` — thuộc nhánh tính năng
"brain" mà working tree hiện tại không còn mã nguồn (chỉ còn vài file `.pyc`). Alembic dựng đồ
thị revision từ thư mục `alembic/versions/`, không thấy `0018`, nên **mọi** lệnh alembic đều
dừng ngay ở `Can't locate revision identified by '0018'` — có hay không có migration mới cũng
vậy.

Script này đi đường vòng: áp đúng phần DDL mà `deriv0001` mô tả, rồi ghi nhận revision đó vào
`alembic_version`. Không đụng tới các dòng revision khác, nên khi nào nhánh brain được khôi
phục thì lịch sử vẫn còn nguyên để gộp lại.

Chạy **lại nhiều lần vẫn an toàn**: mọi bước đều kiểm tra trước khi làm. Đó là điều kiện bắt
buộc của một script vá tay — thứ người ta chạy khi đang bối rối và không nhớ đã chạy chưa.

Cách dùng
---------
    cd backend
    .venv/Scripts/python.exe scripts/apply_derivatives.py            # áp thật
    .venv/Scripts/python.exe scripts/apply_derivatives.py --dry-run  # chỉ xem sẽ làm gì

Đọc cấu hình kết nối từ `app.core.config` như mọi phần còn lại của hệ thống, nên không có tham
số máy chủ/mật khẩu nào để gõ sai.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Cho phép chạy thẳng `python scripts/apply_derivatives.py` từ thư mục `backend`.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import create_engine, text  # noqa: E402

from app.core.config import settings  # noqa: E402

REVISION = "deriv0001"

#: Giống hệt danh sách trong `alembic/versions/deriv0001_derivatives.py`. Hai chỗ phải khớp
#: nhau; đây là cái giá của việc có một đường đi vòng, và nó rẻ hơn hẳn một cơ sở dữ liệu không
#: khởi động nổi.
DERIVATIVES = [
    ("VN30F1M", "Hợp đồng tương lai VN30 — tháng gần nhất"),
    ("VN30F2M", "Hợp đồng tương lai VN30 — tháng kế tiếp"),
    ("VN30F1Q", "Hợp đồng tương lai VN30 — quý gần nhất"),
    ("VN30F2Q", "Hợp đồng tương lai VN30 — quý kế tiếp"),
]


def main() -> int:
    dry = "--dry-run" in sys.argv
    engine = create_engine(settings.database_url)
    done: list[str] = []
    skipped: list[str] = []

    with engine.begin() as conn:
        database = conn.execute(text("SELECT DATABASE()")).scalar()
        print(f"Cơ sở dữ liệu: {database}")
        print(f"Chế độ: {'CHỈ XEM (không ghi gì)' if dry else 'ÁP THẬT'}\n")

        def has_column(table: str, column: str) -> bool:
            return bool(
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM information_schema.columns "
                        "WHERE table_schema = DATABASE() AND table_name = :t "
                        "AND column_name = :c"
                    ),
                    {"t": table, "c": column},
                ).scalar()
            )

        def has_index(table: str, index: str) -> bool:
            return bool(
                conn.execute(
                    text(
                        "SELECT COUNT(*) FROM information_schema.statistics "
                        "WHERE table_schema = DATABASE() AND table_name = :t "
                        "AND index_name = :i"
                    ),
                    {"t": table, "i": index},
                ).scalar()
            )

        def step(label: str, sql: str) -> None:
            if dry:
                print(f"  SẼ LÀM: {label}")
            else:
                conn.execute(text(sql))
                print(f"  ĐÃ LÀM: {label}")
            done.append(label)

        # ---- 1. Cột asset_class ----------------------------------------------------
        print("1) Cột symbols.asset_class")
        if has_column("symbols", "asset_class"):
            print("  bỏ qua — đã có")
            skipped.append("cột asset_class")
        else:
            step(
                "thêm cột asset_class",
                "ALTER TABLE symbols ADD COLUMN asset_class VARCHAR(12) "
                "NOT NULL DEFAULT 'STOCK'",
            )

        # ---- 2. Chỉ mục ------------------------------------------------------------
        print("\n2) Chỉ mục")
        for name, cols in (
            ("ix_symbols_asset_class", "asset_class"),
            ("ix_symbol_asset_active", "asset_class, is_active"),
        ):
            if has_index("symbols", name):
                print(f"  bỏ qua {name} — đã có")
                skipped.append(f"chỉ mục {name}")
            elif dry and not has_column("symbols", "asset_class"):
                # Chưa có cột thì câu tạo chỉ mục chưa chạy được; ở chế độ xem thì chỉ báo.
                print(f"  SẼ LÀM: tạo {name} (sau khi cột được thêm)")
            else:
                step(f"tạo chỉ mục {name}", f"CREATE INDEX {name} ON symbols ({cols})")

        # ---- 3. Bốn hợp đồng --------------------------------------------------------
        print("\n3) Hợp đồng phái sinh")
        for code, name in DERIVATIVES:
            exists = conn.execute(
                text("SELECT COUNT(*) FROM symbols WHERE symbol = :s"), {"s": code}
            ).scalar()
            if exists:
                # Mã đã có (thêm tay từ trước) — chỉ gắn đúng loại tài sản, không đụng tên.
                if dry:
                    print(f"  SẼ LÀM: gắn {code} thành DERIVATIVE (mã đã tồn tại)")
                else:
                    if has_column("symbols", "asset_class"):
                        conn.execute(
                            text(
                                "UPDATE symbols SET asset_class = 'DERIVATIVE' WHERE symbol = :s"
                            ),
                            {"s": code},
                        )
                    print(f"  ĐÃ LÀM: gắn {code} thành DERIVATIVE")
                done.append(f"gắn {code}")
                continue

            if dry:
                print(f"  SẼ LÀM: nạp {code}")
                done.append(f"nạp {code}")
            else:
                conn.execute(
                    text(
                        "INSERT INTO symbols (symbol, exchange, asset_class, company_name, "
                        "is_active) VALUES (:s, 'HNX', 'DERIVATIVE', :n, 1)"
                    ),
                    {"s": code, "n": name},
                )
                print(f"  ĐÃ LÀM: nạp {code}")
                done.append(f"nạp {code}")

        # ---- 4. Ghi nhận revision ----------------------------------------------------
        print("\n4) Ghi nhận revision vào alembic_version")
        current = [r[0] for r in conn.execute(text("SELECT version_num FROM alembic_version"))]
        print(f"  đang có: {current}")
        if REVISION in current:
            print(f"  bỏ qua — {REVISION} đã được ghi nhận")
            skipped.append(f"revision {REVISION}")
        elif dry:
            print(f"  SẼ LÀM: thêm dòng {REVISION}")
            done.append(f"revision {REVISION}")
        else:
            # Thêm dòng chứ không thay dòng nào: các revision khác trong bảng thuộc nhánh
            # tính năng khác và phải giữ nguyên để sau này còn gộp lại được.
            conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:v)"), {"v": REVISION}
            )
            print(f"  ĐÃ LÀM: thêm dòng {REVISION}")
            done.append(f"revision {REVISION}")

    print("\n" + "=" * 60)
    print(f"Đã làm : {len(done)} việc")
    print(f"Bỏ qua : {len(skipped)} việc (đã đúng từ trước)")
    if dry:
        print("\nĐây là chế độ chỉ xem — chưa ghi gì. Bỏ --dry-run để áp thật.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
