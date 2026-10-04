"""MCP server `stock-articles` — công cụ chuyên dụng cho AI tạo, đăng và quản lý bài viết CMS.

Chạy thử nghiệm:
    python -m app.mcp.article_server        (từ thư mục `backend`)
    hoặc: python <duong/dan>/app/mcp/article_server.py

Dùng được cho cả:
    * Claude Desktop / Cursor / Antigravity IDE (qua giao thức stdio)
    * Quy trình AI biên tập và xuất bản bài viết tự động

Cung cấp đầy đủ các công cụ:
    1. lay_danh_muc_bai_viet   — Lấy danh mục bài viết (Bình luận thị trường, Vĩ mô, Cổ phiếu...)
    2. lay_danh_sach_goi       — Lấy danh sách gói dịch vụ (TRIAL, PKG3M...) để thiết lập quyền đọc
    3. tim_kiem_bai_viet       — Tìm kiếm & lọc bài viết hiện có
    4. xem_chi_tiet_bai_viet   — Đọc chi tiết nội dung, thuộc tính và lịch sử bài viết
    5. dang_bai_viet           — Đăng bài viết mới (hỗ trợ Markdown & HTML, tự làm sạch XSS, lưu lịch sử)
    6. cap_nhat_bai_viet       — Cập nhật bài viết hiện có, tạo phiên bản mới trong lịch sử
    7. xuat_ban_bai_viet       — Xuất bản bài viết trực tiếp (chuyển sang PUBLISHED và bắn realtime)
    8. chuyen_trang_thai_bai_viet — Đổi trạng thái (DRAFT, PENDING_REVIEW, PUBLISHED, ARCHIVED)
    9. xoa_bai_viet            — Xoá bài viết (kèm lý do bắt buộc theo chuẩn BR-503)
    10. lay_lich_su_phien_ban  — Xem lịch sử các phiên bản sửa đổi của bài viết
"""

# Cố ý KHÔNG `from __future__ import annotations`: FastMCP đọc chú thích kiểu của hàm tool
# bằng `inspect` để sinh JSON Schema. Với annotation hoãn (chuỗi), nó sẽ lỗi khi đăng ký tool.

import json
import logging
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional, Union

# Nạp thư mục `backend` vào `sys.path` TRƯỚC khi import bất cứ thứ gì thuộc `app`.
_BACKEND_DIR = Path(__file__).resolve().parents[2]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from markdown_it import MarkdownIt  # noqa: E402
from mcp.server import FastMCP  # noqa: E402
from slugify import slugify  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.constants import ArticleStatus, CategoryType, StaffStatus  # noqa: E402
from app.core.datetime_utils import utcnow  # noqa: E402
from app.core.database import session_scope  # noqa: E402
from app.models.content import Article, ArticleVersion, Category  # noqa: E402
from app.models.staff import Staff  # noqa: E402
from app.models.user import Package  # noqa: E402
from app.services import html_sanitizer, realtime  # noqa: E402
from app.services.audit_service import AuditAction, log_action  # noqa: E402

# stdio là kênh truyền của giao thức MCP — mọi thứ in ra stdout sẽ làm hỏng JSON-RPC.
# Đẩy toàn bộ log sang stderr trước khi bất cứ thứ gì kịp ghi.
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
log = logging.getLogger("stock-articles-mcp")

mcp = FastMCP("stock-articles")

# Bộ chuyển đổi Markdown sang HTML hỗ trợ bảng (GFM table) và thẻ gạch ngang
_md_parser = MarkdownIt("commonmark", {"html": True}).enable("table").enable("strikethrough")


def _json(payload) -> str:
    """Kết quả trả về luôn là chuỗi JSON UTF-8 sạch, không escape ký tự tiếng Việt."""
    return json.dumps(payload, ensure_ascii=False, default=str)


def _unique_slug(db, title: str, explicit: Optional[str] = None, exclude_id: Optional[int] = None) -> str:
    """Tạo slug duy nhất theo chuẩn của hệ thống."""
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


