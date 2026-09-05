"""Tin tức dẫn nguồn — Customer Site.

Chỉ đọc. Không có màn chi tiết: bấm vào một tin là sang thẳng trang gốc. Endpoint `click` chỉ để
đếm lượt, và giao diện **không được chờ nó** trước khi mở link — người đọc không phải trả giá
bằng một vòng mạng cho số liệu thống kê của chúng ta.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select, update

from app.core.deps import ActiveUser, DbSession
from app.core.pagination import PageParams, page_params, paginate_page
from app.models.news import NewsItem
from app.schemas.common import Message
from app.schemas.domain import NewsItemOut

router = APIRouter(prefix="/news", tags=["customer-news"])

Pagination = Annotated[PageParams, Depends(page_params)]


@router.get("", response_model=dict)
def list_news(
    user: ActiveUser,
    db: DbSession,
    params: Pagination,
    q: str | None = Query(default=None, max_length=100),
) -> dict:
    stmt = select(NewsItem).where(NewsItem.is_active.is_(True))
    if q:
        pattern = f"%{q.strip()}%"
        stmt = stmt.where(
            or_(NewsItem.title.like(pattern), NewsItem.summary.like(pattern))
        )
    stmt = stmt.order_by(
        NewsItem.sort_order.desc(), NewsItem.published_at.desc(), NewsItem.id.desc()
    )
    return paginate_page(db, stmt, params, NewsItemOut.model_validate)


@router.post("/{news_id}/click", response_model=Message)
def track_click(news_id: int, user: ActiveUser, db: DbSession) -> Message:
    """Đếm lượt bấm. Cộng bằng biểu thức SQL để hai lượt cùng lúc không đè số của nhau."""
    db.execute(
        update(NewsItem)
        .where(NewsItem.id == news_id, NewsItem.is_active.is_(True))
        .values(click_count=NewsItem.click_count + 1)
    )
    db.commit()
    return Message(message="OK")
