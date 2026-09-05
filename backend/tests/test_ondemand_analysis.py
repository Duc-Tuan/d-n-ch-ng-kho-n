"""Phân tích theo yêu cầu — hạn mức, dùng chung kết quả, và chống chạy trùng.

Chạy:  pytest -q tests/test_ondemand_analysis.py

Ba điều được kiểm ở đây đều là những chỗ hỏng thì **không nhìn ra được từ giao diện**: một lượt
bấm bị trừ oan, hai tiến trình cùng phân tích một mã, hay người thứ hai nhận về một bản khác
người thứ nhất. Cả ba chỉ lộ ra khi đọc hoá đơn hạn mức hoặc log tiến trình.
"""

from __future__ import annotations

import os
from datetime import date, timedelta
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test.db")

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core.constants import (
    AnalysisSource,
    StrategyKind,
    StrategyOwnerType,
    StrategyStatus,
    SymbolAnalysisStatus,
)
from app.core.constants import ArticleStatus, CategoryType
from app.core.datetime_utils import utcnow
from app.core.exceptions import TooManyRequests, ValidationError
from app.api.customer.analysis import _RELATED_LIMIT, _related_articles
from app.models import Base
from app.models.analysis import AnalysisQuotaUsage, SymbolAnalysis
from app.models.content import Article, Category
from app.models.market import OhlcvDaily, Symbol
from app.models.strategy import Strategy, StrategySymbol
from app.services.analysis import market_ai, ondemand


@pytest.fixture()
def db():
    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, expire_on_commit=False)
    session = Session()
    yield session
    session.close()


def make_strategy(db, kind: str = StrategyKind.DOCUMENT, symbols=("HPG",)) -> Strategy:
    strategy = Strategy(
        code=f"S{kind}", name=f"Chiến lược {kind}", school="SMC", kind=kind,
        timeframe="D1", owner_type=StrategyOwnerType.SYSTEM, status=StrategyStatus.ACTIVE,
    )
    db.add(strategy)
    db.flush()
    for symbol in symbols:
        db.add(StrategySymbol(strategy_id=strategy.id, symbol=symbol))
        db.add(Symbol(symbol=symbol, company_name=symbol, exchange="HOSE", is_active=True))
        # Cổng `_assert_has_candles` cần ít nhất một nến — mã không có giá thì không phân tích.
        db.add(
            OhlcvDaily(
                symbol=symbol, trade_date=date(2026, 8, 28), open=Decimal("20"),
                high=Decimal("21"), low=Decimal("19"), close=Decimal("20.5"), volume=1_000,
            )
        )
    db.flush()
    return strategy


# ======================================================================
# Dùng chung kết quả theo ngày (mục 1.3)
# ======================================================================
def test_nguoi_thu_hai_doc_lai_ban_da_co_va_khong_bi_tru_luot(db):
    strategy = make_strategy(db)

    first, started_first = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    second, started_second = ondemand.request_analysis(db, user_id=2, strategy=strategy, symbol="HPG")

    assert started_first is True, "Người đầu tiên khởi động mẻ phân tích"
    assert started_second is False, "Người thứ hai chỉ đọc lại, không chạy thêm lượt nào"
    assert first.id == second.id, "Hai người phải nhận đúng cùng một bản"

    assert ondemand.quota_used(db, 1) == 1
    assert ondemand.quota_used(db, 2) == 0, "Đọc lại bản đã có thì không trừ lượt"


def test_dem_luot_mo_ban(db):
    strategy = make_strategy(db)
    ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.request_analysis(db, user_id=2, strategy=strategy, symbol="HPG")
    item, _ = ondemand.request_analysis(db, user_id=3, strategy=strategy, symbol="HPG")
    assert item.view_count == 3


def test_ma_khac_va_ngay_khac_la_ban_khac(db):
    strategy = make_strategy(db, symbols=("HPG", "SSI"))
    a, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    b, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="SSI")
    assert a.id != b.id

    # Bản của hôm qua không được dùng lại cho hôm nay: nến đã đổi.
    a.analysis_date = a.analysis_date - timedelta(days=1)
    db.flush()
    c, started = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    assert started is True and c.id != a.id


