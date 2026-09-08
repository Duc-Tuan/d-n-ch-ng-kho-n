"""Xoá chiến lược — chứng minh đúng lỗi đang gặp, không phải chứng minh hàm chạy được.

**`PRAGMA foreign_keys=ON` là điểm mấu chốt của file này.** SQLite mặc định **không** cưỡng chế
khoá ngoại, nên một test chạy trên cấu hình mặc định sẽ xanh với cả code cũ lẫn code mới — đúng
kiểu test không phát hiện được gì. Bật cưỡng chế lên thì SQLite hành xử như MySQL: `signals`
trỏ về `strategies` không có `ON DELETE CASCADE`, nên `db.delete(strategy)` trần chết ngay khi
chiến lược đã phát ra một tín hiệu. Đó chính là "không xoá được" mà người dùng gặp.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timezone
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test.db")

import pytest
from sqlalchemy import create_engine, event, select
from sqlalchemy.orm import sessionmaker

from app.core.constants import (
    SignalType,
    StrategyKind,
    StrategyOwnerType,
    StrategyStatus,
)
from app.models import Base
from app.models.analysis import SymbolAnalysis, SymbolAnalysisSetup
from app.models.strategy import (
    Signal,
    Strategy,
    StrategyQuestion,
    StrategyShare,
    StrategySymbol,
)
from app.models.telegram import AlertDelivery, StrategyAlert
from app.models.user import User
from app.services import strategy_service


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)

    @event.listens_for(engine, "connect")
    def _enforce_fk(dbapi_connection, _record):  # noqa: ANN001
        dbapi_connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    session.close()


def _user(db, index: int = 0) -> User:
    user = User(
        email=f"kh{index}@test.vn",
        phone=f"09{index:08d}",
        password_hash="x",
        full_name="Khách Test",
    )
    db.add(user)
    db.flush()
    return user


def _strategy(db, owner: User | None = None) -> Strategy:
    strategy = Strategy(
        code=f"S{db.query(Strategy).count() + 1}",
        name="Chiến lược thử",
        school="ICT",
        kind=StrategyKind.RULE,
        timeframe="D1",
        status=StrategyStatus.ACTIVE,
        owner_type=StrategyOwnerType.USER if owner else StrategyOwnerType.SYSTEM,
        owner_id=owner.id if owner else None,
    )
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="HPG"))
    db.flush()
    return strategy


def _signal(db, strategy: Strategy) -> Signal:
    signal = Signal(
        strategy_id=strategy.id,
        symbol="HPG",
        timeframe="D1",
        signal_type=SignalType.LIVE,
        direction="BUY",
        entry_time=datetime(2026, 1, 5, tzinfo=timezone.utc),
        entry_price=Decimal("28.5"),
    )
    db.add(signal)
    db.flush()
    return signal


def test_xoa_duoc_chien_luoc_da_phat_tin_hieu(db):
    """Đúng trường hợp đang hỏng: có tín hiệu thì nút Xoá báo lỗi máy chủ."""
    strategy = _strategy(db)
    signal = _signal(db, strategy)
    db.add(AlertDelivery(signal_id=signal.id, user_id=1, alert_type="ENTRY"))
    db.flush()

    result = strategy_service.purge(db, strategy)
    db.commit()

    assert result.signals == 1
    assert db.scalar(select(Strategy).where(Strategy.id == strategy.id)) is None
    assert db.scalars(select(Signal)).all() == []
    assert db.scalars(select(AlertDelivery)).all() == []
    # `strategy_symbols` do quan hệ delete-orphan của ORM lo, không dọn tay — kiểm tra để chắc
    # rằng việc bỏ nó ra khỏi `purge` không để lại dòng mồ côi.
    assert db.scalars(select(StrategySymbol)).all() == []


def test_xoa_keo_theo_phan_tich_va_kich_ban_con(db):
    strategy = _strategy(db)
    analysis = SymbolAnalysis(
        analysis_date=date(2026, 1, 5), strategy_id=strategy.id, symbol="HPG", source="ENGINE"
    )
    db.add(analysis)
    db.flush()
    db.add(SymbolAnalysisSetup(analysis_id=analysis.id, direction="BUY", entry_price=Decimal("28")))
    db.flush()

    result = strategy_service.purge(db, strategy)
    db.commit()

    assert result.analyses == 1
    assert db.scalars(select(SymbolAnalysis)).all() == []
    assert db.scalars(select(SymbolAnalysisSetup)).all() == []


def test_cau_hoi_cua_chien_luoc_khac_khong_bi_xoa_lay(db):
    """Câu hỏi thuộc chiến lược B nhưng hỏi về tín hiệu của A: gỡ tham chiếu, giữ câu hỏi."""
    a, b = _strategy(db), _strategy(db)
    signal = _signal(db, a)
    question = StrategyQuestion(
        strategy_id=b.id, signal_id=signal.id, user_id=1, question="Vào lệnh này sao?"
    )
    db.add(question)
    db.flush()

    strategy_service.purge(db, a)
    db.commit()

    remaining = db.scalars(select(StrategyQuestion)).all()
    assert len(remaining) == 1
    assert remaining[0].strategy_id == b.id
    assert remaining[0].signal_id is None


def test_xoa_chien_luoc_ca_nhan_thu_hoi_moi_luot_chia_se(db):
    owner, receiver = _user(db, 0), _user(db, 1)
    strategy = _strategy(db, owner=owner)
    db.add(
        StrategyShare(
            strategy_id=strategy.id,
            shared_by_user_id=owner.id,
            shared_with_user_id=receiver.id,
        )
    )
    db.add(StrategyAlert(user_id=receiver.id, strategy_id=strategy.id, symbol="HPG"))
    db.flush()

    result = strategy_service.purge(db, strategy)
    db.commit()

    assert result.shares == 1
    assert result.alerts == 1
    assert db.scalars(select(StrategyShare)).all() == []
    assert db.scalars(select(StrategyAlert)).all() == []


def test_dem_truoc_khi_xoa_khop_voi_so_thuc_te(db):
    """`counts_for` là thứ hộp xác nhận hiển thị — lệch số là nói dối người bấm nút."""
    strategy = _strategy(db)
    _signal(db, strategy)
    _signal(db, strategy)
    db.add(SymbolAnalysis(analysis_date=date(2026, 1, 5), strategy_id=strategy.id,
                          symbol="HPG", source="ENGINE"))
    db.flush()

    before = strategy_service.counts_for(db, strategy.id)
    result = strategy_service.purge(db, strategy)
    db.commit()

    assert before["signals"] == result.signals == 2
    assert before["analyses"] == result.analyses == 1
