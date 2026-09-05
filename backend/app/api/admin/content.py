"""CMS bài viết và kho tài liệu — mục 3.2, 3.3."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, Request, UploadFile
from slugify import slugify
from sqlalchemy import func, or_, select

from app.core.config import settings
from app.core.constants import ArticleStatus, CategoryType
from app.core.datetime_utils import utcnow
from app.core.deps import CurrentStaff, DbSession, client_ip, require_permission, user_agent
from app.core.exceptions import Conflict, Forbidden, NotFound, ValidationError
from app.core.pagination import PageParams, build_page, count_of, page_params
from app.models.content import (
    Article,
    ArticleVersion,
    Category,
    Document,
    DocumentDownload,
)
from app.models.media import MediaAsset
from app.models.staff import Staff
from app.schemas.common import IdResponse, Message
from app.schemas.domain import (
    ArticleCreateRequest,
    ArticleDetail,
    ArticleStatusRequest,
    ArticleUpdateRequest,
    CategoryOut,
    DocumentListItem,
)
from app.services import html_sanitizer, rbac, realtime, storage_service
from app.services.audit_service import AuditAction, diff, log_action

router = APIRouter(tags=["admin-content"])

Pagination = Annotated[PageParams, Depends(page_params)]
CanViewContent = Annotated[Staff, Depends(require_permission("content.view", "content.create"))]
CanCreate = Annotated[Staff, Depends(require_permission("content.create"))]
CanPublish = Annotated[Staff, Depends(require_permission("content.publish"))]
CanDelete = Annotated[Staff, Depends(require_permission("content.delete"))]

CanViewDoc = Annotated[Staff, Depends(require_permission("doc.view"))]
CanUploadDoc = Annotated[Staff, Depends(require_permission("doc.upload"))]
CanEditDoc = Annotated[Staff, Depends(require_permission("doc.edit"))]
CanDeleteDoc = Annotated[Staff, Depends(require_permission("doc.delete"))]


# ======================================================================
# DANH MỤC
# ======================================================================
@router.get("/categories", response_model=list[CategoryOut])
def list_categories(staff: CurrentStaff, db: DbSession,
                    type: str | None = None) -> list[Category]:
    stmt = select(Category).where(Category.is_active.is_(True))
    if type:
        stmt = stmt.where(Category.type == type)
    return list(db.scalars(stmt.order_by(Category.type, Category.sort_order)).all())


# ======================================================================
# BÀI VIẾT — BR-500..503
# ======================================================================
def _unique_slug(db, title: str, explicit: str | None, exclude_id: int | None = None) -> str:
    base = slugify(explicit or title)[:200] or "bai-viet"
    slug, counter = base, 1
    while True:
        stmt = select(Article).where(Article.slug == slug)
        if exclude_id:
            stmt = stmt.where(Article.id != exclude_id)
        if not db.scalar(stmt):
            return slug
        counter += 1
        slug = f"{base}-{counter}"


def _can_edit_article(staff: Staff, article: Article) -> bool:
    """CONTENT_EDITOR chỉ sửa bài của mình; CONTENT_MANAGER sửa mọi bài (mục 3.5)."""
    if rbac.has_permission(staff, "content.edit_all"):
        return True
    return rbac.has_permission(staff, "content.edit") and article.author_id == staff.id


def _notify_article_change(article_id: int, slug: str, action: str) -> None:
    """Báo cho site khách hàng biết một bài **đang hiển thị công khai** vừa đổi (YC16).

    Chỉ gọi khi thay đổi thật sự nhìn thấy được ở site khách hàng. Sửa một bài nháp mà cũng bắn
    sự kiện thì mọi trình duyệt đang mở phải tải lại danh sách bài viết vô ích.

    Gói tin cố tình chỉ mang `id` + `slug`: phía khách hàng dùng nó để biết **cần tải lại cái gì**
    rồi tự gọi API thường — nội dung vẫn đi qua đúng chốt kiểm tra gói dịch vụ (BR-502), không bị
    kênh real-time cấp phát vượt quyền.
    """
    realtime.broadcast_public_event(
        {"type": "content", "entity": "article", "action": action, "id": article_id, "slug": slug}
    )


@router.get("/articles", response_model=dict)
def list_articles(
    staff: CanViewContent,
    db: DbSession,
    params: Pagination,
    status: str | None = None,
    category_id: int | None = None,
    mine: bool = False,
    q: str | None = Query(default=None, max_length=100),
) -> dict:
    stmt = select(Article, Category.name).join(Category, Category.id == Article.category_id)

    # Nhân viên không có quyền sửa mọi bài thì mặc định chỉ thấy bài của mình.
    if not rbac.has_permission(staff, "content.edit_all") and not rbac.has_permission(
        staff, "content.publish"
    ):
        stmt = stmt.where(Article.author_id == staff.id)
    elif mine:
        stmt = stmt.where(Article.author_id == staff.id)

    if status:
        stmt = stmt.where(Article.status == status)
    if category_id:
        stmt = stmt.where(Article.category_id == category_id)
    if q:
        stmt = stmt.where(Article.title.contains(q.strip()))

    stmt = stmt.order_by(Article.id.desc())
    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()

    items = []
    for article, category_name in rows:
        item = ArticleDetail.model_validate(article)
        item.category_name = category_name
        item.content = None  # danh sách không cần nội dung đầy đủ
        items.append(item)
    return build_page(items, total, params)


@router.get("/articles/{article_id}", response_model=ArticleDetail)
def get_article(article_id: int, staff: CanViewContent, db: DbSession) -> ArticleDetail:
    article = db.get(Article, article_id)
    if not article:
        raise NotFound("Bài viết không tồn tại")
    if not _can_edit_article(staff, article) and not rbac.has_permission(staff, "content.publish"):
        raise Forbidden("Bạn chỉ được xem bài viết của mình", "NOT_AUTHOR")

    detail = ArticleDetail.model_validate(article)
    category = db.get(Category, article.category_id)
    detail.category_name = category.name if category else None
    return detail


@router.post("/articles", response_model=IdResponse, status_code=201)
def create_article(payload: ArticleCreateRequest, staff: CanCreate, request: Request,
                   db: DbSession) -> IdResponse:
    """Nhân viên soạn bài — luôn tạo ở `DRAFT`, không được tự xuất bản (BR-500)."""
    category = db.get(Category, payload.category_id)
    if not category or category.type != CategoryType.ARTICLE:
        raise ValidationError("Danh mục bài viết không hợp lệ", {"field": "category_id"})

    # Nội dung được render bằng dangerouslySetInnerHTML ở site khách hàng — lọc trước khi lưu,
    # không phải lúc hiển thị. Xem app/services/html_sanitizer.py.
    clean_content = html_sanitizer.sanitize_html(payload.content)

    article = Article(
        category_id=payload.category_id,
        title=payload.title.strip(),
        slug=_unique_slug(db, payload.title, payload.slug),
        excerpt=payload.excerpt or html_sanitizer.to_plain_text(clean_content, 200),
        content=clean_content,
        thumbnail=payload.thumbnail,
        tags=payload.tags,
        min_package_id=payload.min_package_id,
        status=ArticleStatus.DRAFT,
        author_id=staff.id,
        published_at=payload.published_at,
    )
    db.add(article)
    db.flush()

    db.add(
        ArticleVersion(
            article_id=article.id, version=1, title=article.title,
            content=article.content, edited_by=staff.id, change_note="Tạo mới",
        )
    )
    log_action(
        db, action=AuditAction.ARTICLE_CREATE, actor=staff, target_type="article",
        target_id=article.id, new_value={"title": article.title, "slug": article.slug},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(id=article.id, message="Đã tạo bài viết ở trạng thái Nháp")


@router.put("/articles/{article_id}", response_model=Message)
def update_article(article_id: int, payload: ArticleUpdateRequest, staff: CanCreate,
                   request: Request, db: DbSession) -> Message:
    """BR-503 — mỗi lần sửa lưu một version, biết ai sửa gì lúc nào."""
    article = db.get(Article, article_id)
    if not article:
        raise NotFound("Bài viết không tồn tại")
    if not _can_edit_article(staff, article):
        raise Forbidden("Bạn chỉ được sửa bài viết của mình", "NOT_AUTHOR")

    before = {
        "title": article.title, "category_id": article.category_id,
        "min_package_id": article.min_package_id, "published_at": article.published_at,
    }

    article.category_id = payload.category_id
    article.title = payload.title.strip()
    if payload.slug and payload.slug != article.slug:
        article.slug = _unique_slug(db, payload.title, payload.slug, exclude_id=article.id)
    clean_content = html_sanitizer.sanitize_html(payload.content)
    article.excerpt = payload.excerpt or html_sanitizer.to_plain_text(clean_content, 200)
    article.content = clean_content
    article.thumbnail = payload.thumbnail
    article.tags = payload.tags
    article.min_package_id = payload.min_package_id
    article.published_at = payload.published_at

    last_version = db.scalar(
        select(func.max(ArticleVersion.version)).where(ArticleVersion.article_id == article.id)
    ) or 0
    db.add(
        ArticleVersion(
            article_id=article.id, version=last_version + 1, title=article.title,
            content=article.content, edited_by=staff.id, change_note=payload.change_note,
        )
    )

    after = {
        "title": article.title, "category_id": article.category_id,
        "min_package_id": article.min_package_id, "published_at": article.published_at,
    }
    old_changed, new_changed = diff(before, after)
    if old_changed:
        log_action(
            db, action=AuditAction.ARTICLE_UPDATE, actor=staff, target_type="article",
            target_id=article.id, old_value=old_changed, new_value=new_changed,
            ip=client_ip(request), user_agent=user_agent(request),
        )
    published = article.status == ArticleStatus.PUBLISHED
    article_id_, slug_ = article.id, article.slug
    db.commit()

    # Bắn sau commit: khách hàng nhận được tín hiệu thì dữ liệu mới chắc chắn đã nằm trong CSDL,
    # nếu không họ sẽ tải lại và đọc trúng bản cũ.
    if published:
        _notify_article_change(article_id_, slug_, "updated")
    return Message(message="Đã lưu bài viết")


@router.post("/articles/{article_id}/status", response_model=Message)
def change_status(article_id: int, payload: ArticleStatusRequest, staff: CurrentStaff,
                  request: Request, db: DbSession) -> Message:
    """BR-500 — `DRAFT → PENDING_REVIEW → PUBLISHED → ARCHIVED`.

    Nhân viên soạn chỉ đưa lên được `PENDING_REVIEW`; chỉ `content.publish` mới xuất bản.
    """
    article = db.get(Article, article_id)
    if not article:
        raise NotFound("Bài viết không tồn tại")

    target = payload.status
    if target in (ArticleStatus.PUBLISHED, ArticleStatus.ARCHIVED):
        if not rbac.has_permission(staff, "content.publish"):
            raise Forbidden(
                "Nội dung tư vấn chứng khoán ra công chúng cần qua kiểm duyệt. "
                "Bạn chỉ có thể gửi duyệt, không thể tự xuất bản.",
                "PUBLISH_DENIED",
            )
    elif not _can_edit_article(staff, article):
        raise Forbidden("Bạn chỉ được thao tác trên bài viết của mình", "NOT_AUTHOR")

    old_status = article.status
    article.status = target

    if target == ArticleStatus.PUBLISHED:
        article.reviewed_by = staff.id
        article.reviewed_at = utcnow()
        # BR-501 — giữ lịch tương lai nếu đã đặt; nếu chưa thì xuất bản ngay.
        article.published_at = payload.published_at or article.published_at or utcnow()

    log_action(
        db,
        action=AuditAction.ARTICLE_PUBLISH if target == ArticleStatus.PUBLISHED
        else AuditAction.ARTICLE_UPDATE,
        actor=staff, target_type="article", target_id=article.id,
        old_value={"status": old_status},
        new_value={"status": target, "published_at": article.published_at},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    article_id_, slug_ = article.id, article.slug
    db.commit()

    # Vào hoặc ra khỏi PUBLISHED đều làm danh sách bên site khách hàng đổi.
    if target == ArticleStatus.PUBLISHED:
        _notify_article_change(article_id_, slug_, "published")
    elif old_status == ArticleStatus.PUBLISHED:
        _notify_article_change(article_id_, slug_, "unpublished")

    labels = {
        ArticleStatus.DRAFT: "Nháp",
        ArticleStatus.PENDING_REVIEW: "Chờ duyệt",
        ArticleStatus.PUBLISHED: "Đã xuất bản",
        ArticleStatus.ARCHIVED: "Lưu trữ",
    }
    return Message(message=f"Đã chuyển bài viết sang trạng thái: {labels.get(target, target)}")


@router.get("/articles/{article_id}/versions", response_model=dict)
def article_versions(article_id: int, staff: CanViewContent, db: DbSession,
                     params: Pagination) -> dict:
    """BR-503 — bài sửa nhiều lần thì danh sách phiên bản dài ra vô hạn, nên phân trang."""
    stmt = (
        select(ArticleVersion)
        .where(ArticleVersion.article_id == article_id)
        .order_by(ArticleVersion.version.desc())
    )
    total = count_of(db, stmt)
    rows = db.scalars(stmt.limit(params.size).offset(params.offset)).all()
    staff_names = {s.id: s.full_name for s in db.scalars(select(Staff)).all()}
    return build_page(
        [
            {
                "id": v.id, "version": v.version, "title": v.title,
                "edited_by": v.edited_by, "edited_by_name": staff_names.get(v.edited_by),
                "change_note": v.change_note, "created_at": v.created_at,
            }
            for v in rows
        ],
        int(total),
        params,
    )


@router.delete("/articles/{article_id}", response_model=Message)
def delete_article(article_id: int, reason: str, staff: CanDelete, request: Request,
                   db: DbSession) -> Message:
    """Xoá bài viết — bắt buộc ghi audit log kèm lý do (mục 3.6)."""
    article = db.get(Article, article_id)
    if not article:
        raise NotFound("Bài viết không tồn tại")

    log_action(
        db, action=AuditAction.ARTICLE_DELETE, actor=staff, target_type="article",
        target_id=article.id,
        old_value={"title": article.title, "slug": article.slug, "status": article.status},
        reason=reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    # Đọc trước khi xoá: sau `db.delete` + commit thì object hết hiệu lực, chạm vào là lỗi.
    was_published = article.status == ArticleStatus.PUBLISHED
    article_id_, slug_ = article.id, article.slug

    db.delete(article)
    db.commit()

    if was_published:
        _notify_article_change(article_id_, slug_, "deleted")
    return Message(message="Đã xoá bài viết")


# ======================================================================
# TÀI LIỆU — BR-510..513
# ======================================================================
@router.get("/documents", response_model=dict)
def list_documents(staff: CanViewDoc, db: DbSession, params: Pagination,
                   category_id: int | None = None,
                   q: str | None = Query(default=None, max_length=100)) -> dict:
    stmt = (
        select(Document, Category.name)
        .join(Category, Category.id == Document.category_id)
        # Tài liệu khách tự tải lên cho chiến lược cá nhân (BR-850) không thuộc kho chung và
        # không phải việc của nhân viên — cả danh sách lẫn thao tác sửa/xoá.
        .where(Document.owner_user_id.is_(None))
        .order_by(Document.id.desc())
    )
    if category_id:
        stmt = stmt.where(Document.category_id == category_id)
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(or_(Document.title.like(pattern), Document.original_name.like(pattern)))

    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()

    items = []
    for doc, category_name in rows:
        item = DocumentListItem.model_validate(doc)
        item.category_name = category_name
        items.append(item)
    return build_page(items, total, params)


@router.post("/documents", response_model=IdResponse, status_code=201)
async def upload_document(
    staff: CanUploadDoc,
    request: Request,
    db: DbSession,
    file: UploadFile = File(...),
    title: str = Form(...),
    category_id: int = Form(...),
    description: str | None = Form(None),
    min_package_id: int | None = Form(None),
) -> IdResponse:
    """BR-510/511 — whitelist đuôi, giới hạn dung lượng, đổi tên khi lưu, để ngoài thư mục public."""
    category = db.get(Category, category_id)
    if not category or category.type != CategoryType.DOCUMENT:
        raise ValidationError("Danh mục tài liệu không hợp lệ", {"field": "category_id"})

    content = await storage_service.read_upload(file)
    ext, mime = storage_service.validate_upload(
        file.filename or "", len(content), content[:16]
    )

    stored_name = storage_service.generate_stored_name(ext)
    checksum = storage_service.save_file(content, stored_name)

    document = Document(
        category_id=category_id,
        title=title.strip(),
        description=description,
        stored_name=stored_name,
        original_name=storage_service.sanitize_filename(file.filename or stored_name),
        file_size=len(content),
        mime_type=mime,
        checksum=checksum,
        min_package_id=min_package_id,
        uploaded_by=staff.id,
    )
    db.add(document)
    db.flush()

    log_action(
        db, action=AuditAction.DOCUMENT_UPLOAD, actor=staff, target_type="document",
        target_id=document.id,
        new_value={"title": document.title, "size": document.file_size, "mime": mime},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()
    return IdResponse(id=document.id, message="Đã tải lên tài liệu")


@router.put("/documents/{document_id}", response_model=Message)
def update_document(
    document_id: int, staff: CanEditDoc, request: Request, db: DbSession,
    title: str | None = None, description: str | None = None,
    category_id: int | None = None, min_package_id: int | None = None,
    is_active: bool | None = None,
) -> Message:
    document = db.get(Document, document_id)
    if not document:
        raise NotFound("Tài liệu không tồn tại")

    before = {
        "title": document.title, "category_id": document.category_id,
        "min_package_id": document.min_package_id, "is_active": document.is_active,
    }
    if title is not None:
        document.title = title.strip()
    if description is not None:
        document.description = description
    if category_id is not None:
        document.category_id = category_id
    if min_package_id is not None:
        document.min_package_id = min_package_id
    if is_active is not None:
        document.is_active = is_active

    after = {
        "title": document.title, "category_id": document.category_id,
        "min_package_id": document.min_package_id, "is_active": document.is_active,
    }
    old_changed, new_changed = diff(before, after)
    if old_changed:
        log_action(
            db, action=AuditAction.DOCUMENT_UPDATE, actor=staff, target_type="document",
            target_id=document.id, old_value=old_changed, new_value=new_changed,
            ip=client_ip(request), user_agent=user_agent(request),
        )
    db.commit()
    return Message(message="Đã cập nhật tài liệu")


@router.delete("/documents/{document_id}", response_model=Message)
def delete_document(document_id: int, reason: str, staff: CanDeleteDoc, request: Request,
                    db: DbSession) -> Message:
    document = db.get(Document, document_id)
    if not document:
        raise NotFound("Tài liệu không tồn tại")

    log_action(
        db, action=AuditAction.DOCUMENT_DELETE, actor=staff, target_type="document",
        target_id=document.id,
        old_value={"title": document.title, "stored_name": document.stored_name},
        reason=reason, ip=client_ip(request), user_agent=user_agent(request),
    )
    storage_service.delete_file(document.stored_name)
    # Giữ bản ghi ở trạng thái không hoạt động để log tải xuống cũ không mất tham chiếu.
    document.is_active = False
    db.commit()
    return Message(message="Đã xoá tài liệu")


@router.get("/documents/{document_id}/downloads", response_model=dict)
def document_downloads(document_id: int, staff: CanViewDoc, db: DbSession,
                       params: Pagination) -> dict:
    """BR-513 — ai đã tải file này, lúc nào, từ IP nào.

    Trước đây cắt cứng 500 dòng gần nhất. Nhật ký tải là bằng chứng truy vết nguồn phát tán, mà
    lượt tải thứ 501 trở về trước lại không còn cách nào xem — phân trang thay cho cắt cứng.
    """
    from app.models.user import User

    stmt = (
        select(DocumentDownload, User.email, User.full_name)
        .outerjoin(User, User.id == DocumentDownload.user_id)
        .where(DocumentDownload.document_id == document_id)
        .order_by(DocumentDownload.id.desc())
    )
    total = count_of(db, stmt)
    rows = db.execute(stmt.limit(params.size).offset(params.offset)).all()
    return build_page(
        [
            {
                "id": d.id, "user_id": d.user_id, "email": email, "full_name": name,
                "ip": d.ip, "watermarked": d.watermarked, "created_at": d.created_at,
            }
            for d, email, name in rows
        ],
        int(total),
        params,
    )


# ======================================================================
# ẢNH MINH HOẠ TRONG BÀI VIẾT — YC14
# ======================================================================
#: Ảnh nhúng giữa bài không cần lớn như tài liệu tải về; chặn sớm để không tốn băng thông của
#: người đọc trên điện thoại.
MAX_IMAGE_MB = 5
IMAGE_EXTENSIONS = {"png", "jpg", "jpeg"}


@router.post("/media", response_model=dict, status_code=201)
async def upload_media(
    staff: CanCreate,
    request: Request,
    db: DbSession,
    file: UploadFile = File(...),
    alt_text: str | None = Form(None),
) -> dict:
    """Tải ảnh để chèn vào bài viết.

    Dùng lại toàn bộ kiểm tra của `storage_service` (whitelist đuôi, chữ ký byte, đổi tên khi
    lưu), rồi siết thêm: chỉ nhận ảnh, và dung lượng nhỏ hơn tài liệu.
    """
    content = await storage_service.read_upload(file, MAX_IMAGE_MB)
    ext, mime = storage_service.validate_upload(file.filename or "", len(content), content[:16])

    if ext not in IMAGE_EXTENSIONS:
        raise ValidationError(
            f"Chỉ chèn được ảnh vào bài viết ({', '.join(sorted(IMAGE_EXTENSIONS))}). "
            "Tài liệu PDF, Word thì tải ở mục Kho tài liệu.",
            {"field": "file"},
        )
    if len(content) > MAX_IMAGE_MB * 1024 * 1024:
        raise ValidationError(
            f"Ảnh vượt quá {MAX_IMAGE_MB}MB. Nén hoặc giảm kích thước trước khi tải lên.",
            {"field": "file"},
        )

    stored_name = storage_service.generate_stored_name(ext)
    storage_service.save_file(content, stored_name)

    asset = MediaAsset(
        stored_name=stored_name,
        original_name=storage_service.sanitize_filename(file.filename or stored_name),
        mime_type=mime,
        file_size=len(content),
        alt_text=(alt_text or "").strip()[:255] or None,
        uploaded_by=staff.id,
    )
    db.add(asset)
    db.flush()

    log_action(
        db, action=AuditAction.DOCUMENT_UPLOAD, actor=staff, target_type="media",
        target_id=asset.id,
        new_value={"file": asset.original_name, "size": asset.file_size, "mime": mime},
        ip=client_ip(request), user_agent=user_agent(request),
    )
    db.commit()

    return {
        "id": asset.id,
        # Đường dẫn tương đối để bài viết không gắn cứng tên miền — đổi tên miền là hỏng hết ảnh.
        "url": f"{settings.api_prefix}/media/{asset.stored_name}",
        "alt_text": asset.alt_text,
        "original_name": asset.original_name,
        "file_size": asset.file_size,
        "message": "Đã tải ảnh lên",
    }


@router.get("/media", response_model=dict)
def list_media(staff: CanCreate, db: DbSession, pagination: Pagination) -> dict:
    """Thư viện ảnh đã tải — chèn lại ảnh cũ thay vì tải lên trùng lặp."""
    stmt = (
        select(MediaAsset)
        .where(MediaAsset.is_active.is_(True))
        .order_by(MediaAsset.id.desc())
    )
    total = db.scalar(
        select(func.count()).select_from(MediaAsset).where(MediaAsset.is_active.is_(True))
    ) or 0
    rows = db.scalars(
        stmt.offset((pagination.page - 1) * pagination.size).limit(pagination.size)
    ).all()

    return build_page(
        [
            {
                "id": a.id,
                "url": f"{settings.api_prefix}/media/{a.stored_name}",
                "alt_text": a.alt_text,
                "original_name": a.original_name,
                "file_size": a.file_size,
                "created_at": a.created_at,
            }
            for a in rows
        ],
        total,
        pagination,
    )


@router.delete("/media/{media_id}", response_model=Message)
def delete_media(media_id: int, staff: CanDelete, db: DbSession) -> Message:
    """Gỡ ảnh khỏi thư viện.

    Không xoá file khỏi ổ đĩa: ảnh có thể đang nằm trong một bài đã xuất bản, xoá file sẽ làm bài
    đó hỏng ảnh mà không ai biết. Chỉ ẩn khỏi thư viện chọn ảnh.
    """
    asset = db.get(MediaAsset, media_id)
    if not asset:
        raise NotFound("Không tìm thấy ảnh")

    asset.is_active = False
    db.commit()
    return Message(
        message="Đã gỡ ảnh khỏi thư viện. Ảnh vẫn hiển thị ở những bài viết đang dùng nó."
    )