# ======================================================================
# Xem lại bản của những ngày trước
# ======================================================================
def test_xem_lai_duoc_ban_cua_ngay_cu(db):
    """Bản cũ vẫn đọc được sau khi hôm nay đã có bản mới — đúng bản của đúng ngày."""
    strategy = make_strategy(db)
    hom_qua, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ngay_cu = hom_qua.analysis_date - timedelta(days=1)
    hom_qua.analysis_date = ngay_cu
    db.flush()

    hom_nay, started = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    assert started is True and hom_nay.id != hom_qua.id

    assert ondemand.find_for(db, strategy.id, "HPG").id == hom_nay.id, "Không truyền ngày = hôm nay"
    assert ondemand.find_for(db, strategy.id, "HPG", ngay_cu).id == hom_qua.id


def test_danh_sach_ngay_chi_gom_ban_da_xong_va_moi_nhat_truoc(db):
    """Ô chọn ngày chỉ được liệt kê những ngày bấm vào là có bài để đọc."""
    strategy = make_strategy(db)
    hom_nay = date(2026, 9, 3)
    for offset, status in ((3, SymbolAnalysisStatus.DONE),
                           (2, SymbolAnalysisStatus.FAILED),
                           (1, SymbolAnalysisStatus.DONE)):
        db.add(
            SymbolAnalysis(
                analysis_date=hom_nay - timedelta(days=offset),
                strategy_id=strategy.id, symbol="HPG",
                source=AnalysisSource.AI, status=status, requested_by=1,
            )
        )
    db.flush()

    rows = ondemand.history_for(db, strategy.id, "hpg")
    assert [r.analysis_date for r in rows] == [
        hom_nay - timedelta(days=1),
        hom_nay - timedelta(days=3),
    ], "Ngày mới nhất trước, và ngày chạy hỏng không nằm trong danh sách chọn"


def test_danh_sach_ngay_khong_lan_sang_cap_khac(db):
    strategy = make_strategy(db, symbols=("HPG", "SSI"))
    # Chiến lược thứ hai dựng tay: `make_strategy` sẽ thêm lại nến của HPG và vướng khoá trùng.
    other = Strategy(
        code="S2", name="Chiến lược khác", school="SMC", kind=StrategyKind.RULE,
        timeframe="D1", owner_type=StrategyOwnerType.SYSTEM, status=StrategyStatus.ACTIVE,
    )
    db.add(other)
    db.flush()
    for strategy_id, symbol in ((strategy.id, "HPG"), (strategy.id, "SSI"), (other.id, "HPG")):
        db.add(
            SymbolAnalysis(
                analysis_date=date(2026, 9, 2), strategy_id=strategy_id, symbol=symbol,
                source=AnalysisSource.AI, status=SymbolAnalysisStatus.DONE, requested_by=1,
            )
        )
    db.flush()

    rows = ondemand.history_for(db, strategy.id, "HPG")
    assert len(rows) == 1 and rows[0].strategy_id == strategy.id and rows[0].symbol == "HPG"


# ======================================================================
# Hạn mức (mục 1.1)
# ======================================================================
def test_het_han_muc_thi_tu_choi(db, monkeypatch):
    monkeypatch.setattr(ondemand.settings, "analysis_daily_quota", 2)
    strategy = make_strategy(db, symbols=("AAA", "BBB", "CCC"))

    ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="AAA")
    ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="BBB")
    with pytest.raises(TooManyRequests):
        ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="CCC")

    assert ondemand.quota_state(db, 1) == {"used": 2, "limit": 2, "remaining": 0}


def test_chien_luoc_loai_dieu_kien_khong_ton_han_muc(db, monkeypatch):
    """Loại RULE chạy bộ điều kiện tại chỗ — không có lượt gọi mô hình nào để mà tính tiền."""
    monkeypatch.setattr(ondemand.settings, "analysis_daily_quota", 1)
    strategy = make_strategy(db, kind=StrategyKind.RULE, symbols=("AAA", "BBB"))

    a, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="AAA")
    b, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="BBB")

    assert a.source == AnalysisSource.ENGINE and b.source == AnalysisSource.ENGINE
    assert ondemand.quota_used(db, 1) == 0
    assert db.scalar(select(AnalysisQuotaUsage.id)) is None


# ======================================================================
# Chống chạy trùng (mục 1.4)
# ======================================================================
def test_chi_mot_worker_chiem_duoc_viec(db):
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")

    assert ondemand.claim(db, item.id) is True, "Worker đầu tiên nhận việc"
    assert ondemand.claim(db, item.id) is False, "Worker thứ hai phải bị từ chối"
    assert db.get(SymbolAnalysis, item.id).status == SymbolAnalysisStatus.RUNNING


def test_ma_ngoai_pham_vi_bi_chan(db):
    strategy = make_strategy(db, symbols=("HPG",))
    db.add(Symbol(symbol="VNM", company_name="VNM", exchange="HOSE", is_active=True))
    db.flush()
    with pytest.raises(ValidationError):
        ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="VNM")


