"""BR-840 — chan sua tin hieu o tang CSDL

Tin hiệu là bất biến. Tầng service đã không cung cấp hàm sửa, nhưng chốt chặn ở tầng
ứng dụng có thể bị đi vòng bằng truy vấn SQL trực tiếp. Trigger này chặn việc sửa
các cột **gốc** của tín hiệu (mã, chiều, giá vào, SL, TP, thời điểm, loại tín hiệu),
đồng thời vẫn cho phép job `close_signals` ghi kết quả vào các cột exit_*/result/r_multiple.

Nếu không có ràng buộc này, toàn bộ thống kê hiệu suất trở nên vô nghĩa và bạn không
còn gì để tự bảo vệ khi khách hàng khiếu nại.

Revision ID: 0002
Revises: 0001
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TRIGGER_NAME = "trg_signals_immutable"

MYSQL_TRIGGER = f"""
CREATE TRIGGER {TRIGGER_NAME} BEFORE UPDATE ON signals
FOR EACH ROW
BEGIN
    IF  NEW.strategy_id  <> OLD.strategy_id
     OR NEW.symbol       <> OLD.symbol
     OR NEW.timeframe    <> OLD.timeframe
     OR NEW.signal_type  <> OLD.signal_type
     OR NEW.direction    <> OLD.direction
     OR NEW.entry_time   <> OLD.entry_time
     OR NEW.entry_price  <> OLD.entry_price
     OR NOT (NEW.sl <=> OLD.sl)
     OR NOT (NEW.tp <=> OLD.tp)
    THEN
        SIGNAL SQLSTATE '45000'
        SET MESSAGE_TEXT = 'BR-840: tin hieu la bat bien, khong duoc sua sau khi tao';
    END IF;
END
"""

SQLITE_TRIGGER = f"""
CREATE TRIGGER {TRIGGER_NAME} BEFORE UPDATE ON signals
FOR EACH ROW
WHEN NEW.strategy_id  IS NOT OLD.strategy_id
  OR NEW.symbol       IS NOT OLD.symbol
  OR NEW.timeframe    IS NOT OLD.timeframe
  OR NEW.signal_type  IS NOT OLD.signal_type
  OR NEW.direction    IS NOT OLD.direction
  OR NEW.entry_time   IS NOT OLD.entry_time
  OR NEW.entry_price  IS NOT OLD.entry_price
  OR NEW.sl           IS NOT OLD.sl
  OR NEW.tp           IS NOT OLD.tp
BEGIN
    SELECT RAISE(ABORT, 'BR-840: tin hieu la bat bien, khong duoc sua sau khi tao');
END
"""


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name
    if dialect == "mysql":
        op.execute(MYSQL_TRIGGER)
    elif dialect == "sqlite":
        op.execute(SQLITE_TRIGGER)
    # Các dialect khác: chốt chặn vẫn còn ở tầng service (app/services/signal_service.py).


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name in ("mysql", "sqlite"):
        op.execute(f"DROP TRIGGER IF EXISTS {TRIGGER_NAME}")
