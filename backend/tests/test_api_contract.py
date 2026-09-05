"""Kiểm thử hợp đồng API — các kiểu dữ liệu mà frontend phụ thuộc vào.

Lý do có file này: thư viện biểu đồ `lightweight-charts` từ chối thẳng giá trị chuỗi và ném
lỗi runtime ngay giữa màn hình khách hàng:

    Assertion failed: Candlestick series item data value of open must be a number,
    got=string, value=92000.0000

Mặc định Pydantic serialize `Decimal` thành chuỗi để giữ độ chính xác. Kiểu TypeScript ở
frontend lại khai báo `number`, nên sai lệch này không bị phát hiện lúc biên dịch — chỉ vỡ khi
người dùng thật mở biểu đồ. Test dưới đây khoá hợp đồng đó lại.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test_contract.db")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.constants import SignalType
from app.models import Base
from app.models.strategy import Strategy, StrategySymbol
from app.models.user import Package
from app.schemas.domain import NavPoint, PackageOut, SignalOut, SubscriptionHistoryItem
from app.services import signal_service


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, expire_on_commit=False)()
    yield session
    session.close()


def _json_of(model) -> dict:
    """Serialize đúng như FastAPI trả về cho client."""
    import json

    return json.loads(model.model_dump_json())


# ======================================================================
# Giá và tiền phải là SỐ trong JSON, không phải chuỗi
# ======================================================================
def test_signal_prices_serialize_as_numbers(db):
    """Đây chính là lỗi đã làm vỡ màn biểu đồ chiến lược."""
    strategy = Strategy(code="C1", name="Test", school="SMC", timeframe="D1", status="ACTIVE")
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="FPT"))
    db.commit()

    signal = signal_service.create_signal(
        db,
        strategy_id=strategy.id,
        symbol="FPT",
        direction="BUY",
        entry_time=datetime.now(timezone.utc) - timedelta(days=5),
        entry_price=Decimal("92000.0000"),
        sl=Decimal("88000.0000"),
        tp=Decimal("101000.0000"),
        signal_type=SignalType.LIVE,
        dispatch_alerts=False,
    )
    signal_service.close_signal(
        db, signal, exit_price=Decimal("101000.0000"),
        exit_time=datetime.now(timezone.utc), exit_reason="TP",
    )
    db.commit()

    payload = _json_of(SignalOut.model_validate(signal))

    for field in ("entry_price", "sl", "tp", "exit_price", "r_multiple"):
        value = payload[field]
        assert value is None or isinstance(value, (int, float)), (
            f"{field} phải là số trong JSON, đang là {type(value).__name__} = {value!r}. "
            "Thư viện biểu đồ sẽ ném lỗi runtime với giá trị chuỗi."
        )

    # Giá trị vẫn đúng sau khi đổi cách biểu diễn.
    assert payload["entry_price"] == 92000.0
    assert payload["r_multiple"] == pytest.approx(2.25, abs=0.01)


def test_package_price_serializes_as_number(db):
    package = Package(
        code="P1", name="Gói 3 tháng", duration_months=3, duration_days=0,
        price=Decimal("2400000.00"), is_trial=False, tier=2,
    )
    db.add(package)
    db.commit()

    payload = _json_of(PackageOut.model_validate(package))
    assert isinstance(payload["price"], (int, float))
    assert payload["price"] == 2400000.0


def test_nav_point_serializes_as_number():
    """Biểu đồ NAV ở trang khách hàng và trang quản trị đều tính toán trên giá trị này."""
    payload = _json_of(
        NavPoint(trade_date=datetime.now().date(), nav=Decimal("451200000.00"))
    )
    assert isinstance(payload["nav"], (int, float))
    assert payload["nav"] == 451200000.0


def test_subscription_amount_serializes_as_number():
    payload = _json_of(
        SubscriptionHistoryItem(
            id=1, package_name="Gói 12 tháng",
            starts_at=datetime.now(timezone.utc),
            expires_at=datetime.now(timezone.utc) + timedelta(days=365),
            amount=Decimal("7200000.00"), payment_status="PAID",
            frozen_days=0, created_by_type="self", created_at=datetime.now(timezone.utc),
        )
    )
    assert isinstance(payload["amount"], (int, float))


def test_request_schema_still_parses_decimal():
    """Chiều NHẬN VÀO vẫn phải là Decimal — tính toán tiền không được dùng float."""
    from app.schemas.domain import SignalCreateRequest

    request = SignalCreateRequest(
        strategy_id=1, symbol="HPG", direction="BUY", signal_type="LIVE",
        entry_time=datetime.now(timezone.utc), entry_price="28500.50",
        sl="27200", tp="31500",
    )
    assert isinstance(request.entry_price, Decimal)
    assert request.entry_price == Decimal("28500.50")
