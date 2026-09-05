"""Lưu trữ tài liệu — BR-510, 511, 512.

Nguyên tắc: file **không nằm trong thư mục public**; mọi lượt tải đi qua endpoint kiểm tra quyền.
"""

from __future__ import annotations

import hashlib
import io
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.core.config import settings
from app.core.exceptions import ValidationError
from app.core.security import create_token

log = logging.getLogger(__name__)

MIME_BY_EXT = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
}

#: Chữ ký byte đầu file — chặn trường hợp đổi đuôi file để lách whitelist.
MAGIC_BYTES = {
    "pdf": [b"%PDF"],
    "png": [b"\x89PNG\r\n\x1a\n"],
    "jpg": [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
    "docx": [b"PK\x03\x04"],
    "xlsx": [b"PK\x03\x04"],
    "pptx": [b"PK\x03\x04"],
}


def storage_root() -> Path:
    path = settings.storage_path
    path.mkdir(parents=True, exist_ok=True)
    return path


async def read_upload(file, max_mb: int | None = None) -> bytes:
    """Đọc nội dung file tải lên, **dừng ngay** khi vượt hạn mức.

    `await file.read()` đọc trọn thân request vào bộ nhớ rồi mới để tầng trên kiểm tra dung
    lượng — nghĩa là kiểm tra diễn ra sau khi thiệt hại đã xong. Một request khai
    `Content-Length: 5GB` sẽ hạ tiến trình bằng OOM trước khi chạm tới dòng kiểm tra đầu tiên.
    Đọc theo khối và bỏ ngang khiến chi phí của kẻ tấn công lớn hơn chi phí của máy chủ.
    """
    limit = (max_mb if max_mb is not None else settings.max_upload_mb) * 1024 * 1024
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        size += len(chunk)
        if size > limit:
            raise ValidationError(
                f"File vượt quá dung lượng cho phép ({limit // (1024 * 1024)}MB)",
                {"field": "file"},
            )
        chunks.append(chunk)
    return b"".join(chunks)


def resolve_path(stored_name: str) -> Path:
    """Ghép đường dẫn an toàn — chặn path traversal từ tên file trong DB."""
    safe = Path(stored_name).name
    return storage_root() / safe


def validate_upload(filename: str, size: int, head: bytes) -> tuple[str, str]:
    """BR-510 — whitelist đuôi file, giới hạn dung lượng, kiểm tra chữ ký byte.

    Trả về (extension, mime_type).
    """
    ext = Path(filename).suffix.lower().lstrip(".")
    if ext not in settings.allowed_ext_set:
        raise ValidationError(
            f"Định dạng .{ext} không được phép. Chỉ chấp nhận: "
            f"{', '.join(sorted(settings.allowed_ext_set))}",
            {"field": "file"},
        )

    max_bytes = settings.max_upload_mb * 1024 * 1024
    if size > max_bytes:
        raise ValidationError(
            f"File vượt quá dung lượng cho phép ({settings.max_upload_mb}MB)", {"field": "file"}
        )
    if size == 0:
        raise ValidationError("File rỗng", {"field": "file"})

    signatures = MAGIC_BYTES.get(ext)
    if signatures and not any(head.startswith(sig) for sig in signatures):
        raise ValidationError(
            "Nội dung file không khớp với phần mở rộng. File có thể đã bị đổi đuôi.",
            {"field": "file"},
        )

    return ext, MIME_BY_EXT.get(ext, "application/octet-stream")


def generate_stored_name(ext: str) -> str:
    """BR-510 — **đổi tên file khi lưu**, không giữ tên gốc do người dùng đặt."""
    return f"{datetime.now(timezone.utc):%Y%m%d}_{uuid.uuid4().hex}.{ext}"


def save_file(content: bytes, stored_name: str) -> str:
    """Ghi file xuống ổ đĩa, trả về checksum SHA-256."""
    path = resolve_path(stored_name)
    path.write_bytes(content)
    return hashlib.sha256(content).hexdigest()


def delete_file(stored_name: str) -> None:
    path = resolve_path(stored_name)
    if path.exists():
        path.unlink()


#: Giá trị của claim `scope` trên token tải tài liệu.
DOWNLOAD_SCOPE = "download"


def create_download_token(document_id: int, user_id: int) -> str:
    """BR-511 — token TTL ngắn, gắn cứng với đúng (document, user).

    Hai điểm quan trọng, cả hai đều từng sai:

    * **Thời hạn đúng bằng `SIGNED_URL_TTL_SECONDS`.** Trước đây token này mượn hạn mặc định của
      access token (30 phút) trong khi phiếu tải trả về cho giao diện lại ghi 5 phút — link sống
      gấp sáu lần thời gian được công bố.
    * **Claim `scope`.** Token đi trong URL, nên nó rơi vào lịch sử trình duyệt, header `Referer`
      và log của reverse proxy. Không có `scope`, nó là một access token hoàn chỉnh: ai nhặt được
      link tải chỉ cần gắn vào header `Authorization` là đọc được toàn bộ tài khoản đó.
      `deps.current_user` từ chối mọi token có `scope`, nên token này chỉ mở được đúng một tài liệu.
    """
    return create_token(
        user_id,
        "customer",
        "access",
        extra={"scope": DOWNLOAD_SCOPE, "doc": document_id},
        expires_in=timedelta(seconds=settings.signed_url_ttl_seconds),
    )


# ----------------------------------------------------------------------
# BR-512 — watermark động
# ----------------------------------------------------------------------
def _mask_email(email: str) -> str:
    """Che một phần email — đủ để truy vết nhưng không phơi bày địa chỉ đầy đủ trên mỗi trang."""
    name, _, domain = email.partition("@")
    visible = name[:3] if len(name) > 3 else name
    return f"{visible}{'*' * max(len(name) - len(visible), 0)}@{domain}"


def watermark_pdf(source: Path, email: str, customer_code: str | None) -> io.BytesIO | None:
    """Đóng dấu email KH + thời điểm tải lên từng trang PDF.

    Trả về None nếu không watermark được — khi đó tầng gọi trả file gốc thay vì chặn KH tải.
    Đây là đánh đổi có chủ ý: chống phát tán quan trọng, nhưng chặn KH đã trả tiền
    tải tài liệu vì một lỗi thư viện thì tệ hơn.
    """
    try:
        from pypdf import PdfReader, PdfWriter
        from reportlab.lib.pagesizes import A4
        from reportlab.pdfgen import canvas

        stamp = (
            f"{_mask_email(email)} · {customer_code or ''} · "
            f"{datetime.now(settings.tz):%d/%m/%Y %H:%M}"
        )

        reader = PdfReader(str(source))
        writer = PdfWriter()

        for page in reader.pages:
            width = float(page.mediabox.width) or A4[0]
            height = float(page.mediabox.height) or A4[1]

            buffer = io.BytesIO()
            c = canvas.Canvas(buffer, pagesize=(width, height))
            # Dấu mờ chéo giữa trang.
            c.saveState()
            c.setFillColorRGB(0.6, 0.6, 0.6, alpha=0.18)
            c.setFont("Helvetica-Bold", 26)
            c.translate(width / 2, height / 2)
            c.rotate(35)
            c.drawCentredString(0, 0, stamp)
            c.restoreState()
            # Dòng chân trang, dễ đọc khi ảnh chụp màn hình bị cắt.
            c.setFillColorRGB(0.45, 0.45, 0.45, alpha=0.55)
            c.setFont("Helvetica", 7)
            c.drawString(20, 12, stamp)
            c.save()
            buffer.seek(0)

            overlay = PdfReader(buffer).pages[0]
            page.merge_page(overlay)
            writer.add_page(page)

        output = io.BytesIO()
        writer.write(output)
        output.seek(0)
        return output

    except Exception as exc:
        log.warning("Không đóng được watermark cho %s: %s", source.name, exc)
        return None


def sanitize_filename(name: str) -> str:
    """Làm sạch tên gốc trước khi lưu vào DB (vẫn hiển thị lại cho KH khi tải)."""
    cleaned = re.sub(r"[\r\n\t\"\\/]", "_", name).strip()
    return cleaned[:255] or "tai-lieu"
