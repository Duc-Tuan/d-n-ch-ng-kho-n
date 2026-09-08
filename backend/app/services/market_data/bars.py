"""Đọc và ghi nến ở mọi khung thời gian.

Một chỗ duy nhất trả lời câu "cho tôi chuỗi nến của mã X ở khung Y", bất kể khung đó nằm ở
`ohlcv_daily`, ở `ohlcv_bars`, hay không nằm ở đâu cả vì phải gộp ra lúc đọc. Nơi gọi — biểu
đồ khách hàng, màn quản trị, phân tích AI — không cần biết sự khác nhau đó, và **không được
biết**: mỗi chỗ tự quyết định lấy dữ liệu ở đâu là mỗi chỗ một cách gộp nến, rồi ba màn hình
cùng vẽ một mã ở cùng một khung mà ra ba hình khác nhau.

BR-832 vẫn nguyên: đường đi của request chỉ đọc cơ sở dữ liệu. Lời gọi ra nhà cung cấp duy nhất
ở đây là `sync_bars`, và nó chỉ chạy trong job nền hoặc lần đầu một mã chưa có gì.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import and_, delete, func, select
from sqlalchemy.dialects.mysql import insert as mysql_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.datetime_utils import utcnow
from app.models.market import OhlcvBar, OhlcvDaily, Symbol, SymbolTimeframeSync
from app.services.market_data import timeframes as tfs
from app.services.market_data.base import Bar, MarketDataError
from app.services.market_data.providers import get_intraday_provider
from app.services.market_data.timeframes import Timeframe

log = logging.getLogger(__name__)

#: Số nến cũ hơn mốc đã có được xin lại mỗi lần đồng bộ tăng dần.
#:
#: Không phải để phòng hờ chung chung mà để sửa **một nến cụ thể**: mẻ chạy lúc 10 giờ ghi lại
#: nến 1 giờ của 10:00 khi nó mới hình thành được vài phút. Không xin lại thì cây nến dở dang
#: đó nằm vĩnh viễn trong cơ sở dữ liệu với giá đóng cửa sai.
OVERLAP_BUCKETS = 3

#: Khoảng nghỉ tối thiểu giữa hai lần tự tải cùng một cặp (mã, khung) từ đường đi của request.
#:
#: Không có nó thì một cặp mà nguồn **thật sự không có dữ liệu** — mã ít thanh khoản ở khung 1
#: phút là trường hợp thường gặp — sẽ gọi ra nhà cung cấp ở **mỗi lần** ai đó mở biểu đồ: lần
#: nào cũng không có gì để ghi, nên lần sau vẫn thấy rỗng và lại gọi tiếp. Một mã như vậy nằm
#: trong danh sách theo dõi của vài người là đủ để bị chặn IP, mà không có lỗi nào xuất hiện.
AUTO_FETCH_COOLDOWN_SECONDS = 900


@dataclass(slots=True)
class Candle:
    """Một nến đã sẵn sàng cho giao diện, không phụ thuộc nó được lấy từ bảng nào.

    `time` là mốc **mở** nến ở UTC. Nến ngày dùng nửa đêm UTC của `trade_date` — giữ đúng quy
    ước cũ để biểu đồ ngày không xê dịch một pixel nào sau thay đổi này.
    """

    time: datetime
    trade_date: date
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int


# ======================================================================
# Ghi
# ======================================================================
def _rows_for(symbol: str, timeframe: str, bars: list[Bar], source: str) -> list[dict]:
    return [
        {
            "symbol": symbol,
            "timeframe": timeframe,
            # Cột `DATETIME` của MySQL không giữ múi giờ; bỏ tzinfo sau khi đã quy về UTC để
            # giá trị đọc lên không lệch 7 tiếng giữa MySQL và SQLite (BR-130).
            "ts": b.opened_at().astimezone(timezone.utc).replace(tzinfo=None),
            "open": b.open,
            "high": b.high,
            "low": b.low,
            "close": b.close,
            "volume": b.volume,
            "source": source,
        }
        for b in bars
    ]


def upsert_bars(db: Session, symbol: str, timeframe: str, bars: list[Bar], source: str) -> int:
    """Ghi nến vào `ohlcv_bars`, ghi đè bản ghi trùng `(symbol, timeframe, ts)`.

    Ghi đè chứ không bỏ qua: nến gần nhất gần như luôn được ghi lần đầu lúc còn dở dang, và
    lần đồng bộ sau mới mang về giá đóng cửa thật của nó.
    """
    if not bars:
        return 0

    rows = _rows_for(symbol, timeframe, bars, source)
    dialect = db.bind.dialect.name

    if dialect == "mysql":
        stmt = mysql_insert(OhlcvBar).values(rows)
        stmt = stmt.on_duplicate_key_update(
            open=stmt.inserted.open, high=stmt.inserted.high,
            low=stmt.inserted.low, close=stmt.inserted.close,
            volume=stmt.inserted.volume, source=stmt.inserted.source,
        )
    elif dialect == "sqlite":
        stmt = sqlite_insert(OhlcvBar).values(rows)
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "timeframe", "ts"],
            set_={
                "open": stmt.excluded.open, "high": stmt.excluded.high,
                "low": stmt.excluded.low, "close": stmt.excluded.close,
                "volume": stmt.excluded.volume, "source": stmt.excluded.source,
            },
        )
    else:
        for row in rows:
            db.merge(OhlcvBar(**row))
        db.flush()
        return len(rows)

    db.execute(stmt)
    db.flush()
    return len(rows)


def stored_source(db: Session, symbol: str, timeframe: str) -> str | None:
    """Nhà cung cấp đã ghi nến **mới nhất** của cặp (mã, khung). `None` nếu chưa có nến nào."""
    return db.scalar(
        select(OhlcvBar.source)
        .where(OhlcvBar.symbol == symbol, OhlcvBar.timeframe == timeframe)
        .order_by(OhlcvBar.ts.desc())
        .limit(1)
    )


def sync_state(db: Session, symbol: str, timeframe: str) -> SymbolTimeframeSync:
    """Dòng trạng thái của một cặp (mã, khung), tạo mới nếu chưa có."""
    row = db.scalar(
        select(SymbolTimeframeSync).where(
            SymbolTimeframeSync.symbol == symbol,
            SymbolTimeframeSync.timeframe == timeframe,
        )
    )
    if row is None:
        row = SymbolTimeframeSync(symbol=symbol, timeframe=timeframe)
        db.add(row)
        db.flush()
    return row


def sync_bars(
    db: Session,
    symbol: str,
    timeframe: str,
    *,
    days: int | None = None,
    force_full: bool = False,
) -> int:
    """Tải nến của một mã ở **một khung trong ngày**. Trả về số nến đã ghi (chưa commit).

    Khung ngày không đi qua đây — nó có đường riêng ở `service.sync_ohlcv`, ghi vào `ohlcv_daily`
    và cập nhật `symbols.last_ohlcv_date` mà chiến lược đang đọc.

    Không có vòng lặp chia nhỏ khoảng thời gian, và đó là chủ ý: nguồn chỉ phục vụ **một cửa sổ
    trượt** vài trăm nến gần đây, mọi khoảng trong quá khứ đều trả `no_data` (đã đo trên VPS ở
    cả 1m, 5m, 15m và 60m). Chia nhỏ ra chỉ tạo thêm hàng chục lời gọi rỗng và nguy cơ bị chặn.
    """
    tf = tfs.get(timeframe)
    if tf.derived:
        raise ValueError(
            f"Khung {tf.code} được gộp lúc đọc từ {tf.derive_from}, không đồng bộ riêng."
        )
    if tf.is_daily:
        from app.services.market_data.service import sync_ohlcv

        return sync_ohlcv(db, symbol, force_full=force_full)

    provider = get_intraday_provider()
    try:
        written = sync_bars_with(provider, db, symbol, tf, days=days, force_full=force_full)
    finally:
        if hasattr(provider, "close"):
            provider.close()
    return written


def sync_bars_with(
    provider,
    db: Session,
    symbol: str,
    tf: Timeframe,
    *,
    days: int | None = None,
    force_full: bool = False,
) -> int:
    """Như `sync_bars` nhưng dùng lại một provider có sẵn.

    Mẻ toàn danh mục là hàng nghìn lượt (mã × khung); dựng một provider — kèm một pool kết nối
    HTTP — cho mỗi lượt vừa chậm vừa là kiểu rò rỉ không để lại lỗi nào, chỉ có số socket mở
    tăng dần theo thời gian chạy.
    """
    symbol = symbol.strip().upper()
    state = sync_state(db, symbol, tf.code)
    now = utcnow()

    # Xin đúng bằng khoảng mình định giữ lại. Trước đây mọi khung đều xin chung một con số 60
    # ngày, và con số đó lặng lẽ trở thành trần thật sự: nguồn có ba năm nến 1 giờ mà hệ thống
    # chỉ bao giờ thấy hai tháng, không có lỗi nào, chỉ là biểu đồ 1 giờ nông hơn nó cần phải có.
    window = days or tf.retention_days or settings.market_intraday_history_days
    start = now - timedelta(days=window)

    # Chỉ bám vào mốc cũ khi nến đang có **đến từ chính nhà cung cấp này**.
    #
    # Đổi nguồn xong thì mốc cũ trở thành cái bẫy: nó nói "đã có dữ liệu tới hôm qua" nên mỗi
    # lượt đồng bộ chỉ xin thêm vài nến cuối, và phần lịch sử sâu hơn của nguồn mới **không bao
    # giờ được hỏi tới**. Không có lỗi nào, không có cảnh báo nào — chỉ là biểu đồ vẫn nông y
    # như cũ, và người vận hành bấm đồng bộ mãi mà không hiểu vì sao không có gì đổi.
    #
    # Khi nguồn đã đổi thì bỏ mốc, xin trọn cửa sổ một lượt. Lượt sau nến mới nhất đã mang tên
    # nguồn mới nên lại quay về đồng bộ tăng dần bình thường.
    same_source = stored_source(db, symbol, tf.code) in (None, provider.name)
    if not force_full and same_source and state.last_ts is not None:
        last = state.last_ts.replace(tzinfo=timezone.utc)
        start = max(start, last - timedelta(seconds=tf.seconds * OVERLAP_BUCKETS))

    try:
        bars = provider.get_bars(symbol, start, now, tf.provider_resolution)
    except Exception as exc:
        state.last_synced_at = now.replace(tzinfo=None)
        state.last_error = f"{type(exc).__name__}: {exc}"[:255]
        raise

    written = upsert_bars(db, symbol, tf.code, bars, provider.name)

    state.last_synced_at = now.replace(tzinfo=None)
    state.last_error = None
    if bars:
        state.last_ts = bars[-1].opened_at().astimezone(timezone.utc).replace(tzinfo=None)
    return written


# ======================================================================
# Đọc
# ======================================================================
def _as_candle(row: OhlcvDaily | OhlcvBar) -> Candle:
    if isinstance(row, OhlcvDaily):
        return Candle(
            time=datetime.combine(row.trade_date, datetime.min.time(), tzinfo=timezone.utc),
            trade_date=row.trade_date,
            open=row.open, high=row.high, low=row.low, close=row.close,
            volume=row.volume,
        )
    ts = row.ts.replace(tzinfo=timezone.utc)
    return Candle(
        time=ts,
        trade_date=ts.astimezone(settings.tz).date(),
        open=row.open, high=row.high, low=row.low, close=row.close,
        volume=row.volume,
    )


def _read_stored(
    db: Session,
    symbol: str,
    tf: Timeframe,
    *,
    start: datetime | None,
    end: datetime | None,
    limit: int,
    end_exclusive: bool = False,
) -> list[Candle]:
    """`limit` nến gần nhất trong khoảng, đọc thẳng từ bảng lưu. Trả về theo thứ tự tăng dần.

    `end_exclusive` phân biệt hai câu hỏi khác hẳn nhau mà cùng dùng một biến trên:

    * `date_to` — "tới hết ngày này", **bao gồm** nến cuối ngày đó.
    * `before` — "những nến mở **trước** mốc này", tức là loại trừ. Đây là đường cuộn ngược của
      biểu đồ: tính bao gồm thì mỗi lần cuộn trả lại đúng cây nến ở mép mà giao diện đã có, và
      vòng lặp "tải thêm rồi thấy không có gì mới" khiến biểu đồ dừng sớm hơn hết lịch sử thật.
    """
    if tf.is_daily:
        conditions = [OhlcvDaily.symbol == symbol]
        if start:
            conditions.append(OhlcvDaily.trade_date >= start.astimezone(settings.tz).date())
        if end:
            edge = end.astimezone(settings.tz).date()
            conditions.append(
                OhlcvDaily.trade_date < edge if end_exclusive else OhlcvDaily.trade_date <= edge
            )
        rows = db.scalars(
            select(OhlcvDaily)
            .where(and_(*conditions))
            .order_by(OhlcvDaily.trade_date.desc())
            .limit(limit)
        ).all()
    else:
        conditions = [OhlcvBar.symbol == symbol, OhlcvBar.timeframe == tf.code]
        if start:
            conditions.append(OhlcvBar.ts >= start.astimezone(timezone.utc).replace(tzinfo=None))
        if end:
            edge = end.astimezone(timezone.utc).replace(tzinfo=None)
            conditions.append(OhlcvBar.ts < edge if end_exclusive else OhlcvBar.ts <= edge)
        rows = db.scalars(
            select(OhlcvBar)
            .where(and_(*conditions))
            .order_by(OhlcvBar.ts.desc())
            .limit(limit)
        ).all()

    return [_as_candle(r) for r in reversed(rows)]


def aggregate(candles: list[Candle], tf: Timeframe) -> list[Candle]:
    """Gộp chuỗi nến (tăng dần) thành khung `tf`.

    Mở lấy nến đầu ô, đóng lấy nến cuối ô, cao/thấp lấy biên, khối lượng cộng dồn — đúng định
    nghĩa mà mọi phần mềm biểu đồ dùng, nên nến 4 giờ ở đây khớp với nến 4 giờ ở TradingView.

    `trade_date` lấy của nến **đầu ô** chứ không suy từ mốc mở: ô tuần bắt đầu ở thứ Hai, mà thứ
    Hai có thể là ngày nghỉ lễ — nhãn "tuần bắt đầu 01/01" cho một ngày không có phiên nào là
    thứ người đọc bảng sẽ phải dừng lại để nghi ngờ.
    """
    if not candles:
        return []

    out: list[Candle] = []
    current: Candle | None = None
    current_bucket: datetime | None = None

    for c in candles:
        bucket = tfs.bucket_start(c.time, tf)
        if current is None or bucket != current_bucket:
            if current is not None:
                out.append(current)
            current_bucket = bucket
            current = Candle(
                time=bucket,
                trade_date=c.trade_date,
                open=c.open, high=c.high, low=c.low, close=c.close,
                volume=c.volume,
            )
            continue

        current.high = max(current.high, c.high)
        current.low = min(current.low, c.low)
        current.close = c.close
        current.volume += c.volume

    if current is not None:
        out.append(current)
    return out


def read_bars(
    db: Session,
    symbol: str,
    timeframe: str = tfs.DAILY,
    *,
    date_from: date | None = None,
    date_to: date | None = None,
    before: datetime | None = None,
    limit: int = 400,
    auto_fetch: bool = True,
) -> list[Candle]:
    """Chuỗi nến của một mã ở một khung, mới nhất ở cuối.

    `before` — chỉ lấy nến **mở trước** mốc này. Đây là đường cuộn ngược của biểu đồ, và nó phải
    nhận `datetime` chứ không phải `date`: một phiên có 285 nến 1 phút, lùi theo ngày thì mỗi
    lần cuộn nhảy qua cả phiên và người dùng không bao giờ xem được đoạn giữa.
    """
    symbol = symbol.strip().upper()
    tf = tfs.get(timeframe)
    base = tfs.base_of(tf.code)

    start = _day_start(date_from) if date_from else None
    end = before or (_day_end(date_to) if date_to else None)
    end_exclusive = before is not None

    if tf.derived:
        # Đọc dư một ô: ô cũ nhất gần như luôn bị cắt mất phần đầu, và một cây nến tuần dựng từ
        # hai phiên thay vì năm phiên trông vẫn hoàn toàn bình thường trên biểu đồ.
        need = limit * tfs.bars_per_bucket(tf) + tfs.bars_per_bucket(tf)
        rows = _read_stored(
            db, symbol, base, start=start, end=end, limit=need, end_exclusive=end_exclusive
        )
        truncated = len(rows) >= need
        candles = aggregate(rows, tf)
        # Ô cũ nhất chỉ đáng tin khi ta chắc đã đọc tới đầu chuỗi.
        if truncated and candles:
            candles = candles[1:]
        return candles[-limit:]

    candles = _read_stored(
        db, symbol, base, start=start, end=end, limit=limit, end_exclusive=end_exclusive
    )

    # Chỉ tự tải khi hỏi dữ liệu **mới nhất** và chưa có gì. Hỏi một khoảng quá khứ mà rỗng
    # nghĩa là khoảng đó nằm ngoài cửa sổ nguồn phục vụ — gọi lại cũng chỉ nhận `no_data`.
    if not candles and auto_fetch and end is None and _may_auto_fetch(db, symbol, base.code):
        try:
            sync_bars(db, symbol, base.code)
            # Đóng dấu cả khi khung ngày đi đường riêng: dấu này là thứ duy nhất chặn lượt gọi
            # tiếp theo nếu nguồn vừa trả về rỗng.
            sync_state(db, symbol, base.code).last_synced_at = utcnow().replace(tzinfo=None)
            db.commit()
        except (MarketDataError, ValueError) as exc:
            log.warning("Không tải được nến %s của %s theo yêu cầu: %s", base.code, symbol, exc)
            db.rollback()
            return []
        candles = _read_stored(
            db, symbol, base, start=start, end=end, limit=limit, end_exclusive=end_exclusive
        )

    return candles


def _may_auto_fetch(db: Session, symbol: str, timeframe: str) -> bool:
    """Đã đủ lâu kể từ lần tự tải gần nhất chưa. Xem `AUTO_FETCH_COOLDOWN_SECONDS`."""
    state = db.scalar(
        select(SymbolTimeframeSync).where(
            SymbolTimeframeSync.symbol == symbol,
            SymbolTimeframeSync.timeframe == timeframe,
        )
    )
    if state is None or state.last_synced_at is None:
        return True
    last = state.last_synced_at.replace(tzinfo=timezone.utc)
    return (utcnow() - last).total_seconds() >= AUTO_FETCH_COOLDOWN_SECONDS


def _day_start(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time(), tzinfo=settings.tz).astimezone(timezone.utc)


def _day_end(d: date) -> datetime:
    return datetime.combine(d, datetime.max.time(), tzinfo=settings.tz).astimezone(timezone.utc)


# ======================================================================
# Vận hành: độ phủ và dọn dữ liệu quá hạn
# ======================================================================
def coverage(db: Session) -> list[dict]:
    """Số nến, số mã và mốc mới nhất của **từng khung** — cho màn Dữ liệu thị trường.

    Khung suy ra vẫn có một dòng, nhưng số của nó là số của khung gốc kèm cờ `derived`: nói
    "khung 4 giờ: 0 nến" thì đúng về mặt bảng lưu và sai hoàn toàn về mặt người vận hành đang
    hỏi "biểu đồ 4 giờ có chạy được không".
    """
    daily_bars = int(db.scalar(select(func.count()).select_from(OhlcvDaily)) or 0)
    daily_symbols = int(db.scalar(select(func.count(func.distinct(OhlcvDaily.symbol)))) or 0)
    daily_latest = db.scalar(select(func.max(OhlcvDaily.trade_date)))

    stored: dict[str, dict] = {
        tfs.DAILY: {
            "bars": daily_bars,
            "symbols": daily_symbols,
            "latest": (
                datetime.combine(daily_latest, datetime.min.time(), tzinfo=timezone.utc)
                if daily_latest
                else None
            ),
            "oldest": None,
        }
    }
    oldest_daily = db.scalar(select(func.min(OhlcvDaily.trade_date)))
    if oldest_daily:
        stored[tfs.DAILY]["oldest"] = datetime.combine(
            oldest_daily, datetime.min.time(), tzinfo=timezone.utc
        )

    for row in db.execute(
        select(
            OhlcvBar.timeframe,
            func.count().label("bars"),
            func.count(func.distinct(OhlcvBar.symbol)).label("symbols"),
            func.min(OhlcvBar.ts).label("oldest"),
            func.max(OhlcvBar.ts).label("latest"),
        ).group_by(OhlcvBar.timeframe)
    ).all():
        stored[row.timeframe] = {
            "bars": int(row.bars),
            "symbols": int(row.symbols),
            "oldest": row.oldest.replace(tzinfo=timezone.utc) if row.oldest else None,
            "latest": row.latest.replace(tzinfo=timezone.utc) if row.latest else None,
        }

    enabled = set(tfs.parse_list(settings.market_intraday_timeframes)) | {tfs.DAILY}

    out: list[dict] = []
    for code, tf in tfs.TIMEFRAMES.items():
        source = stored.get(tfs.base_of(code).code, {})
        out.append(
            {
                **tf.as_dict(),
                "bars": source.get("bars", 0),
                "symbols": source.get("symbols", 0),
                "oldest": source.get("oldest"),
                "latest": source.get("latest"),
                #: Khung suy ra không có gì để bật/tắt — nó chạy được ngay khi khung gốc có dữ liệu.
                "sync_enabled": tf.derived or code in enabled,
            }
        )
    return out


def prune(db: Session) -> dict:
    """Xoá nến trong ngày quá hạn giữ theo `Timeframe.retention_days`. Trả về số dòng mỗi khung.

    Chạy trong job `cleanup` hằng đêm nên mỗi lượt chỉ chạm một ngày dữ liệu — trừ lần đầu sau
    khi ai đó siết `retention_days` lại, lượt đó sẽ nặng đúng một lần.
    """
    if not settings.market_bar_retention_enabled:
        return {"enabled": False, "deleted": {}}

    now = utcnow()
    deleted: dict[str, int] = {}
    for code in tfs.STORED_INTRADAY:
        tf = tfs.TIMEFRAMES[code]
        if not tf.retention_days:
            continue
        cutoff = (now - timedelta(days=tf.retention_days)).replace(tzinfo=None)
        result = db.execute(
            delete(OhlcvBar).where(OhlcvBar.timeframe == code, OhlcvBar.ts < cutoff)
        )
        if result.rowcount:
            deleted[code] = int(result.rowcount)
    db.commit()

    if deleted:
        log.info("Đã dọn nến quá hạn: %s", deleted)
    return {"enabled": True, "deleted": deleted}


def symbol_timeframe_status(db: Session, symbols: list[str]) -> dict[str, dict[str, dict]]:
    """Mốc đồng bộ của từng khung cho một nhóm mã — dùng ở bảng danh mục màn quản trị."""
    if not symbols:
        return {}

    rows = db.scalars(
        select(SymbolTimeframeSync).where(SymbolTimeframeSync.symbol.in_(symbols))
    ).all()

    out: dict[str, dict[str, dict]] = {}
    for row in rows:
        out.setdefault(row.symbol, {})[row.timeframe] = {
            "last_ts": row.last_ts.replace(tzinfo=timezone.utc) if row.last_ts else None,
            "last_synced_at": (
                row.last_synced_at.replace(tzinfo=timezone.utc) if row.last_synced_at else None
            ),
            "last_error": row.last_error,
        }
    return out


def active_symbol_codes(db: Session) -> list[str]:
    """Mã đang theo dõi — dùng chung cho các mẻ đồng bộ đa khung."""
    return list(
        db.scalars(
            select(Symbol.symbol).where(Symbol.is_active.is_(True)).order_by(Symbol.symbol)
        ).all()
    )
