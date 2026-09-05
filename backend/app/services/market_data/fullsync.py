"""Đồng bộ giá toàn danh mục theo yêu cầu, có báo tiến độ (nút "Đồng bộ tất cả").

Vì sao cần một module riêng thay vì gọi thẳng `sync_ohlcv_batch` trong `BackgroundTasks`:

* Mẻ toàn thị trường chạy hàng nghìn mã, mỗi mã một lời gọi mạng — tính bằng chục phút. Chạy
  trong `BackgroundTasks` là chiếm một worker của chính tiến trình đang phục vụ request suốt
  chừng ấy thời gian.
* Người bấm nút cần biết **đang tới đâu**. Một thanh tiến độ đứng im và một mẻ đã treo trông
  giống hệt nhau nếu không có số mã đã xử lý và tên mã đang tải.
* Bấm hai lần không được chạy hai mẻ: hai luồng cùng gọi nhà cung cấp cho cùng danh sách mã là
  cách nhanh nhất để bị chặn IP, mà kết quả thu về không hơn một mẻ.

Trạng thái sống trong bộ nhớ tiến trình, giống các job nền khác của hệ thống: khởi động lại
backend thì mẻ dở dang mất theo. Chấp nhận được vì đồng bộ tăng dần — chạy lại chỉ tải nốt phần
còn thiếu, không mất dữ liệu đã ghi. Kết quả cuối cùng vẫn nằm ở `market_sync_logs` (BR-835).
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import select

from app.core.config import settings
from app.core.database import session_scope
from app.core.datetime_utils import utcnow
from app.core.exceptions import Conflict
from app.models.market import Symbol

log = logging.getLogger(__name__)

#: Giữ lại vài lỗi gần nhất để hiện ngay trên màn hình. Danh sách đầy đủ nằm ở nhật ký đồng bộ —
#: nhồi cả nghìn dòng lỗi vào bộ nhớ chỉ để vẽ một cái bảng là không đáng.
MAX_TRACKED_ERRORS = 20

#: Trần lịch sử khi tải lại toàn bộ. Nguồn tự cắt phần mã chưa niêm yết.
FULL_HISTORY_DAYS = 30 * 365


@dataclass
class _Progress:
    """Ảnh chụp một mẻ đồng bộ. Chỉ đọc/ghi khi đang giữ `_lock`."""

    state: str = "idle"  # idle | running | done | stopped | failed
    total: int = 0
    processed: int = 0
    synced: int = 0
    failed: int = 0
    skipped: int = 0
    rows_written: int = 0
    current_symbol: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    triggered_by: str | None = None
    days: int = 0
    force_full: bool = False
    message: str | None = None
    errors: list[dict] = field(default_factory=list)


_lock = threading.Lock()
_state = _Progress()
_stop = threading.Event()
_thread: threading.Thread | None = None


def is_running() -> bool:
    with _lock:
        return _state.state == "running"


def snapshot() -> dict:
    """Trạng thái hiện tại, dạng sẵn sàng trả về cho giao diện."""
    with _lock:
        elapsed = None
        if _state.started_at:
            end = _state.finished_at or utcnow()
            elapsed = max(0, int((end - _state.started_at).total_seconds()))

        percent = round(_state.processed / _state.total * 100, 1) if _state.total else 0.0

        # Ước lượng thời gian còn lại từ nhịp thực tế của chính mẻ này, không phải từ một hằng
        # số đoán trước: tốc độ phụ thuộc nhà cung cấp và số phiên phải tải của từng mã.
        eta = None
        remaining = _state.total - _state.processed
        if _state.state == "running" and elapsed and _state.processed > 0 and remaining > 0:
            eta = int(elapsed / _state.processed * remaining)

        return {
            "state": _state.state,
            "total": _state.total,
            "processed": _state.processed,
            "synced": _state.synced,
            "failed": _state.failed,
            "skipped": _state.skipped,
            "rows_written": _state.rows_written,
            "current_symbol": _state.current_symbol,
            "percent": percent,
            "started_at": _state.started_at,
            "finished_at": _state.finished_at,
            "elapsed_seconds": elapsed,
            "eta_seconds": eta,
            "triggered_by": _state.triggered_by,
            "days": _state.days,
            "force_full": _state.force_full,
            "stop_requested": _stop.is_set(),
            "message": _state.message,
            "errors": list(_state.errors),
        }


def start(*, days: int, force_full: bool, triggered_by: str) -> dict:
    """Khởi động một mẻ đồng bộ toàn danh mục. Trả về ảnh chụp trạng thái ban đầu.

    Ném `Conflict` nếu đang có mẻ chạy — người bấm nhận thông báo rõ ràng thay vì âm thầm sinh
    thêm một luồng nữa gọi cùng một nhà cung cấp.
    """
    global _thread, _state

    with _lock:
        if _state.state == "running":
            raise Conflict(
                "Đang có một mẻ đồng bộ chạy dở. Đợi mẻ này xong hoặc bấm Dừng trước đã.",
                "MARKET_SYNC_RUNNING",
            )

        _stop.clear()
        # Thay hẳn bản ghi thay vì đặt lại từng trường: quên một trường là mẻ mới hiện số đếm
        # của mẻ cũ, kiểu sai lặng lẽ nhất mà giao diện không có cách nào lộ ra.
        _state = _Progress(
            state="running",
            started_at=utcnow(),
            triggered_by=triggered_by,
            days=days,
            force_full=force_full,
            message="Đang lấy danh sách mã…",
        )

    _thread = threading.Thread(
        target=_run,
        args=(days, force_full),
        name="market-fullsync",
        daemon=True,
    )
    _thread.start()
    return snapshot()


def request_stop() -> dict:
    """Xin dừng mẻ đang chạy. Mã đang tải dở vẫn chạy nốt rồi vòng lặp mới thoát."""
    with _lock:
        if _state.state != "running":
            raise Conflict("Không có mẻ đồng bộ nào đang chạy", "MARKET_SYNC_NOT_RUNNING")
        _state.message = "Đã nhận yêu cầu dừng, đang kết thúc mã hiện tại…"
    _stop.set()
    return snapshot()


def _on_progress(event: dict) -> None:
    with _lock:
        _state.current_symbol = event["symbol"]
        _state.total = event["total"]
        _state.processed = event["processed"]
        _state.synced = event["synced"]
        _state.failed = event["failed"]
        _state.skipped = event["skipped"]
        _state.rows_written = event["rows_written"]
        if event.get("error"):
            _state.errors.append({"symbol": event["symbol"], "issue": event["error"]})
            del _state.errors[:-MAX_TRACKED_ERRORS]


def _finish(state: str, message: str) -> None:
    with _lock:
        _state.state = state
        _state.message = message
        _state.current_symbol = None
        _state.finished_at = utcnow()


def _run(days: int, force_full: bool) -> None:
    """Thân luồng nền.

    Mọi lối thoát đều phải để lại một trạng thái đọc được trên giao diện: một luồng chết lặng lẽ
    để lại thanh tiến độ đứng im mãi mãi, và nút bấm thì bị khoá vì hệ thống tưởng còn đang chạy.
    """
    from app.services.market_data.service import sync_ohlcv_batch

    try:
        with session_scope() as db:
            symbols = list(
                db.scalars(
                    select(Symbol.symbol)
                    .where(Symbol.is_active.is_(True))
                    .order_by(Symbol.symbol)
                ).all()
            )

        with _lock:
            _state.total = len(symbols)
            _state.message = f"Đang đồng bộ {len(symbols)} mã…"

        if not symbols:
            _finish("done", "Danh mục không có mã nào đang theo dõi")
            return

        with session_scope() as db:
            result = sync_ohlcv_batch(
                db,
                symbols,
                days=days,
                force_full=force_full,
                delay_seconds=settings.market_sync_delay_seconds,
                on_progress=_on_progress,
                should_stop=_stop.is_set,
            )

        summary = (
            f"{result['synced']} mã thành công, {result['failed']} mã lỗi, "
            f"{result['rows_written']:,} nến ghi thêm"
        )
        if result["stopped"]:
            _finish(
                "stopped",
                f"Đã dừng sau {result['processed']}/{result['total']} mã · {summary}",
            )
        else:
            _finish("done", f"Hoàn tất {result['processed']} mã · {summary}")

    except Exception as exc:  # noqa: BLE001
        log.exception("Mẻ đồng bộ toàn danh mục hỏng")
        _finish("failed", f"{type(exc).__name__}: {exc}"[:300])
