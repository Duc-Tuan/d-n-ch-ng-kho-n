"""Bóc chữ từ tài liệu chiến lược để làm bối cảnh cho AI.

Ba quyết định đáng nói:

**Đọc file gốc, không đóng dấu chìm.** `storage_service.watermark_pdf` chỉ dành cho lượt tải của
khách hàng — nó chèn tên và mã khách lên từng trang. Đóng dấu rồi bóc chữ sẽ trộn rác vào bối
cảnh của mô hình.

**Bóc một lần rồi cache vào `strategy_kb_docs.extracted_text`.** Một chiến lược 19 lô/ngày mà
bóc lại mỗi lô là 19 lần đọc cùng một file PDF. Quan trọng hơn: cache đảm bảo mọi lô nhận **cùng
một bối cảnh**, nên kết quả giữa các mã mới so sánh được với nhau.

**Không im lặng bỏ qua file không đọc được.** `docx/xlsx/pptx` chưa bóc được và PDF quét ảnh bóc
ra rỗng — cả hai đều ghi trạng thái vào `index_status` và **liệt kê tên file** ra `run.summary`.
Một chiến lược mất tài liệu nền vẫn cho ra phân tích trôi chảy, chỉ là chung chung; không có cách
nào nhận ra điều đó từ kết quả, nên phải nói ra ở đây.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.constants import KbIndexStatus
from app.core.datetime_utils import utcnow
from app.models.content import Document
from app.models.strategy import StrategyKbDoc
from app.services import storage_service

log = logging.getLogger(__name__)

#: Trần ký tự cho toàn bộ bối cảnh tài liệu của một chiến lược.
#:
#: Claude Code cảnh báo khi một kết quả MCP vượt 10.000 token và **cắt ở 25.000**
#: (`MAX_MCP_OUTPUT_TOKENS`). Cắt xảy ra ở giữa câu, không báo lỗi — mô hình vẫn trả lời, chỉ là
#: trên bối cảnh cụt. Cắt chủ động ở đây, kèm ghi chú thấy được, thì ít nhất biết là đã cắt.
MAX_CONTEXT_CHARS = 60_000

#: Trần cho một tài liệu đơn lẻ — để một file dày không nuốt hết chỗ của các file còn lại.
MAX_DOC_CHARS = 30_000

#: Đuôi file nhận ra được nhưng chưa bóc được chữ. `storage_service.MIME_BY_EXT` cho phép tải
#: lên, nên chúng có thật trong kho; im lặng bỏ qua sẽ giấu mất việc thiếu tài liệu nền.
UNSUPPORTED_EXT = {"docx", "xlsx", "pptx", "png", "jpg", "jpeg"}


def _ext_of(document: Document) -> str:
    return (document.original_name or "").rsplit(".", 1)[-1].lower()


def extract_pdf_text(path, max_chars: int = MAX_DOC_CHARS) -> str:
    """Bóc chữ khỏi PDF. Trả chuỗi rỗng khi là bản quét ảnh (không có lớp text)."""
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    parts: list[str] = []
    total = 0
    for page in reader.pages:
        try:
            text = page.extract_text() or ""
        except Exception:  # pragma: no cover — trang hỏng không được làm chết cả tài liệu
            continue
        text = text.strip()
        if not text:
            continue
        parts.append(text)
        total += len(text)
        if total >= max_chars:
            break
    return "\n\n".join(parts)[:max_chars].strip()


def ensure_extracted(db: Session, link: StrategyKbDoc, document: Document,
                     force: bool = False) -> str:
    """Bóc chữ nếu chưa có, ghi kết quả và trạng thái vào `strategy_kb_docs`.

    Trả về toàn văn (chuỗi rỗng nếu không bóc được). Hàm `flush`, không `commit` — tầng gọi
    quyết định ranh giới giao dịch.
    """
    if not force and link.extracted_text and link.index_status == KbIndexStatus.OK:
        return link.extracted_text

    ext = _ext_of(document)
    link.extracted_at = utcnow()
    link.indexed_at = link.extracted_at

    if ext in UNSUPPORTED_EXT:
        link.index_status = KbIndexStatus.UNSUPPORTED
        link.extracted_text = None
        db.flush()
        return ""

    if ext != "pdf":
        link.index_status = KbIndexStatus.UNSUPPORTED
        link.extracted_text = None
        db.flush()
        return ""

    path = storage_service.resolve_path(document.stored_name)
    if not path.exists():
        link.index_status = KbIndexStatus.EMPTY
        link.extracted_text = None
        db.flush()
        log.warning("Tài liệu %s không còn file trên đĩa: %s", document.id, path)
        return ""

    try:
        text = extract_pdf_text(path)
    except Exception as exc:
        log.warning("Bóc chữ thất bại tài liệu %s: %s", document.id, exc)
        link.index_status = KbIndexStatus.EMPTY
        link.extracted_text = None
        db.flush()
        return ""

    if not text:
        # PDF quét ảnh: có file, có trang, không có lớp chữ. Cần OCR — chưa làm ở bước này.
        link.index_status = KbIndexStatus.EMPTY
        link.extracted_text = None
        db.flush()
        return ""

    link.index_status = KbIndexStatus.OK
    link.extracted_text = text
    db.flush()
    return text


def strategy_context(db: Session, strategy_id: int, force: bool = False) -> dict:
    """Toàn bộ bối cảnh tài liệu của một chiến lược, kèm danh sách file bị bỏ qua.

    Trả về `{"text": str, "documents": [...], "skipped": [{"title", "reason"}]}`.
    `skipped` đi thẳng vào `run.summary` — đó là chỗ duy nhất người vận hành nhìn thấy nó.
    """
    rows = db.execute(
        select(StrategyKbDoc, Document)
        .join(Document, Document.id == StrategyKbDoc.document_id)
        .where(StrategyKbDoc.strategy_id == strategy_id, Document.is_active.is_(True))
        .order_by(StrategyKbDoc.id)
    ).all()

    chunks: list[str] = []
    used: list[dict] = []
    skipped: list[dict] = []
    total = 0

    for link, document in rows:
        text = ensure_extracted(db, link, document, force=force)
        if not text:
            skipped.append(
                {
                    "document_id": document.id,
                    "title": document.title,
                    "file": document.original_name,
                    "reason": (
                        "Định dạng chưa bóc được chữ (docx/xlsx/pptx/ảnh)"
                        if link.index_status == KbIndexStatus.UNSUPPORTED
                        else "PDF không có lớp văn bản (bản quét ảnh) hoặc file lỗi"
                    ),
                    "index_status": link.index_status,
                }
            )
            continue

        remaining = MAX_CONTEXT_CHARS - total
        if remaining <= 0:
            skipped.append(
                {
                    "document_id": document.id,
                    "title": document.title,
                    "file": document.original_name,
                    "reason": f"Vượt trần bối cảnh {MAX_CONTEXT_CHARS:,} ký tự",
                    "index_status": link.index_status,
                }
            )
            continue

        piece = text[:remaining]
        total += len(piece)
        chunks.append(f"### Tài liệu: {document.title}\n\n{piece}")
        # `truncated` **phải** đi kèm. Một PDF 212 trang bị cắt còn 30.000 ký tự vẫn cho ra
        # phân tích trôi chảy — chỉ là dựa trên 15% tài liệu — và không có cách nào nhận ra
        # điều đó từ kết quả. Báo "OK" mà không báo đã cắt là giấu mất một sai số lớn.
        cut_by_doc = len(text) >= MAX_DOC_CHARS
        cut_by_context = len(piece) < len(text)
        used.append(
            {
                "document_id": document.id,
                "title": document.title,
                "chars": len(piece),
                "truncated": cut_by_doc or cut_by_context,
                "truncated_reason": (
                    f"Cắt ở {MAX_DOC_CHARS:,} ký tự — trần cho một tài liệu"
                    if cut_by_doc
                    else (
                        f"Cắt vì đạt trần bối cảnh {MAX_CONTEXT_CHARS:,} ký tự"
                        if cut_by_context
                        else None
                    )
                ),
            }
        )

    return {"text": "\n\n---\n\n".join(chunks), "documents": used, "skipped": skipped}


def has_documents(db: Session, strategy_id: int) -> bool:
    """Chiến lược có tài liệu đang hoạt động nào không — dùng để chia nhánh ENGINE/AI."""
    return bool(
        db.scalar(
            select(StrategyKbDoc.id)
            .join(Document, Document.id == StrategyKbDoc.document_id)
            .where(StrategyKbDoc.strategy_id == strategy_id, Document.is_active.is_(True))
            .limit(1)
        )
    )
