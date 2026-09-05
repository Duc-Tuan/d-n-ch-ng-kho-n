"""Kiểm thử máy chạy chiến lược.

Phần này khoá lại những quy ước mà **nếu sai thì không có gì báo lỗi** — hệ thống vẫn chạy, vẫn
ra số đẹp, chỉ có điều số đó là bịa. Đó là loại lỗi nguy hiểm nhất trong một sản phẩm tư vấn đầu
tư: khách hàng ra quyết định bằng tiền thật dựa trên thống kê sai.

Ba thứ được bảo vệ ở đây:
  1. Không nhìn trước tương lai (vào lệnh ở phiên kế tiếp).
  2. Cắt lỗ được ưu tiên khi cùng phiên chạm cả cắt lỗ lẫn chốt lời.
  3. Lệnh còn mở không được tính vào thống kê thắng thua.
"""

from __future__ import annotations

import pytest

from app.services.strategy_engine import indicators, rules as rules_module, runner
from app.services.strategy_engine.indicators import Series


def make_series(closes: list[float], *, highs=None, lows=None, opens=None, volumes=None) -> Series:
    n = len(closes)
    return Series(
        dates=[f"2026-01-{i + 1:02d}" if i < 31 else f"2026-02-{i - 30:02d}" for i in range(n)],
        open=opens or list(closes),
        high=highs or [c * 1.01 for c in closes],
        low=lows or [c * 0.99 for c in closes],
        close=closes,
        volume=volumes or [1000.0] * n,
    )


# ======================================================================
# Chỉ báo
# ======================================================================
def test_sma_giu_nguyen_do_dai_va_de_trong_phan_chua_du_du_lieu():
    """Sai lệch chỉ số giữa chỉ báo và nến là nguồn lỗi âm thầm — độ dài phải luôn khớp."""
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    result = indicators.sma(values, 3)

    assert len(result) == len(values)
    assert result[:2] == [None, None]
    assert result[2] == pytest.approx(2.0)
    assert result[4] == pytest.approx(4.0)


def test_ema_khoi_tao_bang_sma_dau_chu_ky():
    values = [float(i) for i in range(1, 11)]
    result = indicators.ema(values, 5)

    assert result[3] is None
    assert result[4] == pytest.approx(3.0)  # SMA của 1..5


def test_rsi_bang_100_khi_khong_co_phien_giam():
    values = [float(i) for i in range(1, 20)]
    result = indicators.rsi(values, 14)
    assert result[14] == pytest.approx(100.0)


def test_dinh_n_phien_khong_tinh_phien_hien_tai():
    """Nếu tính cả phiên hiện tại thì điều kiện phá đỉnh không bao giờ đúng.

    `close > highest(high, N)` là bộ lọc phá đỉnh phổ biến nhất. Giá đóng cửa luôn nhỏ hơn hoặc
    bằng giá cao nhất của chính phiên đó, nên nếu cửa sổ gồm cả phiên hiện tại thì chiến lược im
    lặng không sinh lệnh nào — không lỗi, không cảnh báo, chỉ là kết quả rỗng khó hiểu.
    """
    highs = [10.0, 11.0, 12.0, 9.0]
    result = indicators.highest(highs, 3)

    assert result[:3] == [None, None, None]
    assert result[3] == pytest.approx(12.0)  # đỉnh của 3 phiên TRƯỚC, không gồm phiên thứ 4


# ======================================================================
# Phân tích bộ lọc
# ======================================================================
@pytest.mark.parametrize(
    "raw",
    [
        {},
        {"entry": {"conditions": []}},
        {"entry": {"conditions": [{"left": {"key": "khong_ton_tai"}, "operator": "gt", "right": {"value": 1}}]}},
        {"entry": {"conditions": [{"left": {"key": "close"}, "operator": "eval", "right": {"value": 1}}]}},
        {"entry": {"conditions": [{"left": {"value": 5}, "operator": "gt", "right": {"value": 1}}]}},
        {
            "entry": {"conditions": [{"left": {"key": "sma", "params": {"period": 99999}},
                                      "operator": "gt", "right": {"value": 1}}]}
        },
    ],
)
def test_bo_loc_sai_bi_chan(raw):
    """Bộ lọc đến từ người dùng nên mọi trường hợp sai đều phải bị chặn, không được ném lỗi lạ."""
    with pytest.raises(rules_module.RuleError):
        rules_module.parse_rules(raw)


