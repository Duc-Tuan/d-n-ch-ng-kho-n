"""Kiểm thử các quy tắc nghiệp vụ dễ làm sai nhất.

Chạy:  pytest -q     (từ thư mục backend, với .env đã cấu hình)

Các test ở đây bám sát những chỗ đặc tả nhấn mạnh là "hay bị làm sai":
BR-001 thứ tự ưu tiên, BR-130 cộng tháng lịch, BR-131 cộng dồn gia hạn,
BR-300 NAV trung bình, BR-301 thiếu dữ liệu ≠ vi phạm, BR-304 đóng băng gói,
BR-813 idempotency, BR-841 tách LIVE/BACKTEST.
"""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test.db")

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    SignalType,
    SubscriptionStatus,
)
from app.core.datetime_utils import add_months
from app.models import Base
from app.models.nav import NavDaily
from app.models.user import Package, User
from app.services import access_control, compliance_service, nav_sync_service, subscription_service


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    yield session
    session.close()


@pytest.fixture()
def packages(db):
    trial = Package(code="TRIAL", name="Dùng thử", duration_months=0, duration_days=7,
                    price=0, is_trial=True, tier=1)
    p3 = Package(code="PKG3M", name="3 tháng", duration_months=3, duration_days=0,
                 price=2_400_000, is_trial=False, tier=2)
    p12 = Package(code="PKG12M", name="12 tháng", duration_months=12, duration_days=0,
                  price=7_200_000, is_trial=False, tier=4)
    db.add_all([trial, p3, p12])
    db.commit()
    return {"trial": trial, "p3": p3, "p12": p12}


def make_user(db, **kwargs) -> User:
    defaults = dict(
        email=f"kh{db.query(User).count()}@test.vn",
        phone=f"09{db.query(User).count():08d}",
        password_hash="x",
        full_name="Khách Test",
        customer_type=CustomerType.IB_LINKED,
        subscription_status=SubscriptionStatus.ACTIVE,
        compliance_status=ComplianceStatus.OK,
    )
    defaults.update(kwargs)
    user = User(**defaults)
    db.add(user)
    db.commit()
    return user


# ======================================================================
# BR-130 — cộng theo tháng lịch, không dùng "90 ngày"
# ======================================================================
def test_br130_add_months_clamps_to_month_end():
    """Gói 3 tháng mua ngày 31/01 phải hết hạn 30/04, không phải 31/04 (không tồn tại)."""
    assert add_months(datetime(2026, 1, 31), 3).date() == datetime(2026, 4, 30).date()
    assert add_months(datetime(2026, 1, 31), 1).date() == datetime(2026, 2, 28).date()
    assert add_months(datetime(2024, 1, 31), 1).date() == datetime(2024, 2, 29).date()  # năm nhuận
    assert add_months(datetime(2026, 12, 15), 3).date() == datetime(2027, 3, 15).date()


# ======================================================================
# BR-001 — thứ tự ưu tiên: compliance chặn TRƯỚC subscription
# ======================================================================
def test_br001_compliance_blocks_before_subscription(db, packages):
    """KH vừa hết hạn gói vừa bị SUSPENDED phải thấy lý do compliance, không phải lý do hết hạn.

    Nếu ngược lại, hệ thống sẽ bán gói cho tài khoản mà ngay sau đó bị khoá vì NAV.
    """
    user = make_user(
        db,
        subscription_status=SubscriptionStatus.EXPIRED,
        compliance_status=ComplianceStatus.SUSPENDED,
        suspended_reason="NAV trung bình dưới ngưỡng",
    )
    decision = access_control.evaluate_access(user)
    assert decision.allowed is False
    assert "COMPLIANCE" in decision.reason
    assert decision.action["type"] == "RESTORE_COMPLIANCE"


def test_br001_grace_allows_with_banner(db, packages):
    """GRACE vẫn vào được nhưng phải có banner đỏ (BR-134)."""
    user = make_user(db, subscription_status=SubscriptionStatus.GRACE)
    decision = access_control.evaluate_access(user, datetime.now(timezone.utc) - timedelta(days=1))
    assert decision.allowed is True
    assert decision.banner["code"] == "GRACE"
    assert decision.banner["level"] == "danger"


