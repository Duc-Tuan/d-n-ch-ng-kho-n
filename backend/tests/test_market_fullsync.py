"""Đồng bộ giá toàn danh mục có báo tiến độ — nút "Đồng bộ tất cả" ở màn Dữ liệu thị trường.

Cái được khoá ở đây không phải là "có tải được giá không" — mà là **người vận hành có nhìn thấy
mẻ đang chạy tới đâu không**, và **bấm Dừng thì có dừng thật không**. Hai điều đó hỏng lặng lẽ:
giao diện vẫn vẽ một thanh tiến độ, chỉ là nó đứng im, và không ai phân biệt được với một mẻ đã
treo giữa chừng.
"""

from __future__ import annotations

import os
from datetime import date, timedelta
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test_fullsync.db")

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.models import Base
from app.models.market import MarketSyncLog, OhlcvDaily, Symbol
from app.services.market_data import service
from app.services.market_data.base import Bar, MarketDataError


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    session.close()


class _FakeProvider:
    """Nhà cung cấp giả — trả một nến hợp lệ, hoặc ném lỗi cho những mã được chỉ định."""

    name = "FAKE"

    def __init__(self, failing: set[str] | None = None, empty: set[str] | None = None) -> None:
        self.failing = failing or set()
        self.empty = empty or set()
        self.calls: list[str] = []

    def get_ohlcv(self, symbol: str, date_from: date, date_to: date) -> list[Bar]:
        self.calls.append(symbol)
        if symbol in self.failing:
            raise MarketDataError("nguồn từ chối")
        if symbol in self.empty:
            return []
        return [
            Bar(
                trade_date=date_to - timedelta(days=1),
                open=Decimal("10"),
                high=Decimal("11"),
                low=Decimal("9"),
                close=Decimal("10.5"),
                volume=1000,
            )
        ]


def _seed(db, *codes: str) -> None:
    for code in codes:
        db.add(Symbol(symbol=code, exchange="HOSE", is_active=True))
    db.commit()


def _use(monkeypatch, provider: _FakeProvider) -> None:
    monkeypatch.setattr(service, "get_provider", lambda: provider)


# ======================================================================
# Báo tiến độ
# ======================================================================
def test_progress_reports_every_symbol(db, monkeypatch):
    """Mỗi mã phải để lại dấu vết — nếu không, thanh tiến độ nhảy từ 0 lên 100."""
    _seed(db, "AAA", "BBB", "CCC")
    _use(monkeypatch, _FakeProvider())

    events: list[dict] = []
    result = service.sync_ohlcv_batch(
        db, ["AAA", "BBB", "CCC"], days=30, delay_seconds=0, on_progress=events.append
    )

    assert result["processed"] == 3
    assert result["synced"] == 3
    assert [e["symbol"] for e in events if e["done"]] == ["AAA", "BBB", "CCC"]

    # Số đếm chỉ được tăng, không bao giờ lùi: một thanh tiến độ chạy giật lùi làm người xem
    # mất hẳn niềm tin vào con số đang nhìn.
    processed = [e["processed"] for e in events]
    assert processed == sorted(processed)
    assert events[-1]["processed"] == 3
    assert events[-1]["total"] == 3


def test_progress_carries_error_of_failed_symbol(db, monkeypatch):
    """Mã lỗi phải nói rõ lỗi gì ngay trên màn hình, không chỉ tăng một con số đếm."""
    _seed(db, "AAA", "BBB")
    _use(monkeypatch, _FakeProvider(failing={"BBB"}))

    events: list[dict] = []
    result = service.sync_ohlcv_batch(
        db, ["AAA", "BBB"], days=30, delay_seconds=0, on_progress=events.append
    )

    assert result["synced"] == 1
    assert result["failed"] == 1
    errors = [e for e in events if e.get("error")]
    assert len(errors) == 1
    assert errors[0]["symbol"] == "BBB"
    assert "nguồn từ chối" in errors[0]["error"]