def _resolve_category(db, identifier: Union[int, str]) -> Optional[Category]:
    """Tìm danh mục bài viết theo ID, theo Mã Code (MARKET_COMMENT...) hoặc theo Tên."""
    if identifier is None:
        return None

    # Nếu truyền số nguyên hoặc chuỗi số
    if isinstance(identifier, int) or (isinstance(identifier, str) and identifier.strip().isdigit()):
        cat = db.get(Category, int(identifier))
        if cat and cat.type == CategoryType.ARTICLE:
            return cat

    raw_str = str(identifier).strip()
    code_upper = raw_str.upper()

    # Tìm theo mã code chính xác (ưu tiên)
    cat = db.scalar(
        select(Category).where(
            Category.code == code_upper,
            Category.type == CategoryType.ARTICLE,
            Category.is_active.is_(True),
        )
    )
    if cat:
        return cat

    # Tìm theo tên tiếng Việt gần đúng hoặc bằng
    cat = db.scalar(
        select(Category).where(
            Category.name.ilike(raw_str),
            Category.type == CategoryType.ARTICLE,
            Category.is_active.is_(True),
        )
    )
    if cat:
        return cat

    # Tìm chứa chuỗi
    return db.scalar(
        select(Category).where(
            Category.name.contains(raw_str),
            Category.type == CategoryType.ARTICLE,
            Category.is_active.is_(True),
        )
    )


def _resolve_staff(db, identifier: Union[int, str, None] = None) -> Optional[Staff]:
    """Tìm tài khoản nhân viên / tác giả. Nếu không truyền, mặc định chọn biên tập viên hoặc superadmin."""
    if identifier is not None:
        if isinstance(identifier, int) or (isinstance(identifier, str) and identifier.strip().isdigit()):
            staff = db.get(Staff, int(identifier))
            if staff and staff.status == StaffStatus.ACTIVE:
                return staff

        staff_uname = str(identifier).strip().lower()
        staff = db.scalar(
            select(Staff).where(Staff.username == staff_uname, Staff.status == StaffStatus.ACTIVE)
        )
        if staff:
            return staff

    # Mặc định: ưu tiên bientap -> quanlynoidung -> superadmin -> nhân viên active đầu tiên
    for preferred in ("bientap", "quanlynoidung", "superadmin"):
        staff = db.scalar(
            select(Staff).where(Staff.username == preferred, Staff.status == StaffStatus.ACTIVE)
        )
        if staff:
            return staff

    return db.scalar(select(Staff).where(Staff.status == StaffStatus.ACTIVE).order_by(Staff.id.asc()))


def _resolve_package(db, identifier: Union[int, str, None] = None) -> Optional[Package]:
    """Tìm gói cước yêu cầu tối thiểu (nếu bài viết phân quyền theo gói cước)."""
    if identifier is None:
        return None

    if isinstance(identifier, int) or (isinstance(identifier, str) and identifier.strip().isdigit()):
        return db.get(Package, int(identifier))

    code_upper = str(identifier).strip().upper()
    return db.scalar(select(Package).where(Package.code == code_upper, Package.is_active.is_(True)))


def _process_content(raw_text: str) -> str:
    """Xử lý nội dung: chuyển Markdown sang HTML và lọc thẻ độc hại qua html_sanitizer."""
    if not raw_text or not raw_text.strip():
        return ""
    rendered_html = _md_parser.render(raw_text)
    clean_html = html_sanitizer.sanitize_html(rendered_html)
    return clean_html


def _notify_change(article_id: int, slug: str, action: str) -> None:
    """Phát thông báo realtime cho site khách hàng (nếu đang chạy trên ASGI server)."""
    try:
        realtime.broadcast_public_event(
            {"type": "content", "entity": "article", "action": action, "id": article_id, "slug": slug}
        )
    except Exception as exc:
        log.debug("Bỏ qua thông báo WebSocket khi chạy stdio đơn lẻ: %s", exc)


def _parse_datetime(dt_str: Optional[str]) -> Optional[datetime]:
    """Chuyển chuỗi ISO hoặc định dạng thông dụng sang datetime."""
    if not dt_str or not dt_str.strip():
        return None
    cleaned = dt_str.strip()
    try:
        return datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
    except Exception:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
            try:
                return datetime.strptime(cleaned, fmt)
            except ValueError:
                pass
    return None


# ======================================================================
# DANH MỤC & GÓI CƯỚC (CONTEXT TOOLS)
# ======================================================================

