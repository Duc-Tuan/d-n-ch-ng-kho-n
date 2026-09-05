"""Bài viết và kho tài liệu (mục 3.2, 3.3)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import ArticleStatus, CategoryType
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin


class Category(Base, IdMixin, TimestampMixin):
    __tablename__ = "categories"

    code: Mapped[str] = mapped_column(String(50), nullable=False)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    type: Mapped[str] = mapped_column(String(15), nullable=False, default=CategoryType.ARTICLE, index=True)
    sort_order: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

    __table_args__ = (Index("uq_category_code_type", "code", "type", unique=True),)


class Article(Base, IdMixin, TimestampMixin):
    """BR-500..503."""

    __tablename__ = "articles"

    category_id: Mapped[int] = mapped_column(PKType, ForeignKey("categories.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    slug: Mapped[str] = mapped_column(String(255), unique=True, nullable=False)
    excerpt: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    thumbnail: Mapped[str | None] = mapped_column(String(500))
    tags: Mapped[str | None] = mapped_column(String(500))

    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=ArticleStatus.DRAFT, index=True
    )
    #: BR-502 — nội dung cao cấp chỉ hiện với gói dài hạn.
    min_package_id: Mapped[int | None] = mapped_column(PKType, ForeignKey("packages.id"))

    author_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    reviewed_by: Mapped[int | None] = mapped_column(PKType)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime)
    #: BR-501 — cho phép đặt lịch xuất bản trong tương lai.
    published_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)
    view_count: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"),
                                            nullable=False, default=0)

    category: Mapped[Category] = relationship()

    __table_args__ = (Index("ix_article_status_published", "status", "published_at"),)


class ArticleVersion(Base, IdMixin, CreatedAtMixin):
    """BR-503 — biết ai sửa gì lúc nào."""

    __tablename__ = "article_versions"

    article_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    edited_by: Mapped[int] = mapped_column(PKType, nullable=False)
    change_note: Mapped[str | None] = mapped_column(String(255))


class Document(Base, IdMixin, TimestampMixin):
    """BR-510..513 — file KHÔNG nằm trong thư mục public."""

    __tablename__ = "documents"

    category_id: Mapped[int] = mapped_column(PKType, ForeignKey("categories.id"), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)

    #: Tên file đã đổi khi lưu (BR-510) — không bao giờ giữ tên gốc do KH đặt.
    stored_name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    file_size: Mapped[int] = mapped_column(BigInteger().with_variant(Integer(), "sqlite"), nullable=False)
    mime_type: Mapped[str] = mapped_column(String(100), nullable=False)
    checksum: Mapped[str | None] = mapped_column(String(64))

    min_package_id: Mapped[int | None] = mapped_column(PKType, ForeignKey("packages.id"))

    #: NULL = tài liệu của kho chung (nhân viên tải lên, mọi khách đủ gói đều thấy).
    #: Có giá trị = tài liệu riêng của một khách hàng, đính vào chiến lược cá nhân của họ.
    #:
    #: Không có cột này thì file khách tự tải lên rơi thẳng vào kho tài liệu chung và hiện ra
    #: với mọi khách hàng khác — vỡ BR-850 ngay ở lượt tải đầu tiên.
    owner_user_id: Mapped[int | None] = mapped_column(PKType, index=True)

    uploaded_by: Mapped[int] = mapped_column(PKType, nullable=False)
    download_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, index=True)

    category: Mapped[Category] = relationship()


class DocumentDownload(Base, IdMixin, CreatedAtMixin):
    """BR-513 — log mọi lượt tải: ai, file nào, lúc nào, IP nào."""

    __tablename__ = "document_downloads"

    document_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(400))
    watermarked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)


class ArticleView(Base, IdMixin, CreatedAtMixin):
    """Tab 5 của mục 3.4 — lịch sử xem bài viết của KH."""

    __tablename__ = "article_views"

    article_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("articles.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(String(45))
