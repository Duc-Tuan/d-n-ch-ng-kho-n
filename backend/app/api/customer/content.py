"""Bài viết và tải tài liệu — Customer Site (F11..F16, F20)."""

from __future__ import annotations

import mimetypes
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from sqlalchemy import select

from app.core.config import settings
from app.core.constants import ArticleStatus, CategoryType, DISCLAIMER_TEXT
from app.core.datetime_utils import ensure_aware, utcnow
from app.core.deps import ActiveUser, DbSession, client_ip, user_agent
from app.core.exceptions import Forbidden, NotFound
from app.core.pagination import PageParams, page_params, paginate_rows
from app.core.security import decode_token
from app.models.content import (
    Article,
    ArticleView,
    Category,
    Document,
    DocumentDownload,
)
from app.schemas.common import PageResponse
from app.schemas.domain import (
    ArticleDetail,
    ArticleListItem,
    CategoryOut,
    DownloadTicket,
)
from app.services import access_control, storage_service, subscription_service

router = APIRouter(tags=["customer-content"])

Pagination = Annotated[PageParams, Depends(page_params)]


@router.get("/categories", response_model=list[CategoryOut])
def list_categories(db: DbSession, type: str = CategoryType.ARTICLE) -> list[Category]:
    return list(
        db.scalars(
            select(Category)
            .where(Category.type == type, Category.is_active.is_(True))
            .order_by(Category.sort_order, Category.name)
        ).all()
    )


# ======================================================================
# BÀI VIẾT
# ======================================================================
@router.get("/articles", response_model=PageResponse[ArticleListItem])
def list_articles(
    user: ActiveUser,
    db: DbSession,
    params: Pagination,
    category_id: int | None = None,
    q: str | None = Query(default=None, max_length=100),
) -> dict:
    """BR-501 — bài đặt lịch tương lai chưa được hiện."""
    now = utcnow()
    stmt = (
        select(Article, Category.name)
        .join(Category, Category.id == Article.category_id)
        .where(Article.status == ArticleStatus.PUBLISHED, Article.published_at <= now)
        .order_by(Article.published_at.desc())
    )
    if category_id:
        stmt = stmt.where(Article.category_id == category_id)
    if q:
        stmt = stmt.where(Article.title.contains(q.strip()))

    allowed = subscription_service.package_gate(db, user)

    def to_item(article: Article, category_name: str) -> ArticleListItem:
        item = ArticleListItem.model_validate(article)
        item.category_name = category_name
        # BR-502 — nội dung cao cấp chỉ hiện với gói dài hạn.
        item.locked = not allowed(article.min_package_id)
        return item

    return paginate_rows(db, stmt, params, to_item)


@router.get("/articles/{slug}", response_model=ArticleDetail)
def get_article(slug: str, user: ActiveUser, request: Request, db: DbSession) -> ArticleDetail:
    article = db.scalar(select(Article).where(Article.slug == slug))
    now = utcnow()
    if (
        not article
        or article.status != ArticleStatus.PUBLISHED
        or (article.published_at and ensure_aware(article.published_at, now) > now)
    ):
        raise NotFound("Bài viết không tồn tại hoặc chưa được xuất bản")

    detail = ArticleDetail.model_validate(article)
    category = db.get(Category, article.category_id)
    detail.category_name = category.name if category else None

    if not subscription_service.can_access_min_package(db, user, article.min_package_id):
        # Vẫn trả tiêu đề + tóm tắt để KH thấy giá trị và có lý do nâng gói.
        detail.locked = True
        detail.content = None
        return detail

    article.view_count = (article.view_count or 0) + 1
    db.add(ArticleView(article_id=article.id, user_id=user.id, ip=client_ip(request)))
    db.commit()
    return detail


# ======================================================================
# TÀI LIỆU — BR-510..513
# ======================================================================
# Kho tài liệu chung **không có endpoint liệt kê ở đây**, và đó là chủ ý.
#
# Tài liệu nhân viên tải lên (`owner_user_id IS NULL`) là tài sản nội bộ của công ty, không phải
# hàng bán cho khách — cùng lẽ với tài liệu của chiến lược hệ thống (xem
# `strategies.py`). Chỉ gỡ màn ở giao diện là không đủ: còn endpoint thì mở tab mạng là lấy
# được danh sách, và từ đó là phiếu tải.
#
# Hai endpoint tải bên dưới ở lại cho tài liệu **của chính khách** đính vào chiến lược cá nhân
# (`owner_user_id` có giá trị), xem `my_strategies.py`.
# ======================================================================
def _assert_document_access(db, user, document) -> None:
    """Một chỗ duy nhất quyết định ai tải được tài liệu nào.

    Hai loại tài liệu, hai luật khác hẳn:

    * `owner_user_id IS NULL` — kho chung của công ty, khách không đụng tới được.
    * Có chủ — tài liệu riêng của một chiến lược cá nhân. Bậc gói **không** áp dụng: nó
      không phải hàng của công ty bán. Điều kiện là người đọc phải xem được chiến lược
      đã đính tài liệu đó — tức là chủ sở hữu, hoặc người được chia sẻ (BR-850).

    Viết thành hàm riêng vì cả hai điểm vào — cấp phiếu và lúc tải thật — đều phải xét, và
    một trong hai quên là đủ để thủng.
    """
    if document.owner_user_id is None:
        # Kho chung không phục vụ khách nữa. Không tiết lộ là tài liệu có tồn tại hay không — dò id
        # chạy từ 1 lên mà phân biệt được 403 với 404 là đếm được cả kho.
        raise NotFound("Tài liệu không tồn tại")

    if document.owner_user_id == user.id:
        return

    from app.models.strategy import StrategyKbDoc
    from app.services import user_strategy_service

    visible = user_strategy_service.visible_strategy_ids(db, user)
    owners = set(
        db.scalars(
            select(StrategyKbDoc.strategy_id).where(StrategyKbDoc.document_id == document.id)
        ).all()
    )
    if not (owners & visible):
        # Không tiết lộ tài liệu có tồn tại hay không — cùng nguyên tắc với BR-850.
        raise NotFound("Tài liệu không tồn tại")