@mcp.tool()
def lay_danh_muc_bai_viet() -> str:
    """Lấy danh sách các danh mục bài viết đang hoạt động trong hệ thống.

    Mỗi bài viết khi đăng BẮT BUỘC phải thuộc một trong các danh mục này:
    - MARKET_COMMENT   : Bình luận thị trường (nhận định phiên, VN-Index, dòng tiền)
    - MACRO            : Vĩ mô (lãi suất, tỷ giá, chính sách tiền tệ)
    - COMPANY_ANALYSIS : Phân tích doanh nghiệp (báo cáo tài chính, định giá, triển vọng ngành)
    - PORTFOLIO_REPORT : Báo cáo danh mục (hiệu suất, cơ cấu tài sản)
    - STRATEGIC_STOCK  : Cổ phiếu chiến lược (điểm mua/bán, định vị trung - dài hạn)
    - NEWS             : Tin tức thị trường nổi bật
    - BASIC_KNOWLEDGE  : Kiến thức cơ bản cho nhà đầu tư
    """
    with session_scope() as db:
        cats = db.scalars(
            select(Category)
            .where(Category.type == CategoryType.ARTICLE, Category.is_active.is_(True))
            .order_by(Category.sort_order.asc(), Category.id.asc())
        ).all()
        return _json({
            "ok": True,
            "danh_muc": [
                {
                    "id": c.id,
                    "code": c.code,
                    "name": c.name,
                    "sort_order": c.sort_order,
                }
                for c in cats
            ],
            "tong_so": len(cats),
        })


@mcp.tool()
def lay_danh_sach_goi() -> str:
    """Lấy danh sách các gói cước dịch vụ trong hệ thống.

    Dùng khi muốn thiết lập `goi_toi_thieu` (min_package) để giới hạn bài viết chuyên sâu
    dành riêng cho khách hàng VIP đã trả phí:
    - TRIAL   : Dùng thử (miễn phí)
    - PKG3M   : Gói 3 tháng
    - PKG6M   : Gói 6 tháng
    - PKG12M  : Gói 12 tháng (hạng cao nhất)
    Nếu bài viết dành cho mọi khách hàng (công khai), hãy để `goi_toi_thieu=None`.
    """
    with session_scope() as db:
        packages = db.scalars(
            select(Package)
            .where(Package.is_active.is_(True))
            .order_by(Package.sort_order.asc())
        ).all()
        return _json({
            "ok": True,
            "goi_dich_vu": [
                {
                    "id": p.id,
                    "code": p.code,
                    "name": p.name,
                    "tier": p.tier,
                    "price": p.price,
                    "is_trial": p.is_trial,
                }
                for p in packages
            ],
        })


# ======================================================================
# TÌM KIẾM & XEM BÀI VIẾT (READ TOOLS)
# ======================================================================

@mcp.tool()
def tim_kiem_bai_viet(
    tu_khoa: Optional[str] = None,
    danh_muc: Optional[str] = None,
    trang_thai: Optional[str] = None,
    gioi_han: int = 10,
    bo_qua: int = 0,
) -> str:
    """Tìm kiếm hoặc liệt kê các bài viết trong hệ thống.

    Tham số:
    - `tu_khoa`   : Từ khoá cần tìm trong tiêu đề bài viết (vd: "HPG", "VN-Index", "lạm phát")
    - `danh_muc`  : Lọc theo danh mục (truyền mã code như "MARKET_COMMENT", tên hoặc ID)
    - `trang_thai`: Lọc theo trạng thái ("DRAFT", "PENDING_REVIEW", "PUBLISHED", "ARCHIVED")
    - `gioi_han`  : Số lượng bản ghi tối đa trả về (mặc định 10, tối đa 50)
    - `bo_qua`    : Số bản ghi bỏ qua để phân trang (offset)
    """
    limit = max(1, min(gioi_han, 50))
    offset = max(0, bo_qua)

    with session_scope() as db:
        stmt = select(Article, Category.name, Staff.full_name).join(
            Category, Category.id == Article.category_id
        ).outerjoin(
            Staff, Staff.id == Article.author_id
        )

        if tu_khoa and tu_khoa.strip():
            stmt = stmt.where(Article.title.contains(tu_khoa.strip()))

        if danh_muc:
            cat = _resolve_category(db, danh_muc)
            if cat:
                stmt = stmt.where(Article.category_id == cat.id)

        if trang_thai and trang_thai.strip():
            status_clean = trang_thai.strip().upper()
            stmt = stmt.where(Article.status == status_clean)

        count_stmt = select(func.count()).select_from(stmt.subquery())
        total = db.scalar(count_stmt) or 0

        rows = db.execute(stmt.order_by(Article.id.desc()).limit(limit).offset(offset)).all()

        items = []
        for article, category_name, author_name in rows:
            items.append({
                "id": article.id,
                "title": article.title,
                "slug": article.slug,
                "category_id": article.category_id,
                "category_name": category_name,
                "status": article.status,
                "excerpt": article.excerpt,
                "author_id": article.author_id,
                "author_name": author_name,
                "published_at": article.published_at.isoformat() if article.published_at else None,
                "view_count": article.view_count,
                "min_package_id": article.min_package_id,
                "tags": article.tags,
            })

        return _json({
            "ok": True,
            "tong_so": total,
            "gioi_han": limit,
            "bo_qua": offset,
            "bai_viet": items,
        })


