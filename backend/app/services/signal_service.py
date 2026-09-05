"""Chiến lược & tín hiệu — Phần 13.

BR-840: tín hiệu là **bất biến**. Module này cố tình KHÔNG cung cấp hàm sửa tín hiệu.
Muốn huỷ thì đánh dấu `CANCELLED` kèm lý do, bản ghi gốc giữ nguyên.
Ở tầng CSDL còn một trigger chặn UPDATE các cột gốc (xem migration).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.constants import (
    AlertType,
    SignalDirection,
    SignalExitReason,
    SignalResult,
    SignalType,
)
from app.core.datetime_utils import to_local, utcnow
from app.core.exceptions import Conflict, NotFound, ValidationError
from app.models.strategy import Signal, Strategy, StrategyStat, StrategySymbol


@dataclass(slots=True)
class StatsSummary:
    """BR-843 — thống kê phải trung thực và luôn kèm khoảng thời gian được tính."""

    total_trades: int = 0
    closed_trades: int = 0
    wins: int = 0
    losses: int = 0
    breakeven: int = 0
    open_trades: int = 0
    win_rate: float | None = None
    avg_r: float | None = None
    max_dd: float | None = None
    profit_factor: float | None = None
    period_from: date | None = None
    period_to: date | None = None
    signal_type: str = SignalType.LIVE

    def as_dict(self) -> dict:
        return {
            "total_trades": self.total_trades,
            "closed_trades": self.closed_trades,
            "wins": self.wins,
            "losses": self.losses,
            "breakeven": self.breakeven,
            "open_trades": self.open_trades,
            "win_rate": self.win_rate,
            "avg_r": self.avg_r,
            "max_dd": self.max_dd,
            "profit_factor": self.profit_factor,
            "period_from": self.period_from,
            "period_to": self.period_to,
            "signal_type": self.signal_type,
        }


# ======================================================================
# Tạo tín hiệu
# ======================================================================
def create_signal(
    db: Session,
    *,
    strategy_id: int,
    symbol: str,
    direction: str,
    entry_time: datetime,
    entry_price: Decimal,
    sl: Decimal | None = None,
    tp: Decimal | None = None,
    timeframe: str | None = None,
    signal_type: str = SignalType.LIVE,
    reason_text: str | None = None,
    created_by: int | None = None,
    dispatch_alerts: bool = True,
) -> Signal:
    """Ghi một tín hiệu mới (analyst nhập tay hoặc bot đẩy vào).

    BR-842 — với tín hiệu BACKTEST, `entry_time` phải là thời điểm trong quá khứ và
    dữ liệu dùng để sinh tín hiệu chỉ được là dữ liệu có tại thời điểm đó. Hệ thống
    không thể tự kiểm chứng điều này nên chỉ chặn được trường hợp rõ ràng nhất:
    tín hiệu BACKTEST mang thời điểm tương lai.
    """
    strategy = db.get(Strategy, strategy_id)
    if not strategy:
        raise NotFound("Chiến lược không tồn tại")

    symbol = symbol.strip().upper()
    if direction not in (SignalDirection.BUY, SignalDirection.SELL):
        raise ValidationError("Chiều lệnh phải là BUY hoặc SELL", {"field": "direction"})

    in_scope = db.scalar(
        select(func.count())
        .select_from(StrategySymbol)
        .where(StrategySymbol.strategy_id == strategy_id, StrategySymbol.symbol == symbol)
    )
    if not in_scope:
        raise ValidationError(
            f"Mã {symbol} chưa nằm trong phạm vi áp dụng của chiến lược. "
            "Thêm mã vào chiến lược trước khi nhập tín hiệu.",
            {"field": "symbol"},
        )

    now = utcnow()
    entry_time_utc = entry_time if entry_time.tzinfo else entry_time.replace(tzinfo=now.tzinfo)
    if signal_type == SignalType.BACKTEST and entry_time_utc > now:
        raise ValidationError(
            "Tín hiệu mô phỏng không thể có thời điểm vào lệnh ở tương lai (BR-842)",
            {"field": "entry_time"},
        )

    if entry_price is None or entry_price <= 0:
        raise ValidationError("Giá vào phải lớn hơn 0", {"field": "entry_price"})

    # Kiểm tra tính nhất quán của SL/TP so với chiều lệnh — sai ở đây làm hỏng toàn bộ thống kê R.
    if sl is not None and tp is not None:
        if direction == SignalDirection.BUY and not (sl < entry_price < tp):
            raise ValidationError(
                "Lệnh MUA phải có: cắt lỗ < giá vào < chốt lời", {"field": "sl"}
            )
        if direction == SignalDirection.SELL and not (tp < entry_price < sl):
            raise ValidationError(
                "Lệnh BÁN phải có: chốt lời < giá vào < cắt lỗ", {"field": "sl"}
            )

    signal = Signal(
        strategy_id=strategy_id,
        symbol=symbol,
        timeframe=timeframe or strategy.timeframe,
        signal_type=signal_type,
        direction=direction,
        entry_time=entry_time,
        entry_price=entry_price,
        sl=sl,
        tp=tp,
        result=SignalResult.OPEN,
        reason_text=reason_text,
        created_by=created_by,
    )
    db.add(signal)
    db.flush()

    # Chỉ tín hiệu LIVE mới đẩy thông báo — tín hiệu mô phỏng chưa từng phát ra thực tế (BR-841).
    if dispatch_alerts and signal_type == SignalType.LIVE:
        from app.services import telegram_service

        db.commit()
        telegram_service.enqueue_signal_alerts(db, signal, AlertType.ENTRY)

    return signal


def cancel_signal(db: Session, signal_id: int, reason: str, staff_id: int | None = None) -> Signal:
    """BR-840 — huỷ tín hiệu = đánh dấu, KHÔNG xoá bản ghi."""
    signal = db.get(Signal, signal_id)
    if not signal:
        raise NotFound("Tín hiệu không tồn tại")
    if signal.result != SignalResult.OPEN:
        raise Conflict(
            "Chỉ huỷ được tín hiệu đang mở. Tín hiệu đã chốt kết quả là bất biến (BR-840).",
            "SIGNAL_NOT_OPEN",
        )
    if not (reason or "").strip():
        raise ValidationError("Bắt buộc nhập lý do huỷ", {"field": "reason"})

    signal.result = SignalResult.CANCELLED
    signal.cancel_reason = reason[:255]
    signal.exit_time = utcnow()
    signal.exit_reason = SignalExitReason.MANUAL
    db.flush()
    return signal


def close_signal(
    db: Session, signal: Signal, *, exit_price: Decimal, exit_time: datetime, exit_reason: str
) -> Signal:
    """Chốt kết quả theo dữ liệu giá — do job `close_signals` gọi.

    R-multiple = lãi/lỗ chia cho rủi ro ban đầu (|giá vào − cắt lỗ|). Không có SL thì không tính R.
    """
    if signal.result != SignalResult.OPEN:
        return signal

    signal.exit_price = exit_price
    signal.exit_time = exit_time
    signal.exit_reason = exit_reason

    pnl = (
        exit_price - signal.entry_price
        if signal.direction == SignalDirection.BUY
        else signal.entry_price - exit_price
    )

    if signal.sl is not None:
        risk = abs(signal.entry_price - signal.sl)
        if risk > 0:
            signal.r_multiple = (pnl / risk).quantize(Decimal("0.001"))

    if pnl > 0:
        signal.result = SignalResult.WIN
    elif pnl < 0:
        signal.result = SignalResult.LOSS
    else:
        signal.result = SignalResult.BE

    db.flush()
    return signal


# ======================================================================
# Thống kê — BR-843
# ======================================================================
def compute_stats(
    db: Session,
    strategy_id: int,
    *,
    symbol: str | None = None,
    signal_type: str = SignalType.LIVE,
    period_from: date | None = None,
    period_to: date | None = None,
) -> StatsSummary:
    """Tính thống kê cho MỘT loại tín hiệu.

    BR-841 — hàm này **luôn** lọc theo `signal_type`; không có đường nào gộp LIVE với BACKTEST.
    BR-843 — mặc định là toàn bộ lịch sử; `period_from`/`period_to` chỉ để người dùng xem thêm,
    và khoảng thời gian luôn được trả về kèm số liệu.
    """
    conditions = [Signal.strategy_id == strategy_id, Signal.signal_type == signal_type]
    if symbol:
        conditions.append(Signal.symbol == symbol.upper())
    if period_from:
        conditions.append(Signal.entry_time >= datetime.combine(period_from, datetime.min.time()))
    if period_to:
        conditions.append(Signal.entry_time <= datetime.combine(period_to, datetime.max.time()))

    signals = db.scalars(select(Signal).where(*conditions).order_by(Signal.entry_time)).all()
    return summarize(signals, signal_type=signal_type, period_from=period_from, period_to=period_to)


def summarize(
    signals: Sequence[Signal],
    *,
    signal_type: str,
    period_from: date | None = None,
    period_to: date | None = None,
) -> StatsSummary:
    """Gộp một danh sách tín hiệu **đã lọc sẵn** thành bộ số liệu.

    Tách khỏi `compute_stats` để phần tính toán dùng lại được cho cả đường đọc từng chiến lược
    lẫn đường đọc cả trang (`compute_stats_bulk`). Hàm này không chạm CSDL.
    """
    summary = StatsSummary(signal_type=signal_type, total_trades=len(signals))
    if not signals:
        return summary

    # MySQL trả về datetime naive, còn bản ghi vừa tạo trong cùng session lại tz-aware.
    # Chuẩn hoá trước khi so sánh, nếu không sẽ vỡ với "can't compare offset-naive and
    # offset-aware datetimes" — lỗi chỉ lộ ra khi trộn hai nguồn trong một phiên.
    entry_dates = [to_local(s.entry_time).date() for s in signals]
    summary.period_from = period_from or min(entry_dates)
    summary.period_to = period_to or max(entry_dates)

    r_values: list[Decimal] = []
    gross_profit = gross_loss = Decimal(0)
    equity = Decimal(0)
    peak = Decimal(0)
    max_dd = Decimal(0)

    for s in signals:
        if s.result == SignalResult.OPEN:
            summary.open_trades += 1
            continue
        if s.result == SignalResult.CANCELLED:
            continue

        summary.closed_trades += 1
        if s.result == SignalResult.WIN:
            summary.wins += 1
        elif s.result == SignalResult.LOSS:
            summary.losses += 1
        else:
            summary.breakeven += 1

        if s.r_multiple is not None:
            r = Decimal(s.r_multiple)
            r_values.append(r)
            if r > 0:
                gross_profit += r
            else:
                gross_loss += abs(r)
            equity += r
            peak = max(peak, equity)
            max_dd = max(max_dd, peak - equity)

    if summary.closed_trades:
        summary.win_rate = round(summary.wins / summary.closed_trades * 100, 2)
    if r_values:
        summary.avg_r = float(round(sum(r_values) / len(r_values), 3))
        summary.max_dd = float(round(max_dd, 3))
        summary.profit_factor = (
            float(round(gross_profit / gross_loss, 3)) if gross_loss > 0 else None
        )
    return summary


def compute_stats_bulk(
    db: Session,
    strategy_ids: Sequence[int],
    signal_types: Sequence[str] = (SignalType.LIVE, SignalType.BACKTEST),
) -> dict[tuple[int, str], StatsSummary]:
    """Thống kê cho **nhiều chiến lược** trong đúng một truy vấn.

    Màn danh sách hiển thị mỗi chiến lược kèm hai khối thống kê (LIVE và BACKTEST). Gọi
    `compute_stats` trong vòng lặp nghĩa là 2 truy vấn × số dòng, và mỗi truy vấn kéo **toàn bộ
    lịch sử tín hiệu** của chiến lược đó về Python. Một trang 20 dòng thành 40 lượt quét bảng
    `signals` — đây là truy vấn đắt nhất của cả hệ thống và nó nằm trên màn hình ai cũng mở đầu tiên.

    Lấy một lần rồi gom theo (chiến lược, loại tín hiệu) cho ra **cùng con số**, vì phép tính
    vốn đã chạy trong Python.
    """
    result: dict[tuple[int, str], StatsSummary] = {
        (sid, stype): StatsSummary(signal_type=stype)
        for sid in strategy_ids
        for stype in signal_types
    }
    if not strategy_ids:
        return result

    rows = db.scalars(
        select(Signal)
        .where(Signal.strategy_id.in_(list(strategy_ids)), Signal.signal_type.in_(list(signal_types)))
        .order_by(Signal.entry_time)
    ).all()

    grouped: dict[tuple[int, str], list[Signal]] = {}
    for signal in rows:
        grouped.setdefault((signal.strategy_id, signal.signal_type), []).append(signal)

    for key, signals in grouped.items():
        result[key] = summarize(signals, signal_type=key[1])
    return result


def refresh_stats_cache(db: Session, strategy_id: int) -> None:
    """Ghi thống kê toàn lịch sử vào `strategy_stats` cho cả LIVE và BACKTEST."""
    for stype in (SignalType.LIVE, SignalType.BACKTEST):
        summary = compute_stats(db, strategy_id, signal_type=stype)
        row = db.scalar(
            select(StrategyStat).where(
                StrategyStat.strategy_id == strategy_id,
                StrategyStat.symbol.is_(None),
                StrategyStat.signal_type == stype,
            )
        )
        if not row:
            row = StrategyStat(strategy_id=strategy_id, symbol=None, signal_type=stype)
            db.add(row)
        row.period_from = summary.period_from
        row.period_to = summary.period_to
        row.total_trades = summary.total_trades
        row.win_rate = Decimal(str(summary.win_rate)) if summary.win_rate is not None else None
        row.avg_r = Decimal(str(summary.avg_r)) if summary.avg_r is not None else None
        row.max_dd = Decimal(str(summary.max_dd)) if summary.max_dd is not None else None
        row.profit_factor = (
            Decimal(str(summary.profit_factor)) if summary.profit_factor is not None else None
        )
        row.calculated_at = utcnow()
    db.flush()


# ======================================================================
# Marker cho biểu đồ — mục 13.2, 13.3
# ======================================================================
#: BR-845 — giới hạn số marker render đồng thời.
MAX_MARKERS = 500


def get_markers(
    db: Session,
    strategy_id: int,
    symbol: str,
    *,
    signal_type: str | None = None,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = MAX_MARKERS,
) -> dict:
    """Dữ liệu vẽ marker mua/bán lên biểu đồ.

    Trả kèm `truncated` để FE hiển thị cảnh báo và gợi ý thu hẹp khoảng thời gian —
    biểu đồ 5 năm với 3.000 marker sẽ làm treo trình duyệt trên điện thoại (BR-845).
    """
    conditions = [Signal.strategy_id == strategy_id, Signal.symbol == symbol.upper()]
    if signal_type:
        conditions.append(Signal.signal_type == signal_type)
    if date_from:
        conditions.append(Signal.entry_time >= datetime.combine(date_from, datetime.min.time()))
    if date_to:
        conditions.append(Signal.entry_time <= datetime.combine(date_to, datetime.max.time()))

    total = db.scalar(select(func.count()).select_from(Signal).where(*conditions)) or 0
    signals = db.scalars(
        select(Signal).where(*conditions).order_by(Signal.entry_time.desc()).limit(min(limit, MAX_MARKERS))
    ).all()

    return {
        "total": int(total),
        "returned": len(signals),
        "truncated": int(total) > len(signals),
        "max_markers": MAX_MARKERS,
        "signals": list(reversed(signals)),
    }