def test_ma_chua_co_nen_bi_chan(db):
    strategy = make_strategy(db, symbols=("HPG",))
    db.execute(OhlcvDaily.__table__.delete())
    db.flush()
    with pytest.raises(ValidationError):
        ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")


# ======================================================================
# Ghi kết quả — nhiều chiều lệnh (mục 1.5)
# ======================================================================
def test_luu_duoc_ca_chieu_mua_lan_chieu_ban(db):
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.claim(db, item.id)

    saved = ondemand.save_result(
        db, item.id,
        title="HPG: hai kịch bản",
        summary="<p>Có cả điểm mua và điểm bán.</p>",
        rationale="Giá đang đi ngang trong biên 19–22.",
        setups=[
            {"direction": "BUY", "entry_price": 19.5, "sl": 18.8, "tp": 21.5,
             "confidence": "MEDIUM"},
            {"direction": "SELL", "entry_price": 21.8, "sl": 22.5, "tp": 19.8,
             "confidence": "LOW"},
        ],
    )
    assert saved.status == SymbolAnalysisStatus.DONE
    assert {s.direction for s in saved.setups} == {"BUY", "SELL"}


def test_phan_tich_theo_bieu_do_chi_giu_moi_chieu_mot_kich_ban(db):
    """Màn bảng giá cần một câu trả lời dứt khoát: bốn thẻ lệnh lệch nhau vài giá là đẩy phần
    chọn ngược lại cho chính người vừa hỏi. Chốt ở máy chủ chứ không chỉ dặn trong lời nhắc.
    """
    make_strategy(db)  # để có mã HPG kèm nến
    item, _ = market_ai.request_analysis(
        db, user_id=1, symbol="HPG", indicators=[{"defId": "rsi", "params": {"length": 14}}]
    )
    ondemand.claim(db, item.id)

    saved = ondemand.save_result(
        db, item.id,
        title="HPG: hai kịch bản",
        summary="<p>Có cả điểm mua và điểm bán.</p>",
        rationale="Giá đi ngang trong biên 19–22.",
        setups=[
            {"direction": "BUY", "entry_price": 19.5, "sl": 18.8, "tp": 21.5,
             "confidence": "LOW"},
            {"direction": "BUY", "entry_price": 19.2, "sl": 18.5, "tp": 21.0,
             "confidence": "HIGH"},
            {"direction": "SELL", "entry_price": 21.8, "sl": 22.5, "tp": 19.8,
             "confidence": "MEDIUM"},
            {"direction": "SELL", "entry_price": 21.9, "sl": 22.6, "tp": 19.9,
             "confidence": "LOW"},
        ],
    )

    assert len(saved.setups) == 2
    best = {s.direction: s for s in saved.setups}
    # Mỗi chiều giữ đúng cái có độ tin cậy cao nhất, không phải cái đứng đầu danh sách.
    assert best["BUY"].confidence == "HIGH"
    assert best["BUY"].entry_price == Decimal("19.2")
    assert best["SELL"].confidence == "MEDIUM"


def test_phan_tich_theo_chien_luoc_van_giu_du_moi_kich_ban(db):
    """Tài liệu chiến lược có thể mô tả nhiều lối vào khác hẳn nhau — cắt bớt là bỏ mất nội dung
    của chính chiến lược đó. Trần hai kịch bản chỉ áp cho nhánh biểu đồ.
    """
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.claim(db, item.id)

    saved = ondemand.save_result(
        db, item.id, title="HPG", summary="<p>x</p>", rationale="y",
        setups=[
            {"direction": "BUY", "entry_price": 19.5, "sl": 18.8, "tp": 21.5,
             "confidence": "LOW"},
            {"direction": "BUY", "entry_price": 19.2, "sl": 18.5, "tp": 21.0,
             "confidence": "HIGH"},
            {"direction": "SELL", "entry_price": 21.8, "sl": 22.5, "tp": 19.8,
             "confidence": "MEDIUM"},
        ],
    )
    assert len(saved.setups) == 3


def test_khong_co_kich_ban_van_la_ket_qua_hop_le(db):
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.claim(db, item.id)

    saved = ondemand.save_result(db, item.id, title="HPG: chưa có điểm vào",
                                 summary="<p>Đứng ngoài.</p>", rationale="Chưa đủ căn cứ.",
                                 setups=[])
    assert saved.status == SymbolAnalysisStatus.DONE
    assert saved.setups == []