def test_broken_progress_callback_does_not_break_the_batch(db, monkeypatch):
    """Phần hiển thị hỏng thì mất phần hiển thị — không được kéo theo cả mẻ dữ liệu."""
    _seed(db, "AAA")
    _use(monkeypatch, _FakeProvider())

    def explode(_event: dict) -> None:
        raise RuntimeError("giao diện hỏng")

    result = service.sync_ohlcv_batch(
        db, ["AAA"], days=30, delay_seconds=0, on_progress=explode
    )
    assert result["synced"] == 1
    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "AAA")) is not None


# ======================================================================
# Dừng giữa chừng
# ======================================================================
def test_stop_halts_batch_and_keeps_what_was_downloaded(db, monkeypatch):
    """Bấm Dừng phải dừng thật, và phần đã tải phải còn nguyên."""
    _seed(db, "AAA", "BBB", "CCC")
    provider = _FakeProvider()
    _use(monkeypatch, provider)

    stop_after = 2
    processed: list[str] = []

    def on_progress(event: dict) -> None:
        if event["done"]:
            processed.append(event["symbol"])

    result = service.sync_ohlcv_batch(
        db,
        ["AAA", "BBB", "CCC"],
        days=30,
        delay_seconds=0,
        on_progress=on_progress,
        should_stop=lambda: len(processed) >= stop_after,
    )

    assert result["stopped"] is True
    assert result["processed"] == 2
    assert provider.calls == ["AAA", "BBB"]  # CCC không bao giờ được gọi
    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "AAA")) is not None
    assert db.scalar(select(OhlcvDaily).where(OhlcvDaily.symbol == "CCC")) is None


def test_stopped_batch_still_writes_a_log_row(db, monkeypatch):
    """BR-835 — một mẻ đã chạy phải để lại vết, kể cả khi bị dừng.

    Và số mã trong nhật ký là số **thật sự đã xử lý**: ghi trọn danh sách yêu cầu thì dòng nhật
    ký nói dối rằng cả nghìn mã đã chạy xong.
    """
    _seed(db, "AAA", "BBB", "CCC")
    _use(monkeypatch, _FakeProvider())

    service.sync_ohlcv_batch(
        db,
        ["AAA", "BBB", "CCC"],
        days=30,
        delay_seconds=0,
        should_stop=lambda: True,
    )

    log_row = db.scalar(select(MarketSyncLog).order_by(MarketSyncLog.id.desc()))
    assert log_row is not None
    assert log_row.symbols_total == 0

    service.sync_ohlcv_batch(db, ["AAA", "BBB"], days=30, delay_seconds=0)
    log_row = db.scalar(select(MarketSyncLog).order_by(MarketSyncLog.id.desc()))
    assert log_row.symbols_total == 2
    assert log_row.symbols_synced == 2


# ======================================================================
# Chốt chặn chống chạy trùng
# ======================================================================
def test_second_run_is_rejected_while_one_is_running(monkeypatch):
    """Hai mẻ song song gọi cùng một nhà cung cấp cho cùng danh sách mã là cách nhanh nhất để
    bị chặn IP, mà không thu về thêm gì."""
    from app.core.exceptions import Conflict
    from app.services.market_data import fullsync

    monkeypatch.setattr(fullsync, "_state", fullsync._Progress(state="running"))
    with pytest.raises(Conflict):
        fullsync.start(days=30, force_full=False, triggered_by="admin")


def test_snapshot_of_idle_tracker_is_safe_to_render(monkeypatch):
    """Màn hình gọi endpoint tiến độ ngay khi mở, lúc chưa có mẻ nào — không được chia cho 0."""
    from app.services.market_data import fullsync

    monkeypatch.setattr(fullsync, "_state", fullsync._Progress())
    snap = fullsync.snapshot()
    assert snap["state"] == "idle"
    assert snap["percent"] == 0.0
    assert snap["eta_seconds"] is None