def test_br112_block_message_names_reason_and_action(db):
    """BR-112 — thông báo phải nêu đúng lý do và hành động, không dùng câu chung chung."""
    user = make_user(db, subscription_status=SubscriptionStatus.TRIAL_EXPIRED,
                     compliance_status=ComplianceStatus.NOT_REQUIRED)
    decision = access_control.evaluate_access(user)
    assert decision.allowed is False
    assert "dùng thử" in decision.message
    assert decision.action["type"] == "CHOOSE_PACKAGE"


# ======================================================================
# 7.1 — hai tuyến khách hàng
# ======================================================================
def test_paid_only_customer_not_subject_to_compliance(db):
    """Chốt 7.1 — tuyến trả phí thuần chỉ chịu trục thời hạn, không áp NAV/giao dịch."""
    ib_user = make_user(db, customer_type=CustomerType.IB_LINKED)
    paid_user = make_user(db, customer_type=CustomerType.PAID_ONLY)
    exempt_user = make_user(db, customer_type=CustomerType.IB_LINKED, compliance_exempt=True)
    trial_user = make_user(db, customer_type=CustomerType.IB_LINKED,
                           subscription_status=SubscriptionStatus.TRIAL)

    assert access_control.is_compliance_applicable(ib_user) is True
    assert access_control.is_compliance_applicable(paid_user) is False
    assert access_control.is_compliance_applicable(exempt_user) is False
    # Mục 2.6 bước 1 — trial không áp điều kiện IB.
    assert access_control.is_compliance_applicable(trial_user) is False


# ======================================================================
# BR-131 / BR-132 — gia hạn cộng dồn
# ======================================================================
def test_br131_renew_before_expiry_extends_from_current_expiry(db, packages):
    user = make_user(db, subscription_status=SubscriptionStatus.ACTIVE)
    first = subscription_service.grant_package(db, user, packages["p3"])
    db.commit()

    second = subscription_service.grant_package(db, user, packages["p3"])
    db.commit()

    # Cộng dồn: gói mới bắt đầu từ ngày hết hạn của gói cũ, không ghi đè.
    assert second.expires_at.date() == add_months(first.expires_at, 3).date()
    # BR-135 — bản ghi cũ được giữ nguyên, không sửa đè.
    assert first.id != second.id
    assert db.query(type(first)).filter_by(user_id=user.id).count() == 2


def test_trial_remaining_time_not_carried_over(db, packages):
    """Thời gian trial còn lại không được cộng dồn vào gói trả phí — trial là quà, không phải hàng đã mua."""
    user = make_user(db, subscription_status=SubscriptionStatus.PENDING_VERIFY,
                     compliance_status=ComplianceStatus.NOT_REQUIRED)
    subscription_service.start_trial(db, user)
    db.commit()

    paid = subscription_service.grant_package(db, user, packages["p3"])
    db.commit()

    now = datetime.now(timezone.utc)
    assert abs((paid.expires_at.replace(tzinfo=timezone.utc) - add_months(now, 3)).days) <= 1


def test_trial_only_once(db, packages):
    user = make_user(db, subscription_status=SubscriptionStatus.PENDING_VERIFY)
    subscription_service.start_trial(db, user)
    db.commit()
    with pytest.raises(Exception):
        subscription_service.start_trial(db, user)


# ======================================================================
# BR-304 — đóng băng thời hạn gói khi bị tạm khoá
# ======================================================================
def test_br304_freeze_and_unfreeze_extends_expiry(db, packages):
    """KH đã trả tiền cho 365 ngày SỬ DỤNG, không phải 365 ngày lịch."""
    user = make_user(db)
    sub = subscription_service.grant_package(db, user, packages["p12"])
    db.commit()
    original_expiry = sub.expires_at

    subscription_service.freeze_subscription(db, user)
    # Giả lập đã bị khoá 10 ngày.
    sub.frozen_since = datetime.now(timezone.utc) - timedelta(days=10)
    db.commit()

    frozen_days = subscription_service.unfreeze_subscription(db, user)
    db.commit()

    assert frozen_days == 10
    assert (sub.expires_at - original_expiry).days == 10
    assert sub.frozen_days == 10
    assert sub.frozen_since is None


