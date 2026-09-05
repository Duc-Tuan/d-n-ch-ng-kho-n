"""Hàng đợi chạy phân tích — một bể luồng nhỏ, sống cùng vòng đời ứng dụng.

Vì sao là bể luồng chứ không phải `BackgroundTasks` của FastAPI: một lượt AI là tiến trình
`claude -p` chạy tới vài phút. `BackgroundTasks` chạy trong chính worker đang phục vụ request,
nên hai chục lượt bấm sẽ chiếm hết worker và cả site đứng hình. Bể luồng có **trần cứng**
(`ANALYSIS_WORKERS`): quá trần thì việc xếp hàng, không sinh thêm tiến trình.

Vì sao không dùng scheduler có sẵn: scheduler chỉ bật khi `ENABLE_SCHEDULER=true`. Nút Phân tích
là chức năng khách hàng trả tiền để dùng — nó không được phụ thuộc vào một cờ vận hành.

Bể luồng chỉ là *bộ điều phối*. Chốt chặn chống chạy trùng nằm ở CSDL (`ondemand.claim`), nên
kể cả gọi `submit` hai lần cho cùng một việc thì vẫn chỉ một lượt chạy thật.
"""

from __future__ import annotations

import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from sqlalchemy import select

from app.core.config import settings
from app.core.constants import AnalysisSource, SymbolAnalysisStatus
from app.core.database import session_scope
from app.models.analysis import SymbolAnalysis
from app.services.analysis import ondemand, runner

log = logging.getLogger(__name__)

_pool: ThreadPoolExecutor | None = None
_lock = threading.Lock()


def start() -> None:
    """Gọi lúc ứng dụng khởi động."""
    global _pool
    with _lock:
        if _pool is None:
            _pool = ThreadPoolExecutor(
                max_workers=max(1, settings.analysis_workers),
                thread_name_prefix="analysis",
            )
            log.info("Bể phân tích đã khởi động với %s luồng", settings.analysis_workers)


def shutdown() -> None:
    global _pool
    with _lock:
        pool, _pool = _pool, None
    if pool:
        # `wait=False`: lượt AI đang chạy có thể còn vài phút, không giữ tiến trình lại vì nó.
        # Việc dở nằm lại ở RUNNING và được `requeue_stale` nhặt lên ở lần khởi động sau.
        pool.shutdown(wait=False, cancel_futures=True)
        log.info("Bể phân tích đã dừng")


def submit(analysis_id: int) -> None:
    """Xếp một việc vào hàng. An toàn khi gọi trùng — `claim` ở CSDL lọc phần thừa."""
    if _pool is None:
        start()
    assert _pool is not None
    _pool.submit(_run_guarded, analysis_id)


def _run_guarded(analysis_id: int) -> None:
    """Bọc ngoài cùng: một việc hỏng không bao giờ được giết luồng của bể."""
    try:
        _run(analysis_id)
    except Exception as exc:  # noqa: BLE001
        log.exception("Lượt phân tích #%s hỏng ngoài dự tính", analysis_id)
        try:
            with session_scope() as db:
                ondemand.fail(db, analysis_id, f"{type(exc).__name__}: {exc}")
        except Exception:  # pragma: no cover — CSDL cũng hỏng thì chỉ còn log
            log.exception("Không ghi được lỗi cho lượt phân tích #%s", analysis_id)


def _run(analysis_id: int) -> None:
    # ---------- Chiếm việc ----------
    # Mỗi giai đoạn một phiên riêng: nhánh AI gọi tiến trình ngoài và có thể mất vài phút, không
    # giữ một transaction mở suốt quãng đó.
    with session_scope() as db:
        if not ondemand.claim(db, analysis_id):
            log.debug("Lượt phân tích #%s đã có worker khác nhận", analysis_id)
            return
        item = db.get(SymbolAnalysis, analysis_id)
        if item is None:
            return
        source = item.source
        strategy_id = item.strategy_id
        symbol = item.symbol
        prompt = ""
        strategy_name = ""
        if source == AnalysisSource.AI:
            prompt, strategy = runner.build_ai_prompt(db, item)
            # Bản phân tích theo biểu đồ không có chiến lược — tên chỉ dùng để ghi log.
            strategy_name = strategy.name if strategy else ""

    # ---------- Nhánh bộ điều kiện: chạy tại chỗ ----------
    if source != AnalysisSource.AI:
        from app.models.strategy import Strategy

        with session_scope() as db:
            item = db.get(SymbolAnalysis, analysis_id)
            if item is None:
                return
            if item.strategy_id is None:
                # Không thể xảy ra qua đường bình thường (bản theo biểu đồ luôn là AI), nhưng
                # `db.get(Strategy, None)` ném lỗi khó hiểu nên chặn ở đây cho rõ nguyên nhân.
                ondemand.fail(db, analysis_id, "Bản phân tích không gắn chiến lược nào để chạy")
                return
            strategy = db.get(Strategy, item.strategy_id)
            if strategy is None:
                ondemand.fail(db, analysis_id, "Chiến lược không còn tồn tại")
                return
            try:
                runner.run_engine(db, item, strategy)
            except Exception as exc:  # noqa: BLE001
                log.warning("Lỗi bộ điều kiện %s/%s: %s", strategy.id, item.symbol, exc)
                ondemand.fail(db, analysis_id, f"{type(exc).__name__}: {exc}")
        return

    # ---------- Nhánh AI: tiến trình ngoài ghi kết quả qua MCP ----------
    result = runner.run_ai(analysis_id, strategy_id, strategy_name, symbol, prompt)

    with session_scope() as db:
        item = db.get(SymbolAnalysis, analysis_id)
        if item is None:
            return
        if not result["ok"]:
            ondemand.fail(db, analysis_id, result["error"])
            return
        if item.status != SymbolAnalysisStatus.DONE:
            # Tiến trình thoát sạch nhưng chưa ghi kết quả — thường là chạm hạn mức gói thuê bao
            # giữa chừng. Đánh dấu để lượt bấm sau không chờ mãi một việc không bao giờ xong.
            ondemand.fail(
                db,
                analysis_id,
                "Lượt phân tích kết thúc nhưng chưa ghi được kết quả "
                "(có thể đã chạm giới hạn sử dụng của gói thuê bao).",
            )


def requeue_stale() -> int:
    """Đưa việc kẹt ở RUNNING/QUEUED về hàng đợi — gọi lúc khởi động.

    Backend tắt giữa lúc một lượt đang chạy thì dòng đó nằm lại ở RUNNING vĩnh viễn: người bấm
    sau đọc thấy "đang chạy" và chờ một tiến trình đã chết từ lâu. Quét một lần lúc khởi động là
    đủ, vì đó là thời điểm duy nhất chắc chắn không có worker nào của lần chạy trước còn sống.
    """
    with session_scope() as db:
        rows = list(
            db.scalars(
                select(SymbolAnalysis).where(
                    SymbolAnalysis.status.in_(
                        [SymbolAnalysisStatus.QUEUED, SymbolAnalysisStatus.RUNNING]
                    )
                )
            ).all()
        )
        for item in rows:
            ondemand.reset_for_retry(db, item)
        ids = [item.id for item in rows]

    for analysis_id in ids:
        submit(analysis_id)
    if ids:
        log.info("Đã xếp lại %s lượt phân tích còn dở từ lần chạy trước", len(ids))
    return len(ids)