def test_kich_ban_nguoc_chieu_bi_tu_choi(db):
    """Một thẻ "MUA, vào 20, cắt lỗ 25, chốt lời 18" không phải dữ liệu thiếu — nó là lời khuyên
    ngược, và khách không có cách nào biết đó là lỗi máy."""
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.claim(db, item.id)

    with pytest.raises(ValidationError):
        ondemand.save_result(
            db, item.id, title="x", summary="y", rationale="z",
            setups=[{"direction": "BUY", "entry_price": 20, "sl": 25, "tp": 18}],
        )


def test_ban_that_bai_giu_lai_ly_do(db):
    strategy = make_strategy(db)
    item, _ = ondemand.request_analysis(db, user_id=1, strategy=strategy, symbol="HPG")
    ondemand.claim(db, item.id)

    failed = ondemand.fail(db, item.id, "Không chạy được Claude Code CLI")
    assert failed.status == SymbolAnalysisStatus.FAILED
    assert "Claude Code CLI" in failed.error_message

    # Bấm lại không tạo bản mới và không trừ thêm lượt — bản hỏng vẫn là bản của hôm nay.
    again, started = ondemand.request_analysis(db, user_id=2, strategy=strategy, symbol="HPG")
    assert started is False and again.id == item.id
    assert ondemand.quota_used(db, 2) == 0


# ======================================================================
# Bài viết gắn theo thẻ
# ======================================================================
def make_article(db, slug: str, tags: str | None, *, status=ArticleStatus.PUBLISHED,
                 published_at=None, min_package_id=None) -> Article:
    """Một bài viết tối thiểu. `category_id` trỏ tới một danh mục có thật vì cột này NOT NULL."""
    category = db.scalar(select(Category).limit(1))
    if category is None:
        category = Category(code="PT", name="Phân tích", type=CategoryType.ARTICLE)
        db.add(category)
        db.flush()
    article = Article(
        category_id=category.id, title=slug, slug=slug, content="<p>x</p>", tags=tags,
        status=status, author_id=1, min_package_id=min_package_id,
        published_at=published_at if published_at is not None else utcnow() - timedelta(days=1),
    )
    db.add(article)
    db.flush()
    return article


class _AnyUser:
    """Khách không gói — `package_gate` chỉ cần `id`, và bài không đặt `min_package_id` thì mở."""

    id = 1
    current_subscription_id = None


def test_bai_viet_gan_theo_the_khop_tron_the_khong_khop_chuoi_con(db):
    """`,HPG,` chứ không phải `%HPG%`: SHPG và HPG3 là mã của doanh nghiệp khác."""
    hpg = make_article(db, "bai-hpg", "thep, HPG, quy-2")
    make_article(db, "bai-shpg", "SHPG")
    make_article(db, "bai-hpg3", "HPG3")

    found = _related_articles(db, _AnyUser(), "HPG")
    assert [a.slug for a in found] == ["bai-hpg"]
    assert found[0].id == hpg.id

    # Không phân biệt hoa thường, và thẻ thừa khoảng trắng vẫn khớp.
    assert [a.slug for a in _related_articles(db, _AnyUser(), " hpg ")] == ["bai-hpg"]
    # Mã chưa có bài nào là trạng thái bình thường, không phải lỗi.
    assert _related_articles(db, _AnyUser(), "VNM") == []


def test_bai_viet_gan_theo_the_ton_trong_br501(db):
    """Bài nháp và bài hẹn giờ tương lai chưa được gắn — chúng chưa tồn tại với khách hàng."""
    make_article(db, "ban-nhap", "SSI", status=ArticleStatus.DRAFT)
    make_article(db, "hen-gio", "SSI", published_at=utcnow() + timedelta(days=3))
    make_article(db, "da-dang", "SSI")

    assert [a.slug for a in _related_articles(db, _AnyUser(), "SSI")] == ["da-dang"]


def test_bai_viet_gan_theo_the_moi_nhat_truoc_va_co_tran(db):
    """Sắp mới nhất trước và cắt ở `_RELATED_LIMIT` — đây là phần phụ dưới kết quả phân tích."""
    for i in range(_RELATED_LIMIT + 3):
        make_article(db, f"bai-{i}", "FPT", published_at=utcnow() - timedelta(days=i + 1))

    found = _related_articles(db, _AnyUser(), "FPT")
    assert len(found) == _RELATED_LIMIT
    assert [a.slug for a in found] == [f"bai-{i}" for i in range(_RELATED_LIMIT)]