def test_br304_frozen_subscription_does_not_expire(db, packages):
    """Đồng hồ đang đóng băng thì job check_subscription không được chuyển sang EXPIRED."""
    user = make_user(db)
    sub = subscription_service.grant_package(db, user, packages["p3"])
    sub.expires_at = datetime.now(timezone.utc) - timedelta(days=30)
    sub.frozen_since = datetime.now(timezone.utc) - timedelta(days=30)
    db.commit()

    assert subscription_service.refresh_subscription_status(db, user) is None
    assert user.subscription_status == SubscriptionStatus.ACTIVE


def test_subscription_lifecycle_active_grace_expired(db, packages):
    user = make_user(db)
    sub = subscription_service.grant_package(db, user, packages["p3"])
    db.commit()

    # Vừa hết hạn 1 ngày → GRACE (BR-134, ân hạn 3 ngày).
    sub.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    db.commit()
    assert subscription_service.refresh_subscription_status(db, user) == SubscriptionStatus.GRACE

    # Quá ân hạn → EXPIRED.
    sub.expires_at = datetime.now(timezone.utc) - timedelta(days=5)
    db.commit()
    assert subscription_service.refresh_subscription_status(db, user) == SubscriptionStatus.EXPIRED


# ======================================================================
# BR-300 / BR-301 — đo NAV và nguyên tắc an toàn tuyệt đối
# ======================================================================
def _add_nav(db, user, values: list[int], start_days_ago: int = 30) -> None:
    base = datetime.now(timezone.utc).date()
    for i, value in enumerate(values):
        db.add(
            NavDaily(
                user_id=user.id,
                trade_date=base - timedelta(days=start_days_ago - i),
                nav=Decimal(value),
                last_trade_date=base - timedelta(days=1),
            )
        )
    db.commit()


def test_br300_nav_average_smooths_short_term_dip(db):
    """Một KH tốt rút tạm tiền vài ngày không được bị khoá oan."""
    user = make_user(db)
    # 17 phiên ở 150tr, 3 phiên tụt xuống 50tr → trung bình vẫn trên 100tr.
    _add_nav(db, user, [150_000_000] * 17 + [50_000_000] * 3)

    check = compliance_service.measure(db, user)
    assert check.has_data is True
    assert check.sessions_counted == 20
    assert check.violate_nav is False, "NAV trung bình 20 phiên phải lọc được nhiễu ngắn hạn"


def test_br301_missing_data_is_not_violation(db):
    """*Không có dữ liệu ≠ vi phạm.* Đây là quy tắc quan trọng nhất của module compliance."""
    user = make_user(db)  # không có dòng nav_daily nào

    check = compliance_service.measure(db, user)
    assert check.has_data is False
    assert check.violated is False
    assert check.nav_avg is None
    assert check.missing_reason


def test_br301_job_does_not_change_status_without_data(db):
    user = make_user(db, compliance_status=ComplianceStatus.OK)
    result = compliance_service.ComplianceRunResult()

    compliance_service._process_user(db, user, result)

    assert user.compliance_status == ComplianceStatus.OK, "Thiếu dữ liệu không được đổi trạng thái"
    assert result.skipped_no_data == 1
    assert result.warned == 0


def test_c2_threshold_uses_strict_less_than(db):
    """Chốt 7.3 — đúng 100 triệu là ĐẠT, không bị khoá."""
    user = make_user(db)
    _add_nav(db, user, [100_000_000] * 20)

    check = compliance_service.measure(db, user)
    assert check.violate_nav is False

    user2 = make_user(db)
    _add_nav(db, user2, [99_999_999] * 20)
    assert compliance_service.measure(db, user2).violate_nav is True


def test_c1_no_trade_over_90_days(db):
    user = make_user(db)
    _add_nav(db, user, [200_000_000] * 20)
    user.last_trade_date = datetime.now(timezone.utc).date() - timedelta(days=91)
    db.commit()

    check = compliance_service.measure(db, user)
    assert check.violate_no_trade is True
    assert check.violate_nav is False
    assert "C1" in check.reason_text


