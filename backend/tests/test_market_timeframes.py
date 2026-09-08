"""Đồng bộ và đọc nến đa khung thời gian.

Cái được khoá ở đây là **hai chuỗi nến của cùng một mã phải kể cùng một câu chuyện**. Biểu đồ
sai theo kiểu này không bao giờ báo lỗi: nến 4 giờ vẫn có bốn giá, vẫn vẽ ra hình, chỉ là nó
không khớp với nến 1 giờ ngay bên cạnh — và người dùng đọc ra một cú đảo chiều không có thật.

Ba nhóm ràng buộc:

* **Gộp nến** — nến gộp phải mở bằng nến đầu ô, đóng bằng nến cuối ô, và neo vào mốc giờ Việt
  Nam chứ không phải giờ UTC.
* **Ô cũ nhất không đủ dữ liệu thì bỏ đi** — một cây nến tuần dựng từ hai phiên thay vì năm
  phiên trông hoàn toàn bình thường trên biểu đồ, và đó là lý do phải chặn nó ở đây.
* **Mẻ đồng bộ đếm theo cặp (mã, khung)** — gộp một mã tải xong 4/5 khung thành "một mã thành
  công" là giấu đi đúng cái khung đang hỏng.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test_timeframes.db")

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.datetime_utils import utcnow
from app.models import Base
from app.models.market import OhlcvBar, OhlcvDaily, Symbol, SymbolTimeframeSync
from app.services.market_data import bars as bars_store
from app.services.market_data import service
from app.services.market_data import timeframes as tfs
from app.services.market_data.base import Bar, MarketDataError


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    session.close()


def _vn(y, m, d, hh=0, mm=0) -> datetime:
    """Một mốc giờ Việt Nam, trả về UTC — cách người đọc bài test nghĩ về phiên giao dịch."""
    return datetime(y, m, d, hh, mm, tzinfo=settings.tz).astimezone(timezone.utc)


# ======================================================================
# Danh mục khung
# ======================================================================
def test_minute_and_month_are_told_apart_by_case():
    """`1m` là một phút, `1M` là một tháng — quy ước TradingView.

    Ai đó gọi `.upper()` cho tiện là biểu đồ một phút lặng lẽ trả về nến tháng.
    """
    assert tfs.get("1m").seconds == 60
    assert tfs.get("1M").seconds > 86_400
    assert tfs.normalize("M") == "1M"
    assert tfs.normalize("m1") == "1m"


def test_provider_resolutions_are_mapped_both_ways():
    """Khung của nhà cung cấp (`60`, `D`) và khung của hệ thống (`1h`, `1D`) là một."""
    assert tfs.normalize("60") == "1h"
    assert tfs.normalize("D") == tfs.DAILY
    assert tfs.get("1h").provider_resolution == "60"


def test_unsupported_timeframes_are_derived_not_fetched():
    """4 giờ, tuần và tháng **không** có ở nguồn — đã đo. Chúng phải là khung gộp."""
    for code in ("4h", "1W", "1M"):
        assert tfs.get(code).derived, code
        assert tfs.get(code).provider_resolution is None, code
    assert tfs.base_of("4h").code == "1h"
    assert tfs.base_of("1W").code == tfs.DAILY


def test_bad_timeframe_in_config_is_dropped_not_fatal():
    """`.env` viết sai không được làm backend chết lúc khởi động — mất cả scheduler."""
    assert tfs.parse_list("1m, ,xyz,1h") == ["1m", "1h"]
    assert tfs.parse_list("xyz", default=(tfs.DAILY,)) == [tfs.DAILY]


# ======================================================================
# Chia ô thời gian
# ======================================================================
def test_intraday_buckets_are_anchored_to_vietnam_midnight():
    """Neo theo UTC thì nến 4 giờ rơi vào 07:00 giờ Việt Nam — cắt ngang phiên sáng."""
    tf4 = tfs.get("4h")

    morning = tfs.bucket_start(_vn(2026, 9, 8, 9, 15), tf4).astimezone(settings.tz)
    afternoon = tfs.bucket_start(_vn(2026, 9, 8, 13, 30), tf4).astimezone(settings.tz)

    assert (morning.hour, morning.minute) == (8, 0)
    assert (afternoon.hour, afternoon.minute) == (12, 0)


def test_two_hour_buckets_split_a_session_into_four():
    tf2 = tfs.get("2h")
    hours = {
        tfs.bucket_start(_vn(2026, 9, 8, h, m), tf2).astimezone(settings.tz).hour
        for h, m in [(9, 15), (10, 30), (11, 20), (13, 5), (14, 40)]
    }
    assert hours == {8, 10, 12, 14}


def test_weekly_bucket_starts_on_monday():
    tfw = tfs.get("1W")
    # 2026-09-08 là thứ Ba; ô của nó phải bắt đầu ở thứ Hai 2026-09-07.
    start = tfs.bucket_start(_vn(2026, 9, 8, 10), tfw).astimezone(settings.tz)
    assert start.date() == date(2026, 9, 7)
    assert start.weekday() == 0


def test_monthly_bucket_starts_on_the_first():
    start = tfs.bucket_start(_vn(2026, 9, 23, 10), tfs.get("1M")).astimezone(settings.tz)
    assert start.date() == date(2026, 9, 1)


# ======================================================================
# Gộp nến
# ======================================================================
def _candle(ts: datetime, o, h, low, c, v=100) -> bars_store.Candle:
    return bars_store.Candle(
        time=ts,
        trade_date=ts.astimezone(settings.tz).date(),
        open=Decimal(str(o)), high=Decimal(str(h)),
        low=Decimal(str(low)), close=Decimal(str(c)), volume=v,
    )


def test_aggregate_takes_first_open_and_last_close():
    """Định nghĩa của một nến gộp. Lấy nhầm sang giá của nến khác thì hình vẫn vẽ ra được."""
    series = [
        _candle(_vn(2026, 9, 8, 9), 10, 12, 9, 11, v=100),
        _candle(_vn(2026, 9, 8, 10), 11, 15, 10, 14, v=200),
        _candle(_vn(2026, 9, 8, 11), 14, 16, 8, 13, v=300),
    ]
    merged = bars_store.aggregate(series, tfs.get("4h"))

    assert len(merged) == 1
    bar = merged[0]
    assert bar.open == Decimal("10")   # nến đầu ô
    assert bar.close == Decimal("13")  # nến cuối ô
    assert bar.high == Decimal("16")
    assert bar.low == Decimal("8")
    assert bar.volume == 600


def test_aggregate_splits_morning_and_afternoon_of_the_same_day():
    series = [
        _candle(_vn(2026, 9, 8, 9), 10, 12, 9, 11),
        _candle(_vn(2026, 9, 8, 13), 20, 22, 19, 21),
    ]
    merged = bars_store.aggregate(series, tfs.get("4h"))
    assert [float(b.open) for b in merged] == [10.0, 20.0]


def test_weekly_bar_is_labelled_with_a_real_trading_day():
    """Nhãn ô tuần lấy phiên đầu tiên có thật, không lấy thứ Hai suy ra từ mốc mở.

    Thứ Hai có thể là ngày nghỉ lễ, và một dòng "tuần bắt đầu 01/01" cho một ngày không có
    phiên nào là thứ người đọc bảng phải dừng lại để nghi ngờ.
    """
    # Tuần 07/09/2026 (thứ Hai) nhưng phiên đầu tiên có dữ liệu là thứ Ba 08/09.
    series = [
        _candle(_vn(2026, 9, 8), 10, 11, 9, 10),
        _candle(_vn(2026, 9, 9), 10, 13, 10, 12),
    ]
    merged = bars_store.aggregate(series, tfs.get("1W"))
    assert len(merged) == 1
    assert merged[0].trade_date == date(2026, 9, 8)
    assert merged[0].time.astimezone(settings.tz).date() == date(2026, 9, 7)


# ======================================================================
# Đọc: khung lưu và khung gộp
# ======================================================================
def _seed_daily(db, symbol: str, start: date, count: int) -> None:
    for i in range(count):
        d = start + timedelta(days=i)
        db.add(
            OhlcvDaily(
                symbol=symbol, trade_date=d,
                open=Decimal("10"), high=Decimal("11"), low=Decimal("9"),
                close=Decimal(str(10 + i)), volume=1_000, source="TEST",
            )
        )
    db.commit()


def test_daily_read_keeps_the_old_shape(db):
    """Khung ngày phải đi qua đúng bảng cũ — chiến lược và backtest đang đọc nó."""
    _seed_daily(db, "AAA", date(2026, 9, 1), 5)
    candles = bars_store.read_bars(db, "AAA", "1D", auto_fetch=False)

    assert len(candles) == 5
    assert candles[0].trade_date == date(2026, 9, 1)
    # Mốc của nến ngày là nửa đêm UTC — giữ nguyên quy ước cũ để biểu đồ không xê dịch.
    assert candles[0].time == datetime(2026, 9, 1, tzinfo=timezone.utc)


def test_weekly_is_derived_from_the_same_daily_rows(db):
    """Không có bảng nến tuần: nến tuần luôn khớp nến ngày vì nó *là* nến ngày gộp lại."""
    _seed_daily(db, "AAA", date(2026, 9, 7), 10)  # thứ Hai, hai tuần
    weekly = bars_store.read_bars(db, "AAA", "1W", auto_fetch=False)

    assert db.scalar(select(OhlcvBar).where(OhlcvBar.timeframe == "1W")) is None
    assert len(weekly) == 2
    assert weekly[0].volume == 7_000  # 7 phiên liên tiếp trong ô đầu


def test_oldest_incomplete_bucket_is_dropped(db):
    """Ô cũ nhất bị cắt mất phần đầu thì bỏ hẳn, không vẽ ra một cây nến thiếu dữ liệu."""
    _seed_daily(db, "AAA", date(2026, 9, 7), 21)  # ba tuần tròn

    full = bars_store.read_bars(db, "AAA", "1W", limit=10, auto_fetch=False)
    assert len(full) == 3

    # `limit=1` chỉ đọc đủ dòng cho một ô rưỡi — ô cũ nhất chắc chắn khuyết.
    cut = bars_store.read_bars(db, "AAA", "1W", limit=1, auto_fetch=False)
    assert len(cut) == 1
    assert cut[0].time == full[-1].time


def test_intraday_read_returns_stored_bars(db):
    for i in range(4):
        db.add(
            OhlcvBar(
                symbol="AAA", timeframe="1h",
                ts=_vn(2026, 9, 8, 9 + i).replace(tzinfo=None),
                open=Decimal("10"), high=Decimal("12"), low=Decimal("9"),
                close=Decimal("11"), volume=50, source="TEST",
            )
        )
    db.commit()

    candles = bars_store.read_bars(db, "AAA", "1h", auto_fetch=False)
    assert len(candles) == 4
    assert candles[0].time.astimezone(settings.tz).hour == 9
    # Ngày giao dịch của nến trong ngày tính theo giờ Việt Nam, không theo ngày UTC.
    assert candles[0].trade_date == date(2026, 9, 8)


def test_four_hour_is_built_from_stored_one_hour_bars(db):
    for i, close in enumerate([11, 12, 13, 14, 15]):
        db.add(
            OhlcvBar(
                symbol="AAA", timeframe="1h",
                ts=_vn(2026, 9, 8, 9 + i).replace(tzinfo=None),
                open=Decimal("10"), high=Decimal("20"), low=Decimal("5"),
                close=Decimal(str(close)), volume=10, source="TEST",
            )
        )
    db.commit()

    four = bars_store.read_bars(db, "AAA", "4h", auto_fetch=False)
    # 09,10,11 vào ô 08:00; 13 vào ô 12:00 (12:00 không có phiên nào ở đây).
    assert [c.time.astimezone(settings.tz).hour for c in four] == [8, 12]
    assert four[0].close == Decimal("13")


def test_before_scrolls_back_by_the_minute_not_by_the_day(db):
    """Một phiên có 285 nến 1 phút; lùi theo ngày thì mỗi lần cuộn nhảy qua cả phiên."""
    for i in range(6):
        db.add(
            OhlcvBar(
                symbol="AAA", timeframe="1h",
                ts=_vn(2026, 9, 8, 9).replace(tzinfo=None) + timedelta(hours=i),
                open=Decimal("10"), high=Decimal("11"), low=Decimal("9"),
                close=Decimal("10"), volume=1, source="TEST",
            )
        )
    db.commit()

    older = bars_store.read_bars(db, "AAA", "1h", before=_vn(2026, 9, 8, 11), auto_fetch=False)
    assert len(older) == 2
    assert older[-1].time.astimezone(settings.tz).hour == 10


# ======================================================================
# Đồng bộ
# ======================================================================
class _FakeProvider:
    """Nhà cung cấp giả nói được nhiều khung, giống các nguồn UDF thật."""

    name = "FAKE"
    supported_resolutions = frozenset({"1", "5", "15", "30", "60", "D"})

    def __init__(self, failing: set[str] | None = None, empty: set[str] | None = None) -> None:
        self.failing = failing or set()
        self.empty = empty or set()
        self.calls: list[tuple[str, str]] = []

    def get_ohlcv(self, symbol, date_from, date_to):
        return self.get_bars(
            symbol,
            datetime.combine(date_from, datetime.min.time(), tzinfo=timezone.utc),
            datetime.combine(date_to, datetime.max.time(), tzinfo=timezone.utc),
            "D",
        )

    def get_bars(self, symbol, start, end, resolution="D"):
        self.calls.append((symbol, resolution))
        if resolution not in self.supported_resolutions:
            raise MarketDataError(f"khung {resolution} không có")
        if symbol in self.failing:
            raise MarketDataError("nguồn từ chối")
        if symbol in self.empty:
            return []
        if resolution == "D":
            return [
                Bar(
                    trade_date=end.date() - timedelta(days=1),
                    open=Decimal("10"), high=Decimal("11"),
                    low=Decimal("9"), close=Decimal("10.5"), volume=1_000,
                )
            ]
        return [
            Bar(
                trade_date=(end - timedelta(hours=1)).astimezone(settings.tz).date(),
                open=Decimal("10"), high=Decimal("11"),
                low=Decimal("9"), close=Decimal("10.5"), volume=100,
                ts=(end - timedelta(hours=1)).replace(minute=0, second=0, microsecond=0),
            )
        ]


def _use(monkeypatch, provider) -> None:
    """Thay **cả hai** cửa lấy provider bằng nhà cung cấp giả.

    Có hai cửa chứ không một: nến ngày đi qua `get_provider`, nến trong ngày đi qua
    `get_intraday_provider` — vì hai loại nến có thể lấy từ hai nguồn khác nhau
    (`MARKET_INTRADAY_PROVIDER`). Vá thiếu một cửa thì bài test **lặng lẽ gọi ra Internet
    thật**: nó vẫn xanh, chỉ chậm đi và phụ thuộc vào việc nhà cung cấp có sống hay không.
    """
    monkeypatch.setattr(service, "get_provider", lambda: provider)
    monkeypatch.setattr(service, "get_intraday_provider", lambda: provider)
    monkeypatch.setattr(bars_store, "get_intraday_provider", lambda: provider)


def _seed_symbols(db, *codes: str) -> None:
    for code in codes:
        db.add(Symbol(symbol=code, exchange="HOSE", is_active=True))
    db.commit()


def test_batch_counts_every_symbol_timeframe_pair(db, monkeypatch):
    """Một mã tải xong 4/5 khung không phải là "một mã thành công"."""
    _seed_symbols(db, "AAA", "BBB")
    provider = _FakeProvider()
    _use(monkeypatch, provider)

    result = service.sync_ohlcv_batch(
        db, ["AAA", "BBB"], timeframes=["1D", "1h"], delay_seconds=0
    )

    assert result["total"] == 4
    assert result["processed"] == 4
    assert result["synced"] == 4
    assert result["timeframes"] == ["1h", "1D"]
    assert result["by_timeframe"]["1h"]["synced"] == 2
    assert {c[1] for c in provider.calls} == {"D", "60"}


def test_batch_ignores_derived_timeframes(db, monkeypatch):
    """Tích khung 4 giờ trên giao diện không được sinh ra lời gọi nào — nó là khung gộp."""
    _seed_symbols(db, "AAA")
    provider = _FakeProvider()
    _use(monkeypatch, provider)

    result = service.sync_ohlcv_batch(
        db, ["AAA"], timeframes=["4h", "1W", "1h"], delay_seconds=0
    )

    assert result["timeframes"] == ["1h"]
    assert provider.calls == [("AAA", "60")]


def test_batch_without_timeframes_behaves_exactly_as_before(db, monkeypatch):
    """Đường cũ không được đổi nghĩa: bỏ trống `timeframes` là chỉ nến ngày."""
    _seed_symbols(db, "AAA")
    provider = _FakeProvider()
    _use(monkeypatch, provider)

    result = service.sync_ohlcv_batch(db, ["AAA"], delay_seconds=0)

    assert result["total"] == 1
    assert provider.calls == [("AAA", "D")]
    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "AAA")) is not None


def test_intraday_sync_records_its_own_watermark(db, monkeypatch):
    """Mỗi cặp (mã, khung) có mốc riêng — khung 1 phút đứng từ hôm qua phải nhìn thấy được."""
    _seed_symbols(db, "AAA")
    provider = _FakeProvider()
    _use(monkeypatch, provider)

    service.sync_ohlcv_batch(db, ["AAA"], timeframes=["1h"], delay_seconds=0)

    state = db.scalar(
        select(SymbolTimeframeSync).where(
            SymbolTimeframeSync.symbol == "AAA", SymbolTimeframeSync.timeframe == "1h"
        )
    )
    assert state is not None
    assert state.last_ts is not None
    assert state.last_error is None


def test_empty_intraday_response_is_missing_data_not_a_failure(db, monkeypatch):
    """Mã ít thanh khoản không có nến 1 phút nào là chuyện thường.

    Đếm thành lỗi thì tỉ lệ hỏng của mẻ vọt lên và cảnh báo "nguồn đổi endpoint" réo mỗi ngày
    trong khi không có gì hỏng cả.
    """
    _seed_symbols(db, "AAA")
    provider = _FakeProvider(empty={"AAA"})
    _use(monkeypatch, provider)

    result = service.sync_ohlcv_batch(db, ["AAA"], timeframes=["1h"], delay_seconds=0)

    assert result["failed"] == 0
    assert result["skipped"] == 1


def test_failed_intraday_pair_keeps_the_error_on_its_own_row(db, monkeypatch):
    _seed_symbols(db, "AAA")
    provider = _FakeProvider(failing={"AAA"})
    _use(monkeypatch, provider)

    result = service.sync_ohlcv_batch(db, ["AAA"], timeframes=["1h"], delay_seconds=0)
    db.commit()

    assert result["failed"] == 1
    state = db.scalar(select(SymbolTimeframeSync).where(SymbolTimeframeSync.symbol == "AAA"))
    assert state is not None and "nguồn từ chối" in state.last_error


def test_resync_overwrites_the_bar_that_was_still_forming(db, monkeypatch):
    """Nến ghi lúc còn dở dang phải được sửa ở lần chạy sau, không nằm lại với giá đóng sai."""
    _seed_symbols(db, "AAA")
    ts = _vn(2026, 9, 8, 10)
    db.add(
        OhlcvBar(
            symbol="AAA", timeframe="1h", ts=ts.replace(tzinfo=None),
            open=Decimal("10"), high=Decimal("10"), low=Decimal("10"),
            close=Decimal("10"), volume=1, source="TEST",
        )
    )
    db.commit()

    bars_store.upsert_bars(
        db, "AAA", "1h",
        [Bar(trade_date=date(2026, 9, 8), open=Decimal("10"), high=Decimal("14"),
             low=Decimal("9"), close=Decimal("13"), volume=900, ts=ts)],
        "FAKE",
    )
    db.commit()

    rows = db.scalars(select(OhlcvBar).where(OhlcvBar.symbol == "AAA")).all()
    assert len(rows) == 1
    assert rows[0].close == Decimal("13")
    assert rows[0].volume == 900


def test_prune_only_touches_timeframes_past_their_retention(db):
    """Dọn nến quá hạn không được chạm vào khung ngày — lịch sử ngày phải giữ vĩnh viễn."""
    _seed_daily(db, "AAA", date(2020, 1, 1), 3)
    old = datetime.now(timezone.utc) - timedelta(days=400)
    fresh = datetime.now(timezone.utc) - timedelta(days=1)
    for ts in (old, fresh):
        db.add(
            OhlcvBar(
                symbol="AAA", timeframe="1m", ts=ts.replace(tzinfo=None),
                open=Decimal("10"), high=Decimal("11"), low=Decimal("9"),
                close=Decimal("10"), volume=1, source="TEST",
            )
        )
    db.commit()

    bars_store.prune(db)

    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "AAA")) is not None
    left = db.scalars(select(OhlcvBar).where(OhlcvBar.timeframe == "1m")).all()
    assert len(left) == 1
    assert left[0].ts.replace(tzinfo=timezone.utc) > old


def test_auto_fetch_is_throttled_when_the_source_has_nothing(db, monkeypatch):
    """Cặp (mã, khung) mà nguồn không có gì **không được** gọi lại ở mỗi lần mở biểu đồ.

    Không chặn thì lần nào cũng rỗng nên lần sau lại gọi tiếp: một mã ít thanh khoản nằm trong
    danh sách theo dõi của vài người là đủ để bị chặn IP, mà không có lỗi nào xuất hiện.
    """
    _seed_symbols(db, "AAA")
    provider = _FakeProvider(empty={"AAA"})
    _use(monkeypatch, provider)

    assert bars_store.read_bars(db, "AAA", "1h") == []
    assert bars_store.read_bars(db, "AAA", "1h") == []

    assert provider.calls == [("AAA", "60")]


def test_configured_lists_daily_plus_the_enabled_intraday_frames(monkeypatch):
    """`configured()` là nguồn duy nhất cho cả job hằng đêm lẫn hai nút chạy tay.

    Trước đây hai cái nút mặc định chỉ chạy nến ngày trong khi job chạy đủ khung: người vận hành
    bấm "Đồng bộ tất cả", thấy báo hoàn tất, rồi mở biểu đồ 1 giờ ra vẫn trống.
    """
    monkeypatch.setattr(settings, "market_intraday_timeframes", "1h,15m")
    assert tfs.configured() == ["15m", "1h", "1D"]

    # Tắt hết khung trong ngày thì quay về đúng hành vi cũ, không ném lỗi.
    monkeypatch.setattr(settings, "market_intraday_timeframes", "")
    assert tfs.configured() == [tfs.DAILY]


def test_sync_all_default_covers_every_enabled_frame(db, monkeypatch):
    """Bỏ trống `timeframes` ở đường chạy tay = đúng bộ khung mà job hằng đêm chạy."""
    _seed_symbols(db, "AAA")
    provider = _FakeProvider()
    _use(monkeypatch, provider)
    monkeypatch.setattr(settings, "market_intraday_timeframes", "5m,1h")

    result = service.sync_ohlcv_batch(
        db, ["AAA"], timeframes=tfs.configured(), delay_seconds=0
    )

    assert result["timeframes"] == ["5m", "1h", "1D"]
    assert sorted(c[1] for c in provider.calls) == ["5", "60", "D"]
    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "AAA")) is not None
    assert sorted(
        {r.timeframe for r in db.scalars(select(OhlcvBar).where(OhlcvBar.symbol == "AAA")).all()}
    ) == ["1h", "5m"]


def test_intraday_uses_its_own_provider_when_configured(db, monkeypatch):
    """Nến ngày và nến trong ngày có thể đến từ hai nguồn khác nhau, và phải đúng nguồn.

    Đây là chỗ vừa suýt hỏng lặng lẽ: mẻ đồng bộ dựng provider cho nến ngày rồi dùng luôn nó
    cho mọi khung. Lúc đó cấu hình `MARKET_INTRADAY_PROVIDER` không có tác dụng gì, mà cũng
    chẳng có lỗi nào — chỉ là khung 1 giờ lặng lẽ nông đi mấy chục lần.
    """
    _seed_symbols(db, "AAA")
    daily = _FakeProvider()
    intraday = _FakeProvider()
    intraday.name = "FAKE_INTRADAY"

    monkeypatch.setattr(service, "get_provider", lambda: daily)
    monkeypatch.setattr(service, "get_intraday_provider", lambda: intraday)
    monkeypatch.setattr(service, "intraday_provider_name", lambda: "FAKE_INTRADAY")

    service.sync_ohlcv_batch(db, ["AAA"], timeframes=["1D", "1h"], delay_seconds=0)

    assert daily.calls == [("AAA", "D")], "nến ngày phải đi qua nguồn chính"
    assert intraday.calls == [("AAA", "60")], "nến trong ngày phải đi qua nguồn riêng"


def test_provider_resolution_names_are_translated_per_source():
    """Entrade gọi khung giờ là `1H`; hỏi nó bằng `60` thì nhận mảng rỗng, không phải lỗi.

    Bảng đổi tên là thứ duy nhất chặn kiểu hỏng đó, nên nó phải được khoá lại ở đây.
    """
    from app.services.market_data.providers import EntradeProvider, VpsProvider

    assert EntradeProvider.RESOLUTION_MAP["60"] == "1H"
    assert EntradeProvider.RESOLUTION_MAP["D"] == "1D"
    # Nguồn nói đúng giao thức UDF thì không cần đổi tên gì cả.
    assert VpsProvider.RESOLUTION_MAP == {}


def test_entrade_reads_data_without_a_status_field():
    """Entrade không có trường `s` như hai nguồn kia — mảng rỗng nghĩa là không có nến."""
    from app.services.market_data.providers import EntradeProvider, VpsProvider

    entrade = EntradeProvider()
    assert entrade._has_data({"t": [1, 2]}, "FPT", "1H") is True
    assert entrade._has_data({"t": []}, "FPT", "1H") is False

    # Còn nguồn UDF thật thì vẫn phải đọc `s`, và trạng thái lạ vẫn phải ném lỗi.
    vps = VpsProvider()
    assert vps._has_data({"s": "ok", "t": [1]}, "FPT", "60") is True
    assert vps._has_data({"s": "no_data"}, "FPT", "60") is False
    with pytest.raises(MarketDataError):
        vps._has_data({"s": "error"}, "FPT", "60")


def test_changing_provider_refetches_the_whole_window(db, monkeypatch):
    """Đổi nguồn xong, lượt đồng bộ kế tiếp phải xin lại trọn cửa sổ chứ không bám mốc cũ.

    Đây là cái bẫy đã làm 147/150 mã đứng nguyên ở dữ liệu nguồn cũ: mốc `last_ts` nói "đã có
    tới hôm qua" nên mỗi lượt chỉ xin thêm vài nến cuối, và phần lịch sử sâu hơn của nguồn mới
    không bao giờ được hỏi tới. Không có lỗi nào — chỉ là biểu đồ vẫn nông y như cũ.
    """
    _seed_symbols(db, "AAA")
    tf = tfs.get("1h")

    # Nến cũ do nguồn CU ghi, kèm mốc đồng bộ mới tinh.
    old_ts = utcnow().replace(tzinfo=None) - timedelta(hours=2)
    db.add(
        OhlcvBar(
            symbol="AAA", timeframe="1h", ts=old_ts,
            open=Decimal("10"), high=Decimal("11"), low=Decimal("9"),
            close=Decimal("10"), volume=1, source="NGUON_CU",
        )
    )
    state = bars_store.sync_state(db, "AAA", "1h")
    state.last_ts = old_ts
    db.commit()

    asked: list[datetime] = []

    class _Recorder(_FakeProvider):
        name = "NGUON_MOI"

        def get_bars(self, symbol, start, end, resolution="D"):
            asked.append(start)
            return super().get_bars(symbol, start, end, resolution)

    provider = _Recorder()
    bars_store.sync_bars_with(provider, db, "AAA", tf)
    db.commit()

    # Xin trọn cửa sổ giữ lại của khung, không phải vài giờ quanh mốc cũ.
    window_days = (utcnow() - asked[0]).days
    assert window_days > 30, f"chỉ xin {window_days} ngày — vẫn đang bám mốc của nguồn cũ"

    # Lượt sau, nến mới nhất đã mang tên nguồn mới, nên quay lại đồng bộ tăng dần.
    asked.clear()
    bars_store.sync_bars_with(provider, db, "AAA", tf)
    assert (utcnow() - asked[0]).days < 2, "cùng nguồn thì phải đồng bộ tăng dần cho nhẹ"
