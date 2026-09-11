"""Giá thời gian thực cho bảng giá — BR-830, BR-831.

Cái được khoá ở đây là **những sai lệch không bao giờ báo lỗi**. Bảng giá vẫn vẽ ra đủ sáu mươi
dòng, vẫn có số ở mọi cột, vẫn đổi màu — chỉ là con số sai. Bốn kiểu sai đã đo được trên nguồn
thật và mỗi kiểu có một nhóm test ở đây:

* **Khối lượng lệch 10 lần.** VPS trả khối lượng theo lô 10 cổ phiếu. Quên nhân 10 thì cột khối
  lượng nhỏ đi một bậc, mà một con số khối lượng "hợp lý" thì không ai đi kiểm tra.
* **Mã giảm hiện thành mã tăng.** Trường `ot`/`changePc` của VPS **không mang dấu** — đo 405 mã
  HOSE, 0 dòng có dấu âm. Lấy thẳng là mọi mã giảm thành tăng, và màu đỏ biến mất khỏi bảng.
* **Nến đang chạy lọt vào cơ sở dữ liệu.** Vi phạm BR-832: chiến lược chạy lúc 10:00 và lúc
  14:00 sẽ đọc hai nến cuối khác nhau cho cùng một ngày.
* **Kho ôi mà vẫn hiện như đang chạy.** Nguồn chết im lặng và nguồn đang chạy trông y hệt nhau
  nếu không có mốc `as_of` và cờ `stale`.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

os.environ.setdefault("DATABASE_URL_OVERRIDE", "sqlite:///./test_realtime_quotes.db")

import pytest

from app.core.config import settings
from app.services.market_data import quote_store as qs
from app.services.market_data import timeframes as tfs
from app.services.market_data.bars import Candle, _with_live_tail
from app.services.market_data.quotes import Quote, QuoteLevel, VpsBoardProvider

# Một dòng thật lấy từ `bgapidatafeed.vps.com.vn`, cắt bớt các trường không dùng. HPG lúc 13:14
# ngày 10/09/2026: giá 21,95 · tham chiếu 22,05 — tức là **đang giảm**.
HPG_ROW = {
    "sym": "HPG",
    "lastPrice": 21.95,
    "lastVolume": 40,
    "c": 23.55,
    "f": 20.55,
    "r": 22.05,
    "openPrice": "22.0",
    "highPrice": "22.05",
    "lowPrice": "21.8",
    "avePrice": "21.94",
    "lot": 658880,
    # Không dấu, dù mã đang giảm — đây chính là cái bẫy.
    "ot": "0.10",
    "changePc": "0.45",
    "g1": "21.95|40270|d",
    "g2": "21.9|43280|d",
    "g3": "21.85|35610|d",
    "g4": "22.0|39130|d",
    "g5": "22.05|42580|e",
    "g6": "22.1|69670|i",
    "g7": "0|0|e",
    "fBVol": "211316",
    "fSVolume": "76530",
    "fRoom": "229867940.40",
}

NOW = datetime(2026, 9, 10, 6, 14, tzinfo=timezone.utc)


# ======================================================================
# Đọc dữ liệu từ nguồn
# ======================================================================
def test_khoi_luong_doi_tu_lo_sang_co_phieu():
    """Mọi trường khối lượng phải nhân 10 — `lot`, `lastVolume`, và cả bậc sổ lệnh.

    Bỏ sót một trường thôi thì cột đó lệch 10 lần so với các cột còn lại, và không có gì trên
    màn hình nói cho ai biết cột nào mới đúng.
    """
    quote = VpsBoardProvider._parse(HPG_ROW, NOW)

    assert quote.volume == 658_880 * 10
    assert quote.last_volume == 40 * 10
    assert quote.bids[0].volume == 40_270 * 10
    assert quote.asks[0].volume == 39_130 * 10
    assert quote.foreign_buy == 211_316 * 10
    assert quote.foreign_sell == 76_530 * 10


def test_thay_doi_gia_tu_tinh_va_mang_dau_am():
    """Mã đang giảm phải ra số âm, dù nguồn trả `ot` không dấu."""
    quote = VpsBoardProvider._parse(HPG_ROW, NOW)

    assert quote.change == Decimal("21.95") - Decimal("22.05")
    assert quote.change < 0, "lấy thẳng `ot` của VPS thì mã giảm hiện thành mã tăng"
    assert quote.change_pct == pytest.approx(-0.45, abs=0.01)


def test_so_lenh_dung_ben_va_dung_thu_tu():
    """`g1..g3` là bên mua, `g4..g6` là bên bán. Đảo hai bên thì bảng giá vẫn đầy số nhưng vô nghĩa."""
    quote = VpsBoardProvider._parse(HPG_ROW, NOW)

    assert [b.price for b in quote.bids] == [Decimal("21.95"), Decimal("21.9"), Decimal("21.85")]
    assert [a.price for a in quote.asks] == [Decimal("22.0"), Decimal("22.05"), Decimal("22.1")]
    # Bất biến của mọi sổ lệnh: giá mua tốt nhất luôn thấp hơn giá bán tốt nhất.
    assert quote.bids[0].price < quote.asks[0].price


def test_bac_rong_bi_bo_khong_thanh_gia_0():
    """`g7` là "0|0|e" — mức giá 0 không tồn tại, đưa vào là vẽ một bậc giả ở đáy sổ lệnh."""
    quote = VpsBoardProvider._parse({**HPG_ROW, "g3": "0|0|e"}, NOW)

    assert len(quote.bids) == 2
    assert all(level.price > 0 for level in quote.bids)


def test_ma_chua_khop_lenh_tra_ve_gia_rong():
    """Mã chưa có giao dịch nào trả 0 ở mọi trường giá.

    Để nguyên 0 thì phép tính thay đổi giá ra -100% và cả bảng đỏ rực vì những mã đơn giản là
    chưa ai mua bán.
    """
    quote = VpsBoardProvider._parse(
        {**HPG_ROW, "lastPrice": 0, "openPrice": "0", "avePrice": "0"}, NOW
    )

    assert quote.price is None
    assert quote.open is None
    assert quote.change is None and quote.change_pct is None


def test_don_vi_gia_giu_nguyen_nghin_dong():
    """VPS trả sẵn nghìn đồng — không được chia hay nhân thêm lần nào."""
    quote = VpsBoardProvider._parse(HPG_ROW, NOW)

    assert quote.price == Decimal("21.95")
    assert quote.ceiling == Decimal("23.55")
    assert quote.floor == Decimal("20.55")
    assert quote.at_ceiling is False and quote.at_floor is False


def test_nhan_dien_tran_va_san():
    """Nguồn cho quy ước màu tím-trần / xanh lam-sàn của bảng giá Việt Nam."""
    assert VpsBoardProvider._parse({**HPG_ROW, "lastPrice": 23.55}, NOW).at_ceiling is True
    assert VpsBoardProvider._parse({**HPG_ROW, "lastPrice": 20.55}, NOW).at_floor is True


# ======================================================================
# Kho snapshot
# ======================================================================
@pytest.fixture()
def store():
    s = qs.QuoteStore()
    yield s
    s.clear()


def _quote(symbol="HPG", price="21.95", volume=100, as_of=NOW) -> Quote:
    return Quote(
        symbol=symbol, price=Decimal(price), reference=Decimal("22.05"),
        ceiling=Decimal("23.55"), floor=Decimal("20.55"),
        open=Decimal("22.0"), high=Decimal("22.05"), low=Decimal("21.8"),
        volume=volume, as_of=as_of,
    )


def test_chi_tra_ve_ma_thuc_su_doi(store):
    """Kênh WebSocket chỉ đẩy phần đổi. Trả về cả kho mỗi nhịp là 143 KB thay vì vài trăm byte."""
    store.replace([_quote(), _quote("FPT", "74.0")])

    unchanged = store.replace([_quote(), _quote("FPT", "74.0")])
    assert unchanged == []

    changed = store.replace([_quote(price="22.00"), _quote("FPT", "74.0")])
    assert [q.symbol for q in changed] == ["HPG"]


def test_moc_thoi_gian_doi_khong_tinh_la_doi_gia(store):
    """`as_of` đổi ở **mọi** nhịp. Đưa nó vào phép so thì mọi mã đều "đổi" và diff thành vô nghĩa."""
    store.replace([_quote(as_of=NOW)])

    changed = store.replace([_quote(as_of=NOW + timedelta(seconds=2))])
    assert changed == []


def test_kho_rong_tinh_la_oi(store):
    """Chưa có gì để phủ lên thì bảng giá phải giữ nguyên đường đọc cơ sở dữ liệu."""
    assert store.is_stale() is True


def test_kho_qua_han_tinh_la_oi(store, monkeypatch):
    monkeypatch.setattr(settings, "market_realtime_stale_seconds", 30)
    store.replace([_quote()])
    store._stats.last_success_at = NOW

    assert store.is_stale(now=NOW + timedelta(seconds=10)) is False
    assert store.is_stale(now=NOW + timedelta(seconds=31)) is True


def test_sang_phien_moi_thi_bo_so_cua_hom_qua(store, monkeypatch):
    """Giữ lại thì mã chưa khớp lệnh sáng nay vẫn hiện giá và khối lượng của phiên trước."""
    monkeypatch.setattr(qs, "local_today", lambda: date(2026, 9, 10))
    store.replace([_quote(), _quote("FPT", "74.0")])
    assert len(store.all_symbols()) == 2

    monkeypatch.setattr(qs, "local_today", lambda: date(2026, 9, 11))
    store.replace([_quote()])
    assert store.all_symbols() == ["HPG"]


# ======================================================================
# Cửa sổ phiên
# ======================================================================
@pytest.mark.parametrize(
    ("hour", "minute", "expected"),
    [
        (8, 30, "CLOSED"),
        (9, 5, "ATO"),
        (10, 0, "LO"),
        (12, 0, "BREAK"),
        (13, 30, "LO"),
        (14, 35, "ATC"),
        (14, 50, "PT"),
        (15, 30, "CLOSED"),
    ],
)
def test_nhan_phien_theo_dong_ho(hour, minute, expected):
    """VPS không trả trạng thái phiên (`tradingSession` là None ở cả 405 mã đã đo), nên nhãn
    ATO/Liên tục/Nghỉ trưa/ATC phải suy từ đồng hồ."""
    now = datetime(2026, 9, 10, hour, minute, tzinfo=settings.tz)
    assert qs.current_session(now) == expected


def test_ngoai_cua_so_phien_thi_khong_goi_mang(monkeypatch):
    """Không có lý do gì để nện endpoint của nhà cung cấp suốt đêm và cả cuối tuần."""
    monkeypatch.setattr(settings, "market_realtime_enabled", True)
    monkeypatch.setattr(qs, "local_now", lambda: datetime(2026, 9, 10, 22, 0, tzinfo=settings.tz))

    result = qs.poll_once()
    assert result["skipped"] is True
    assert result["reason"] == "ngoài cửa sổ phiên"


def test_tat_co_thi_khong_lam_gi(monkeypatch):
    monkeypatch.setattr(settings, "market_realtime_enabled", False)
    assert qs.poll_once()["reason"] == "tắt"


# ======================================================================
# Nến đang hình thành — BR-832
# ======================================================================
def test_nen_ngay_dung_so_luy_ke_cua_nguon(store):
    """Nến ngày hôm nay **chính xác tuyệt đối**: giá mở, cao, thấp và khối lượng đều là số luỹ
    kế cả phiên do sở tính, không phải số mình lấy mẫu."""
    store.replace([_quote(volume=6_588_800)])
    store._stats.last_success_at = qs.utcnow()

    bar = store.live_bar("HPG", "1D")
    assert bar is not None and bar.exact is True
    assert bar.open == Decimal("22.0")
    assert bar.high == Decimal("22.05")
    assert bar.low == Decimal("21.8")
    assert bar.close == Decimal("21.95")
    assert bar.volume == 6_588_800


def test_nen_trong_ngay_gom_dan_theo_mau(store, monkeypatch):
    """Khung trong ngày là xấp xỉ — biên lấy từ các mẫu poll, và khối lượng trừ ra từ luỹ kế."""
    monkeypatch.setattr(settings, "market_intraday_timeframes", "1h")

    store.replace([_quote(price="21.90", volume=1_000_000)])
    store.replace([_quote(price="22.10", volume=1_050_000)])
    store.replace([_quote(price="22.00", volume=1_080_000)])
    store._stats.last_success_at = qs.utcnow()

    bar = store.live_bar("HPG", "1h")
    assert bar is not None and bar.exact is False
    assert bar.open == Decimal("21.90")
    assert bar.high == Decimal("22.10")
    assert bar.low == Decimal("21.90")
    assert bar.close == Decimal("22.00")
    assert bar.volume == 80_000  # 1.080.000 trừ mốc mở 1.000.000


def test_kho_oi_thi_khong_dung_nen_dang_chay(store):
    """Nguồn đã chết thì cây nến cuối phải biến mất chứ không đứng im mãi ở giá cuối cùng."""
    store.replace([_quote()])
    store._stats.last_success_at = NOW - timedelta(hours=2)

    assert store.live_bar("HPG", "1D") is None


# ======================================================================
# Ghép đuôi sống vào chuỗi nến
# ======================================================================
def _candle(day: int, close="70", volume=1000) -> Candle:
    d = date(2026, 9, day)
    return Candle(
        time=datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc),
        trade_date=d,
        open=Decimal("69"), high=Decimal("71"), low=Decimal("68"),
        close=Decimal(close), volume=volume,
    )


def test_ghep_them_cay_nen_moi_khi_chua_co(monkeypatch):
    stored = [_candle(8), _candle(9)]
    live = _candle(10, close="74")
    monkeypatch.setattr("app.services.market_data.bars.live_candle", lambda s, b: live)

    out = _with_live_tail("FPT", tfs.get("1D"), stored)
    assert len(out) == 3 and out[-1].trade_date == date(2026, 9, 10)


def test_hop_nhat_thay_vi_them_cay_trung(monkeypatch):
    """`sync_bars` giữa phiên có thể đã ghi đúng ô đang hình thành. Thêm cây nữa thì biểu đồ có
    hai nến cùng mốc thời gian — thư viện vẽ chồng lên nhau và không ai hiểu chuyện gì.

    Hợp nhất lấy giá mở **đã lưu** (chính xác hơn giá lấy mẫu) và biên rộng hơn của hai bên.
    """
    stored = [_candle(9), _candle(10, close="72", volume=500)]
    live = Candle(
        time=stored[-1].time, trade_date=stored[-1].trade_date,
        open=Decimal("70"), high=Decimal("75"), low=Decimal("67"),
        close=Decimal("74"), volume=900,
    )
    monkeypatch.setattr("app.services.market_data.bars.live_candle", lambda s, b: live)

    out = _with_live_tail("FPT", tfs.get("1D"), stored)
    assert len(out) == 2
    assert out[-1].open == Decimal("69")   # giữ giá mở đã lưu
    assert out[-1].high == Decimal("75")   # biên rộng hơn
    assert out[-1].low == Decimal("67")
    assert out[-1].close == Decimal("74")  # giá mới nhất
    assert out[-1].volume == 900


def test_nen_da_luu_moi_hon_thi_bo_qua_duoi_song(monkeypatch):
    """Chuỗi đã lưu mới hơn cây nến đang chạy thì giữ nguyên.

    Xảy ra khi kho giá còn đang giữ ảnh chụp của phiên trước mà cơ sở dữ liệu đã có nến của
    phiên mới — ghép vào là chèn một cây nến lùi về quá khứ vào giữa chuỗi.
    """
    stored = [_candle(9), _candle(11)]
    live = _candle(10)
    monkeypatch.setattr("app.services.market_data.bars.live_candle", lambda s, b: live)

    assert _with_live_tail("FPT", tfs.get("1D"), stored) == stored


def test_cuon_ve_qua_khu_thi_khong_ghep_duoi_song(monkeypatch):
    """Cuộn ngược bằng `before` thì cây nến của lúc này không thuộc về đoạn đang xem.

    Chốt chặn nằm ở `read_bars` chứ không ở `_with_live_tail`, nên phải kiểm ở đúng tầng đó —
    nếu không thì mỗi lần người dùng kéo biểu đồ về năm ngoái lại có một cây nến hôm nay dính
    vào cuối đoạn.
    """
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.models import Base
    from app.models.market import OhlcvDaily
    from app.services.market_data.bars import read_bars

    engine = create_engine("sqlite:///:memory:", future=True)
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine, future=True)()

    for day in (7, 8, 9):
        db.add(OhlcvDaily(
            symbol="FPT", trade_date=date(2026, 9, day),
            open=Decimal("69"), high=Decimal("71"), low=Decimal("68"), close=Decimal("70"),
            volume=1000, source="VPS",
        ))
    db.commit()

    monkeypatch.setattr(settings, "market_realtime_enabled", True)
    monkeypatch.setattr(
        "app.services.market_data.bars.live_candle", lambda s, b: _candle(10, close="99")
    )

    latest = read_bars(db, "FPT", "1D", limit=10, auto_fetch=False)
    assert latest[-1].trade_date == date(2026, 9, 10), "đoạn mới nhất phải có đuôi sống"

    past = read_bars(
        db, "FPT", "1D", limit=10, auto_fetch=False,
        before=datetime(2026, 9, 9, tzinfo=timezone.utc),
    )
    assert [c.trade_date for c in past] == [date(2026, 9, 7), date(2026, 9, 8)]
    db.close()


def test_tat_co_thi_khong_co_duoi_song(monkeypatch, store):
    """Tắt cờ là bảng giá và biểu đồ quay về đúng hành vi trước khi có real-time."""
    monkeypatch.setattr(settings, "market_realtime_enabled", False)
    from app.services.market_data.bars import live_candle

    assert live_candle("HPG", tfs.get("1D")) is None


# ======================================================================
# Hợp đồng với frontend — cùng lý do tồn tại của `tests/test_api_contract.py`
# ======================================================================
def test_goi_tin_websocket_tra_ve_so_khong_phai_chuoi():
    """Giá trong gói tin WebSocket phải là **số**, không phải chuỗi.

    Đường REST có `Money` của Pydantic lo việc này; đường WebSocket thì không có Pydantic ở
    giữa, và `json.dumps(default=str)` sẽ lặng lẽ biến `Decimal('21.95')` thành `"21.95"`.
    TypeScript không bắt được vì kiểu khai là `number`, còn hậu quả thì xuất hiện ở chỗ không ai
    ngờ: trong JavaScript `"9.5" > "10.5"` là **đúng**, nên ô giá nháy xanh cho một mã vừa giảm.
    """
    import json

    payload = VpsBoardProvider._parse(HPG_ROW, NOW).as_dict()

    for field in ("price", "reference", "ceiling", "floor", "open", "high", "low",
                  "avg_price", "change", "value"):
        assert isinstance(payload[field], float), f"{field} phải là số, đang là {type(payload[field])}"
    assert isinstance(payload["bids"][0]["price"], float)
    assert isinstance(payload["asks"][0]["price"], float)

    # Và phải đi qua được json.dumps mà không cần `default=str` cứu.
    encoded = json.loads(json.dumps(payload))
    assert encoded["price"] == 21.95
    assert encoded["change"] < 0