def test_warning_then_suspend_flow(db, packages):
    """BR-302 — không khoá đột ngột; phải qua vòng WARNING 7 ngày."""
    user = make_user(db, compliance_status=ComplianceStatus.OK)
    subscription_service.grant_package(db, user, packages["p12"])
    _add_nav(db, user, [50_000_000] * 20)
    db.commit()

    result = compliance_service.ComplianceRunResult()
    compliance_service._process_user(db, user, result)
    assert user.compliance_status == ComplianceStatus.WARNING
    assert user.warning_until is not None

    # Chưa hết 7 ngày → vẫn WARNING.
    compliance_service._process_user(db, user, result)
    assert user.compliance_status == ComplianceStatus.WARNING

    # Quá hạn cảnh báo → SUSPENDED, đồng hồ gói dừng đếm.
    user.warning_until = datetime.now(timezone.utc) - timedelta(days=1)
    db.commit()
    compliance_service._process_user(db, user, result)
    assert user.compliance_status == ComplianceStatus.SUSPENDED

    sub = subscription_service.get_current_subscription(db, user)
    assert sub.frozen_since is not None, "BR-304: SUSPENDED phải đóng băng đồng hồ gói"


def test_br303_self_recovery(db, packages):
    """SUSPENDED do compliance là **tự khôi phục** — KH nạp tiền hôm nay, mai job tự mở lại."""
    user = make_user(db, compliance_status=ComplianceStatus.SUSPENDED)
    sub = subscription_service.grant_package(db, user, packages["p12"])
    subscription_service.freeze_subscription(db, user)
    sub.frozen_since = datetime.now(timezone.utc) - timedelta(days=5)
    _add_nav(db, user, [500_000_000] * 20)
    user.last_trade_date = datetime.now(timezone.utc).date()
    db.commit()

    result = compliance_service.ComplianceRunResult()
    compliance_service._process_user(db, user, result)

    assert user.compliance_status == ComplianceStatus.OK
    assert result.restored == 1
    assert sub.frozen_days == 5, "BR-304: phải bù đúng số ngày bị khoá"


# ======================================================================
# BR-841 — LIVE và BACKTEST không bao giờ gộp khi tính thống kê
# ======================================================================
def test_br841_stats_never_mix_live_and_backtest(db):
    from app.core.constants import SignalResult
    from app.models.strategy import Signal, Strategy, StrategySymbol
    from app.services import signal_service

    strategy = Strategy(code="TEST", name="Test", school="SMC", timeframe="D1", status="ACTIVE")
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="HPG"))
    db.commit()

    now = datetime.now(timezone.utc) - timedelta(days=10)
    # 1 LIVE thắng, 3 BACKTEST thắng.
    db.add(Signal(strategy_id=strategy.id, symbol="HPG", timeframe="D1",
                  signal_type=SignalType.LIVE, direction="BUY", entry_time=now,
                  entry_price=Decimal(100), sl=Decimal(90), tp=Decimal(120),
                  result=SignalResult.WIN, r_multiple=Decimal("2.0")))
    for _ in range(3):
        db.add(Signal(strategy_id=strategy.id, symbol="HPG", timeframe="D1",
                      signal_type=SignalType.BACKTEST, direction="BUY", entry_time=now,
                      entry_price=Decimal(100), sl=Decimal(90), tp=Decimal(120),
                      result=SignalResult.WIN, r_multiple=Decimal("2.0")))
    db.commit()

    live = signal_service.compute_stats(db, strategy.id, signal_type=SignalType.LIVE)
    backtest = signal_service.compute_stats(db, strategy.id, signal_type=SignalType.BACKTEST)

    assert live.total_trades == 1
    assert backtest.total_trades == 3
    # BR-843 — luôn trả kèm khoảng thời gian được tính.
    assert live.period_from is not None and live.period_to is not None


def test_br840_signal_cannot_be_edited_after_close(db):
    from app.core.constants import SignalResult
    from app.models.strategy import Signal, Strategy, StrategySymbol
    from app.services import signal_service

    strategy = Strategy(code="T2", name="Test2", school="ICT", timeframe="D1", status="ACTIVE")
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="FPT"))
    db.commit()

    signal = signal_service.create_signal(
        db, strategy_id=strategy.id, symbol="FPT", direction="BUY",
        entry_time=datetime.now(timezone.utc) - timedelta(days=1),
        entry_price=Decimal(100), sl=Decimal(90), tp=Decimal(120),
        dispatch_alerts=False,
    )
    db.commit()

    signal_service.close_signal(
        db, signal, exit_price=Decimal(120),
        exit_time=datetime.now(timezone.utc), exit_reason="TP",
    )
    db.commit()
    assert signal.result == SignalResult.WIN
    assert signal.r_multiple == Decimal("2.000")

    # Đã chốt kết quả thì không huỷ được nữa.
    with pytest.raises(Exception):
        signal_service.cancel_signal(db, signal.id, "thử huỷ")


