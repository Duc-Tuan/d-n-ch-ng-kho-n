"""Lọc HTML của bài viết trước khi lưu.

Nội dung bài viết được render bằng `dangerouslySetInnerHTML` trên site khách hàng. Nếu không
lọc, một tài khoản biên tập bị chiếm quyền có thể nhúng `<script>` vào bài viết và chiếm phiên
đăng nhập của **mọi khách hàng** đọc bài đó — lỗ hổng XSS lưu trữ, loại nghiêm trọng nhất vì nó
tự lan mà không cần dụ nạn nhân bấm gì.

Lọc ở **máy chủ lúc lưu**, không phải ở trình duyệt lúc hiển thị. Lọc phía trình duyệt chỉ bảo
vệ được người dùng chạy đúng mã của mình; ai gọi thẳng API vẫn nhận HTML gốc. Và dữ liệu bẩn nằm
trong cơ sở dữ liệu là quả bom hẹn giờ cho mọi nơi khác đọc lại nó sau này.

Danh sách thẻ ở đây là **danh sách trắng**: cái gì không có tên thì bị gỡ. Ngược lại — liệt kê
thẻ nguy hiểm để chặn — luôn thua, vì trình duyệt liên tục có cách viết mới.
"""

from __future__ import annotations

import html as html_std
import re

import nh3

#: Thẻ cho phép — đủ để soạn một bài phân tích có tiêu đề, bảng, ảnh, trích dẫn và mã.
ALLOWED_TAGS = {
    "p", "br", "hr", "div", "span",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "mark", "sub", "sup",
    "ul", "ol", "li",
    "blockquote", "pre", "code",
    "a", "img", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
}

#: Thuộc tính cho phép theo từng thẻ. Không cho `style` ở bất cứ đâu — `style` là đường vòng kinh
#: điển để nhúng mã (`background:url(javascript:…)`) và để phủ nội dung giả lên giao diện thật.
ALLOWED_ATTRIBUTES = {
    # Không liệt kê `rel` ở đây: `link_rel` bên dưới tự gắn, và nh3 từ chối chạy nếu khai cả hai.
    "a": {"href", "title", "target"},
    "img": {"src", "alt", "title", "width", "height"},
    "th": {"colspan", "rowspan", "scope"},
    "td": {"colspan", "rowspan"},
    "col": {"span"},
    "colgroup": {"span"},
    # `class` chỉ mở cho vài thẻ bố cục, để giao diện gắn được kiểu hiển thị bảng và ảnh.
    "div": {"class"},
    "span": {"class"},
    "figure": {"class"},
    "table": {"class"},
    "pre": {"class"},
    "code": {"class"},
}

#: Giao thức cho phép trong `href` và `src`. Thiếu dòng này thì `javascript:` lọt qua.
ALLOWED_SCHEMES = {"http", "https", "mailto"}


#: Dấu hiệu "cả chuỗi là HTML đã bị escape": một thẻ mở/đóng viết dưới dạng thực thể.
_ESCAPED_TAG = re.compile(r"&lt;/?[a-zA-Z]")


def _unescape_if_escaped_markup(raw: str) -> str:
    """Gỡ escape khi nội dung là HTML đã bị mã hoá thành thực thể.

    Vì sao cần: `luu_phan_tich` nhận `public_summary` từ mô hình, và mô hình **không nhất quán** —
    khoảng một nửa số lần nó gửi `&lt;p&gt;` thay vì `<p>`. `nh3.clean` giữ nguyên thực thể (đúng
    như nó phải làm), nên chuỗi đó xuống CSDL vẫn ở dạng escape và khách hàng đọc được nguyên văn
    thẻ `<p><strong>…` trên màn hình.

    Điều kiện chặt có chủ đích — chỉ gỡ khi **không có thẻ thật nào** trong chuỗi. Nội dung có
    lẫn cả hai dạng thì để nguyên: đó gần như chắc chắn là văn bản đang *nói về* HTML, và gỡ
    escape ở đó sẽ biến ví dụ trong bài thành thẻ thật.

    An toàn không phụ thuộc vào hàm này: `nh3.clean` vẫn chạy **sau**, nên `&lt;script&gt;` gỡ ra
    thành `<script>` rồi bị danh sách trắng gỡ bỏ như mọi thẻ lạ khác.

    Vòng lặp chỉ chạy tiếp khi lớp vừa gỡ lại lộ ra một lớp escape nữa mà vẫn chưa có thẻ thật.
    Chuỗi escape hai lớp ngay từ đầu (`&amp;lt;p&amp;gt;`) **không** khớp điều kiện và được giữ
    nguyên — chưa từng gặp, và đoán mò ở đây rủi ro hơn là để nguyên.
    """
    for _ in range(3):
        if "<" in raw or not _ESCAPED_TAG.search(raw):
            return raw
        raw = html_std.unescape(raw)
    return raw


def sanitize_html(raw: str | None) -> str:
    """Trả về HTML đã lọc. Nội dung rỗng trả chuỗi rỗng."""
    if not raw or not raw.strip():
        return ""

    raw = _unescape_if_escaped_markup(raw)

    return nh3.clean(
        raw,
        tags=ALLOWED_TAGS,
        attributes={tag: set(attrs) for tag, attrs in ALLOWED_ATTRIBUTES.items()},
        url_schemes=ALLOWED_SCHEMES,
        # Link ra ngoài luôn kèm rel chống lộ phiên qua `window.opener`.
        link_rel="noopener noreferrer nofollow",
        strip_comments=True,
    )


def to_plain_text(html: str | None, limit: int = 300) -> str:
    """Rút văn bản thuần từ HTML — dùng để sinh đoạn tóm tắt khi biên tập bỏ trống.

    Cách làm: lọc sạch mọi thẻ rồi gom khoảng trắng. Không cố dựng cây HTML vì mục đích ở đây chỉ
    là một dòng xem trước, không cần chính xác từng dấu cách.
    """
    if not html:
        return ""

    # Chèn khoảng trắng vào ranh giới thẻ trước khi gỡ, nếu không "</h2><p>" sẽ dính hai khối
    # thành một từ ("Tiêu đềNội dung").
    text = nh3.clean(html.replace("><", "> <"), tags=set(), attributes={})
    # nh3 để lại thực thể HTML; đổi vài cái hay gặp cho dễ đọc.
    for entity, char in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        text = text.replace(entity, char)

    collapsed = " ".join(text.split())
    if len(collapsed) <= limit:
        return collapsed
    # Cắt ở ranh giới từ để không đứt giữa chừng.
    return collapsed[:limit].rsplit(" ", 1)[0] + "…"
