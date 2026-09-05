"""Ảnh minh hoạ trong bài viết (YC14).

Đường dẫn nằm ngoài hai vùng `/customer` và `/admin` vì cùng một tấm ảnh được cả hai bên xem:
biên tập nhìn khi soạn bài, khách hàng nhìn khi đọc bài. Nhân đôi endpoint chỉ để giữ hình thức
đối xứng sẽ khiến mọi ảnh phải có hai đường dẫn và bài viết lưu nhầm đường dẫn của site kia.

**Quyền xem**: cần một phiên đăng nhập bất kỳ (khách hàng hoặc nhân viên). Cố tình không khoá
theo từng bài viết:

* Tên file là chuỗi ngẫu nhiên 32 ký tự hex nên không đoán được.
* Một tấm ảnh có thể được dùng lại ở nhiều bài; ràng ảnh vào đúng một bài sẽ hỏng khi biên tập
  chép đoạn văn sang bài khác.
* Điều đáng bảo vệ là **tài liệu bán tiền** — thứ đó nằm ở `documents`, có kiểm tra gói, đóng dấu
  chìm và ghi nhật ký từng lượt tải. Ảnh minh hoạ giữa bài viết không cùng hạng giá trị đó.

Yêu cầu đăng nhập là để chặn người ngoài dùng máy chủ làm kho ảnh miễn phí, không phải để bảo mật
nội dung.
"""

from __future__ import annotations

from fastapi import APIRouter, Request, Response
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.core.deps import CUSTOMER_ACCESS_COOKIE, STAFF_ACCESS_COOKIE, DbSession
from app.core.exceptions import NotFound, Unauthorized
from app.core.security import decode_token
from app.models.media import MediaAsset
from app.services import storage_service

router = APIRouter(prefix="/media", tags=["media"])

#: Ảnh trong bài viết không đổi nội dung (tên file gắn với nội dung), nên cho trình duyệt giữ lâu.
CACHE_CONTROL = "private, max-age=604800, immutable"


def _require_any_session(request: Request) -> None:
    """Chấp nhận phiên của khách hàng **hoặc** của nhân viên.

    Đây là ngoại lệ duy nhất với nguyên tắc tách đôi ở BR-000, và nó an toàn vì chỉ dùng để trả
    ảnh minh hoạ — không đọc dữ liệu của ai, không thao tác gì. Hai loại token vẫn được kiểm bằng
    hai khoá bí mật riêng; ở đây chỉ là "một trong hai hợp lệ là đủ".
    """
    for cookie_name, audience in (
        (CUSTOMER_ACCESS_COOKIE, "customer"),
        (STAFF_ACCESS_COOKIE, "staff"),
    ):
        token = request.cookies.get(cookie_name)
        if not token:
            continue
        # `decode_token` **trả về None** khi token sai, nó không ném lỗi. Bọc trong try/except rồi
        # `return` ngay sau lời gọi nghĩa là mọi chuỗi rác đặt vào cookie đều được coi là hợp lệ —
        # cả cửa xác thực này chỉ kiểm tra "có cookie tên đó hay không". Phải xét giá trị trả về.
        payload = decode_token(token, audience)
        if payload and payload.get("typ") == "access":
            return

    raise Unauthorized("Cần đăng nhập để xem ảnh trong bài viết")


@router.get("/{stored_name}")
def get_media(stored_name: str, request: Request, db: DbSession) -> Response:
    _require_any_session(request)

    asset = db.scalar(
        select(MediaAsset).where(
            MediaAsset.stored_name == stored_name, MediaAsset.is_active.is_(True)
        )
    )
    if not asset:
        raise NotFound("Không tìm thấy ảnh")

    path = storage_service.resolve_path(asset.stored_name)
    if not path.exists():
        # Bản ghi còn mà file mất — thường do khôi phục CSDL không kèm thư mục lưu trữ.
        raise NotFound("Ảnh không còn trên máy chủ")

    # `FileResponse` truyền theo luồng; `path.read_bytes()` nạp trọn file vào RAM cho **mỗi**
    # request. Một bài viết mười ảnh với năm mươi người đọc cùng lúc là năm trăm bản sao trong
    # bộ nhớ, tất cả chỉ để phục vụ những byte vốn đã nằm sẵn trên đĩa.
    return FileResponse(
        path,
        media_type=asset.mime_type,
        headers={
            "Cache-Control": CACHE_CONTROL,
            # Ảnh luôn được hiển thị trong trang, không bao giờ dùng làm trang độc lập.
            "Content-Disposition": "inline",
            "X-Content-Type-Options": "nosniff",
        },
    )