def test_signal_sl_tp_consistency_enforced(db):
    from app.models.strategy import Strategy, StrategySymbol
    from app.services import signal_service

    strategy = Strategy(code="T3", name="Test3", school="QUANT", timeframe="H1", status="ACTIVE")
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="MWG"))
    db.commit()

    # Lệnh MUA có cắt lỗ CAO hơn giá vào — sai, làm hỏng toàn bộ thống kê R.
    with pytest.raises(Exception):
        signal_service.create_signal(
            db, strategy_id=strategy.id, symbol="MWG", direction="BUY",
            entry_time=datetime.now(timezone.utc), entry_price=Decimal(100),
            sl=Decimal(110), tp=Decimal(120), dispatch_alerts=False,
        )


def test_backtest_signal_cannot_be_in_future(db):
    """BR-842 — chống nhìn trước ở mức tối thiểu có thể kiểm chứng tự động."""
    from app.models.strategy import Strategy, StrategySymbol
    from app.services import signal_service

    strategy = Strategy(code="T4", name="Test4", school="SMC", timeframe="D1", status="ACTIVE")
    db.add(strategy)
    db.flush()
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="VNM"))
    db.commit()

    with pytest.raises(Exception):
        signal_service.create_signal(
            db, strategy_id=strategy.id, symbol="VNM", direction="BUY",
            entry_time=datetime.now(timezone.utc) + timedelta(days=5),
            entry_price=Decimal(100), signal_type=SignalType.BACKTEST, dispatch_alerts=False,
        )


# ======================================================================
# BR-813 — idempotency của thông báo
# ======================================================================
def test_br813_notification_sent_only_once(db):
    from app.core.constants import NotificationChannel, NotificationCode
    from app.models.notification import Notification
    from app.services import notification_service

    user = make_user(db)

    first = notification_service.enqueue(
        db, user=user, code=NotificationCode.EXPIRY_T7,
        channels=[NotificationChannel.EMAIL], reference_id="sub:1",
        context={"full_name": user.full_name},
    )
    db.commit()
    second = notification_service.enqueue(
        db, user=user, code=NotificationCode.EXPIRY_T7,
        channels=[NotificationChannel.EMAIL], reference_id="sub:1",
        context={"full_name": user.full_name},
    )
    db.commit()

    assert len(first) == 1
    assert len(second) == 0, "Job chạy lại không được gửi email trùng"
    assert db.query(Notification).filter_by(user_id=user.id).count() == 1


# ======================================================================
# BR-403 — validate trước khi ghi
# ======================================================================
def test_br403_empty_sheet_aborts(db):
    with pytest.raises(nav_sync_service.SyncAborted):
        nav_sync_service.validate_before_write(db, [], datetime.now().date())


def test_br403_row_drop_aborts(db):
    from app.core.constants import SyncJobStatus, SyncJobType
    from app.models.nav import SyncJob

    today = datetime.now(timezone.utc).date()
    db.add(
        SyncJob(
            job_type=SyncJobType.SYNC_NAV, run_date=today - timedelta(days=1),
            status=SyncJobStatus.SUCCESS, rows_read=100, started_at=datetime.now(timezone.utc),
        )
    )
    db.commit()

    rows = [
        nav_sync_service.SheetRow(
            row_number=i, email=f"a{i}@x.vn", account_no="1", full_name=None,
            nav=Decimal(1), last_trade_date=today, order_count_30d=1, updated_date=today,
        )
        for i in range(50)  # giảm 50% so với hôm qua
    ]
    with pytest.raises(nav_sync_service.SyncAborted, match="giảm"):
        nav_sync_service.validate_before_write(db, rows, today)


def test_br403_negative_nav_rejected():
    raw = [["a@x.vn", "123", "A", "-500", "2026-08-01", "5", "2026-08-01"]]
    valid, invalid = nav_sync_service.parse_rows(raw)
    assert not valid
    assert "âm" in invalid[0]["error"]


def test_parse_rows_handles_vietnamese_number_and_date_formats():
    raw = [["A@X.VN", "0001", "Nguyễn A", "1,500,000,000", "01/08/2026", "12", "2026-08-01"]]
    valid, invalid = nav_sync_service.parse_rows(raw)
    assert not invalid
    assert valid[0].email == "a@x.vn"
    assert valid[0].nav == Decimal("1500000000")
    assert valid[0].last_trade_date == datetime(2026, 8, 1).date()


