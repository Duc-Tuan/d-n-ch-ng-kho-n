"""Nạp danh mục mã hạt giống — `python -m app.scripts.sync_symbol_universe`

**Nguồn sự thật của danh mục theo dõi là bảng `symbols`, không phải file này.** Thêm/bớt/sửa mã
là việc làm hằng ngày ở Quản trị → *Dữ liệu thị trường → Danh mục mã*, và thao tác đó có audit
log lẫn tự tải giá về.

Script này chỉ dùng cho **lần dựng hệ thống đầu tiên**: đổ 150 mã khởi tạo ở
`app.data.symbol_universe` vào cơ sở dữ liệu. Mã đã có thì **bỏ qua, không đụng tới** — ngành,
tier và trạng thái của chúng do người quản trị đặt, ghi đè bằng nội dung file là xoá công sức đó.

    python -m app.scripts.sync_symbol_universe --dry-run   # xem trước, không ghi gì

`--prune` khôi phục hành vi cũ: **xoá** mọi mã ngoài file kèm giá lịch sử và liên kết chiến lược.
Chỉ dùng khi muốn ép danh mục về đúng file — nó xoá cả những mã quản trị viên vừa thêm trên giao
diện. Mã đang có tín hiệu (bảng `signals`) vẫn không bị xoá mà chỉ tắt cờ hoạt động: tín hiệu đã
phát ra là dữ liệu bất biến (BR-83x), xoá mã của nó đi thì lịch sử không tra cứu lại được.
"""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import session_scope
from app.data.symbol_universe import SYMBOL_UNIVERSE, UNIVERSE_SYMBOLS
from app.models.market import OhlcvDaily, Symbol
from app.models.strategy import Signal, StrategySymbol


def out(msg: str = "") -> None:
    print(msg, flush=True)


def _chunked(items: list[str], size: int = 500):
    """Chia nhỏ mệnh đề IN — vài nghìn tham số trong một câu lệnh dễ vượt giới hạn của MySQL."""
    for i in range(0, len(items), size):
        yield items[i : i + size]


def apply_universe(db: Session, *, dry_run: bool = False, prune: bool = False) -> dict:
    existing = {s.symbol: s for s in db.scalars(select(Symbol)).all()}

    # ---- 1. Thêm mã hạt giống còn thiếu -------------------------------
    # Chỉ THÊM. Mã đã có trong cơ sở dữ liệu không bị đụng tới: ngành, tier và trạng thái của
    # chúng do người quản trị đặt trên giao diện, ghi đè bằng nội dung file là xoá công sức đó.
    created = skipped = 0
    for spec in SYMBOL_UNIVERSE:
        if spec.symbol in existing:
            skipped += 1
            continue
        if not dry_run:
            db.add(
                Symbol(
                    symbol=spec.symbol,
                    # Sàn trong file danh mục chỉ là giá trị khởi tạo; lần `sync_symbols`
                    # kế tiếp sẽ ghi đè bằng sàn niêm yết thật từ nhà cung cấp.
                    exchange=spec.exchange,
                    industry=spec.industry,
                    tier=spec.tier,
                    is_active=True,
                )
            )
        created += 1

    # ---- 2. Xác định mã cần loại --------------------------------------
    if not prune:
        return {
            "created": created,
            "updated": skipped,
            "deleted": 0,
            "kept_inactive": [],
            "bars_deleted": 0,
            "links_deleted": 0,
        }

    obsolete = sorted(set(existing) - UNIVERSE_SYMBOLS)

    # Mã còn tín hiệu thì giữ lại danh mục để tra cứu, chỉ tắt cờ hoạt động.
    with_signals = set()
    for chunk in _chunked(obsolete):
        with_signals.update(
            db.scalars(select(Signal.symbol).where(Signal.symbol.in_(chunk)).distinct()).all()
        )

    deletable = [s for s in obsolete if s not in with_signals]
    kept_inactive = sorted(with_signals)

    # ---- 3. Xoá mã ngoài danh mục + dữ liệu đi kèm ---------------------
    bars_deleted = links_deleted = 0
    for chunk in _chunked(deletable):
        bars_deleted += int(
            db.scalar(select(func.count()).select_from(OhlcvDaily).where(
                OhlcvDaily.symbol.in_(chunk))) or 0
        )
        links_deleted += int(
            db.scalar(select(func.count()).select_from(StrategySymbol).where(
                StrategySymbol.symbol.in_(chunk))) or 0
        )
        if not dry_run:
            db.execute(OhlcvDaily.__table__.delete().where(OhlcvDaily.symbol.in_(chunk)))
            db.execute(StrategySymbol.__table__.delete().where(StrategySymbol.symbol.in_(chunk)))
            db.execute(Symbol.__table__.delete().where(Symbol.symbol.in_(chunk)))

    if not dry_run:
        for chunk in _chunked(kept_inactive):
            db.execute(StrategySymbol.__table__.delete().where(StrategySymbol.symbol.in_(chunk)))
            db.execute(
                Symbol.__table__.update()
                .where(Symbol.symbol.in_(chunk))
                .values(is_active=False)
            )
        db.flush()

    return {
        "created": created,
        "updated": updated,
        "deleted": len(deletable),
        "kept_inactive": kept_inactive,
        "bars_deleted": bars_deleted,
        "links_deleted": links_deleted,
    }


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Nạp danh mục mã hạt giống vào cơ sở dữ liệu")
    parser.add_argument(
        "--dry-run", action="store_true", help="Chỉ in ra những gì sẽ thay đổi, không ghi dữ liệu"
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="NGUY HIỂM: xoá mọi mã không có trong file, kể cả mã do quản trị viên thêm",
    )
    args = parser.parse_args()

    out(f"\nNạp {len(SYMBOL_UNIVERSE)} mã hạt giống" + (" — CHẠY KHÔ" if args.dry_run else ""))
    if args.prune:
        out("!! --prune: mã ngoài file SẼ BỊ XOÁ, kể cả mã do quản trị viên thêm trên giao diện")
    out("=" * 62)

    with session_scope() as db:
        before = db.scalar(select(func.count()).select_from(Symbol)) or 0
        result = apply_universe(db, dry_run=args.dry_run, prune=args.prune)

        if args.dry_run:
            db.rollback()

    out(f"  Mã trong hệ thống trước khi chạy : {before}")
    out(f"  Thêm mới                         : {result['created']}")
    out(f"  Đã có, giữ nguyên                : {result['updated']}")
    if args.prune:
        out(f"  Xoá khỏi danh mục                : {result['deleted']}")
        out(f"  Xoá nến giá kèm theo             : {result['bars_deleted']:,}")
        out(f"  Gỡ mã khỏi chiến lược            : {result['links_deleted']}")

        if result["kept_inactive"]:
            out(
                f"  Giữ lại (ngừng hoạt động) vì còn tín hiệu: "
                f"{', '.join(result['kept_inactive'])}"
            )

    out("=" * 62)
    if args.dry_run:
        out("Chạy khô — không có gì được ghi. Bỏ --dry-run để áp dụng thật.\n")
    else:
        out("Xong. Thêm/bớt mã hằng ngày làm ở Quản trị → Dữ liệu thị trường → Danh mục mã.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