def test_bo_loc_khong_nhan_bieu_thuc_tu_do():
    """Không có đường nào để người dùng gửi mã thực thi vào máy chủ."""
    with pytest.raises(rules_module.RuleError):
        rules_module.parse_rules(
            {"entry": {"conditions": [
                {"left": {"key": "__import__('os').system('ls')"}, "operator": "gt", "right": {"value": 1}}
            ]}}
        )


def test_cat_len_can_phien_truoc_de_xac_dinh():
    """Phiên đầu chuỗi không thể có tín hiệu cắt — chưa có gì để so sánh."""
    series = make_series([10.0, 11.0, 12.0])
    parsed = rules_module.parse_rules(
        {"entry": {"conditions": [{"left": {"key": "close"}, "operator": "cross_above", "right": {"value": 10.5}}]}}
    )
    flags = rules_module.evaluate_group(series, parsed.entry)

    assert flags[0] is False
    assert flags[1] is True   # 10 <= 10.5 rồi 11 > 10.5
    assert flags[2] is False  # đã ở trên rồi, không phải cắt lên nữa


# ======================================================================
# Máy chạy
# ======================================================================
def _entry_at_index(index: int, total: int) -> rules_module.StrategyRules:
    """Bộ lọc nhân tạo chỉ thoả đúng một phiên, dùng để soi thời điểm vào lệnh."""
    del total
    return rules_module.parse_rules(
        {
            "direction": "BUY",
            "entry": {"conditions": [{"left": {"key": "volume"}, "operator": "gt", "right": {"value": 5000}}]},
            "risk": {"max_hold_days": 5},
        }
    )


def test_vao_lenh_o_phien_ke_tiep_khong_nhin_truoc_tuong_lai():
    """Điều kiện tính trên phiên T thì sớm nhất cũng chỉ mua được ở phiên T+1.

    Vào ngay giá đóng cửa phiên T nghĩa là dùng thông tin chưa thể biết vào lúc đặt lệnh, và
    luôn cho ra kết quả đẹp hơn thực tế.
    """
    closes = [100.0] * 70
    volumes = [1000.0] * 70
    volumes[30] = 9999.0  # chỉ phiên 30 thoả điều kiện khối lượng

    series = make_series(closes, volumes=volumes, opens=[101.0] * 70)
    result = runner.run(series, _entry_at_index(30, 70), "TEST")

    assert result.trades, "Phải sinh đúng một lệnh"
    trade = result.trades[0]
    assert trade.entry_date == series.dates[31], "Vào lệnh ở phiên KẾ TIẾP, không phải phiên tín hiệu"
    assert trade.entry_price == pytest.approx(series.open[31]), "Vào ở giá mở cửa, không phải giá đóng cửa"


def test_cat_lo_duoc_uu_tien_khi_cung_phien_cham_ca_hai_muc():
    """Dữ liệu ngày không cho biết giá chạm mức nào trước.

    Chọn phía bất lợi để thống kê không bị thổi phồng. Nếu ưu tiên chốt lời, mọi chiến lược có
    biên độ rộng đều hiện ra tỷ lệ thắng cao giả tạo.
    """
    n = 70
    closes = [100.0] * n
    volumes = [1000.0] * n
    volumes[30] = 9999.0

    highs = [100.5] * n
    lows = [99.5] * n
    # Phiên 32 quét cả hai mức: dưới cắt lỗ 5% và trên chốt lời 5%.
    highs[32] = 200.0
    lows[32] = 50.0

    series = make_series(closes, highs=highs, lows=lows, opens=[100.0] * n, volumes=volumes)
    rules = rules_module.parse_rules(
        {
            "direction": "BUY",
            "entry": {"conditions": [{"left": {"key": "volume"}, "operator": "gt", "right": {"value": 5000}}]},
            "risk": {"stop_loss_pct": 5, "take_profit_pct": 5, "max_hold_days": 30},
        }
    )

    result = runner.run(series, rules, "TEST")
    trade = result.trades[0]

    assert trade.exit_reason == "SL"
    assert trade.profit_pct == pytest.approx(-5.0, abs=0.01)


