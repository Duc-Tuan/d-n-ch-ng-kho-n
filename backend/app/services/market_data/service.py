"""Nghiệp vụ dữ liệu thị trường: đồng bộ, lưu tại chỗ, phục vụ biểu đồ và bảng giá.

BR-831 — cache theo chu kỳ dữ liệu: OHLCV cuối ngày chỉ cần làm mới một lần mỗi ngày.
BR-832 — luôn đọc từ cơ sở dữ liệu của mình, không gọi API bên ngoài ở đường đi của request.
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.core.datetime_utils import local_today, utcnow
from app.core.exceptions import NotFound, ValidationError
from app.models.market import MarketSyncLog, OhlcvDaily, Symbol
from app.services.market_data.base import Bar, MarketDataError, SymbolInfo
from app.services.market_data.providers import get_provider

log = logging.getLogger(__name__)

#: Số ngày lịch sử tải về lần đầu cho một mã.
DEFAULT_HISTORY_DAYS = 730


# ======================================================================
# Đồng bộ danh mục mã
# ======================================================================
def sync_symbols(db: Session) -> dict:
    """Làm mới thông tin niêm yết cho **những mã đã có trong bảng `symbols`**.

    Danh mục theo dõi là chính bảng `symbols` — thêm/bớt mã làm ở màn quản trị (*Dữ liệu thị
    trường → Danh mục mã*). `app.data.symbol_universe` chỉ còn là danh sách hạt giống cho lần
    dựng hệ thống đầu tiên, không còn quyền phủ quyết lên dữ liệu đang chạy.

    Hàm này **không tự thêm mã mới**: nhà cung cấp trả về cả nghìn mã của ba sàn, kéo hết vào là
    phá vỡ chủ đích chọn lọc của danh mục. Nó chỉ làm hai việc:

      * cập nhật sàn và tên doanh nghiệp cho mã đang theo dõi — thông tin này đổi theo thời gian
        (chuyển sàn, đổi tên công ty) và không ai muốn sửa tay;
      * đánh dấu `is_active=False` cho mã **biến mất khỏi toàn thị trường**, tức là huỷ niêm yết
        thật. Tắt cờ chứ không xoá: giá lịch sử và tín hiệu cũ vẫn phải tra cứu được.

    Ngành và tier **không** bị ghi đè — hai trường đó do bộ phận phân tích đặt trên giao diện,
    nhà cung cấp không biết gì về chúng.
    """
    provider = get_provider()
    try:
        listed = {i.symbol: i for i in provider.list_symbols()}
    finally:
        if hasattr(provider, "close"):
            provider.close()

    if not listed:
        # Nguồn lỗi trả rỗng mà vẫn chạy tiếp thì cả danh mục bị đánh dấu huỷ niêm yết.
        raise MarketDataError("Danh sách mã trả về rỗng — không cập nhật gì để tránh hỏng danh mục")

    watched = list(db.scalars(select(Symbol)).all())
    updated = relisted = delisted = 0

    for row in watched:
        info = listed.get(row.symbol)
        if info is None:
            if row.is_active:
                row.is_active = False
                delisted += 1
            continue

        row.exchange = info.exchange
        row.company_name = info.company_name or row.company_name
        row.company_name_en = info.company_name_en or row.company_name_en
        if not row.is_active:
            row.is_active = True
            relisted += 1
        updated += 1

    db.commit()
    log.info(
        "sync_symbols: %s cập nhật, %s niêm yết lại, %s ngừng niêm yết", updated, relisted, delisted
    )
    return {
        "created": 0,
        "updated": updated,
        "relisted": relisted,
        "delisted": delisted,
        "total": len(watched),
    }


def lookup_listing(symbol: str) -> SymbolInfo | None:
    """Tra một mã trên toàn thị trường. Trả về `None` nếu không niêm yết ở đâu cả.

    Dùng khi quản trị viên thêm mã mới: xác nhận mã có thật và lấy sàn cùng tên doanh nghiệp,
    thay vì bắt người nhập tự nhớ và tự gõ. Lỗi mạng cũng trả `None` — chưa xác minh được thì
    không cho thêm, an toàn hơn là tạo ra một mã không bao giờ có giá.
    """
    code = symbol.strip().upper()
    if not code:
        return None

    provider = get_provider()
    try:
        return next((i for i in provider.list_symbols() if i.symbol == code), None)
    except MarketDataError as exc:
        log.warning("Không tra được mã %s: %s", code, exc)
        return None
    finally:
        if hasattr(provider, "close"):
            provider.close()


def add_symbol(
    db: Session,
    symbol: str,
    *,
    industry: str | None = None,
    tier: str | None = None,
    exchange: str | None = None,
) -> Symbol:
    """Thêm một mã vào danh mục theo dõi. Trả về dòng vừa tạo (**chưa** commit).

    Mã được đối chiếu với nhà cung cấp trước khi ghi: gõ nhầm `FTP` thay vì `FPT` bị chặn ngay,
    thay vì tạo ra một dòng không bao giờ có giá và chỉ lộ ra ở cột "mã chậm dữ liệu" vài ngày
    sau. Việc tải giá lịch sử do nơi gọi lo — nó là lời gọi mạng dài, không thuộc transaction này.
    """
    code = symbol.strip().upper()
    if not code:
        raise ValidationError("Chưa nhập mã chứng khoán", {"field": "symbol"})

    if db.scalar(select(Symbol).where(Symbol.symbol == code)):
        raise ValidationError(f"Mã {code} đã có trong danh mục", {"field": "symbol"})

    listing = lookup_listing(code)
    if listing is None:
        raise ValidationError(
            f"Không tìm thấy mã {code} trên HOSE, HNX hay UPCOM. Kiểm tra lại chính tả.",
            {"field": "symbol"},
        )

    row = Symbol(
        symbol=code,
        exchange=exchange or listing.exchange,
        company_name=listing.company_name,
        company_name_en=listing.company_name_en,
        industry=industry,
        tier=tier,
        is_active=True,
    )
    db.add(row)
    db.flush()
    return row


def remove_symbol(db: Session, symbol: str) -> dict:
    """Gỡ một mã khỏi danh mục. Trả về `{deleted, bars, kept_reason}` (**chưa** commit).

    **Mã đã từng phát tín hiệu thì không xoá mà chỉ tắt theo dõi.** Tín hiệu đã gửi tới khách
    hàng là dữ liệu bất biến (BR-83x); xoá mã của nó đi thì màn tra cứu khiếu nại sẽ trống đúng
    lúc cần nhất. Ràng buộc nằm ở đây chứ không ở router, nên mọi đường gọi đều bị chặn như nhau.
    """
    from app.models.strategy import Signal, StrategySymbol

    code = symbol.strip().upper()
    row = db.scalar(select(Symbol).where(Symbol.symbol == code))
    if row is None:
        raise NotFound(f"Không có mã {code} trong danh mục", "SYMBOL_NOT_FOUND")

    bars = int(
        db.scalar(select(func.count()).select_from(OhlcvDaily).where(OhlcvDaily.symbol == code)) or 0
    )
    has_signals = db.scalar(select(Signal.id).where(Signal.symbol == code).limit(1)) is not None

    # Gỡ khỏi chiến lược trong cả hai trường hợp: mã không còn theo dõi thì không được sinh
    # tín hiệu mới, dù bản ghi của nó có được giữ lại để tra cứu hay không.
    db.execute(StrategySymbol.__table__.delete().where(StrategySymbol.symbol == code))

    if has_signals:
        row.is_active = False
        return {"deleted": False, "bars": bars, "kept_reason": "signals"}

    db.execute(OhlcvDaily.__table__.delete().where(OhlcvDaily.symbol == code))
    db.delete(row)
    return {"deleted": True, "bars": bars, "kept_reason": None}


# ======================================================================
# Đồng bộ giá
# ======================================================================
def _upsert_bars(db: Session, symbol: str, bars: list[Bar], source: str) -> int:
    """Ghi nến, bỏ qua bản ghi đã có (UNIQUE symbol+trade_date)."""
    if not bars:
        return 0

    rows = [
        {
            "symbol": symbol,
            "trade_date": b.trade_date,
            "open": b.open,
            "high": b.high,
            "low": b.low,
            "close": b.close,
            "volume": b.volume,
            "source": source,
        }
        for b in bars
    ]

    dialect = db.bind.dialect.name
    if dialect == "mysql":
        stmt = mysql_insert(OhlcvDaily).values(rows)
        # Nguồn có thể sửa lại dữ liệu quá khứ — cập nhật thay vì bỏ qua.
        stmt = stmt.on_duplicate_key_update(
            open=stmt.inserted.open, high=stmt.inserted.high,
            low=stmt.inserted.low, close=stmt.inserted.close,
            volume=stmt.inserted.volume,
        )
    elif dialect == "sqlite":
        stmt = sqlite_insert(OhlcvDaily).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "trade_date"],
            set_={
                "open": stmt.excluded.open, "high": stmt.excluded.high,
                "low": stmt.excluded.low, "close": stmt.excluded.close,
                "volume": stmt.excluded.volume,
            },
        )
    else:
        for row in rows:
            db.merge(OhlcvDaily(**row))
        db.flush()
        return len(rows)

    db.execute(stmt)
    db.flush()
    return len(rows)


def sync_ohlcv(
    db: Session,
    symbol: str,
    *,
    days: int = DEFAULT_HISTORY_DAYS,
    force_full: bool = False,
) -> int:
    """Tải giá cho một mã. Trả về số nến đã ghi.

    Mặc định chỉ tải phần thiếu kể từ lần đồng bộ gần nhất (đồng bộ tăng dần), tránh kéo lại
    hai năm dữ liệu mỗi ngày cho hàng nghìn mã.
    """
    symbol = symbol.strip().upper()
    row = db.scalar(select(Symbol).where(Symbol.symbol == symbol))
    today = local_today()

    date_from = today - timedelta(days=days)
    if not force_full and row and row.last_ohlcv_date:
        # Lùi lại vài phiên phòng khi nguồn điều chỉnh dữ liệu gần đây.
        date_from = max(date_from, row.last_ohlcv_date - timedelta(days=5))

    if date_from >= today:
        return 0

    provider = get_provider()
    try:
        bars = provider.get_ohlcv(symbol, date_from, today)
    finally:
        if hasattr(provider, "close"):
            provider.close()

    written = _upsert_bars(db, symbol, bars, provider.name)

    if row and bars:
        row.last_ohlcv_date = bars[-1].trade_date
        row.last_synced_at = utcnow()
    db.commit()
    return written


def sync_ohlcv_batch(
    db: Session,
    symbols: list[str],
    *,
    days: int = DEFAULT_HISTORY_DAYS,
    delay_seconds: float = 0.25,
    force_full: bool = False,
    progress_every: int = 50,
    on_progress: Callable[[dict], None] | None = None,
    should_stop: Callable[[], bool] | None = None,
) -> dict:
    """Đồng bộ nhiều mã. Một mã lỗi không được làm hỏng cả mẻ.

    `force_full` — bỏ qua mốc `last_ohlcv_date`, tải lại trọn `days` ngày. Dùng khi nạp lịch sử
    lần đầu cho một mã đã có ít dữ liệu: đồng bộ tăng dần sẽ chỉ lấy phần mới và để nguyên
    khoảng trống phía trước.

    `on_progress` — gọi trước và sau mỗi mã, kèm ảnh chụp các số đếm tích luỹ. Đây là thứ duy
    nhất cho biết một mẻ hơn nghìn mã đang chạy tới đâu: không có nó, người vận hành chỉ thấy
    một vòng quay không đáy suốt nửa tiếng và không phân biệt được "đang chạy" với "đã treo".

    `should_stop` — hỏi trước mỗi mã. Trả `True` thì dừng sạch: phần đã tải vẫn được ghi và mẻ
    vẫn có dòng nhật ký, chứ không biến mất như chưa từng chạy.
    """
    started = time.monotonic()
    today = local_today()
    provider = get_provider()

    total = len(symbols)
    processed = synced = failed = skipped = rows_written = 0
    anomalies: list[dict] = []
    stopped = False

    def report(symbol: str, index: int, *, error: str | None = None, done: bool = False) -> None:
        if on_progress is None:
            return
        try:
            on_progress(
                {
                    "symbol": symbol,
                    "index": index,
                    "total": total,
                    "processed": processed,
                    "synced": synced,
                    "failed": failed,
                    "skipped": skipped,
                    "rows_written": rows_written,
                    "error": error,
                    "done": done,
                }
            )
        except Exception:  # noqa: BLE001
            # Báo tiến độ hỏng thì mất phần hiển thị, không được làm hỏng cả mẻ dữ liệu.
            log.exception("Không báo được tiến độ đồng bộ")

    try:
        for index, raw in enumerate(symbols, start=1):
            if should_stop is not None and should_stop():
                stopped = True
                log.info("sync_ohlcv: dừng theo yêu cầu sau %s/%s mã", processed, total)
                break

            symbol = raw.strip().upper()
            report(symbol, index)

            row = db.scalar(select(Symbol).where(Symbol.symbol == symbol))

            date_from = today - timedelta(days=days)
            if not force_full and row and row.last_ohlcv_date:
                date_from = max(date_from, row.last_ohlcv_date - timedelta(days=5))
            if date_from >= today:
                processed += 1
                skipped += 1
                report(symbol, index, done=True)
                continue

            error: str | None = None
            try:
                bars = provider.get_ohlcv(symbol, date_from, today)
                if not bars:
                    error = "không có dữ liệu trả về"
                    anomalies.append({"symbol": symbol, "issue": error})
                    failed += 1
                else:
                    rows_written += _upsert_bars(db, symbol, bars, provider.name)
                    if row:
                        row.last_ohlcv_date = bars[-1].trade_date
                        row.last_synced_at = utcnow()
                    synced += 1

                    if synced % progress_every == 0:
                        db.commit()
                        log.info("sync_ohlcv: đã xong %s/%s mã", synced, total)

            except MarketDataError as exc:
                failed += 1
                error = str(exc)[:180]
                anomalies.append({"symbol": symbol, "issue": error})
                log.warning("sync_ohlcv %s lỗi: %s", symbol, exc)
            except Exception as exc:
                failed += 1
                error = f"{type(exc).__name__}: {exc}"[:180]
                anomalies.append({"symbol": symbol, "issue": error})
                log.exception("sync_ohlcv %s lỗi không mong đợi", symbol)

            processed += 1
            report(symbol, index, error=error, done=True)

            time.sleep(delay_seconds)
    finally:
        if hasattr(provider, "close"):
            provider.close()

    db.commit()

    # BR-835 — ghi nhật ký chất lượng dữ liệu để phát hiện bất thường sớm.
    db.add(
        MarketSyncLog(
            run_date=today,
            # Số mã **thật sự đã xử lý**, không phải số mã được yêu cầu: một mẻ bị dừng giữa
            # chừng mà ghi trọn danh sách thì nhật ký nói dối rằng cả nghìn mã đã chạy xong.
            symbols_total=processed,
            symbols_synced=synced,
            symbols_failed=failed,
            rows_written=rows_written,
            anomalies={"items": anomalies[:100], "count": len(anomalies)} if anomalies else None,
            duration_seconds=int(time.monotonic() - started),
        )
    )
    db.commit()

    return {
        "total": total,
        "processed": processed,
        "synced": synced,
        "failed": failed,
        "skipped": skipped,
        "rows_written": rows_written,
        "stopped": stopped,
        "duration_seconds": int(time.monotonic() - started),
    }


# ======================================================================
# Đọc dữ liệu phục vụ giao diện
# ======================================================================
def get_candles(
    db: Session,
    symbol: str,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = 500,
    auto_fetch: bool = True,
) -> list[OhlcvDaily]:
    """Lấy nến từ cơ sở dữ liệu.

    `auto_fetch` — nếu chưa có dữ liệu của mã này thì tải về ngay lần đầu, các lần sau đọc từ
    cơ sở dữ liệu. Giữ trải nghiệm mượt mà vẫn tôn trọng BR-832: chỉ tải một lần, không gọi
    API bên ngoài ở mọi request.
    """
    symbol = symbol.strip().upper()

    conditions = [OhlcvDaily.symbol == symbol]
    if date_from:
        conditions.append(OhlcvDaily.trade_date >= date_from)
    if date_to:
        conditions.append(OhlcvDaily.trade_date <= date_to)

    rows = db.scalars(
        select(OhlcvDaily)
        .where(and_(*conditions))
        .order_by(OhlcvDaily.trade_date.desc())
        .limit(limit)
    ).all()

    # Chỉ tự tải khi hỏi dữ liệu mới nhất. Hỏi một khoảng quá khứ mà rỗng nghĩa là mã đó
    # chưa niêm yết khi ấy — tải lại toàn bộ cũng không có thêm gì, chỉ tốn thời gian.
    if not rows and auto_fetch and not date_to:
        try:
            sync_ohlcv(db, symbol)
        except MarketDataError as exc:
            log.warning("Không tải được giá %s theo yêu cầu: %s", symbol, exc)
            return []
        rows = db.scalars(
            select(OhlcvDaily)
            .where(and_(*conditions))
            .order_by(OhlcvDaily.trade_date.desc())
            .limit(limit)
        ).all()

    return list(reversed(rows))


def search_symbols(
    db: Session, query: str | None = None, exchange: str | None = None, limit: int = 50
) -> list[Symbol]:
    stmt = select(Symbol).where(Symbol.is_active.is_(True))
    if exchange:
        stmt = stmt.where(Symbol.exchange == exchange.upper())
    if query:
        pattern = f"%{query.strip().upper()}%"
        stmt = stmt.where(
            or_(Symbol.symbol.like(pattern), func.upper(Symbol.company_name).like(pattern))
        )
        # Mã khớp chính xác lên đầu — người dùng gõ "HPG" muốn thấy HPG trước tiên.
        stmt = stmt.order_by(
            (Symbol.symbol == query.strip().upper()).desc(),
            Symbol.symbol.like(f"{query.strip().upper()}%").desc(),
            Symbol.symbol,
        )
    else:
        stmt = stmt.order_by(Symbol.symbol)

    return list(db.scalars(stmt.limit(limit)).all())


def list_symbol_codes(db: Session, exchange: str | None = None) -> list[str]:
    """Toàn bộ mã đang theo dõi, chỉ riêng cột mã.

    Tách khỏi `search_symbols` vì mục đích khác hẳn: dùng cho các nút chọn cả sàn hoặc cả danh
    mục, nên **không được giới hạn số dòng** — cắt bớt ở đây thì người dùng bấm "chọn tất cả" mà
    lặng lẽ nhận thiếu mã, và họ không có cách nào biết. Bù lại chỉ đọc một cột nên dù danh mục
    có hơn 1.500 mã thì phần dữ liệu trả về vẫn nhỏ hơn một lần tra cứu có kèm tên doanh nghiệp.
    """
    stmt = select(Symbol.symbol).where(Symbol.is_active.is_(True))
    if exchange:
        stmt = stmt.where(Symbol.exchange == exchange.upper())
    return list(db.scalars(stmt.order_by(Symbol.symbol)).all())


def get_price_board(
    db: Session, symbols: list[str] | None = None, exchange: str | None = None, limit: int = 50
) -> list[dict]:
    """Bảng giá: phiên gần nhất và phiên liền trước để tính thay đổi.

    Không phải giá realtime — mục 12.1 chấp nhận độ trễ cuối ngày ở giai đoạn này.
    """
    symbol_stmt = select(Symbol).where(Symbol.is_active.is_(True))
    if symbols:
        symbol_stmt = symbol_stmt.where(Symbol.symbol.in_([s.upper() for s in symbols]))
    elif exchange:
        symbol_stmt = symbol_stmt.where(Symbol.exchange == exchange.upper())
    symbol_list = list(db.scalars(symbol_stmt.order_by(Symbol.symbol).limit(limit)).all())

    if not symbol_list:
        return []

    codes = [s.symbol for s in symbol_list]
    rows = db.scalars(
        select(OhlcvDaily)
        .where(OhlcvDaily.symbol.in_(codes))
        .order_by(OhlcvDaily.symbol, OhlcvDaily.trade_date.desc())
    ).all()

    latest: dict[str, list[OhlcvDaily]] = {}
    for row in rows:
        bucket = latest.setdefault(row.symbol, [])
        if len(bucket) < 2:
            bucket.append(row)

    board: list[dict] = []
    for info in symbol_list:
        bars = latest.get(info.symbol) or []
        current = bars[0] if bars else None
        previous = bars[1] if len(bars) > 1 else None

        change = change_pct = None
        if current and previous and previous.close:
            change = current.close - previous.close
            change_pct = float(change / previous.close * 100)

        board.append(
            {
                "symbol": info.symbol,
                "exchange": info.exchange,
                "company_name": info.company_name,
                "trade_date": current.trade_date if current else None,
                "open": current.open if current else None,
                "high": current.high if current else None,
                "low": current.low if current else None,
                "close": current.close if current else None,
                "volume": current.volume if current else None,
                "reference": previous.close if previous else None,
                "change": change,
                "change_pct": round(change_pct, 2) if change_pct is not None else None,
                "has_data": current is not None,
            }
        )
    return board


def coverage_stats(db: Session) -> dict:
    """Đã có dữ liệu giá cho bao nhiêu mã — để màn quản trị biết tiến độ đồng bộ."""
    total = db.scalar(
        select(func.count()).select_from(Symbol).where(Symbol.is_active.is_(True))
    ) or 0
    with_data = db.scalar(
        select(func.count(func.distinct(OhlcvDaily.symbol)))
    ) or 0
    bars = db.scalar(select(func.count()).select_from(OhlcvDaily)) or 0
    latest = db.scalar(select(func.max(OhlcvDaily.trade_date)))

    return {
        "symbols_total": int(total),
        "symbols_with_data": int(with_data),
        "bars_total": int(bars),
        "latest_trade_date": latest,
        "coverage_pct": round(int(with_data) / int(total) * 100, 1) if total else 0,
    }
