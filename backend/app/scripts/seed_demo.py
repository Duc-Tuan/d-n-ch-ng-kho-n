"""Dữ liệu mẫu để xem thử hệ thống — `python -m app.scripts.seed_demo`

Tạo sẵn khách hàng ở **đủ các trạng thái quan trọng** để xem được toàn bộ hành vi
mà không phải tự dựng từng tình huống: đang dùng thử, đang hiệu lực, ân hạn, hết hạn,
cảnh báo NAV, bị tạm dừng.

CHỈ DÙNG Ở MÔI TRƯỜNG THỬ NGHIỆM. Script từ chối chạy khi APP_ENV=production.
Mật khẩu của mọi tài khoản mẫu: demo1234
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from sqlalchemy import select

from app.core.config import settings
from app.core.constants import (
    ComplianceStatus,
    CustomerType,
    IbLinkStatus,
    SignalType,
    StrategyStatus,
    SubscriptionStatus,
)
from app.core.database import session_scope
from app.core.security import hash_password
from app.models.content import Article, Category
from app.models.nav import ComplianceEvent, NavDaily
from app.models.strategy import Strategy, StrategySymbol
from app.models.user import Package, Subscription, User
from app.services import signal_service, subscription_service

DEMO_PASSWORD = "demo1234"
TODAY = date.today()


def out(msg: str) -> None:
    print(msg, flush=True)


# ======================================================================
# Khách hàng mẫu — mỗi người minh hoạ một trạng thái
# ======================================================================
CUSTOMERS = [
    {
        "email": "trial@demo.vn",
        "full_name": "Nguyễn Văn Thử",
        "phone": "0901000001",
        "type": CustomerType.IB_LINKED,
        "state": "TRIAL",
        "note": "Đang trong 7 ngày dùng thử, chưa áp điều kiện IB",
    },
    {
        "email": "active@demo.vn",
        "full_name": "Trần Thị Hoạt Động",
        "phone": "0901000002",
        "type": CustomerType.IB_LINKED,
        "state": "ACTIVE_OK",
        "note": "Gói 12 tháng, NAV tốt, đạt điều kiện duy trì",
    },
    {
        "email": "warning@demo.vn",
        "full_name": "Lê Văn Cảnh Báo",
        "phone": "0901000003",
        "type": CustomerType.IB_LINKED,
        "state": "WARNING",
        "note": "NAV dưới ngưỡng, còn 4 ngày trước khi tạm dừng",
    },
    {
        "email": "suspended@demo.vn",
        "full_name": "Phạm Thị Tạm Dừng",
        "phone": "0901000004",
        "type": CustomerType.IB_LINKED,
        "state": "SUSPENDED",
        "note": "Bị tạm dừng do NAV, gói đang đóng băng",
    },
    {
        "email": "grace@demo.vn",
        "full_name": "Hoàng Văn Ân Hạn",
        "phone": "0901000005",
        "type": CustomerType.PAID_ONLY,
        "state": "GRACE",
        "note": "Vừa hết hạn, đang trong 3 ngày ân hạn",
    },
    {
        "email": "expired@demo.vn",
        "full_name": "Vũ Thị Hết Hạn",
        "phone": "0901000006",
        "type": CustomerType.PAID_ONLY,
        "state": "EXPIRED",
        "note": "Hết hạn và quá ân hạn, chỉ vào được màn gia hạn",
    },
]

BROKERS = [
    ("Nguyễn Minh Quân", "MG0142", "0912345678"),
    ("Đặng Thu Hà", "MG0233", "0987654321"),
]

# Nhân viên mẫu — mỗi người một vai trò để xem rõ khác biệt phân quyền (mục 3.5).
STAFF_MEMBERS = [
    ("bientap", "bientap@demo.vn", "Ngô Thị Biên Tập", "CONTENT_EDITOR",
     "Soạn bài viết, chỉ sửa bài của mình, KHÔNG xuất bản được"),
    ("quanlynoidung", "quanlynoidung@demo.vn", "Bùi Văn Nội Dung", "CONTENT_MANAGER",
     "Toàn quyền bài viết, được xuất bản và duyệt FAQ"),
    ("quanlytailieu", "quanlytailieu@demo.vn", "Đỗ Thị Tài Liệu", "DOC_MANAGER",
     "Chỉ quản lý kho tài liệu"),
    ("chamsoc", "chamsoc@demo.vn", "Lý Văn Chăm Sóc", "CUSTOMER_SUPPORT",
     "Xem hồ sơ KH và ghi chú, không gia hạn/khoá được"),
    ("kinhdoanh", "kinhdoanh@demo.vn", "Trịnh Thị Kinh Doanh", "SALES_IB",
     "Quản lý KH + màn cảnh báo NAV, gia hạn gói được"),
    ("phantich", "phantich@demo.vn", "Mai Văn Phân Tích", "ANALYST",
     "Chiến lược, nhập tín hiệu, trả lời hỏi đáp"),
]


def create_staff(db) -> int:
    """Tạo nhân viên mẫu. BR-532 — mỗi tài khoản vẫn phải tự thiết lập 2FA lần đầu."""
    from app.models.staff import Role, Staff

    created = 0
    for username, email, full_name, role_code, _note in STAFF_MEMBERS:
        if db.scalar(select(Staff).where(Staff.username == username)):
            continue
        role = db.scalar(select(Role).where(Role.code == role_code))
        if not role:
            continue

        staff = Staff(
            username=username,
            email=email,
            full_name=full_name,
            password_hash=hash_password(DEMO_PASSWORD),
            status="ACTIVE",
            totp_enabled=False,
            # Tài khoản mẫu nên bỏ cờ bắt đổi mật khẩu cho đỡ vướng khi xem thử.
            must_change_password=False,
        )
        staff.roles = [role]
        db.add(staff)
        created += 1
    return created


def create_customer(db, spec: dict, packages: dict) -> User:
    existing = db.scalar(select(User).where(User.email == spec["email"]))
    if existing:
        return existing

    broker = BROKERS[hash(spec["email"]) % len(BROKERS)]
    now = datetime.now(timezone.utc)

    user = User(
        email=spec["email"],
        phone=spec["phone"],
        password_hash=hash_password(DEMO_PASSWORD),
        full_name=spec["full_name"],
        customer_type=spec["type"],
        # Đã xác thực email sẵn để đăng nhập được ngay.
        email_verified_at=now - timedelta(days=40),
        subscription_status=SubscriptionStatus.PENDING_VERIFY,
        compliance_status=ComplianceStatus.NOT_REQUIRED,
        trial_used=True,
        broker_name=broker[0],
        broker_code=broker[1],
        broker_phone=broker[2],
        created_at=now - timedelta(days=45),
    )
    db.add(user)
    db.flush()
    user.customer_code = f"KH-{user.id:05d}"

    if spec["type"] == CustomerType.IB_LINKED:
        user.securities_account_no = f"068C{100000 + user.id}"
        user.ib_link_status = IbLinkStatus.OK
        user.ib_linked_at = now - timedelta(days=38)

    _apply_state(db, user, spec["state"], packages)
    db.flush()
    return user


def _apply_state(db, user: User, state: str, packages: dict) -> None:
    now = datetime.now(timezone.utc)

    if state == "TRIAL":
        sub = Subscription(
            user_id=user.id, package_id=packages["TRIAL"].id,
            starts_at=now - timedelta(days=3),
            expires_at=now + timedelta(days=4),
            amount=Decimal(0), payment_status="PAID", is_current=True,
        )
        db.add(sub)
        db.flush()
        user.current_subscription_id = sub.id
        user.subscription_status = SubscriptionStatus.TRIAL
        user.compliance_status = ComplianceStatus.NOT_REQUIRED
        return

    if state in ("ACTIVE_OK", "WARNING", "SUSPENDED"):
        sub = Subscription(
            user_id=user.id, package_id=packages["PKG12M"].id,
            starts_at=now - timedelta(days=35),
            expires_at=now + timedelta(days=330),
            amount=packages["PKG12M"].price, payment_status="PAID",
            paid_at=now - timedelta(days=35), is_current=True,
        )
        db.add(sub)
        db.flush()
        user.current_subscription_id = sub.id
        user.subscription_status = SubscriptionStatus.ACTIVE

        if state == "ACTIVE_OK":
            _add_nav(db, user, 480_000_000, days=30)
            user.compliance_status = ComplianceStatus.OK
            user.last_trade_date = TODAY - timedelta(days=1)

        elif state == "WARNING":
            _add_nav(db, user, 72_000_000, days=30)
            user.compliance_status = ComplianceStatus.WARNING
            user.warning_until = now + timedelta(days=4)
            user.last_trade_date = TODAY - timedelta(days=5)
            db.add(
                ComplianceEvent(
                    user_id=user.id, event="WARNING",
                    from_status=ComplianceStatus.OK, to_status=ComplianceStatus.WARNING,
                    reason="NAV trung bình 20 phiên = 72.000.000đ < 100.000.000đ (C2)",
                    nav_avg_20=Decimal(72_000_000), days_since_last_trade=5,
                    triggered_by="job", created_at=now - timedelta(days=3),
                )
            )

        elif state == "SUSPENDED":
            _add_nav(db, user, 45_000_000, days=30)
            user.compliance_status = ComplianceStatus.SUSPENDED
            user.suspended_at = now - timedelta(days=6)
            user.suspended_reason = (
                "NAV trung bình 20 phiên = 45.000.000đ < 100.000.000đ (C2)"
            )
            user.last_trade_date = TODAY - timedelta(days=12)
            # Đồng hồ gói dừng đếm từ lúc bị tạm dừng.
            sub.frozen_since = now - timedelta(days=6)
            db.add(
                ComplianceEvent(
                    user_id=user.id, event="SUSPEND",
                    from_status=ComplianceStatus.WARNING, to_status=ComplianceStatus.SUSPENDED,
                    reason=user.suspended_reason,
                    nav_avg_20=Decimal(45_000_000), days_since_last_trade=12,
                    triggered_by="job", created_at=now - timedelta(days=6),
                )
            )
        return

    if state == "GRACE":
        sub = Subscription(
            user_id=user.id, package_id=packages["PKG3M"].id,
            starts_at=now - timedelta(days=92),
            expires_at=now - timedelta(days=1),
            amount=packages["PKG3M"].price, payment_status="PAID",
            paid_at=now - timedelta(days=92), is_current=True,
        )
        db.add(sub)
        db.flush()
        user.current_subscription_id = sub.id
        user.subscription_status = SubscriptionStatus.GRACE
        user.compliance_status = ComplianceStatus.NOT_REQUIRED
        return

    if state == "EXPIRED":
        sub = Subscription(
            user_id=user.id, package_id=packages["PKG3M"].id,
            starts_at=now - timedelta(days=100),
            expires_at=now - timedelta(days=8),
            amount=packages["PKG3M"].price, payment_status="PAID",
            paid_at=now - timedelta(days=100), is_current=True,
        )
        db.add(sub)
        db.flush()
        user.current_subscription_id = sub.id
        user.subscription_status = SubscriptionStatus.EXPIRED
        user.compliance_status = ComplianceStatus.NOT_REQUIRED


def _add_nav(db, user: User, base: int, days: int = 30) -> None:
    """Sinh chuỗi NAV dao động nhẹ quanh mức `base` để biểu đồ trông thật."""
    for i in range(days):
        trade_date = TODAY - timedelta(days=days - i)
        if trade_date.weekday() >= 5:  # bỏ cuối tuần
            continue
        # Dao động ±6% theo một mẫu tất định, không cần random để chạy lại ra kết quả giống nhau.
        swing = 1 + ((i * 37) % 13 - 6) / 100
        nav = Decimal(int(base * swing))
        db.add(
            NavDaily(
                user_id=user.id, trade_date=trade_date, nav=nav,
                last_trade_date=user.last_trade_date or trade_date,
                account_no=user.securities_account_no, source="DEMO",
            )
        )
    user.latest_nav = Decimal(base)
    user.latest_nav_date = TODAY - timedelta(days=1)


# ======================================================================
# Nội dung mẫu
# ======================================================================
ARTICLES = [
    ("MARKET_COMMENT", "Bình luận thị trường: VN-Index giằng co quanh vùng kháng cự",
     "Thanh khoản giảm nhẹ, dòng tiền phân hoá mạnh giữa các nhóm ngành.",
     "<p>Phiên hôm nay VN-Index giằng co quanh vùng kháng cự ngắn hạn. Thanh khoản khớp lệnh "
     "giảm so với trung bình 20 phiên, cho thấy tâm lý thận trọng.</p>"
     "<h2>Điểm đáng chú ý</h2>"
     "<ul><li>Nhóm ngân hàng giữ nhịp cho chỉ số</li>"
     "<li>Khối ngoại quay lại mua ròng phiên thứ hai liên tiếp</li>"
     "<li>Nhóm bất động sản tiếp tục chịu áp lực chốt lời</li></ul>"
     "<p>Nhà đầu tư nên ưu tiên quản trị rủi ro, hạn chế mua đuổi ở vùng giá cao.</p>"),
    ("MACRO", "Vĩ mô tháng: Lạm phát hạ nhiệt, dư địa chính sách nới lỏng",
     "Chỉ số giá tiêu dùng tăng chậm lại tạo thêm dư địa cho điều hành chính sách tiền tệ.",
     "<p>Số liệu vĩ mô tháng gần nhất cho thấy áp lực giá đã dịu bớt.</p>"
     "<h2>Tác động tới thị trường chứng khoán</h2>"
     "<p>Mặt bằng lãi suất thấp thường có lợi cho định giá cổ phiếu, đặc biệt nhóm có đòn bẩy cao. "
     "Tuy nhiên cần theo dõi thêm diễn biến tỷ giá.</p>"),
    ("BASIC_KNOWLEDGE", "Đọc hiểu chỉ số P/E và P/B cho người mới",
     "Hai chỉ số định giá cơ bản nhất và cách dùng đúng trong từng nhóm ngành.",
     "<p>P/E và P/B là hai chỉ số định giá phổ biến nhất, nhưng dùng sai bối cảnh sẽ cho kết luận "
     "sai lệch.</p>"
     "<h2>P/E — giá trên lợi nhuận mỗi cổ phiếu</h2>"
     "<p>Phù hợp với doanh nghiệp có lợi nhuận ổn định. Không dùng được khi doanh nghiệp lỗ.</p>"
     "<h2>P/B — giá trên giá trị sổ sách</h2>"
     "<p>Phù hợp với ngân hàng và doanh nghiệp thâm dụng tài sản.</p>"),
]


def seed_articles(db, staff_id: int) -> int:
    from slugify import slugify

    created = 0
    now = datetime.now(timezone.utc)

    for index, (cat_code, title, excerpt, content) in enumerate(ARTICLES):
        if db.scalar(select(Article).where(Article.title == title)):
            continue
        category = db.scalar(
            select(Category).where(Category.code == cat_code, Category.type == "ARTICLE")
        )
        if not category:
            continue
        db.add(
            Article(
                category_id=category.id, title=title, slug=slugify(title)[:200],
                excerpt=excerpt, content=content, status="PUBLISHED",
                author_id=staff_id, reviewed_by=staff_id, reviewed_at=now,
                published_at=now - timedelta(days=index), view_count=120 - index * 30,
            )
        )
        created += 1
    return created


def seed_strategy(db, staff_id: int) -> int:
    strategy = db.scalar(select(Strategy).where(Strategy.code == "SMC_BREAKOUT"))
    if not strategy:
        strategy = Strategy(
            code="SMC_BREAKOUT", name="SMC Breakout", school="SMC", timeframe="D1",
            description="Vào lệnh khi giá phá vùng cung/cầu và retest thành công.",
            rules_summary=(
                "1. Xác định vùng cung/cầu trên khung D1.\n"
                "2. Chờ nến đóng cửa phá vùng.\n"
                "3. Vào lệnh khi giá retest vùng vừa phá và cho tín hiệu từ chối.\n"
                "4. Cắt lỗ dưới đáy retest, chốt lời tại vùng cung gần nhất."
            ),
            status=StrategyStatus.ACTIVE, is_public=True, created_by=staff_id,
            analyst_id=staff_id,
        )
        db.add(strategy)
        db.flush()

    existing_symbols = {s.symbol for s in strategy.symbols}
    for symbol in ("HPG", "FPT", "MWG", "VNM"):
        if symbol not in existing_symbols:
            db.add(StrategySymbol(strategy_id=strategy.id, symbol=symbol))
    db.flush()

    from app.models.strategy import Signal

    if db.scalar(select(Signal).where(Signal.strategy_id == strategy.id)):
        return 0

    now = datetime.now(timezone.utc)
    # Vài tín hiệu thực đã chốt kết quả + một tín hiệu đang mở, để thống kê có số liệu thật.
    live = [
        ("HPG", "BUY", 40, 26500, 25400, 29000, 29000, 12, "TP",
         "Phá vùng cung D1, retest thành công"),
        ("HPG", "BUY", 25, 28100, 27000, 30500, 27000, 8, "SL",
         "Phá vùng cầu, nhưng thị trường chung điều chỉnh"),
        ("FPT", "BUY", 30, 92000, 88000, 101000, 101000, 9, "TP",
         "Retest vùng cầu D1, nến từ chối rõ"),
        ("MWG", "SELL", 18, 58000, 61000, 52000, 52000, 6, "TP",
         "Phá vùng cầu, retest thất bại"),
    ]
    for symbol, direction, days_ago, entry, sl, tp, exit_price, exit_days, reason, note in live:
        signal = signal_service.create_signal(
            db, strategy_id=strategy.id, symbol=symbol, direction=direction,
            entry_time=now - timedelta(days=days_ago), entry_price=Decimal(entry),
            sl=Decimal(sl), tp=Decimal(tp), signal_type=SignalType.LIVE,
            reason_text=note, created_by=staff_id, dispatch_alerts=False,
        )
        signal_service.close_signal(
            db, signal, exit_price=Decimal(exit_price),
            exit_time=now - timedelta(days=days_ago - exit_days), exit_reason=reason,
        )

    signal_service.create_signal(
        db, strategy_id=strategy.id, symbol="FPT", direction="BUY",
        entry_time=now - timedelta(days=2), entry_price=Decimal(98500),
        sl=Decimal(94000), tp=Decimal(108000), signal_type=SignalType.LIVE,
        reason_text="Phá đỉnh cũ, khối lượng tăng mạnh", created_by=staff_id,
        dispatch_alerts=False,
    )

    # Vài tín hiệu mô phỏng để thấy rõ hai loại thống kê tách biệt.
    for i, (symbol, entry, sl, tp, exit_price, reason) in enumerate(
        [
            ("VNM", 68000, 65000, 74000, 74000, "TP"),
            ("VNM", 71000, 68000, 77000, 68000, "SL"),
            ("HPG", 24000, 23000, 26500, 26500, "TP"),
        ]
    ):
        signal = signal_service.create_signal(
            db, strategy_id=strategy.id, symbol=symbol, direction="BUY",
            entry_time=now - timedelta(days=120 - i * 20), entry_price=Decimal(entry),
            sl=Decimal(sl), tp=Decimal(tp), signal_type=SignalType.BACKTEST,
            reason_text="Tín hiệu tính lại trên dữ liệu lịch sử",
            created_by=staff_id, dispatch_alerts=False,
        )
        signal_service.close_signal(
            db, signal, exit_price=Decimal(exit_price),
            exit_time=now - timedelta(days=115 - i * 20), exit_reason=reason,
        )

    signal_service.refresh_stats_cache(db, strategy.id)
    return 8


# ======================================================================
def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    if settings.is_production:
        print("\n[TU CHOI] Khong tao du lieu mau o moi truong production.\n")
        return 1

    print(f"\nTao du lieu mau — {settings.app_name}\n" + "=" * 62)

    with session_scope() as db:
        packages = {p.code: p for p in db.scalars(select(Package)).all()}
        if not packages:
            print("  [LOI] Chua co goi dich vu. Chay `python -m app.scripts.seed` truoc.")
            return 1

        from app.models.staff import Staff

        staff = db.scalar(select(Staff).order_by(Staff.id))
        if not staff:
            print("  [LOI] Chua co tai khoan quan tri. Chay `python -m app.scripts.seed` truoc.")
            return 1

        created = 0
        for spec in CUSTOMERS:
            before = db.scalar(select(User).where(User.email == spec["email"]))
            create_customer(db, spec, packages)
            if not before:
                created += 1
        print(f"  ✓ Khách hàng mẫu: {created} mới / {len(CUSTOMERS)} tổng")

        print(f"  ✓ Nhân viên mẫu: {create_staff(db)} mới / {len(STAFF_MEMBERS)} tổng")
        print(f"  ✓ Bài viết mẫu: {seed_articles(db, staff.id)} mới")
        print(f"  ✓ Chiến lược + tín hiệu mẫu: {seed_strategy(db, staff.id)} tín hiệu")

    print("=" * 62)

    print("\n[1] TRANG KHÁCH HÀNG — http://localhost:3000")
    print(f"    Mật khẩu chung: {DEMO_PASSWORD}\n")
    for spec in CUSTOMERS:
        print(f"    {spec['email']:<22} {spec['note']}")

    print("\n[2] TRANG QUẢN TRỊ — http://localhost:3000/admin")
    print(f"    Mật khẩu nhân viên mẫu: {DEMO_PASSWORD}\n")
    print(f"    {settings.seed_super_admin_username:<18} Toàn quyền "
          f"(mật khẩu: xem SEED_SUPER_ADMIN_PASSWORD trong backend/.env)")
    for username, _email, _name, _role, note in STAFF_MEMBERS:
        print(f"    {username:<18} {note}")

    print("\n    Mọi tài khoản quản trị BẮT BUỘC thiết lập xác thực hai lớp ở lần")
    print("    đăng nhập đầu tiên — cần điện thoại có Google Authenticator/Authy.")
    print("\n    Tài khoản quản trị KHÔNG đăng nhập được vào trang khách hàng")
    print("    và ngược lại: hai bảng dữ liệu, hai cookie, hai khoá ký token.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
