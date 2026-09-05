"""Chạy chiến lược lên một mã bất kỳ và trả kết quả cho biểu đồ (YC12).

Tầng này nối ba thứ vốn tách rời: bộ lọc lưu trong CSDL, dữ liệu giá của mã, và máy chạy thuần
tính toán. Nó cũng là nơi thi hành quy tắc **ai được xem gì**.

BR-848 — chiến lược của hệ thống là chất xám công ty. Khách hàng chạy được nó lên mã bất kỳ để
đánh giá khách quan (đó là giá trị họ trả tiền), nhưng phần trả về **không kèm** nội dung bộ lọc:
không có `rules`, không có `summary`, không có tên chỉ báo trong lý do vào lệnh. Với chiến lược
do chính khách hàng tạo thì ngược lại — họ là tác giả nên thấy toàn bộ.
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import StrategyOwnerType
from app.core.exceptions import AppError
from app.models.market import OhlcvDaily, Symbol
from app.models.strategy import Strategy
from app.services import strategy_engine as engine

#: Trần số phiên nạp cho một lần chạy. Hơn 5 năm dữ liệu ngày thì thống kê không còn phản ánh
#: đặc tính hiện tại của mã, mà thời gian tính lại tăng tuyến tính.
MAX_BARS = 1300


class RunError(AppError):
    """Lỗi người dùng sửa được — bộ lọc sai, mã không có dữ liệu. Không phải lỗi hệ thống.

    Dùng `AppError` của hệ thống thay vì `HTTPException` trần để giao diện nhận đúng mã lỗi
    `STRATEGY_RUN_ERROR` và hiển thị được thông báo, giống mọi lỗi nghiệp vụ khác.
    """

    def __init__(self, message: str) -> None:
        super().__init__(message, "STRATEGY_RUN_ERROR", 400)


def load_series(db: Session, symbol: str, *, limit: int = MAX_BARS) -> engine.Series:
    """Nạp chuỗi giá ngày của một mã theo thứ tự thời gian tăng dần."""
    code = symbol.strip().upper()
    if not code:
        raise RunError("Chưa chọn mã chứng khoán")

    exists = db.scalar(select(Symbol.symbol).where(Symbol.symbol == code))
    if not exists:
        raise RunError(f"Không tìm thấy mã {code} trong danh sách niêm yết")

    # Lấy N phiên gần nhất rồi đảo lại — rẻ hơn nhiều so với sắp xếp tăng dần trên toàn bảng.
    rows = db.scalars(
        select(OhlcvDaily)
        .where(OhlcvDaily.symbol == code)
        .order_by(OhlcvDaily.trade_date.desc())
        .limit(limit)
    ).all()

    if not rows:
        raise RunError(
            f"Mã {code} chưa có dữ liệu giá trong hệ thống. Dữ liệu được đồng bộ sau mỗi phiên."
        )

    return engine.series_from_candles(list(reversed(rows)))


def parse_or_400(raw: object) -> engine.StrategyRules:
    """Đọc bộ lọc, đổi lỗi cấu trúc thành 400 kèm thông báo tiếng Việt cho người dùng."""
    try:
        return engine.parse_rules(raw)
    except engine.RuleError as exc:
        raise RunError(str(exc)) from exc


def run_rules(
    db: Session,
    rules: engine.StrategyRules,
    symbol: str,
    *,
    reveal_rules: bool,
    from_date: date | None = None,
) -> dict:
    """Chạy một bộ lọc lên một mã. `reveal_rules=False` thì che toàn bộ nội dung bộ lọc."""
    series = load_series(db, symbol)

    if from_date:
        # Cắt theo ngày **sau khi** đã nạp đủ lịch sử: chỉ báo cần phiên trước đó để có giá trị,
        # cắt trước khi tính sẽ làm mất tín hiệu ở đầu khoảng.
        cutoff = from_date.isoformat()
        if series.dates[-1] < cutoff:
            raise RunError(f"Mã {symbol.upper()} không có dữ liệu sau ngày {cutoff}")

    try:
        result = engine.run(series, rules, symbol.strip().upper())
    except engine.NotEnoughData as exc:
        raise RunError(str(exc)) from exc

    return _serialize(result, rules, reveal_rules=reveal_rules, from_date=from_date)


def run_strategy(
    db: Session,
    strategy: Strategy,
    symbol: str,
    *,
    reveal_rules: bool,
    from_date: date | None = None,
) -> dict:
    """Chạy chiến lược đã lưu lên một mã.

    `reveal_rules` do tầng gọi quyết định, không suy ra ở đây — điều kiện quyền hạn nằm ở API,
    tầng này chỉ thi hành. Riêng một điều luôn đúng: chiến lược của hệ thống thì không bao giờ
    lộ bộ lọc cho khách hàng, nên tầng gọi phải truyền `False`.
    """
    if not strategy.rules_json:
        raise RunError(
            f"Chiến lược “{strategy.name}” chưa thiết lập bộ lọc nên chưa chạy phân tích tự động được. "
            "Tín hiệu của chiến lược này do chuyên viên phân tích phát thủ công."
        )

    rules = parse_or_400(strategy.rules_json)
    payload = run_rules(db, rules, symbol, reveal_rules=reveal_rules, from_date=from_date)
    payload["strategy"] = {
        "id": strategy.id,
        "code": strategy.code,
        "name": strategy.name,
        "school": strategy.school,
        "is_system": strategy.owner_type == StrategyOwnerType.SYSTEM,
    }
    return payload


def _serialize(
    result: engine.RunResult,
    rules: engine.StrategyRules,
    *,
    reveal_rules: bool,
    from_date: date | None,
) -> dict:
    trades = [t for t in result.trades if not from_date or t.entry_date >= from_date.isoformat()]

    markers = []
    for trade in trades:
        markers.append(
            {
                "trade_date": trade.entry_date,
                "kind": "ENTRY",
                "direction": trade.direction,
                "price": trade.entry_price,
                # Lý do vào lệnh chính là bộ lọc — che luôn khi không được xem.
                "label": "MUA" if trade.direction == "BUY" else "BÁN",
                "note": trade.entry_reason if reveal_rules else None,
            }
        )
        if not trade.is_open:
            markers.append(
                {
                    "trade_date": trade.exit_date,
                    "kind": "EXIT",
                    "direction": trade.direction,
                    "price": trade.exit_price,
                    "label": _EXIT_LABEL.get(trade.exit_reason or "", "Thoát"),
                    "note": f"{trade.profit_pct:+.2f}%" if trade.profit_pct is not None else None,
                }
            )

    payload: dict = {
        "symbol": result.symbol,
        "from_date": result.from_date,
        "to_date": result.to_date,
        "bars": result.bars,
        "direction": rules.direction,
        "markers": markers,
        "trades": [
            {
                "direction": t.direction,
                "entry_date": t.entry_date,
                "entry_price": t.entry_price,
                "exit_date": t.exit_date,
                "exit_price": t.exit_price,
                "exit_reason": t.exit_reason,
                "exit_reason_label": _EXIT_LABEL.get(t.exit_reason or "", None),
                "profit_pct": t.profit_pct,
                "r_multiple": t.r_multiple,
                "bars_held": t.bars_held,
                "is_open": t.is_open,
            }
            for t in trades
        ],
        "stats": {
            "total_trades": result.total_trades,
            "wins": result.wins,
            "losses": result.losses,
            "win_rate": result.win_rate,
            "avg_profit_pct": result.avg_profit_pct,
            "best_pct": result.best_pct,
            "worst_pct": result.worst_pct,
            "profit_factor": result.profit_factor,
            "max_drawdown_pct": result.max_drawdown_pct,
            "total_return_pct": result.total_return_pct,
            "avg_bars_held": result.avg_bars_held,
            "open_trades": result.open_trades,
        },
        "warnings": result.warnings,
        # BR-841 — kết quả này là mô phỏng trên dữ liệu quá khứ, không phải tín hiệu đã phát.
        "signal_type": "BACKTEST",
        "disclaimer": (
            "Kết quả mô phỏng trên dữ liệu lịch sử, đã tính theo nguyên tắc vào lệnh ở phiên kế "
            "tiếp sau khi điều kiện thoả. Hiệu quả quá khứ không đảm bảo cho tương lai và chưa "
            "trừ phí giao dịch, thuế hay trượt giá."
        ),
    }

    # Chỉ lộ bộ lọc và đường chỉ báo cho người có quyền xem nội dung chiến lược.
    if reveal_rules:
        payload["summary"] = result.summary
        payload["overlays"] = result.overlays
    else:
        payload["summary"] = None
        payload["overlays"] = []

    return payload


_EXIT_LABEL = {
    "SL": "Cắt lỗ",
    "TP": "Chốt lời",
    "RULE": "Thoát theo điều kiện",
    "TIME": "Hết hạn giữ",
}


def catalog() -> dict:
    """Danh mục chỉ báo và toán tử cho giao diện dựng bộ lọc — dùng chung cho cả hai site."""
    return {
        "indicators": engine.INDICATOR_CATALOG,
        "operators": engine.OPERATORS,
        "min_bars": engine.MIN_BARS,
        "logics": [
            {"key": "AND", "label": "Thoả tất cả điều kiện"},
            {"key": "OR", "label": "Thoả một điều kiện bất kỳ"},
        ],
        "directions": [
            {"key": "BUY", "label": "Mua (kỳ vọng giá tăng)"},
            {"key": "SELL", "label": "Bán (kỳ vọng giá giảm)"},
        ],
    }