@mcp.tool()
def xem_chi_tiet_bai_viet(article_id: Optional[int] = None, slug: Optional[str] = None) -> str:
    """Xem đầy đủ nội dung HTML, thông tin tác giả, danh mục và lịch sử của một bài viết.

    Bạn có thể tra cứu theo `article_id` hoặc theo đường dẫn tĩnh `slug`.
    """
    if article_id is None and (not slug or not slug.strip()):
        return _json({"ok": False, "loi": "Cần cung cấp ít nhất `article_id` hoặc `slug`"})

    with session_scope() as db:
        if article_id is not None:
            article = db.get(Article, article_id)
        else:
            article = db.scalar(select(Article).where(Article.slug == slug.strip()))

        if not article:
            return _json({"ok": False, "loi": "Không tìm thấy bài viết"})

        category = db.get(Category, article.category_id)
        author = db.get(Staff, article.author_id)
        reviewer = db.get(Staff, article.reviewed_by) if article.reviewed_by else None
        package = db.get(Package, article.min_package_id) if article.min_package_id else None

        versions_count = db.scalar(
            select(func.count()).where(ArticleVersion.article_id == article.id)
        ) or 0

        return _json({
            "ok": True,
            "id": article.id,
            "title": article.title,
            "slug": article.slug,
            "status": article.status,
            "category": {
                "id": category.id if category else article.category_id,
                "code": category.code if category else None,
                "name": category.name if category else None,
            },
            "content": article.content,
            "excerpt": article.excerpt,
            "thumbnail": article.thumbnail,
            "tags": article.tags,
            "author": {
                "id": author.id if author else article.author_id,
                "full_name": author.full_name if author else None,
                "username": author.username if author else None,
            },
            "reviewer": {
                "id": reviewer.id if reviewer else None,
                "full_name": reviewer.full_name if reviewer else None,
            } if reviewer else None,
            "min_package": {
                "id": package.id,
                "code": package.code,
                "name": package.name,
            } if package else None,
            "published_at": article.published_at.isoformat() if article.published_at else None,
            "view_count": article.view_count,
            "versions_count": versions_count,
            "created_at": article.created_at.isoformat() if article.created_at else None,
            "updated_at": article.updated_at.isoformat() if article.updated_at else None,
        })


# ======================================================================
# ĐĂNG BÀI & CẬP NHẬT (WRITE TOOLS)
# ======================================================================

