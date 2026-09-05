"""Dữ liệu thị trường — màn quản trị (Phần 12).

Màn này trả lời đúng ba câu hỏi vận hành:
  1. Đã có giá cho bao nhiêu mã, dữ liệu mới đến ngày nào?
  2. Mã nào đang thiếu hoặc chậm dữ liệu?
  3. Mẻ đồng bộ gần nhất chạy thế nào, có bất thường gì?

BR-835 — dữ liệu sai âm thầm nguy hiểm hơn dữ liệu không có, nên nhật ký đồng bộ và danh sách
bất thường phải nhìn thấy được, không nằm im trong bảng.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, func, or_, select

from app.core.datetime_utils import local_today
from app.core.deps import DbSession, client_ip, require_permission, user_agent
from app.core.exceptions import NotFound, ValidationError
from app.core.pagination import PageParams, build_page, count_of, page_params
from app.models.market import MarketSyncLog, OhlcvDaily, Symbol
from app.models.staff import Staff
from app.schemas.common import Message
from app.schemas.domain import CandleOut, SymbolOut
from app.services import market_data
from app.services.audit_service import AuditAction, log_action

log = logging.getLogger(__name__)

router = APIRouter(prefix="/market", tags=["admin-market"])

Pagination = Annotated[PageParams, Depends(page_params)]
CanView = Annotated[Staff, Depends(require_permission("sync.view"))]
CanRun = Annotated[Staff, Depends(require_permission("sync.run"))]
CanManage = Annotated[Staff, Depends(require_permission("symbol.manage"))]

#: Quá số phiên này mà mã chưa có dữ liệu mới thì coi là chậm, cần chú ý.
STALE_AFTER_DAYS = 5

#: Trần số mã cho một lần đồng bộ thủ công. Nhiều hơn thì dùng job nền theo lịch — gọi nhà cung
#: cấp hàng nghìn lần trong một request là cách chắc chắn nhất để bị chặn IP.
MAX_MANUAL_SYMBOLS = 50


@router.get("/overview", response_model=dict)
def overview(staff: CanView, db: DbSession) -> dict:
    """Số liệu tổng quan + mẻ đồng bộ gần nhất."""
    stats = market_data.coverage_stats(db)
    last_log = db.scalar(select(MarketSyncLog).order_by(MarketSyncLog.id.desc()).limit(1))

    today = local_today()
    stale_before = today - timedelta(days=STALE_AFTER_DAYS)
    stale = db.scalar(
        select(func.count()).select_from(Symbol).where(
            Symbol.is_active.is_(True),
            or_(Symbol.last_ohlcv_date.is_(None), Symbol.last_ohlcv_date < stale_before),
        )
    ) or 0

    by_exchange = db.execute(
        select(
            Symbol.exchange,
            func.count().label("total"),
            func.sum(case((Symbol.last_ohlcv_date.is_not(None), 1), else_=0)).label("with_data"),
        )
        .where(Symbol.is_active.is_(True))
        .group_by(Symbol.exchange)
        .order_by(Symbol.exchange)
    ).all()

    return {
        **stats,
        "symbols_stale": int(stale),
        "stale_after_days": STALE_AFTER_DAYS,
        "by_exchange": [
            {"exchange": row.exchange, "total": int(row.total), "with_data": int(row.with_data or 0)}
            for row in by_exchange
        ],
        "last_sync": (
            {
                "id": last_log.id,
                "run_date": last_log.run_date,
                "symbols_total": last_log.symbols_total,
                "symbols_synced": last_log.symbols_synced,
                "symbols_failed": last_log.symbols_failed,
                "rows_written": last_log.rows_written,
                "duration_seconds": last_log.duration_seconds,
                "anomalies": last_log.anomalies,
                "created_at": last_log.created_at,
            }
            if last_log
            else None
        ),
    }


@router.get("/symbols", response_model=dict)
def list_symbols(
    staff: CanView,
    db: DbSession,
    params: Pagination,
    q: str | None = Query(default=None, max_length=100),
    exchange: str | None = None,
    data_state: str | None = Query(default=None, pattern="^(ok|stale|missing)$"),
    only_active: bool = True,
) -> dict:
    """Danh mục mã kèm tình trạng dữ liệu giá của từng mã."""
    today = local_today()
    stale_before = today - timedelta(days=STALE_AFTER_DAYS)

    stmt = select(Symbol)
    if only_active:
        stmt = stmt.where(Symbol.is_active.is_(True))
    if q:
        pattern = f"%{q.strip().upper()}%"
        stmt = stmt.where(
            or_(Symbol.symbol.like(pattern), Symbol.company_name.like(f"%{q.strip()}%"))
        )
    if exchange:
        stmt = stmt.where(Symbol.exchange == exchange)
    if data_state == "missing":
        stmt = stmt.where(Symbol.last_ohlcv_date.is_(None))
    elif data_state == "stale":
        stmt = stmt.where(
            Symbol.last_ohlcv_date.is_not(None), Symbol.last_ohlcv_date < stale_before
        )
    elif data_state == "ok":
        stmt = stmt.where(Symbol.last_ohlcv_date >= stale_before)

    stmt = stmt.order_by(Symbol.symbol)
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()

    # Đếm số nến của đúng trang đang xem — đếm cho toàn bộ bảng thì truy vấn nặng mà không ai đọc.
    symbols_on_page = [r.symbol for r in rows]
    bar_counts = (
        {
            row.symbol: int(row.n)
            for row in db.execute(
                select(OhlcvDaily.symbol, func.count().label("n"))
                .where(OhlcvDaily.symbol.in_(symbols_on_page))
                .group_by(OhlcvDaily.symbol)
            ).all()
        }
        if symbols_on_page
        else {}
    )

    items = []
    for row in rows:
        if row.last_ohlcv_date is None:
            state = "missing"
        elif row.last_ohlcv_date < stale_before:
            state = "stale"
        else:
            state = "ok"
        items.append(
            {
                "id": row.id,
                "symbol": row.symbol,
                "exchange": row.exchange,
                "company_name": row.company_name,
                "industry": row.industry,
                "tier": row.tier,
                "is_active": row.is_active,
                "last_ohlcv_date": row.last_ohlcv_date,
                "last_synced_at": row.last_synced_at,
                "bars": bar_counts.get(row.symbol, 0),
                "data_state": state,
            }
        )
    return build_page(items, total, params)


# ----------------------------------------------------------------------
# Thêm / sửa / xoá mã trong danh mục theo dõi
#
# Bảng `symbols` là nguồn sự thật của danh mục. `app.data.symbol_universe` chỉ còn là danh sách
# hạt giống cho lần dựng hệ thống đầu tiên.
# ----------------------------------------------------------------------
class SymbolCreateIn(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    industry: str | None = Field(default=None, max_length=150)
    tier: str | None = Field(default=None, pattern="^[ABC]$")
    #: Bỏ trống thì lấy sàn thật từ nhà cung cấp — người nhập không phải nhớ mã nào sàn nào.
    exchange: str | None = Field(default=None, pattern="^(HOSE|HNX|UPCOM)$")


class SymbolUpdateIn(BaseModel):
    industry: str | None = Field(default=None, max_length=150)
    tier: str | None = Field(default=None, pattern="^[ABC]$")
    is_active: bool | None = None


@router.post("/symbols", response_model=dict, status_code=201)
def create_symbol(
    payload: SymbolCreateIn,
    staff: CanManage,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
) -> dict:
    """Thêm một mã vào danh mục theo dõi và tải luôn giá lịch sử của nó.

    Mã được **đối chiếu với nhà cung cấp trước khi ghi**: gõ nhầm `FTP` thay vì `FPT` sẽ bị từ
    chối ngay tại đây kèm thông báo rõ ràng, thay vì tạo ra một dòng rác không bao giờ có giá và
    chỉ lộ ra ở cột "mã chậm dữ liệu" vài ngày sau.

    Việc tải trọn lịch sử chạy nền: một mã lâu đời có hơn 6.000 phiên, giữ request chờ chừng ấy
    là chắc chắn timeout.
    """
    row = market_data.add_symbol(
        db,
        payload.symbol,
        industry=payload.industry,
        tier=payload.tier,
        exchange=payload.exchange,
    )
    code = row.symbol

    log_action(
        db, action=AuditAction.SYMBOL_CREATE, actor=staff, target_type="symbol", target_id=code,
        new_value={"symbol": code, "exchange": row.exchange, "industry": row.industry,
                   "tier": row.tier},
        reason=f"Thêm mã {code} vào danh mục theo dõi bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    background.add_task(_backfill_new_symbol_task, code)
    return {
        "id": row.id,
        "symbol": code,
        "exchange": row.exchange,
        "company_name": row.company_name,
        "message": f"Đã thêm {code} ({row.company_name or row.exchange}). "
                   "Đang tải giá lịch sử ở chạy nền, tải lại màn hình sau ít phút.",
    }


@router.patch("/symbols/{code}", response_model=dict)
def update_symbol(
    code: str,
    payload: SymbolUpdateIn,
    staff: CanManage,
    request: Request,
    db: DbSession,
) -> dict:
    """Sửa ngành, tier hoặc bật/tắt theo dõi một mã. Không sửa được chính mã và sàn.

    Đổi mã tức là đổi sang một doanh nghiệp khác — giá lịch sử đang gắn với mã cũ sẽ thành vô
    nghĩa. Muốn vậy thì xoá rồi thêm lại, để hai thao tác đó hiện rõ trong audit log.
    """
    row = db.scalar(select(Symbol).where(Symbol.symbol == code.strip().upper()))
    if row is None:
        raise NotFound(f"Không có mã {code.upper()} trong danh mục", "SYMBOL_NOT_FOUND")

    before = {"industry": row.industry, "tier": row.tier, "is_active": row.is_active}
    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(row, field, value)

    log_action(
        db, action=AuditAction.SYMBOL_UPDATE, actor=staff, target_type="symbol", target_id=row.symbol,
        old_value=before, new_value=data,
        reason=f"Cập nhật mã {row.symbol} bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return {"symbol": row.symbol, "industry": row.industry, "tier": row.tier,
            "is_active": row.is_active, "message": f"Đã cập nhật {row.symbol}"}


@router.delete("/symbols/{code}", response_model=Message)
def delete_symbol(
    code: str,
    staff: CanManage,
    request: Request,
    db: DbSession,
    reason: str = Query(min_length=3, max_length=500, description="Bắt buộc — ghi vào audit log"),
) -> Message:
    """Xoá một mã khỏi danh mục, kèm giá lịch sử và liên kết chiến lược của nó.

    **Mã đã từng phát tín hiệu thì không xoá mà chỉ tắt theo dõi.** Tín hiệu đã gửi tới khách
    hàng là dữ liệu bất biến (BR-83x); xoá mã của nó đi thì màn tra cứu khiếu nại sẽ trống, đúng
    lúc cần nhất. Ràng buộc này nằm ở tầng service nên bấm thẳng API cũng không lách được.
    """
    row = db.scalar(select(Symbol).where(Symbol.symbol == code.strip().upper()))
    if row is None:
        raise NotFound(f"Không có mã {code.upper()} trong danh mục", "SYMBOL_NOT_FOUND")

    symbol = row.symbol
    snapshot = {"symbol": symbol, "exchange": row.exchange, "industry": row.industry,
                "tier": row.tier}

    result = market_data.remove_symbol(db, symbol)

    log_action(
        db, action=AuditAction.SYMBOL_DELETE, actor=staff, target_type="symbol", target_id=symbol,
        old_value={**snapshot, "bars": result["bars"], "deleted": result["deleted"]},
        reason=reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    if not result["deleted"]:
        return Message(
            message=f"{symbol} đã từng phát tín hiệu nên được giữ lại để tra cứu, "
                    "chỉ dừng theo dõi và gỡ khỏi các chiến lược.",
            code="SYMBOL_DEACTIVATED",
        )
    return Message(
        message=f"Đã xoá {symbol} khỏi danh mục cùng {result['bars']:,} nến giá.",
        code="SYMBOL_DELETED",
    )


@router.get("/symbols/search", response_model=list[SymbolOut])
def search_symbols(
    staff: CanView,
    db: DbSession,
    q: str | None = Query(default=None, max_length=50, description="Tìm theo mã hoặc tên công ty"),
    exchange: str | None = Query(default=None, description="HOSE | HNX | UPCOM"),
    limit: int = Query(default=50, ge=1, le=500),
) -> list[SymbolOut]:
    """Tra cứu mã cho ô chọn mã khi dựng chiến lược.

    Bản riêng cho Admin Site — xem lý do ở docstring `ohlcv()` ngay dưới: route bên Customer
    Site (`app.api.customer.market.list_symbols`) đòi cookie `cst_at`, nhân viên trực trang quản
    trị gọi vào đó luôn nhận 401 trừ khi tình cờ cũng đang đăng nhập khách hàng trên cùng trình
    duyệt. Đường dẫn khác `/symbols` (đã dùng cho danh mục quản lý mã) để không đụng route.
    """
    rows = market_data.search_symbols(db, query=q, exchange=exchange, limit=limit)
    return [SymbolOut.model_validate(r) for r in rows]


@router.get("/symbols/codes", response_model=list[str])
def list_symbol_codes(
    staff: CanView,
    db: DbSession,
    exchange: str | None = Query(default=None, description="HOSE | HNX | UPCOM"),
) -> list[str]:
    """Chỉ danh sách mã — cho nút chọn cả sàn/cả danh mục. Bản riêng cho Admin Site, lý do như
    `search_symbols()` ở trên."""
    return market_data.list_symbol_codes(db, exchange=exchange)


@router.get("/ohlcv", response_model=dict)
def ohlcv(
    symbol: str,
    staff: CanView,
    db: DbSession,
    date_from: date | None = None,
    date_to: date | None = None,
    limit: int = Query(default=400, ge=10, le=2000),
) -> dict:
    """Nến ngày của một mã — nguồn dữ liệu cho biểu đồ của màn dựng bộ lọc.

    Giống hệt route cùng tên bên khách hàng, nhưng gác bằng quyền nhân viên. Phải có bản riêng
    chứ không dùng chung được: hai site đọc hai cookie khác nhau (`adm_at` và `cst_at`), ký bằng
    hai secret khác nhau — người trực trang quản trị gọi vào route khách hàng luôn nhận 401.
    """
    candles = market_data.get_candles(
        db, symbol, date_from=date_from, date_to=date_to, limit=limit
    )
    if not candles:
        raise NotFound(f"Chưa có dữ liệu giá cho mã {symbol.upper()}", "NO_PRICE_DATA")

    return {
        "symbol": symbol.upper(),
        "resolution": "D",
        "candles": [CandleOut.model_validate(c) for c in candles],
        "attribution": market_data.attribution(),
    }


@router.get("/sync-logs", response_model=dict)
def list_sync_logs(staff: CanView, db: DbSession, params: Pagination) -> dict:
    """BR-835 — lịch sử các mẻ đồng bộ, kèm danh sách bất thường của từng mẻ."""
    stmt = select(MarketSyncLog).order_by(MarketSyncLog.id.desc())
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    return build_page(
        [
            {
                "id": r.id,
                "run_date": r.run_date,
                "symbols_total": r.symbols_total,
                "symbols_synced": r.symbols_synced,
                "symbols_failed": r.symbols_failed,
                "rows_written": r.rows_written,
                "duration_seconds": r.duration_seconds,
                "anomalies": r.anomalies,
                "created_at": r.created_at,
            }
            for r in rows
        ],
        int(total),
        params,
    )


@router.post("/sync-symbols", response_model=Message)
def run_sync_symbols(staff: CanRun, request: Request, background: BackgroundTasks,
                     db: DbSession) -> Message:
    """Cập nhật danh mục mã từ nhà cung cấp. Chạy nền vì phải gọi ra ngoài."""
    log_action(
        db, action=AuditAction.SYNC_RUN_MANUAL, actor=staff, target_type="market",
        target_id="sync_symbols", reason=f"Đồng bộ danh mục mã bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    background.add_task(_sync_symbols_task)
    return Message(
        message="Đang cập nhật danh mục mã ở chạy nền. Tải lại màn hình sau ít phút để xem kết quả.",
        code="MARKET_SYMBOLS_QUEUED",
    )


@router.post("/sync-ohlcv", response_model=Message)
def run_sync_ohlcv(
    staff: CanRun,
    request: Request,
    background: BackgroundTasks,
    db: DbSession,
    symbols: list[str] | None = None,
    days: int = Query(default=120, ge=1, le=3650),
) -> Message:
    """Tải giá cho một nhóm mã đã chọn.

    Bỏ trống `symbols` thì lấy các mã đang thiếu hoặc chậm dữ liệu — đúng việc người vận hành cần
    làm sau khi nhìn thấy con số "mã chậm dữ liệu" trên màn tổng quan.
    """
    today = local_today()
    stale_before = today - timedelta(days=STALE_AFTER_DAYS)

    if symbols:
        wanted = [s.strip().upper() for s in symbols if s.strip()]
    else:
        wanted = list(
            db.scalars(
                select(Symbol.symbol)
                .where(
                    Symbol.is_active.is_(True),
                    or_(
                        Symbol.last_ohlcv_date.is_(None),
                        Symbol.last_ohlcv_date < stale_before,
                    ),
                )
                .order_by(Symbol.symbol)
                .limit(MAX_MANUAL_SYMBOLS)
            ).all()
        )

    if not wanted:
        raise ValidationError("Không có mã nào cần đồng bộ", {"field": "symbols"})
    if len(wanted) > MAX_MANUAL_SYMBOLS:
        raise ValidationError(
            f"Tối đa {MAX_MANUAL_SYMBOLS} mã cho một lần chạy tay. "
            "Đồng bộ toàn bộ thị trường hãy để job theo lịch chạy.",
            {"field": "symbols"},
        )

    log_action(
        db, action=AuditAction.SYNC_RUN_MANUAL, actor=staff, target_type="market",
        target_id="sync_ohlcv", new_value={"symbols": wanted[:20], "count": len(wanted), "days": days},
        reason=f"Đồng bộ giá bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    background.add_task(_sync_ohlcv_task, wanted, days)
    return Message(
        message=f"Đang tải giá cho {len(wanted)} mã ở chạy nền. Kết quả xem ở phần Nhật ký đồng bộ.",
        code="MARKET_OHLCV_QUEUED",
    )



# ----------------------------------------------------------------------
# Đồng bộ toàn bộ danh mục — chạy tay, có theo dõi tiến độ
#
# Khác `sync-ohlcv` ở trên: route kia giới hạn 50 mã và chạy trong `BackgroundTasks`, hợp với
# việc bù vài mã lẻ. Mẻ toàn thị trường là hàng nghìn mã và hàng chục phút, nên nó có luồng
# riêng cùng một trạng thái đọc được — xem `market_data.fullsync`.
# ----------------------------------------------------------------------
class FullSyncIn(BaseModel):
    #: `incremental` — chỉ tải phần thiếu kể từ `last_ohlcv_date` (việc thường ngày).
    #: `full` — tải lại trọn lịch sử, dùng khi nghi ngờ dữ liệu cũ bị hỏng hoặc thiếu khoảng.
    mode: str = Field(default="incremental", pattern="^(incremental|full)$")
    #: Chỉ dùng cho `incremental`. Khoảng đệm rộng hơn số phiên bỏ lỡ để bù những ngày máy chủ
    #: không chạy; nguồn trả về trùng thì bản ghi cũ được ghi đè, không sinh dòng thừa.
    days: int = Field(default=30, ge=1, le=3650)


@router.post("/sync-all", response_model=dict)
def start_full_sync(
    payload: FullSyncIn,
    staff: CanRun,
    request: Request,
    db: DbSession,
) -> dict:
    """Đồng bộ giá OHLCV cho **toàn bộ mã đang theo dõi**, chạy nền và báo tiến độ.

    Trả về ngay ảnh chụp trạng thái ban đầu; giao diện hỏi tiếp `GET /market/sync-progress` để
    vẽ tiến độ. Đang chạy dở mà bấm lại thì nhận 409 chứ không sinh mẻ thứ hai.
    """
    full = payload.mode == "full"
    days = market_data.fullsync.FULL_HISTORY_DAYS if full else payload.days

    log_action(
        db, action=AuditAction.SYNC_RUN_MANUAL, actor=staff, target_type="market",
        target_id="sync_all",
        new_value={"mode": payload.mode, "days": days},
        reason=f"Đồng bộ giá toàn danh mục ({payload.mode}) bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    # Khởi động sau khi ghi audit: mẻ có chạy được hay không thì thao tác bấm nút vẫn phải có vết.
    return market_data.fullsync.start(
        days=days, force_full=full, triggered_by=staff.username
    )


@router.get("/sync-progress", response_model=dict)
def full_sync_progress(staff: CanView) -> dict:
    """Tiến độ mẻ đồng bộ toàn danh mục — mã đang tải, số đã xong, lỗi gần đây, ước tính còn lại.

    Chỉ đọc bộ nhớ tiến trình nên gọi vài giây một lần cũng không chạm tới cơ sở dữ liệu.
    """
    return market_data.fullsync.snapshot()


@router.post("/sync-all/stop", response_model=dict)
def stop_full_sync(staff: CanRun, request: Request, db: DbSession) -> dict:
    """Dừng mẻ đang chạy. Phần đã tải vẫn được giữ và vẫn có dòng trong nhật ký đồng bộ.

    Cần thiết vì mẻ toàn thị trường chạy hàng chục phút: không có đường dừng thì lỡ tay chọn
    nhầm "tải lại toàn bộ lịch sử" là phải chờ hết hoặc khởi động lại máy chủ.
    """
    log_action(
        db, action=AuditAction.SYNC_JOB_CANCEL, actor=staff, target_type="market",
        target_id="sync_all", reason=f"Dừng đồng bộ giá toàn danh mục bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return market_data.fullsync.request_stop()


# ----------------------------------------------------------------------
# Việc chạy nền — mở phiên CSDL riêng vì phiên của request đã đóng khi task chạy.
# ----------------------------------------------------------------------
def _sync_symbols_task() -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        market_data.sync_symbols(db)
    finally:
        db.close()


def _sync_ohlcv_task(symbols: list[str], days: int) -> None:
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        market_data.sync_ohlcv_batch(db, symbols, days=days)
    finally:
        db.close()


def _backfill_new_symbol_task(symbol: str) -> None:
    """Tải trọn lịch sử cho một mã vừa được thêm.

    Xin 30 năm chứ không phải khoảng đệm ngắn như job hằng ngày: mã mới chưa có gì trong cơ sở
    dữ liệu, phải kéo từ ngày niêm yết. Nguồn tự cắt phần không tồn tại.
    """
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        market_data.sync_ohlcv(db, symbol, days=30 * 365, force_full=True)
    except Exception:
        # Thất bại thì mã nằm lại ở trạng thái "thiếu dữ liệu" trên màn danh mục và người vận
        # hành bấm đồng bộ lại được — không có gì mất mát, không cần dựng cơ chế thử lại riêng.
        log.exception("Không tải được lịch sử cho mã mới %s", symbol)
    finally:
        db.close()
