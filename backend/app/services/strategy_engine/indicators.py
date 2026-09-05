"""Chỉ báo kỹ thuật — nền cho bộ lọc chiến lược.

Tự cài thay vì kéo pandas/numpy: dữ liệu vào là danh sách nến của **một mã**, vài trăm phần tử.
Ở quy mô đó, vòng lặp thuần Python nhanh hơn chi phí dựng DataFrame, và tránh thêm 50MB phụ
thuộc chỉ để tính trung bình động.

Mọi hàm trả về danh sách **cùng độ dài với đầu vào**, các vị trí chưa đủ dữ liệu là `None`.
Giữ nguyên độ dài để chỉ số i luôn ứng với nến i — sai lệch chỉ số là nguồn lỗi âm thầm nguy
hiểm nhất khi tính tín hiệu.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Series:
    """Chuỗi giá của một mã, đã sắp xếp tăng dần theo thời gian."""

    dates: list[str]
    open: list[float]
    high: list[float]
    low: list[float]
    close: list[float]
    volume: list[float]

    def __len__(self) -> int:
        return len(self.close)


def sma(values: list[float], period: int) -> list[float | None]:
    """Trung bình động đơn giản."""
    if period <= 0:
        raise ValueError("Chu kỳ phải lớn hơn 0")

    result: list[float | None] = [None] * len(values)
    running = 0.0
    for i, value in enumerate(values):
        running += value
        if i >= period:
            running -= values[i - period]
        if i >= period - 1:
            result[i] = running / period
    return result


def ema(values: list[float], period: int) -> list[float | None]:
    """Trung bình động luỹ thừa. Khởi tạo bằng SMA của `period` phần tử đầu."""
    if period <= 0:
        raise ValueError("Chu kỳ phải lớn hơn 0")

    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result

    multiplier = 2 / (period + 1)
    previous = sum(values[:period]) / period
    result[period - 1] = previous

    for i in range(period, len(values)):
        previous = (values[i] - previous) * multiplier + previous
        result[i] = previous
    return result


def rsi(values: list[float], period: int = 14) -> list[float | None]:
    """Chỉ số sức mạnh tương đối, dùng trung bình Wilder."""
    result: list[float | None] = [None] * len(values)
    if len(values) <= period:
        return result

    gains = losses = 0.0
    for i in range(1, period + 1):
        change = values[i] - values[i - 1]
        gains += max(change, 0)
        losses += max(-change, 0)

    avg_gain = gains / period
    avg_loss = losses / period
    result[period] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)

    for i in range(period + 1, len(values)):
        change = values[i] - values[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0)) / period
        result[i] = 100.0 if avg_loss == 0 else 100 - 100 / (1 + avg_gain / avg_loss)
    return result


def macd(
    values: list[float], fast: int = 12, slow: int = 26, signal: int = 9
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Trả về (đường MACD, đường tín hiệu, histogram)."""
    fast_ema = ema(values, fast)
    slow_ema = ema(values, slow)

    macd_line: list[float | None] = [
        (f - s) if (f is not None and s is not None) else None
        for f, s in zip(fast_ema, slow_ema)
    ]

    # Đường tín hiệu là EMA của MACD — chỉ tính trên phần đã có giá trị.
    valid = [v for v in macd_line if v is not None]
    signal_valid = ema(valid, signal)
    offset = len(macd_line) - len(valid)

    signal_line: list[float | None] = [None] * len(macd_line)
    for i, value in enumerate(signal_valid):
        signal_line[offset + i] = value

    histogram: list[float | None] = [
        (m - s) if (m is not None and s is not None) else None
        for m, s in zip(macd_line, signal_line)
    ]
    return macd_line, signal_line, histogram


def highest(values: list[float], period: int) -> list[float | None]:
    """Đỉnh của `period` phiên **trước** phiên hiện tại.

    Cố tình loại phiên hiện tại ra khỏi cửa sổ. Nếu tính cả phiên hiện tại thì điều kiện phá đỉnh
    quen thuộc `giá đóng cửa > đỉnh 20 phiên` không bao giờ đúng — giá đóng cửa luôn nhỏ hơn hoặc
    bằng giá cao nhất của chính phiên đó, nên chiến lược im lặng không sinh lệnh nào mà người dùng
    không hiểu vì sao.
    """
    result: list[float | None] = [None] * len(values)
    for i in range(len(values)):
        if i >= period:
            result[i] = max(values[i - period : i])
    return result


def lowest(values: list[float], period: int) -> list[float | None]:
    """Đáy của `period` phiên **trước** phiên hiện tại — cùng lý do với `highest`."""
    result: list[float | None] = [None] * len(values)
    for i in range(len(values)):
        if i >= period:
            result[i] = min(values[i - period : i])
    return result