@mcp.tool()
def dang_bai_viet(
    tieu_de: str,
    noi_dung: str,
    danh_muc: str,
    tom_tat: Optional[str] = None,
    the_tags: Optional[str] = None,
    anh_dai_dien: Optional[str] = None,
    trang_thai: str = "PUBLISHED",
    tac_gia: Optional[str] = None,
    goi_toi_thieu: Optional[str] = None,
    slug: Optional[str] = None,
    ngay_xuat_ban: Optional[str] = None,
) -> str:
    """Tạo và đăng bài viết mới vào hệ thống CMS của trang web.

    Hỗ trợ định dạng Markdown hoàn chỉnh (tiêu đề `#`, `##`, in đậm `**`, bảng dữ liệu, danh sách, link, ảnh...).
    Nội dung sẽ được tự động chuyển đổi thành HTML chuẩn và khử mã độc hại (XSS) theo chuẩn bảo mật hệ thống.

    Tham số:
    - `tieu_de`      : Tiêu đề bài viết (bắt buộc, từ 3 đến 255 ký tự).
    - `noi_dung`     : Toàn văn nội dung bài viết dạng Markdown hoặc HTML.
    - `danh_muc`     : Mã code danh mục (vd: "MARKET_COMMENT", "MACRO", "COMPANY_ANALYSIS",
                       "PORTFOLIO_REPORT", "STRATEGIC_STOCK", "NEWS", "BASIC_KNOWLEDGE") hoặc ID danh mục.
    - `tom_tat`      : Tóm tắt ngắn gọn hiển thị trên card (nếu để trống, hệ thống tự trích xuất 200 ký tự đầu).
    - `the_tags`     : Nhãn từ khoá phân tách bằng dấu phẩy (vd: "VNINDEX, HPG, Tín hiệu kỹ thuật").
    - `anh_dai_dien` : URL hoặc đường dẫn ảnh thumbnail của bài viết.
    - `trang_thai`   : "PUBLISHED" (xuất bản hiển thị ngay trên website, mặc định),
                       "DRAFT" (lưu bản nháp), hoặc "PENDING_REVIEW" (gửi chờ duyệt).
    - `tac_gia`      : Username hoặc ID nhân viên viết bài (nếu để trống, tự lấy tài khoản biên tập viên/superadmin).
    - `goi_toi_thieu`: Gói cước tối thiểu để đọc bài: "PKG3M", "PKG6M", "PKG12M" (hoặc None cho bài miễn phí).
    - `slug`         : Đường dẫn tĩnh tuỳ chọn (nếu không truyền sẽ tự sinh tự động từ tiêu đề).
    - `ngay_xuat_ban`: Thời gian xuất bản (ISO format). Mặc định là thời điểm hiện tại khi `trang_thai="PUBLISHED"`.
    """
    clean_title = (tieu_de or "").strip()
    if len(clean_title) < 3:
        return _json({"ok": False, "loi": "Tiêu đề bài viết phải có ít nhất 3 ký tự"})

    clean_content = _process_content(noi_dung)
    if not clean_content.strip():
        return _json({"ok": False, "loi": "Nội dung bài viết không được để trống"})

    status_upper = (trang_thai or "PUBLISHED").strip().upper()
    valid_statuses = {
        ArticleStatus.DRAFT,
        ArticleStatus.PENDING_REVIEW,
        ArticleStatus.PUBLISHED,
        ArticleStatus.ARCHIVED,
    }
    if status_upper not in valid_statuses:
        return _json({"ok": False, "loi": f"Trạng thái không hợp lệ: '{trang_thai}'. Các giá trị cho phép: {list(valid_statuses)}"})

    try:
        with session_scope() as db:
            # 1. Xác định Danh mục
            cat = _resolve_category(db, danh_muc)
            if not cat:
                return _json({
                    "ok": False,
                    "loi": f"Không tìm thấy danh mục bài viết '{danh_muc}'. Dùng tool `lay_danh_muc_bai_viet` để xem mã hợp lệ."
                })

            # 2. Xác định Tác giả
            author = _resolve_staff(db, tac_gia)
            if not author:
                return _json({"ok": False, "loi": "Không tìm thấy tài khoản nhân viên / tác giả hợp lệ trong hệ thống"})

            # 3. Xác định Gói cước (nếu có)
            pkg = _resolve_package(db, goi_toi_thieu) if goi_toi_thieu else None

            # 4. Xác định thời gian xuất bản
            pub_at = _parse_datetime(ngay_xuat_ban)
            if status_upper == ArticleStatus.PUBLISHED and pub_at is None:
                pub_at = utcnow()

            # 5. Tóm tắt excerpt
            excerpt_text = (tom_tat or "").strip()
            if not excerpt_text:
                excerpt_text = html_sanitizer.to_plain_text(clean_content, 200)

            # 6. Slug duy nhất
            final_slug = _unique_slug(db, clean_title, slug)

            # 7. Khởi tạo Article
            article = Article(
                category_id=cat.id,
                title=clean_title,
                slug=final_slug,
                excerpt=excerpt_text or None,
                content=clean_content,
                thumbnail=anh_dai_dien.strip() if anh_dai_dien else None,
                tags=the_tags.strip() if the_tags else None,
                min_package_id=pkg.id if pkg else None,
                status=status_upper,
                author_id=author.id,
                reviewed_by=author.id if status_upper == ArticleStatus.PUBLISHED else None,
                reviewed_at=utcnow() if status_upper == ArticleStatus.PUBLISHED else None,
                published_at=pub_at,
            )
            db.add(article)
            db.flush()

            # 8. Lưu phiên bản đầu tiên vào ArticleVersion (chuẩn BR-503)
            db.add(
                ArticleVersion(
                    article_id=article.id,
                    version=1,
                    title=article.title,
                    content=article.content,
                    edited_by=author.id,
                    change_note="Tạo mới qua MCP",
                )
            )

            # 9. Ghi Audit Log
            log_action(
                db,
                action=AuditAction.ARTICLE_CREATE,
                actor=author,
                target_type="article",
                target_id=article.id,
                new_value={"title": article.title, "slug": article.slug, "status": article.status},
                user_agent="MCP Server (stock-articles)",
            )
            if status_upper == ArticleStatus.PUBLISHED:
                log_action(
                    db,
                    action=AuditAction.ARTICLE_PUBLISH,
                    actor=author,
                    target_type="article",
                    target_id=article.id,
                    new_value={"status": ArticleStatus.PUBLISHED, "published_at": article.published_at},
                    user_agent="MCP Server (stock-articles)",
                )

            saved_id = article.id
            saved_slug = article.slug
            saved_status = article.status
            saved_cat_name = cat.name

        # 10. Báo sự kiện realtime ra ngoài
        if saved_status == ArticleStatus.PUBLISHED:
            _notify_change(saved_id, saved_slug, "published")

        return _json({
            "ok": True,
            "thong_bao": f"Đã đăng bài viết thành công (Trạng thái: {saved_status})",
            "article_id": saved_id,
            "title": clean_title,
            "slug": saved_slug,
            "category_name": saved_cat_name,
            "status": saved_status,
            "url_khach_hang": f"/articles/{saved_slug}",
            "url_admin": f"/admin/articles/{saved_id}",
        })
    except Exception as exc:
        log.exception("Lỗi khi đăng bài viết: %s", exc)
        return _json({"ok": False, "loi": f"Lỗi hệ thống: {exc}"})


