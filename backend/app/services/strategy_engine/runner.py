"""Máy chạy chiến lược — biến bộ lọc thành điểm mua/bán trên biểu đồ (YC12).

Đây là phần trả lời câu hỏi của khách hàng: *"chiến lược này nếu áp vào mã X thì cho kết quả
gì?"*. Máy chạy duyệt từng phiên theo thứ tự thời gian, không được nhìn trước tương lai.

Ba quy ước cần nhớ vì chúng quyết định con số thống kê có trung thực hay không:

1. **Vào lệnh ở phiên kế tiếp.** Điều kiện tính trên giá đóng cửa phiên T thì sớm nhất cũng chỉ
   mua được ở phiên T+1. Vào ngay giá đóng cửa phiên T là nhìn trộm tương lai và luôn cho ra
   kết quả đẹp hơn thực tế.
2. **Cắt lỗ được ưu tiên hơn chốt lời** khi cả hai cùng chạm trong một phiên. Dữ liệu ngày
   không cho biết giá chạm mức nào trước; chọn phía bất lợi để thống kê không bị thổi phồng.
3. **Lệnh cuối còn mở thì không tính vào thắng/thua** (BR-841 — không trộn kết quả chưa ngã ngũ
   với kết quả đã đóng).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from app.services.strategy_engine import rules as rules_module
from app.services.strategy_engine.indicators import Series
from app.services.strategy_engine.rules import StrategyRules

#: Cần tối thiểu bấy nhiêu phiên thì chỉ báo dài nhất mới có giá trị và thống kê mới có nghĩa.
MIN_BARS = 60

#: Trần số lệnh trả về — chiến lược sai có thể sinh tín hiệu mỗi phiên, không nên nhồi hết ra máy khách.
MAX_TRADES = 500


@dataclass(slots=True)
class Trade:
    """Một lần vào–ra lệnh hoàn chỉnh (hoặc còn mở nếu chạm cuối chuỗi dữ liệu)."""

    direction: str
    entry_date: str
    entry_price: float
    exit_date: str | None = None
    exit_price: float | None = None
    exit_reason: str | None = None
    profit_pct: float | None = None
    r_multiple: float | None = None
    bars_held: int = 0
    entry_reason: str = ""

    @property
    def is_open(self) -> bool:
        return self.exit_date is None


@dataclass(slots=True)
class RunResult:
    symbol: str
    from_date: str
    to_date: str
    bars: int
    trades: list[Trade] = field(default_factory=list)
    summary: str = ""

    #: Thống kê chỉ tính trên lệnh đã đóng.
    total_trades: int = 0
    wins: int = 0
    losses: int = 0
    win_rate: float | None = None
    avg_profit_pct: float | None = None
    best_pct: float | None = None
    worst_pct: float | None = None
    profit_factor: float | None = None
    max_drawdown_pct: float | None = None
    total_return_pct: float | None = None
    avg_bars_held: float | None = None
    open_trades: int = 0

    #: Giá trị chỉ báo để vẽ chồng lên biểu đồ — chỉ các đường dạng giá.
    overlays: list[dict] = field(default_factory=list)

    #: Cảnh báo hiển thị kèm kết quả (dữ liệu ngắn, không có lệnh nào…).
    warnings: list[str] = field(default_factory=list)


class NotEnoughData(ValueError):
    """Chuỗi giá quá ngắn để chạy chiến lược."""


#: Các chỉ báo cùng đơn vị với giá — vẽ chồng lên nến được. RSI/MACD nằm thang khác nên bỏ qua.
_OVERLAY_KEYS = {"sma", "ema", "bb_upper", "bb_lower", "highest", "lowest"}


def run(series: Series, strategy: StrategyRules, symbol: str) -> RunResult:
    """Chạy chiến lược trên một chuỗi giá, trả về danh sách lệnh và thống kê."""
    n = len(series)
    if n < MIN_BARS:
        raise NotEnoughData(
            f"Mã {symbol} chỉ có {n} phiên dữ liệu, cần tối thiểu {MIN_BARS} phiên để chạy chiến lược."
        )

    entry_flags = rules_module.evaluate_group(series, strategy.entry)
    exit_flags = (
        rules_module.evaluate_group(series, strategy.exit) if strategy.exit.conditions else [False] * n
    )

    is_long = strategy.direction == "BUY"
    stop_pct = strategy.risk.stop_loss_pct
    target_pct = strategy.risk.take_profit_pct
    max_hold = strategy.risk.max_hold_days

    trades: list[Trade] = []
    open_trade: Trade | None = None
    entry_index = 0

    for i in range(n):
        if open_trade is not None:
            exit_price: float | None = None
            reason: str | None = None
            held = i - entry_index

            entry_price = open_trade.entry_price
            stop_level = (
                entry_price * (1 - stop_pct / 100) if is_long else entry_price * (1 + stop_pct / 100)
            ) if stop_pct else None
            target_level = (
                entry_price * (1 + target_pct / 100) if is_long else entry_price * (1 - target_pct / 100)
            ) if target_pct else None

            # Quy ước 2 — chạm cắt lỗ thì tính cắt lỗ, kể cả khi phiên đó cũng chạm chốt lời.
            if stop_level is not None and (
                (is_long and series.low[i] <= stop_level) or (not is_long and series.high[i] >= stop_level)
            ):
                exit_price, reason = stop_level, "SL"
            elif target_level is not None and (
                (is_long and series.high[i] >= target_level)
                or (not is_long and series.low[i] <= target_level)
            ):
                exit_price, reason = target_level, "TP"
            elif exit_flags[i]:
                exit_price, reason = series.close[i], "RULE"
            elif held >= max_hold:
                exit_price, reason = series.close[i], "TIME"

            if exit_price is not None:
                _close(open_trade, series.dates[i], exit_price, reason or "RULE", held, is_long, stop_pct)
                trades.append(open_trade)
                open_trade = None
                if len(trades) >= MAX_TRADES:
                    break
                # Đã thoát ở phiên này thì phiên này không vào lại — tránh vào/ra liên tục cùng một nến.
                continue

        # Quy ước 1 — tín hiệu ở phiên i-1, vào lệnh ở giá mở cửa phiên i.
        if open_trade is None and i > 0 and entry_flags[i - 1]:
            open_trade = Trade(
                direction=strategy.direction,
                entry_date=series.dates[i],
                entry_price=series.open[i],
                entry_reason=strategy.entry.label(),
            )
            entry_index = i

    if open_trade is not None:
        open_trade.bars_held = n - 1 - entry_index
        trades.append(open_trade)

    result = RunResult(
        symbol=symbol,
        from_date=series.dates[0],
        to_date=series.dates[-1],
        bars=n,
        trades=trades,
        summary=strategy.summary(),
        overlays=_overlays(series, strategy),
    )
    _compute_stats(result)

    if not trades:
        result.warnings.append(
            "Không có lệnh nào trong khoảng dữ liệu này. Điều kiện có thể quá chặt, "
            "hoặc mã này chưa từng thoả bộ lọc."
        )
    elif result.total_trades < 10:
        result.warnings.append(
            f"Chỉ có {result.total_trades} lệnh đã đóng — quá ít để kết luận chiến lược tốt hay xấu."
        )

    return result


def _close(
    trade: Trade,
    exit_date: str,
    exit_price: float,
    reason: str,
    bars_held: int,
    is_long: bool,
    stop_pct: float | None,
) -> None:
    trade.exit_date = exit_date
    trade.exit_price = exit_price
    trade.exit_reason = reason
    trade.bars_held = bars_held

    change = (exit_price - trade.entry_price) / trade.entry_price * 100
    trade.profit_pct = round(change if is_long else -change, 2)

    # R là lãi/lỗ chia cho mức rủi ro ban đầu — chỉ có nghĩa khi chiến lược đặt cắt lỗ.
    if stop_pct:
        trade.r_multiple = round(trade.profit_pct / stop_pct, 2)


def _compute_stats(result: RunResult) -> None:
    closed = [t for t in result.trades if not t.is_open]
    result.open_trades = len(result.trades) - len(closed)
    result.total_trades = len(closed)
    if not closed:
        return

    profits = [t.profit_pct or 0.0 for t in closed]
    wins = [p for p in profits if p > 0]
    losses = [p for p in profits if p <= 0]

    result.wins = len(wins)
    result.losses = len(losses)
    result.win_rate = round(len(wins) / len(closed) * 100, 2)
    result.avg_profit_pct = round(sum(profits) / len(profits), 2)
    result.best_pct = round(max(profits), 2)
    result.worst_pct = round(min(profits), 2)
    result.avg_bars_held = round(sum(t.bars_held for t in closed) / len(closed), 1)

    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    # Không có lệnh lỗ nào thì profit factor là vô cực — để None thay vì bịa một con số lớn.
    result.profit_factor = round(gross_profit / gross_loss, 2) if gross_loss > 0 else None

    # Vốn cộng dồn qua các lệnh, giả định tái đầu tư toàn bộ vào lệnh kế tiếp.
    equity = 100.0
    peak = 100.0
    max_dd = 0.0
    for profit in profits:
        equity *= 1 + profit / 100
        peak = max(peak, equity)
        max_dd = max(max_dd, (peak - equity) / peak * 100)

    result.total_return_pct = round(equity - 100, 2)
    result.max_drawdown_pct = round(max_dd, 2)


def _overlays(series: Series, strategy: StrategyRules) -> list[dict]:
    """Trích các đường chỉ báo cùng thang giá để vẽ chồng lên nến.

    Chỉ lấy chỉ báo thực sự xuất hiện trong bộ lọc — vẽ thêm đường không liên quan chỉ làm
    biểu đồ rối mà không giúp người xem hiểu chiến lược.
    """
    seen: set[tuple] = set()
    overlays: list[dict] = []

    for group in (strategy.entry, strategy.exit):
        for condition in group.conditions:
            for operand in (condition.left, condition.right):
                if operand.is_constant or operand.key not in _OVERLAY_KEYS:
                    continue
                signature = (operand.key, tuple(sorted(operand.params.items())))
                if signature in seen:
                    continue
                seen.add(signature)

                from app.services.strategy_engine import indicators as ind

                values = ind.compute(series, operand.key or "", operand.params)
                overlays.append(
                    {
                        "label": operand.label(),
                        "points": [
                            {"trade_date": series.dates[i], "value": round(v, 4)}
                            for i, v in enumerate(values)
                            if v is not None
                        ],
                    }
                )

    return overlays


def series_from_candles(candles: list) -> Series:
    """Đổi bản ghi OHLCV từ CSDL thành `Series`.

    Giá lưu dạng `Decimal` để cộng trừ tiền không sai số; tính chỉ báo thì đổi sang `float` vì
    luỹ thừa và căn bậc hai trên `Decimal` vừa chậm vừa không chính xác hơn.
    """
    return Series(
        dates=[c.trade_date.isoformat() if isinstance(c.trade_date, date) else str(c.trade_date) for c in candles],
        open=[float(c.open) for c in candles],
        high=[float(c.high) for c in candles],
        low=[float(c.low) for c in candles],
        close=[float(c.close) for c in candles],
        volume=[float(c.volume or 0) for c in candles],
    )
