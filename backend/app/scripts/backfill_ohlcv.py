"""Nạp toàn bộ giá lịch sử cho danh mục mã — `python -m app.scripts.backfill_ohlcv`

Chạy **một lần** khi dựng hệ thống hoặc sau khi thêm mã mới vào danh mục. Việc cập nhật hằng
ngày do job `sync_market` lo, không cần chạy tay script này mỗi ngày.

Khác với job hằng ngày ở chỗ bỏ qua mốc `last_ohlcv_date` và kéo trọn khoảng lịch sử: một mã
đã có dữ liệu 30 ngày gần nhất vẫn được tải lại từ đầu để lấp khoảng trống phía trước.

    python -m app.scripts.backfill_ohlcv                  # toàn bộ danh mục
    python -m app.scripts.backfill_ohlcv --symbols HPG FPT
    python -m app.scripts.backfill_ohlcv --missing-only   # chỉ mã chưa có nến nào
    python -m app.scripts.backfill_ohlcv --years 5

Nguồn VPS có dữ liệu từ 2000-07-28 — phiên đầu tiên của thị trường chứng khoán Việt Nam. Mã
niêm yết sau mốc đó thì bắt đầu từ đúng ngày niêm yết. (Nguồn VNDIRECT chỉ có từ đầu 2013.)

Chạy chậm là **có chủ ý**: mỗi mã cách nhau `MARKET_SYNC_DELAY_SECONDS`. Bắn hàng trăm request
liên tiếp vào endpoint công khai là cách nhanh nhất để bị chặn IP, và khi đó cả hệ thống mất
nguồn giá chứ không riêng script này.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time

from sqlalchemy import func, select

from app.core.config import settings
from app.core.database import session_scope
from app.models.market import OhlcvDaily, Symbol
from app.services import market_data

#: Thị trường mở cửa 7/2000 — xin dư vài năm cho chắc, phần thừa nguồn tự bỏ qua.
DEFAULT_YEARS = 30


def out(msg: str = "") -> None:
    print(msg, flush=True)


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Nạp toàn bộ giá lịch sử cho danh mục mã")
    parser.add_argument("--symbols", nargs="*", help="Chỉ nạp các mã này (mặc định: cả danh mục)")
    parser.add_argument("--years", type=int, default=DEFAULT_YEARS, help="Số năm lịch sử")
    parser.add_argument(
        "--missing-only", action="store_true", help="Chỉ nạp mã chưa có nến nào trong cơ sở dữ liệu"
    )
    args = parser.parse_args()

    # Không có log thì script chạy im lặng hàng chục phút, không biết còn sống hay treo.
    logging.basicConfig(level=logging.INFO, format="  %(asctime)s  %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    with session_scope() as db:
        if args.symbols:
            wanted = [s.strip().upper() for s in args.symbols if s.strip()]
            known = set(db.scalars(select(Symbol.symbol).where(Symbol.symbol.in_(wanted))).all())
            unknown = [s for s in wanted if s not in known]
            if unknown:
                out(f"\n[LỖI] Không có trong danh mục: {', '.join(unknown)}")
                out("Thêm mã vào app/data/symbol_universe.py rồi chạy sync_symbol_universe trước.\n")
                return 1
            symbols = [s for s in wanted if s in known]
        else:
            symbols = list(
                db.scalars(
                    select(Symbol.symbol).where(Symbol.is_active.is_(True)).order_by(Symbol.symbol)
                ).all()
            )

        if args.missing_only:
            has_data = set(
                db.scalars(
                    select(OhlcvDaily.symbol).where(OhlcvDaily.symbol.in_(symbols)).distinct()
                ).all()
            )
            symbols = [s for s in symbols if s not in has_data]

    if not symbols:
        out("\nKhông có mã nào cần nạp.\n")
        return 0

    days = args.years * 365
    estimate = len(symbols) * (settings.market_sync_delay_seconds + 1.2) / 60

    out(f"\nNạp lịch sử {args.years} năm cho {len(symbols)} mã")
    out(f"Ước tính khoảng {estimate:.0f} phút — cứ 50 mã ghi một lần vào cơ sở dữ liệu.")
    out("=" * 62)

    started = time.monotonic()
    with session_scope() as db:
        result = market_data.sync_ohlcv_batch(
            db,
            symbols,
            days=days,
            delay_seconds=settings.market_sync_delay_seconds,
            force_full=True,
            progress_every=10,
        )

    with session_scope() as db:
        bars_total = db.scalar(select(func.count()).select_from(OhlcvDaily)) or 0
        oldest = db.scalar(select(func.min(OhlcvDaily.trade_date)))
        newest = db.scalar(select(func.max(OhlcvDaily.trade_date)))

    out("=" * 62)
    out(f"  Mã đã nạp        : {result['synced']}/{result['total']}")
    out(f"  Mã lỗi           : {result['failed']}")
    out(f"  Nến ghi lần này  : {result['rows_written']:,}")
    out(f"  Tổng nến trong DB: {bars_total:,}")
    out(f"  Khoảng thời gian : {oldest} → {newest}")
    out(f"  Thời gian chạy   : {(time.monotonic() - started) / 60:.1f} phút")
    out("=" * 62)
    if result["failed"]:
        out("Xem mã lỗi ở Quản trị → Dữ liệu thị trường → Nhật ký đồng bộ.")
    out()
    return 0


if __name__ == "__main__":
    sys.exit(main())