@mcp.tool()
def cap_nhat_bai_viet(
    article_id: int,
    tieu_de: Optional[str] = None,
    noi_dung: Optional[str] = None,
    danh_muc: Optional[str] = None,
    tom_tat: Optional[str] = None,
    the_tags: Optional[str] = None,
    anh_dai_dien: Optional[str] = None,
    goi_toi_thieu: Optional[str] = None,
    slug: Optional[str] = None,
    ghi_chu_thay_doi: str = "Cập nhật qua MCP",
    nguoi_sua: Optional[str] = None,
) -> str:
    """Cập nhật nội dung hoặc thuộc tính của một bài viết đã tồn tại.

    Mỗi lần sửa đều tự động lưu lại một phiên bản trong `article_versions` kèm ghi chú thay đổi (BR-503).
    """
    try:
        with session_scope() as db:
            article = db.get(Article, article_id)
            if not article:
                return _json({"ok": False, "loi": f"Không tìm thấy bài viết #{article_id}"})

            editor = _resolve_staff(db, nguoi_sua)
            if not editor:
                return _json({"ok": False, "loi": "Không tìm thấy tài khoản nhân viên sửa bài"})

            # Cập nhật tiêu đề & slug
            if tieu_de and tieu_de.strip():
                article.title = tieu_de.strip()
                if slug and slug.strip():
                    article.slug = _unique_slug(db, article.title, slug.strip(), exclude_id=article.id)
                elif slug is None:
                    article.slug = _unique_slug(db, article.title, None, exclude_id=article.id)

            # Cập nhật danh mục
            if danh_muc:
                cat = _resolve_category(db, danh_muc)
                if cat:
                    article.category_id = cat.id

            # Cập nhật nội dung
            if noi_dung and noi_dung.strip():
                clean_content = _process_content(noi_dung)
                article.content = clean_content
                if not tom_tat:
                    article.excerpt = html_sanitizer.to_plain_text(clean_content, 200)

            if tom_tat is not None:
                article.excerpt = tom_tat.strip() or None

            if the_tags is not None:
                article.tags = the_tags.strip() or None

            if anh_dai_dien is not None:
                article.thumbnail = anh_dai_dien.strip() or None

            if goi_toi_thieu is not None:
                if str(goi_toi_thieu).strip().lower() in ("", "none", "0", "null"):
                    article.min_package_id = None
                else:
                    pkg = _resolve_package(db, goi_toi_thieu)
                    article.min_package_id = pkg.id if pkg else None

            # Tăng số phiên bản lịch sử
            last_ver = db.scalar(
                select(func.max(ArticleVersion.version)).where(ArticleVersion.article_id == article.id)
            ) or 0

            db.add(
                ArticleVersion(
                    article_id=article.id,
                    version=last_ver + 1,
                    title=article.title,
                    content=article.content,
                    edited_by=editor.id,
                    change_note=ghi_chu_thay_doi.strip() or "Cập nhật qua MCP",
                )
            )

            # Audit log
            log_action(
                db,
                action=AuditAction.ARTICLE_UPDATE,
                actor=editor,
                target_type="article",
                target_id=article.id,
                new_value={"version": last_ver + 1, "change_note": ghi_chu_thay_doi},
                user_agent="MCP Server (stock-articles)",
            )

            is_published = article.status == ArticleStatus.PUBLISHED
            saved_slug = article.slug

        if is_published:
            _notify_change(article_id, saved_slug, "updated")

        return _json({
            "ok": True,
            "thong_bao": f"Đã cập nhật bài viết #{article_id} (Phiên bản mới: #{last_ver + 1})",
            "article_id": article_id,
            "slug": saved_slug,
        })
    except Exception as exc:
        log.exception("Lỗi khi cập nhật bài viết: %s", exc)
        return _json({"ok": False, "loi": f"Lỗi hệ thống: {exc}"})