@router.post("/documents/{document_id}/download-ticket", response_model=DownloadTicket)
def create_download_ticket(document_id: int, user: ActiveUser, db: DbSession) -> DownloadTicket:
    """BR-511 — cấp signed URL TTL 5 phút thay vì link tĩnh.

    Nếu để link tĩnh, KH sẽ copy link chia sẻ ra ngoài và bạn mất kiểm soát hoàn toàn.
    """
    document = db.get(Document, document_id)
    if not document or not document.is_active:
        raise NotFound("Tài liệu không tồn tại")

    _assert_document_access(db, user, document)

    token = storage_service.create_download_token(document.id, user.id)
    ttl = settings.signed_url_ttl_seconds
    return DownloadTicket(
        url=f"{settings.api_prefix}/customer/documents/download?token={token}",
        expires_at=utcnow() + timedelta(seconds=ttl),
        ttl_seconds=ttl,
        watermarked=settings.pdf_watermark and document.mime_type == "application/pdf",
    )


@router.get("/documents/download")
def download_document(token: str, request: Request, db: DbSession):
    """Endpoint tải thật. Token ngắn hạn thay cho session để link dùng được trong thẻ <a>.

    BR-512 — đóng watermark động (email KH + thời điểm tải) lên PDF.
    BR-513 — log mọi lượt tải.
    """
    payload = decode_token(token, "customer")
    if (
        not payload
        or payload.get("typ") != "access"
        or payload.get("scope") != storage_service.DOWNLOAD_SCOPE
        or not payload.get("doc")
    ):
        raise Forbidden("Link tải đã hết hạn hoặc không hợp lệ", "DOWNLOAD_TOKEN_INVALID")

    from app.models.user import User

    user = db.get(User, int(payload["sub"]))
    document = db.get(Document, int(payload["doc"]))
    if not user or user.deleted_at or not document or not document.is_active:
        raise NotFound("Tài liệu không tồn tại")

    # Kiểm tra lại quyền **tại thời điểm tải**, không tin vào lúc cấp phiếu (cùng lý lẽ với
    # BR-866 bên Telegram). Phiếu sống 5 phút, đủ để tài khoản bị khoá hoặc bị hạ gói ngay giữa
    # quãng đó — và tài liệu là thứ đắt nhất trong hệ thống này.
    sub = subscription_service.get_current_subscription(db, user)
    decision = access_control.evaluate_access(user, sub.expires_at if sub else None)
    if not decision.allowed:
        raise Forbidden(decision.message, decision.reason)
    _assert_document_access(db, user, document)

    path = storage_service.resolve_path(document.stored_name)
    if not path.exists():
        raise NotFound("File không tồn tại trên hệ thống lưu trữ")

    log_entry = DocumentDownload(
        document_id=document.id,
        user_id=user.id,
        ip=client_ip(request),
        user_agent=(user_agent(request) or "")[:400] or None,
        watermarked=False,
    )
    db.add(log_entry)
    document.download_count = (document.download_count or 0) + 1

    if settings.pdf_watermark and document.mime_type == "application/pdf":
        stream = storage_service.watermark_pdf(path, user.email, user.customer_code)
        if stream is not None:
            log_entry.watermarked = True
            db.commit()
            return StreamingResponse(
                stream,
                media_type="application/pdf",
                headers={
                    "Content-Disposition": f'attachment; filename="{document.original_name}"',
                    "X-Watermarked": "1",
                },
            )

    db.commit()
    media_type = document.mime_type or mimetypes.guess_type(document.original_name)[0]
    return FileResponse(path, media_type=media_type, filename=document.original_name)


@router.get("/disclaimer", response_model=dict)
def disclaimer() -> dict:
    """BR-601/844 — nội dung disclaimer cố định, FE gắn dưới mọi màn có khuyến nghị."""
    return {"text": DISCLAIMER_TEXT}
