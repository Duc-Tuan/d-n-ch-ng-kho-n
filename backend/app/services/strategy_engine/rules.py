"""Định nghĩa bộ lọc chiến lược và bộ diễn giải điều kiện.

Một chiến lược ở đây là **dữ liệu, không phải mã nguồn**: người dùng dựng điều kiện trên giao
diện, hệ thống lưu JSON, máy chạy đọc JSON rồi tính. Cố tình không cho nhập biểu thức Python
hay công thức tự do — nhận chuỗi rồi `eval` là mở cửa cho người dùng chạy mã tuỳ ý trên máy chủ.

Cấu trúc một chiến lược:

```json
{
  "entry":  {"logic": "AND", "conditions": [ ... ]},
  "exit":   {"logic": "OR",  "conditions": [ ... ]},
  "risk":   {"stop_loss_pct": 7, "take_profit_pct": 15, "max_hold_days": 60},
  "direction": "BUY"
}
```

Một điều kiện:

```json
{
  "left":     {"key": "close", "params": {}},
  "operator": "cross_above",
  "right":    {"key": "sma", "params": {"period": 20}}
}
```

Vế phải có thể là hằng số: `{"value": 30}`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from app.services.strategy_engine import indicators
from app.services.strategy_engine.indicators import Series

#: Toán tử so sánh — nhãn tiếng Việt hiển thị trên giao diện dựng bộ lọc.
OPERATORS = [
    {"key": "gt", "label": "lớn hơn"},
    {"key": "gte", "label": "lớn hơn hoặc bằng"},
    {"key": "lt", "label": "nhỏ hơn"},
    {"key": "lte", "label": "nhỏ hơn hoặc bằng"},
    {"key": "cross_above", "label": "cắt lên trên"},
    {"key": "cross_below", "label": "cắt xuống dưới"},
    {"key": "increasing", "label": "đang tăng so với phiên trước"},
    {"key": "decreasing", "label": "đang giảm so với phiên trước"},
]

OPERATOR_KEYS = {item["key"] for item in OPERATORS}

#: Chặn tham số phi lý trước khi tính: chu kỳ 100.000 phiên chỉ tốn máy, không cho kết quả.
MAX_PERIOD = 500
MAX_CONDITIONS = 10


class RuleError(ValueError):
    """Bộ lọc sai cấu trúc. Thông báo viết cho người dùng cuối đọc, không phải cho lập trình viên."""


@dataclass(slots=True)
class Operand:
    """Một vế của điều kiện: hoặc chỉ báo, hoặc hằng số."""

    key: str | None = None
    params: dict[str, Any] = field(default_factory=dict)
    value: float | None = None

    @property
    def is_constant(self) -> bool:
        return self.key is None

    def label(self) -> str:
        if self.is_constant:
            return f"{self.value:g}"
        meta = next((i for i in indicators.INDICATOR_CATALOG if i["key"] == self.key), None)
        name = meta["label"] if meta else self.key
        if self.params:
            args = ", ".join(str(v) for v in self.params.values())
            return f"{name}({args})"
        return str(name)


@dataclass(slots=True)
class Condition:
    left: Operand
    operator: str
    right: Operand

    def label(self) -> str:
        op = next((o for o in OPERATORS if o["key"] == self.operator), None)
        op_label = op["label"] if op else self.operator
        if self.operator in ("increasing", "decreasing"):
            return f"{self.left.label()} {op_label}"
        return f"{self.left.label()} {op_label} {self.right.label()}"


@dataclass(slots=True)
class ConditionGroup:
    logic: Literal["AND", "OR"] = "AND"
    conditions: list[Condition] = field(default_factory=list)

    def label(self) -> str:
        joiner = " VÀ " if self.logic == "AND" else " HOẶC "
        return joiner.join(c.label() for c in self.conditions)


@dataclass(slots=True)
class RiskRules:
    """Quy tắc thoát lệnh theo rủi ro.

    Luôn có ít nhất một đường thoát: nếu người dùng không đặt gì, `max_hold_days` mặc định 60
    phiên. Chiến lược chỉ có điểm vào mà không có điểm ra thì thống kê thắng/thua vô nghĩa.
    """

    stop_loss_pct: float | None = None
    take_profit_pct: float | None = None
    max_hold_days: int = 60

    def label(self) -> str:
        parts = []
        if self.stop_loss_pct:
            parts.append(f"cắt lỗ {self.stop_loss_pct:g}%")
        if self.take_profit_pct:
            parts.append(f"chốt lời {self.take_profit_pct:g}%")
        parts.append(f"giữ tối đa {self.max_hold_days} phiên")
        return ", ".join(parts)


@dataclass(slots=True)
class StrategyRules:
    entry: ConditionGroup
    exit: ConditionGroup = field(default_factory=ConditionGroup)
    risk: RiskRules = field(default_factory=RiskRules)
    direction: Literal["BUY", "SELL"] = "BUY"

    def summary(self) -> str:
        """Câu mô tả bộ lọc bằng tiếng Việt — hiện dưới biểu đồ để người xem hiểu đang chạy gì."""
        lines = [f"Vào lệnh khi: {self.entry.label()}"]
        if self.exit.conditions:
            lines.append(f"Thoát khi: {self.exit.label()}")
        lines.append(f"Quản trị rủi ro: {self.risk.label()}")
        return " · ".join(lines)


# ---------------------------------------------------------------- phân tích JSON


def _parse_operand(raw: Any, where: str) -> Operand:
    if raw is None:
        raise RuleError(f"{where}: thiếu vế so sánh")

    # Cho phép viết tắt hằng số dạng số trần thay vì {"value": ...}.
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return Operand(value=float(raw))

    if not isinstance(raw, dict):
        raise RuleError(f"{where}: vế so sánh phải là chỉ báo hoặc con số")

    if raw.get("key") in (None, ""):
        if "value" not in raw or raw["value"] is None:
            raise RuleError(f"{where}: phải chọn chỉ báo hoặc nhập con số")
        try:
            return Operand(value=float(raw["value"]))
        except (TypeError, ValueError):
            raise RuleError(f"{where}: giá trị '{raw['value']}' không phải con số") from None

    key = str(raw["key"])
    if key not in indicators.INDICATOR_KEYS:
        raise RuleError(f"{where}: không hỗ trợ chỉ báo '{key}'")

    params = raw.get("params") or {}
    if not isinstance(params, dict):
        raise RuleError(f"{where}: tham số chỉ báo không hợp lệ")

    cleaned: dict[str, Any] = {}
    for name, value in params.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise RuleError(f"{where}: tham số '{name}' phải là con số") from None
        if name in ("period", "fast", "slow", "signal"):
            if not 1 <= number <= MAX_PERIOD:
                raise RuleError(f"{where}: '{name}' phải nằm trong khoảng 1–{MAX_PERIOD}")
            cleaned[name] = int(number)
        else:
            cleaned[name] = number

    return Operand(key=key, params=cleaned)


def _parse_group(raw: Any, where: str, *, required: bool) -> ConditionGroup:
    if not raw:
        if required:
            raise RuleError(f"{where}: phải có ít nhất một điều kiện")
        return ConditionGroup()

    if not isinstance(raw, dict):
        raise RuleError(f"{where}: cấu trúc không hợp lệ")

    logic = str(raw.get("logic", "AND")).upper()
    if logic not in ("AND", "OR"):
        raise RuleError(f"{where}: phép ghép phải là VÀ hoặc HOẶC")

    raw_conditions = raw.get("conditions") or []
    if not isinstance(raw_conditions, list):
        raise RuleError(f"{where}: danh sách điều kiện không hợp lệ")

    if required and not raw_conditions:
        raise RuleError(f"{where}: phải có ít nhất một điều kiện")
    if len(raw_conditions) > MAX_CONDITIONS:
        raise RuleError(f"{where}: tối đa {MAX_CONDITIONS} điều kiện")

    conditions: list[Condition] = []
    for index, item in enumerate(raw_conditions, start=1):
        label = f"{where} — điều kiện {index}"
        if not isinstance(item, dict):
            raise RuleError(f"{label}: cấu trúc không hợp lệ")

        operator = str(item.get("operator", "")).lower()
        if operator not in OPERATOR_KEYS:
            raise RuleError(f"{label}: không hỗ trợ phép so sánh '{operator}'")

        left = _parse_operand(item.get("left"), label)
        if left.is_constant:
            raise RuleError(f"{label}: vế trái phải là chỉ báo, không phải con số")

        # Hai phép này chỉ nhìn vào chính vế trái nên vế phải bỏ trống được.
        if operator in ("increasing", "decreasing"):
            right = Operand(value=0.0)
        else:
            right = _parse_operand(item.get("right"), label)

        conditions.append(Condition(left=left, operator=operator, right=right))

    return ConditionGroup(logic=logic, conditions=conditions)


def parse_rules(raw: Any) -> StrategyRules:
    """Đọc JSON bộ lọc thành đối tượng đã kiểm tra. Ném `RuleError` với thông báo tiếng Việt."""
    if not isinstance(raw, dict):
        raise RuleError("Bộ lọc chiến lược chưa được thiết lập")

    direction = str(raw.get("direction", "BUY")).upper()
    if direction not in ("BUY", "SELL"):
        raise RuleError("Chiều lệnh phải là MUA hoặc BÁN")

    raw_risk = raw.get("risk") or {}
    if not isinstance(raw_risk, dict):
        raise RuleError("Quản trị rủi ro: cấu trúc không hợp lệ")

    def _optional_pct(name: str, label: str) -> float | None:
        value = raw_risk.get(name)
        if value in (None, ""):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise RuleError(f"{label} phải là con số") from None
        if not 0 < number <= 100:
            raise RuleError(f"{label} phải nằm trong khoảng 0–100%")
        return number

    try:
        max_hold = int(raw_risk.get("max_hold_days") or 60)
    except (TypeError, ValueError):
        raise RuleError("Số phiên giữ tối đa phải là con số") from None
    if not 1 <= max_hold <= 1000:
        raise RuleError("Số phiên giữ tối đa phải nằm trong khoảng 1–1000")

    return StrategyRules(
        entry=_parse_group(raw.get("entry"), "Điều kiện vào lệnh", required=True),
        exit=_parse_group(raw.get("exit"), "Điều kiện thoát lệnh", required=False),
        risk=RiskRules(
            stop_loss_pct=_optional_pct("stop_loss_pct", "Cắt lỗ"),
            take_profit_pct=_optional_pct("take_profit_pct", "Chốt lời"),
            max_hold_days=max_hold,
        ),
        direction=direction,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------- tính điều kiện


def _operand_values(series: Series, operand: Operand) -> list[float | None]:
    if operand.is_constant:
        return [operand.value] * len(series)
    return indicators.compute(series, operand.key or "", operand.params)


def evaluate_group(series: Series, group: ConditionGroup) -> list[bool]:
    """Trả về mảng bool cùng độ dài chuỗi giá: phiên nào thoả toàn bộ nhóm điều kiện.

    Phiên nào có chỉ báo chưa đủ dữ liệu thì tính là **không thoả** — không đoán, không nội suy.
    """
    n = len(series)
    if not group.conditions:
        return [False] * n

    per_condition: list[list[bool]] = []
    for condition in group.conditions:
        left = _operand_values(series, condition.left)
        right = _operand_values(series, condition.right)
        per_condition.append(_evaluate_condition(left, right, condition.operator))

    if group.logic == "AND":
        return [all(flags[i] for flags in per_condition) for i in range(n)]
    return [any(flags[i] for flags in per_condition) for i in range(n)]


def _evaluate_condition(
    left: list[float | None], right: list[float | None], operator: str
) -> list[bool]:
    n = len(left)
    result = [False] * n

    for i in range(n):
        current_left = left[i]
        if current_left is None:
            continue

        if operator in ("increasing", "decreasing"):
            previous = left[i - 1] if i > 0 else None
            if previous is None:
                continue
            result[i] = current_left > previous if operator == "increasing" else current_left < previous
            continue

        current_right = right[i]
        if current_right is None:
            continue

        if operator == "gt":
            result[i] = current_left > current_right
        elif operator == "gte":
            result[i] = current_left >= current_right
        elif operator == "lt":
            result[i] = current_left < current_right
        elif operator == "lte":
            result[i] = current_left <= current_right
        elif operator in ("cross_above", "cross_below"):
            # Cắt nhau cần biết trạng thái phiên trước; phiên đầu chuỗi không thể có tín hiệu cắt.
            if i == 0:
                continue
            previous_left, previous_right = left[i - 1], right[i - 1]
            if previous_left is None or previous_right is None:
                continue
            if operator == "cross_above":
                result[i] = previous_left <= previous_right and current_left > current_right
            else:
                result[i] = previous_left >= previous_right and current_left < current_right

    return result