@mcp.tool()
def xuat_ban_bai_viet(
    article_id: int,
    nguoi_duyet: Optional[str] = None,
    ngay_xuat_ban: Optional[str] = None,
) -> str:
    """Xuất bản một bài viết đang ở trạng thái DRAFT hoặc PENDING_REVIEW sang PUBLISHED.

    Hành động này sẽ cập nhật `reviewed_by`, `reviewed_at`, và phát thông báo realtime
    để người dùng trên website có thể đọc ngay lập tức.
    """
    try:
        with session_scope() as db:
            article = db.get(Article, article_id)
            if not article:
                return _json({"ok": False, "loi": f"Không tìm thấy bài viết #{article_id}"})

            reviewer = _resolve_staff(db, nguoi_duyet)
            if not reviewer:
                return _json({"ok": False, "loi": "Không tìm thấy tài khoản nhân viên duyệt bài"})

            old_status = article.status
            article.status = ArticleStatus.PUBLISHED
            article.reviewed_by = reviewer.id
            article.reviewed_at = utcnow()

            pub_dt = _parse_datetime(ngay_xuat_ban)
            article.published_at = pub_dt or article.published_at or utcnow()

            log_action(
                db,
                action=AuditAction.ARTICLE_PUBLISH,
                actor=reviewer,
                target_type="article",
                target_id=article.id,
                old_value={"status": old_status},
                new_value={"status": ArticleStatus.PUBLISHED, "published_at": article.published_at},
                user_agent="MCP Server (stock-articles)",
            )
            saved_slug = article.slug

        _notify_change(article_id, saved_slug, "published")
        return _json({
            "ok": True,
            "thong_bao": f"Đã xuất bản bài viết #{article_id} ra công chúng",
            "article_id": article_id,
            "slug": saved_slug,
            "url_khach_hang": f"/articles/{saved_slug}",
        })
    except Exception as exc:
        log.exception("Lỗi khi xuất bản bài viết: %s", exc)
        return _json({"ok": False, "loi": f"Lỗi hệ thống: {exc}"})


@mcp.tool()
def chuyen_trang_thai_bai_viet(
    article_id: int,
    trang_thai: str,
    ly_do: Optional[str] = None,
    nhan_vien: Optional[str] = None,
) -> str:
    """Thay đổi trạng thái của bài viết: "DRAFT", "PENDING_REVIEW", "PUBLISHED", hoặc "ARCHIVED"."""
    status_upper = (trang_thai or "").strip().upper()
    valid_statuses = {
        ArticleStatus.DRAFT: "Nháp",
        ArticleStatus.PENDING_REVIEW: "Chờ duyệt",
        ArticleStatus.PUBLISHED: "Đã xuất bản",
        ArticleStatus.ARCHIVED: "Lưu trữ",
    }
    if status_upper not in valid_statuses:
        return _json({"ok": False, "loi": f"Trạng thái không hợp lệ. Chọn một trong: {list(valid_statuses.keys())}"})

    try:
        with session_scope() as db:
            article = db.get(Article, article_id)
            if not article:
                return _json({"ok": False, "loi": f"Không tìm thấy bài viết #{article_id}"})

            staff = _resolve_staff(db, nhan_vien)
            if not staff:
                return _json({"ok": False, "loi": "Không tìm thấy tài khoản nhân viên thực hiện"})

            old_status = article.status
            article.status = status_upper

            if status_upper == ArticleStatus.PUBLISHED:
                article.reviewed_by = staff.id
                article.reviewed_at = utcnow()
                if not article.published_at:
                    article.published_at = utcnow()

            log_action(
                db,
                action=AuditAction.ARTICLE_PUBLISH if status_upper == ArticleStatus.PUBLISHED else AuditAction.ARTICLE_UPDATE,
                actor=staff,
                target_type="article",
                target_id=article.id,
                old_value={"status": old_status},
                new_value={"status": status_upper},
                reason=ly_do,
                user_agent="MCP Server (stock-articles)",
            )
            saved_slug = article.slug

        if status_upper == ArticleStatus.PUBLISHED:
            _notify_change(article_id, saved_slug, "published")
        elif old_status == ArticleStatus.PUBLISHED:
            _notify_change(article_id, saved_slug, "unpublished")

        return _json({
            "ok": True,
            "thong_bao": f"Đã chuyển bài viết #{article_id} sang trạng thái: {valid_statuses[status_upper]} ({status_upper})",
            "article_id": article_id,
            "status": status_upper,
        })
    except Exception as exc:
        log.exception("Lỗi khi đổi trạng thái: %s", exc)
        return _json({"ok": False, "loi": f"Lỗi hệ thống: {exc}"})


