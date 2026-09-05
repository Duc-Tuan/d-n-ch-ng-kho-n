"""Tin tức dẫn nguồn — Admin Site.

Hai đường vào, cùng đổ về bảng `news_items`:

* **Nhập tay** — dán đường dẫn bài gốc, điền tiêu đề, mô tả ngắn và ngày đăng.
* **Nguồn tin** — khai báo trang chuyên mục, job `sync_news` dò bài mới theo giờ đặt ở màn Cấu
  hình hệ thống. Nút "Kéo tin ngay" chạy đúng job đó, không đợi tới giờ.

Job chỉ lấy phần mô tả (tiêu đề, tóm tắt, ảnh, ngày đăng) chứ không lấy thân bài — xem lý do ở
`app/models/news.py`.

Dùng lại nhóm quyền `content.*` thay vì thêm quyền mới: người được giao viết và xuất bản nội dung
cũng chính là người chọn tin để dẫn, và thêm một mã quyền mới đòi phải gán lại cho từng role
đang tồn tại trong cơ sở dữ liệu.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from urllib.parse import urlparse

from app.core.constants import SyncJobStatus, SyncJobType
from app.core.datetime_utils import to_local, utcnow
from app.core.deps import DbSession, client_ip, require_permission, user_agent
from app.core.exceptions import Conflict, NotFound, ValidationError
from app.core.pagination import PageParams, page_params, paginate_page
from app.models.nav import SyncJob
from app.models.news import NewsItem, NewsSource
from app.models.staff import Staff
from app.schemas.common import IdResponse, Message
from app.schemas.domain import (
    NewsItemOut,
    NewsItemRequest,
    NewsSourceOut,
    NewsSourceRequest,
)
from app.services import news_sync_service
from app.services.audit_service import AuditAction, log_action

router = APIRouter(prefix="/news", tags=["admin-news"])

Pagination = Annotated[PageParams, Depends(page_params)]

CanViewNews = Annotated[Staff, Depends(require_permission("content.view"))]
CanEditNews = Annotated[Staff, Depends(require_permission("content.create"))]
CanDeleteNews = Annotated[Staff, Depends(require_permission("content.delete"))]


def _source_from(url: str) -> str | None:
    """Suy tên nguồn từ tên miền khi nhân viên bỏ trống ô đó.

    Không bắt buộc nhập vì nó suy ra được, nhưng cũng không bỏ trống được: thẻ tin không ghi
    nguồn thì trông y như bài của chính hệ thống — đúng thứ phải tránh khi chỉ dẫn link.
    """
    try:
        host = urlparse(url).netloc.lower()
    except ValueError:
        return None
    host = host.removeprefix("www.")
    return host or None


# ======================================================================
# Tin
# ======================================================================
@router.get("", response_model=dict)
def list_news(
    staff: CanViewNews,
    db: DbSession,
    params: Pagination,
    q: str | None = Query(default=None, max_length=100),
    is_active: bool | None = None,
    auto: bool | None = None,
) -> dict:
    stmt = select(NewsItem)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(NewsItem.title.like(pattern), NewsItem.source_name.like(pattern))
        )
    if is_active is not None:
        stmt = stmt.where(NewsItem.is_active.is_(is_active))
    if auto is not None:
        # `source_id` vừa là khoá ngoại vừa là dấu "tin này do job kéo về": NULL là nhập tay.
        stmt = stmt.where(
            NewsItem.source_id.isnot(None) if auto else NewsItem.source_id.is_(None)
        )
    # Ghim trước, rồi tới tin mới đăng nhất — cùng thứ tự với site khách để nhân viên nhìn màn
    # hình quản trị là biết khách đang thấy gì ở đầu danh sách.
    stmt = stmt.order_by(
        NewsItem.sort_order.desc(), NewsItem.published_at.desc(), NewsItem.id.desc()
    )
    return paginate_page(db, stmt, params, NewsItemOut.model_validate)


@router.post("", response_model=IdResponse, status_code=201)
def create_news(
    payload: NewsItemRequest, staff: CanEditNews, request: Request, db: DbSession
) -> IdResponse:
    url = payload.url.strip()
    item = NewsItem(
        title=payload.title.strip(),
        summary=(payload.summary or "").strip() or None,
        url=url,
        source_name=(payload.source_name or "").strip() or _source_from(url),
        published_at=payload.published_at,
        is_active=payload.is_active,
        sort_order=payload.sort_order,
        created_by=staff.id,
        # Tin nhập tay cũng có băm: nếu không, job sẽ thêm lại đúng bài này khi nó xuất hiện
        # trên trang chuyên mục của nguồn.
        url_hash=news_sync_service.url_hash(url),
    )
    db.add(item)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise Conflict("Bài này đã có trong danh sách tin", "NEWS_DUPLICATE")

    log_action(
        db, action=AuditAction.NEWS_CREATE, actor=staff, target_type="news",
        target_id=item.id, new_value={"title": item.title, "url": item.url},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(id=item.id, message="Đã thêm tin")


@router.put("/{news_id}", response_model=Message)
def update_news(
    news_id: int, payload: NewsItemRequest, staff: CanEditNews, request: Request, db: DbSession
) -> Message:
    item = db.get(NewsItem, news_id)
    if not item:
        raise NotFound("Tin không tồn tại")

    url = payload.url.strip()
    item.title = payload.title.strip()
    item.summary = (payload.summary or "").strip() or None
    item.url = url
    item.url_hash = news_sync_service.url_hash(url)
    item.source_name = (payload.source_name or "").strip() or _source_from(url)
    item.published_at = payload.published_at
    item.is_active = payload.is_active
    item.sort_order = payload.sort_order

    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise Conflict("Đã có tin khác trỏ tới đúng đường dẫn này", "NEWS_DUPLICATE")

    log_action(
        db, action=AuditAction.NEWS_UPDATE, actor=staff, target_type="news",
        target_id=item.id, new_value={"title": item.title, "url": item.url},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã lưu tin")


@router.delete("/{news_id}", response_model=Message)
def delete_news(news_id: int, reason: str, staff: CanDeleteNews, request: Request,
                db: DbSession) -> Message:
    """Xoá tin đã dẫn — bắt buộc ghi audit log kèm lý do (mục 3.6)."""
    item = db.get(NewsItem, news_id)
    if not item:
        raise NotFound("Tin không tồn tại")

    log_action(
        db, action=AuditAction.NEWS_DELETE, actor=staff, target_type="news",
        target_id=item.id, old_value={"title": item.title, "url": item.url},
        reason=reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    db.delete(item)
    db.commit()
    return Message(message="Đã xoá tin")


# ======================================================================
# Nguồn tin
# ======================================================================
@router.get("/sources", response_model=dict)
def list_sources(staff: CanViewNews, db: DbSession, params: Pagination) -> dict:
    """Danh sách nguồn. Màn quản trị gọi lại chính endpoint này mỗi vài giây khi có lượt đang chạy.

    Dọn trạng thái kẹt ngay tại đây: đây là nơi duy nhất một nguồn treo ở "đang kéo" gây hại —
    thanh tiến trình sẽ quay mãi không dừng.
    """
    news_sync_service.heal_stalled(db)
    stmt = select(NewsSource).order_by(NewsSource.is_active.desc(), NewsSource.id)
    return paginate_page(db, stmt, params, NewsSourceOut.model_validate)


@router.post("/sources", response_model=IdResponse, status_code=201)
def create_source(
    payload: NewsSourceRequest, staff: CanEditNews, request: Request, db: DbSession
) -> IdResponse:
    source = NewsSource(
        name=payload.name.strip(),
        url=payload.url.strip(),
        is_active=payload.is_active,
        max_items=payload.max_items,
        created_by=staff.id,
    )
    db.add(source)
    db.flush()

    log_action(
        db, action="news.source.create", actor=staff, target_type="news_source",
        target_id=source.id, new_value={"name": source.name, "url": source.url},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(id=source.id, message="Đã thêm nguồn tin")


@router.put("/sources/{source_id}", response_model=Message)
def update_source(
    source_id: int, payload: NewsSourceRequest, staff: CanEditNews, request: Request,
    db: DbSession,
) -> Message:
    source = db.get(NewsSource, source_id)
    if not source:
        raise NotFound("Nguồn tin không tồn tại")

    source.name = payload.name.strip()
    source.url = payload.url.strip()
    source.is_active = payload.is_active
    source.max_items = payload.max_items

    log_action(
        db, action="news.source.update", actor=staff, target_type="news_source",
        target_id=source.id, new_value={"name": source.name, "url": source.url},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return Message(message="Đã lưu nguồn tin")


@router.delete("/sources/{source_id}", response_model=Message)
def delete_source(
    source_id: int, staff: CanDeleteNews, request: Request, db: DbSession
) -> Message:
    """Xoá nguồn. Tin đã kéo về **ở lại** — cột `source_id` chỉ chuyển thành NULL.

    Xoá nguồn là thao tác quản lý nguồn, không phải lệnh gỡ tin khỏi site khách. Muốn gỡ tin thì
    lọc theo nguồn ở danh sách tin rồi tắt từng tin.
    """
    source = db.get(NewsSource, source_id)
    if not source:
        raise NotFound("Nguồn tin không tồn tại")

    log_action(
        db, action="news.source.delete", actor=staff, target_type="news_source",
        target_id=source.id, old_value={"name": source.name, "url": source.url},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.delete(source)
    db.commit()
    return Message(message="Đã xoá nguồn tin. Các tin đã kéo về vẫn được giữ lại.")


# ======================================================================
# Chạy tay
# ======================================================================
def _guard_running(db: DbSession) -> None:
    """Chặn lượt chạy chồng lên lượt đang chạy.

    Hai lượt song song cùng quét một trang nguồn: tốn băng thông của họ và dễ bị chặn IP. Cửa 6
    tiếng để một dòng kẹt `RUNNING` (backend chết giữa chừng) không khoá nút vĩnh viễn.
    """
    running = db.scalar(
        select(SyncJob)
        .where(
            SyncJob.job_type == SyncJobType.SYNC_NEWS,
            SyncJob.status == SyncJobStatus.RUNNING,
            SyncJob.started_at >= utcnow() - timedelta(hours=6),
        )
        .order_by(SyncJob.id.desc())
    )
    if running:
        raise Conflict(
            f"Đang kéo tin (bắt đầu lúc {to_local(running.started_at):%H:%M %d/%m}). "
            "Đợi lượt này xong rồi bấm lại.",
            "JOB_ALREADY_RUNNING",
        )


@router.post("/sync", response_model=Message)
def run_sync_now(
    staff: CanEditNews, request: Request, background: BackgroundTasks, db: DbSession
) -> Message:
    """Kéo tin ngay, không đợi tới giờ đặt trong cấu hình. Chạy đúng job `sync_news` của lịch."""
    _guard_running(db)

    sources = db.scalars(
        select(NewsSource).where(NewsSource.is_active.is_(True)).order_by(NewsSource.id)
    ).all()
    if not sources:
        raise ValidationError("Chưa có nguồn nào đang bật để kéo tin")

    log_action(
        db, action="news.sync.manual", actor=staff, target_type="job",
        target_id=SyncJobType.SYNC_NEWS, reason=f"Chạy thủ công bởi {staff.username}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    # Xếp hàng ngay trong request: người vừa bấm phải thấy cả mẻ chuyển sang "đang chờ" tức
    # thì. `sync_all` cũng xếp hàng lần nữa khi tác vụ nền khởi động (lượt chạy theo lịch lúc
    # 04:10 không đi qua đây), và cả hai lần đều cho ra cùng một trạng thái nên không xung đột.
    news_sync_service.mark_pending(db, list(sources), utcnow())

    from app.jobs import runner

    background.add_task(runner.run_job, SyncJobType.SYNC_NEWS, None, "manual", False)
    return Message(
        message=f"Đang kéo tin từ {len(sources)} nguồn. Tiến trình hiện ngay trên danh sách.",
        code="JOB_QUEUED",
    )


@router.post("/sources/{source_id}/sync", response_model=Message)
def run_source_sync(
    source_id: int, staff: CanEditNews, request: Request, background: BackgroundTasks,
    db: DbSession,
) -> Message:
    """Kéo thử một nguồn. Dùng ngay sau khi thêm nguồn để biết đường dẫn có dò ra bài không."""
    source = db.get(NewsSource, source_id)
    if not source:
        raise NotFound("Nguồn tin không tồn tại")
    _guard_running(db)

    # Lượt kéo thử không tạo dòng `sync_jobs` nên `_guard_running` không thấy nó. Chốt riêng ở
    # đây để hai lần bấm liên tiếp không cùng quét một trang nguồn.
    news_sync_service.heal_stalled(db)
    if source.last_status in news_sync_service.BUSY_STATUSES:
        raise Conflict(
            f"Nguồn {source.name} đang được kéo. Đợi lượt này xong rồi bấm lại.",
            "SOURCE_ALREADY_RUNNING",
        )

    log_action(
        db, action="news.sync.manual", actor=staff, target_type="news_source",
        target_id=source.id, reason=f"Kéo thử nguồn {source.name}",
        ip=client_ip(request), user_agent=user_agent(request),
    )
    # Xếp hàng ngay trong request chứ không đợi tác vụ nền: người vừa bấm phải thấy dòng đó
    # chuyển sang "đang chờ" tức thì, không phải chờ tới nhịp làm mới sau.
    news_sync_service.mark_pending(db, [source], utcnow())

    background.add_task(_sync_one_source_task, source.id)
    return Message(
        message=f"Đang kéo thử nguồn {source.name}.",
        code="JOB_QUEUED",
    )


def _sync_one_source_task(source_id: int) -> None:
    """Chạy nền nên phải tự mở phiên: phiên của request đã đóng khi hàm này bắt đầu."""
    from app.core.database import session_scope

    with session_scope() as db:
        source = db.get(NewsSource, source_id)
        if source:
            news_sync_service.sync_source(db, source)