def test_lenh_con_mo_khong_tinh_vao_thong_ke_thang_thua():
    """BR-841 — không trộn kết quả chưa ngã ngũ với kết quả đã đóng."""
    n = 70
    closes = [100.0] * n
    volumes = [1000.0] * n
    volumes[n - 3] = 9999.0  # tín hiệu sát cuối chuỗi, lệnh chưa kịp đóng

    series = make_series(closes, volumes=volumes, opens=[100.0] * n)
    rules = rules_module.parse_rules(
        {
            "direction": "BUY",
            "entry": {"conditions": [{"left": {"key": "volume"}, "operator": "gt", "right": {"value": 5000}}]},
            "risk": {"max_hold_days": 100},
        }
    )

    result = runner.run(series, rules, "TEST")

    assert result.open_trades == 1
    assert result.total_trades == 0, "Lệnh còn mở không được tính vào số lệnh đã đóng"
    assert result.win_rate is None, "Chưa có lệnh đóng thì không có tỷ lệ thắng"


def test_chuoi_gia_qua_ngan_bi_tu_choi():
    """Chỉ báo dài chưa có giá trị thì thống kê vô nghĩa — báo rõ thay vì trả kết quả rỗng."""
    series = make_series([100.0] * 10)
    rules = rules_module.parse_rules(
        {"entry": {"conditions": [{"left": {"key": "close"}, "operator": "gt", "right": {"value": 1}}]}}
    )

    with pytest.raises(runner.NotEnoughData):
        runner.run(series, rules, "TEST")


def test_khong_vao_lenh_moi_o_chinh_phien_vua_thoat():
    """Chặn vòng vào/ra liên tục trong cùng một nến — không phản ánh giao dịch thật."""
    n = 70
    volumes = [9999.0] * n  # điều kiện thoả MỌI phiên
    series = make_series([100.0] * n, volumes=volumes, opens=[100.0] * n)
    rules = rules_module.parse_rules(
        {
            "direction": "BUY",
            "entry": {"conditions": [{"left": {"key": "volume"}, "operator": "gt", "right": {"value": 5000}}]},
            "risk": {"max_hold_days": 1},
        }
    )

    result = runner.run(series, rules, "TEST")

    entry_dates = [t.entry_date for t in result.trades]
    assert len(entry_dates) == len(set(entry_dates)), "Không được có hai lệnh vào cùng một phiên"
    for trade in result.trades:
        if trade.exit_date:
            assert trade.entry_date < trade.exit_date


def test_thong_ke_tinh_dung_tren_ket_qua_da_biet():
    """Kiểm tra số học của phần thống kê bằng một chuỗi lệnh dựng sẵn."""
    result = runner.RunResult(symbol="TEST", from_date="2026-01-01", to_date="2026-03-01", bars=100)
    result.trades = [
        runner.Trade(direction="BUY", entry_date="d1", entry_price=100, exit_date="d2",
                     exit_price=110, exit_reason="TP", profit_pct=10.0, bars_held=3),
        runner.Trade(direction="BUY", entry_date="d3", entry_price=100, exit_date="d4",
                     exit_price=95, exit_reason="SL", profit_pct=-5.0, bars_held=2),
        runner.Trade(direction="BUY", entry_date="d5", entry_price=100, exit_date="d6",
                     exit_price=105, exit_reason="TP", profit_pct=5.0, bars_held=4),
    ]
    runner._compute_stats(result)

    assert result.total_trades == 3
    assert result.wins == 2 and result.losses == 1
    assert result.win_rate == pytest.approx(66.67, abs=0.01)
    assert result.avg_profit_pct == pytest.approx(3.33, abs=0.01)
    assert result.profit_factor == pytest.approx(3.0)  # (10 + 5) / 5
    assert result.best_pct == pytest.approx(10.0)
    assert result.worst_pct == pytest.approx(-5.0)