@mcp.tool()
def xoa_bai_viet(article_id: int, ly_do: str, nhan_vien: Optional[str] = None) -> str:
    """Xoá vĩnh viễn một bài viết khỏi hệ thống.

    Theo nguyên tắc nghiệp vụ BR-503 / BR-304: hành động xoá bài viết BẮT BUỘC phải cung cấp `ly_do`
    để ghi nhật ký kiểm toán (Audit Log) nhằm phục vụ đối soát và an toàn dữ liệu.
    """
    clean_reason = (ly_do or "").strip()
    if not clean_reason:
        return _json({"ok": False, "loi": "Theo chuẩn an toàn dữ liệu BR-503, bạn BẮT BUỘC phải cung cấp `ly_do` xoá bài viết"})

    try:
        with session_scope() as db:
            article = db.get(Article, article_id)
            if not article:
                return _json({"ok": False, "loi": f"Không tìm thấy bài viết #{article_id}"})

            staff = _resolve_staff(db, nhan_vien)
            if not staff:
                return _json({"ok": False, "loi": "Không tìm thấy tài khoản nhân viên thực hiện xoá"})

            was_published = article.status == ArticleStatus.PUBLISHED
            saved_slug = article.slug

            log_action(
                db,
                action=AuditAction.ARTICLE_DELETE,
                actor=staff,
                target_type="article",
                target_id=article.id,
                old_value={"title": article.title, "slug": article.slug, "status": article.status},
                reason=clean_reason,
                user_agent="MCP Server (stock-articles)",
            )

            db.delete(article)

        if was_published:
            _notify_change(article_id, saved_slug, "deleted")

        return _json({
            "ok": True,
            "thong_bao": f"Đã xoá thành công bài viết #{article_id}",
            "article_id": article_id,
            "ly_do": clean_reason,
        })
    except Exception as exc:
        log.exception("Lỗi khi xoá bài viết: %s", exc)
        return _json({"ok": False, "loi": f"Lỗi hệ thống: {exc}"})


@mcp.tool()
def lay_lich_su_phien_ban(article_id: int) -> str:
    """Lấy danh sách các phiên bản đã sửa đổi của một bài viết (BR-503)."""
    with session_scope() as db:
        stmt = (
            select(ArticleVersion, Staff.full_name, Staff.username)
            .outerjoin(Staff, Staff.id == ArticleVersion.edited_by)
            .where(ArticleVersion.article_id == article_id)
            .order_by(ArticleVersion.version.desc())
        )
        rows = db.execute(stmt).all()
        if not rows:
            return _json({"ok": True, "article_id": article_id, "phien_ban": [], "tong_so": 0})

        items = []
        for ver, staff_name, staff_uname in rows:
            items.append({
                "version": ver.version,
                "title": ver.title,
                "change_note": ver.change_note,
                "edited_by": staff_name or staff_uname or f"Staff #{ver.edited_by}",
                "created_at": ver.created_at.isoformat() if ver.created_at else None,
            })

        return _json({
            "ok": True,
            "article_id": article_id,
            "tong_so": len(items),
            "phien_ban": items,
        })


def main() -> None:
    log.info("MCP stock-articles khởi động (stdio), DB=%s", settings.db_name)
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