# ======================================================================
# BR-505 — chính sách mật khẩu và tách secret hai site
# ======================================================================
def test_password_policy():
    from app.core.security import password_policy_errors

    assert password_policy_errors("abc") != []
    assert password_policy_errors("abcdefgh") != []   # thiếu số
    assert password_policy_errors("12345678") != []   # thiếu chữ
    assert password_policy_errors("abcd1234") == []


def test_br000_customer_token_cannot_be_used_as_staff_token():
    """Hai site dùng hai secret khác nhau — token chéo site không verify được."""
    from app.core.security import create_token, decode_token

    customer_token = create_token(1, "customer", "access")
    assert decode_token(customer_token, "customer") is not None
    assert decode_token(customer_token, "staff") is None, "BR-000 bị vi phạm!"

    staff_token = create_token(1, "staff", "access")
    assert decode_token(staff_token, "customer") is None, "BR-000 bị vi phạm!"


# ======================================================================
# BR-83x — xoá mã trong danh mục không được xoá mất lịch sử tín hiệu
# ======================================================================
def test_remove_symbol_deletes_bars_when_no_signal(db):
    """Mã chưa từng phát tín hiệu thì xoá hẳn, kèm giá lịch sử của nó."""
    from datetime import date

    from app.models.market import OhlcvDaily, Symbol
    from app.services import market_data

    db.add(Symbol(symbol="AAA", exchange="HOSE", is_active=True))
    db.add(
        OhlcvDaily(
            symbol="AAA", trade_date=date(2026, 8, 10), open=Decimal("10"), high=Decimal("11"),
            low=Decimal("9"), close=Decimal("10"), volume=1000, source="VPS",
        )
    )
    db.commit()

    result = market_data.remove_symbol(db, "AAA")
    db.commit()

    assert result["deleted"] is True
    assert result["bars"] == 1
    assert db.query(Symbol).filter_by(symbol="AAA").first() is None
    assert db.query(OhlcvDaily).filter_by(symbol="AAA").count() == 0


def test_remove_symbol_keeps_history_when_signal_exists(db):
    """Mã đã phát tín hiệu chỉ bị tắt theo dõi — tín hiệu là dữ liệu bất biến (BR-83x).

    Xoá thật sẽ làm màn tra cứu khiếu nại trống đúng lúc khách hàng thắc mắc về lệnh đã nhận.
    """
    from datetime import date

    from app.models.market import OhlcvDaily, Symbol
    from app.models.strategy import Signal, Strategy, StrategySymbol
    from app.services import market_data

    strategy = Strategy(code="S1", name="Test", school="SMC", timeframe="D1", status="ACTIVE")
    db.add(strategy)
    db.flush()

    db.add(Symbol(symbol="BBB", exchange="HOSE", is_active=True))
    db.add(StrategySymbol(strategy_id=strategy.id, symbol="BBB"))
    db.add(
        OhlcvDaily(
            symbol="BBB", trade_date=date(2026, 8, 10), open=Decimal("10"), high=Decimal("11"),
            low=Decimal("9"), close=Decimal("10"), volume=1000, source="VPS",
        )
    )
    db.add(
        Signal(
            strategy_id=strategy.id, symbol="BBB", direction="BUY",
            entry_time=datetime.now(timezone.utc), entry_price=Decimal("10"),
            signal_type=SignalType.LIVE,
        )
    )
    db.commit()

    result = market_data.remove_symbol(db, "BBB")
    db.commit()

    assert result["deleted"] is False
    assert result["kept_reason"] == "signals"

    row = db.query(Symbol).filter_by(symbol="BBB").first()
    assert row is not None, "Mã có tín hiệu không được xoá khỏi danh mục"
    assert row.is_active is False
    assert db.query(OhlcvDaily).filter_by(symbol="BBB").count() == 1, "Giá lịch sử phải giữ nguyên"
    assert db.query(Signal).filter_by(symbol="BBB").count() == 1, "Tín hiệu phải giữ nguyên"
    # Vẫn gỡ khỏi chiến lược: mã không còn theo dõi thì không được sinh tín hiệu mới.
    assert db.query(StrategySymbol).filter_by(symbol="BBB").count() == 0
