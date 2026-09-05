"""Endpoint công khai — landing page, văn bản pháp lý, bảng giá gói.

Không yêu cầu đăng nhập. Đây là phần bổ sung cho hạng mục còn thiếu số 5 ở Phần 8
(trang chủ công khai) — KH mới cần xem được gì đó trước khi đăng ký.
"""

from __future__ import annotations

from fastapi import APIRouter
from sqlalchemy import select

from app.core.constants import DISCLAIMER_TEXT, LegalDocType
from app.core.deps import DbSession
from app.core.exceptions import NotFound
from app.models.notification import LegalDocument
from app.models.user import Package
from app.schemas.domain import LegalDocumentOut, PackageOut

router = APIRouter(prefix="/public", tags=["public"])


@router.get("/packages", response_model=list[PackageOut])
def public_packages(db: DbSession) -> list[Package]:
    """Bảng giá công khai cho landing page."""
    return list(
        db.scalars(
            select(Package)
            .where(Package.is_active.is_(True))
            .order_by(Package.sort_order, Package.tier)
        ).all()
    )


@router.get("/legal/{doc_type}", response_model=LegalDocumentOut)
def public_legal(doc_type: str, db: DbSession) -> LegalDocument:
    """Mục 9.1 — ToS, Privacy, Refund, Disclaimer, Cookie hiển thị ở footer và bước đăng ký."""
    valid = {t.value for t in LegalDocType}
    if doc_type.upper() not in valid:
        raise NotFound("Loại văn bản không hợp lệ")

    doc = db.scalar(
        select(LegalDocument).where(
            LegalDocument.type == doc_type.upper(), LegalDocument.is_current.is_(True)
        )
    )
    if not doc:
        raise NotFound("Văn bản chưa được ban hành")
    return doc


@router.get("/legal", response_model=list[LegalDocumentOut])
def public_legal_list(db: DbSession) -> list[LegalDocument]:
    return list(
        db.scalars(
            select(LegalDocument)
            .where(LegalDocument.is_current.is_(True))
            .order_by(LegalDocument.type)
        ).all()
    )


@router.get("/disclaimer", response_model=dict)
def public_disclaimer() -> dict:
    """BR-601 — disclaimer cố định, FE gắn ở footer và chân mọi màn có khuyến nghị."""
    return {"text": DISCLAIMER_TEXT}


@router.get("/health", response_model=dict)
def health(db: DbSession) -> dict:
    from sqlalchemy import text

    db.execute(text("SELECT 1"))
    return {"status": "ok"}