def atr(series: Series, period: int = 14) -> list[float | None]:
    """Biên độ thật trung bình — dùng để đặt cắt lỗ theo biến động của chính mã đó."""
    n = len(series)
    result: list[float | None] = [None] * n
    if n <= period:
        return result

    true_ranges: list[float] = [series.high[0] - series.low[0]]
    for i in range(1, n):
        true_ranges.append(
            max(
                series.high[i] - series.low[i],
                abs(series.high[i] - series.close[i - 1]),
                abs(series.low[i] - series.close[i - 1]),
            )
        )

    previous = sum(true_ranges[1 : period + 1]) / period
    result[period] = previous
    for i in range(period + 1, n):
        previous = (previous * (period - 1) + true_ranges[i]) / period
        result[i] = previous
    return result


def bollinger(
    values: list[float], period: int = 20, deviations: float = 2.0
) -> tuple[list[float | None], list[float | None], list[float | None]]:
    """Trả về (dải trên, đường giữa, dải dưới)."""
    middle = sma(values, period)
    upper: list[float | None] = [None] * len(values)
    lower: list[float | None] = [None] * len(values)

    for i in range(len(values)):
        if middle[i] is None:
            continue
        window = values[i - period + 1 : i + 1]
        mean = middle[i]
        variance = sum((v - mean) ** 2 for v in window) / period
        std = variance**0.5
        upper[i] = mean + deviations * std
        lower[i] = mean - deviations * std

    return upper, middle, lower


#: Danh mục chỉ báo cho giao diện dựng bộ lọc — nhãn tiếng Việt và tham số mặc định.
INDICATOR_CATALOG = [
    {"key": "close", "label": "Giá đóng cửa", "params": []},
    {"key": "open", "label": "Giá mở cửa", "params": []},
    {"key": "high", "label": "Giá cao nhất", "params": []},
    {"key": "low", "label": "Giá thấp nhất", "params": []},
    {"key": "volume", "label": "Khối lượng", "params": []},
    {"key": "sma", "label": "Trung bình động (SMA)", "params": [{"name": "period", "default": 20}]},
    {"key": "ema", "label": "Trung bình động luỹ thừa (EMA)", "params": [{"name": "period", "default": 20}]},
    {"key": "rsi", "label": "RSI", "params": [{"name": "period", "default": 14}]},
    {"key": "macd", "label": "MACD", "params": [
        {"name": "fast", "default": 12}, {"name": "slow", "default": 26}, {"name": "signal", "default": 9},
    ]},
    {"key": "macd_signal", "label": "MACD — đường tín hiệu", "params": [
        {"name": "fast", "default": 12}, {"name": "slow", "default": 26}, {"name": "signal", "default": 9},
    ]},
    {"key": "highest", "label": "Đỉnh N phiên trước", "params": [{"name": "period", "default": 20}]},
    {"key": "lowest", "label": "Đáy N phiên trước", "params": [{"name": "period", "default": 20}]},
    {"key": "atr", "label": "Biên độ thật trung bình (ATR)", "params": [{"name": "period", "default": 14}]},
    {"key": "bb_upper", "label": "Bollinger — dải trên", "params": [
        {"name": "period", "default": 20}, {"name": "deviations", "default": 2},
    ]},
    {"key": "bb_lower", "label": "Bollinger — dải dưới", "params": [
        {"name": "period", "default": 20}, {"name": "deviations", "default": 2},
    ]},
    {"key": "volume_sma", "label": "Khối lượng trung bình N phiên", "params": [
        {"name": "period", "default": 20},
    ]},
]

INDICATOR_KEYS = {item["key"] for item in INDICATOR_CATALOG}


def compute(series: Series, key: str, params: dict) -> list[float | None]:
    """Tính một chỉ báo theo khoá và tham số. Dùng chung cho cả vế trái và vế phải của điều kiện."""
    if key == "close":
        return list(series.close)
    if key == "open":
        return list(series.open)
    if key == "high":
        return list(series.high)
    if key == "low":
        return list(series.low)
    if key == "volume":
        return list(series.volume)

    if key == "sma":
        return sma(series.close, int(params.get("period", 20)))
    if key == "ema":
        return ema(series.close, int(params.get("period", 20)))
    if key == "rsi":
        return rsi(series.close, int(params.get("period", 14)))
    if key == "highest":
        return highest(series.high, int(params.get("period", 20)))
    if key == "lowest":
        return lowest(series.low, int(params.get("period", 20)))
    if key == "atr":
        return atr(series, int(params.get("period", 14)))
    if key == "volume_sma":
        return sma(series.volume, int(params.get("period", 20)))

    if key in ("macd", "macd_signal"):
        macd_line, signal_line, _ = macd(
            series.close,
            int(params.get("fast", 12)),
            int(params.get("slow", 26)),
            int(params.get("signal", 9)),
        )
        return macd_line if key == "macd" else signal_line

    if key in ("bb_upper", "bb_lower"):
        upper, _, lower = bollinger(
            series.close,
            int(params.get("period", 20)),
            float(params.get("deviations", 2)),
        )
        return upper if key == "bb_upper" else lower

    raise ValueError(f"Chỉ báo không hỗ trợ: {key}")
