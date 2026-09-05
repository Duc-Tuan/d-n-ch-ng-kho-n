"""Kiểm thử bộ lọc HTML của bài viết.

Nội dung bài viết được render bằng `dangerouslySetInnerHTML` trên site khách hàng. Nếu một trong
những trường hợp dưới đây lọt qua, đó là lỗ hổng XSS lưu trữ: kẻ tấn công chỉ cần một tài khoản
biên tập là chiếm được phiên đăng nhập của **mọi khách hàng** đọc bài đó.

Đây là loại kiểm thử phải chạy trước mỗi lần phát hành, không phải viết một lần rồi quên.
"""

from __future__ import annotations

import pytest

from app.services.html_sanitizer import sanitize_html, to_plain_text


@pytest.mark.parametrize(
    "payload,forbidden",
    [
        # Thẻ thực thi mã.
        ("<script>alert(1)</script>", "script"),
        ("<script src='//evil.com/x.js'></script>", "script"),
        ("<SCRIPT>alert(1)</SCRIPT>", "script"),
        # Thuộc tính sự kiện — cách phổ biến nhất sau khi <script> bị chặn.
        ("<img src=x onerror=alert(1)>", "onerror"),
        ("<p onclick='steal()'>bấm</p>", "onclick"),
        ("<div onmouseover=alert(1)>di chuột</div>", "onmouseover"),
        ("<body onload=alert(1)>", "onload"),
        # Giao thức nguy hiểm trong liên kết.
        ("<a href='javascript:alert(1)'>bấm</a>", "javascript:"),
        ("<a href='JaVaScRiPt:alert(1)'>bấm</a>", "javascript:"),
        ("<a href='data:text/html;base64,PHNjcmlwdD4='>tải</a>", "data:"),
        ("<a href='vbscript:msgbox(1)'>bấm</a>", "vbscript:"),
        # Khung nhúng và thẻ nhúng nội dung ngoài.
        ("<iframe src='//evil.com'></iframe>", "iframe"),
        ("<object data='//evil.com'></object>", "object"),
        ("<embed src='//evil.com'>", "embed"),
        ("<svg onload=alert(1)></svg>", "svg"),
        # `style` là đường vòng để nhúng mã và để phủ nội dung giả lên giao diện thật.
        ("<p style='background:url(javascript:alert(1))'>x</p>", "style"),
        ("<style>body{display:none}</style>", "style"),
        # Chuyển hướng và thẻ meta.
        ("<meta http-equiv='refresh' content='0;url=//evil.com'>", "meta"),
        ("<base href='//evil.com/'>", "base"),
        # Biểu mẫu giả để lừa nhập mật khẩu ngay trong bài viết.
        ("<form action='//evil.com'><input name='password'></form>", "form"),
    ],
)
def test_chan_moi_dang_ma_doc(payload: str, forbidden: str):
    result = sanitize_html(payload).lower()
    assert forbidden.lower() not in result, f"Còn sót '{forbidden}' trong: {result}"


@pytest.mark.parametrize(
    "payload,expected_fragment",
    [
        ("<p>Đoạn văn <strong>đậm</strong></p>", "<strong>đậm</strong>"),
        ("<h2>Tiêu đề</h2>", "<h2>Tiêu đề</h2>"),
        ("<ul><li>một</li><li>hai</li></ul>", "<li>một</li>"),
        ("<blockquote>trích dẫn</blockquote>", "<blockquote>"),
        ("<a href='https://vnexpress.net'>báo</a>", 'href="https://vnexpress.net"'),
        ("<img src='/api/v1/media/abc.png' alt='biểu đồ'>", 'src="/api/v1/media/abc.png"'),
        ("<table><tr><td>ô</td></tr></table>", "<td>ô</td>"),
        ("<pre><code>x = 1</code></pre>", "<code>x = 1</code>"),
    ],
)
def test_giu_nguyen_noi_dung_hop_le(payload: str, expected_fragment: str):
    """Lọc quá tay cũng là lỗi: biên tập soạn bài đúng cách mà nội dung bị nuốt thì không dùng được."""
    assert expected_fragment in sanitize_html(payload)


def test_giu_kich_thuoc_anh_bien_tap_da_chinh():
    """Trình soạn thảo lưu kích thước ảnh bằng thuộc tính `width` (vì `style` bị chặn có chủ đích).

    Gỡ `width` khỏi danh sách trắng sẽ làm mọi thao tác chỉnh kích thước ảnh mất tác dụng ngay lúc
    lưu — bài viết trông vẫn bình thường trong trình soạn thảo nhưng hỏng sau khi đăng.
    """
    result = sanitize_html('<img src="/api/v1/media/abc.png" alt="biểu đồ" width="480">')
    assert 'width="480"' in result


def test_link_ra_ngoai_luon_co_rel_chong_lo_phien():
    """Thiếu `rel=noopener`, trang đích đọc được `window.opener` và đổi hướng tab gốc sang trang giả."""
    result = sanitize_html("<a href='https://vnexpress.net' target='_blank'>báo</a>")
    assert 'rel="noopener noreferrer nofollow"' in result


def test_noi_dung_rong_tra_chuoi_rong():
    assert sanitize_html(None) == ""
    assert sanitize_html("") == ""
    assert sanitize_html("   ") == ""


def test_the_ho_duoc_dong_lai():
    """Thẻ hở sẽ phá vỡ bố cục của cả trang khi bài được chèn vào giao diện khách hàng."""
    result = sanitize_html("<p>chưa đóng<div>lồng sai</p>")
    assert result.count("<p>") == result.count("</p>")
    assert result.count("<div>") == result.count("</div>")


def test_tom_tat_tu_dong_khong_dinh_chu_giua_hai_khoi():
    """"<h2>Tiêu đề</h2><p>Nội dung</p>" phải ra "Tiêu đề Nội dung", không phải "Tiêu đềNội dung"."""
    result = to_plain_text("<h2>Tiêu đề</h2><p>Nội dung bài</p>")
    assert result == "Tiêu đề Nội dung bài"


def test_tom_tat_cat_o_ranh_gioi_tu():
    result = to_plain_text("<p>" + "một hai ba bốn năm sáu bảy tám " * 10 + "</p>", limit=30)
    assert len(result) <= 32
    assert result.endswith("…")
    assert "  " not in result


def test_tom_tat_khong_giu_lai_ma_doc():
    """Đoạn tóm tắt hiển thị ở danh sách bài viết — cũng phải sạch như nội dung chính."""
    result = to_plain_text("<script>alert(1)</script><p>Nội dung thật</p>")
    assert "alert" not in result
    assert "Nội dung thật" in result


# ======================================================================
# HTML tới nơi ở dạng đã escape
# ======================================================================
def test_go_escape_khi_ca_chuoi_la_the_bi_ma_hoa():
    """Mô hình gửi `&lt;p&gt;` thay vì `<p>` khoảng một nửa số lần.

    `nh3.clean` giữ nguyên thực thể — đúng như nó phải làm — nên trước khi có bước gỡ escape,
    chuỗi đó xuống CSDL vẫn ở dạng mã hoá và khách hàng đọc được nguyên văn `<p><strong>…` trên
    màn hình bản tin.
    """
    result = sanitize_html("&lt;p&gt;&lt;strong&gt;Có điểm mua&lt;/strong&gt;&lt;/p&gt;")
    assert result == "<p><strong>Có điểm mua</strong></p>"


def test_go_escape_roi_van_loc_ma_doc():
    """Gỡ escape **trước** rồi mới lọc, nên thẻ nguy hiểm không đi đường vòng qua thực thể."""
    result = sanitize_html("&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;ok&lt;/p&gt;")
    assert "script" not in result
    assert "alert" not in result
    assert result == "<p>ok</p>"


def test_khong_go_escape_khi_bai_dang_noi_ve_html():
    """Có thẻ thật lẫn trong chuỗi thì để nguyên: đó là ví dụ trong bài, không phải lỗi mã hoá."""
    result = sanitize_html("<p>Dùng thẻ &lt;p&gt; để xuống dòng</p>")
    assert result == "<p>Dùng thẻ &lt;p&gt; để xuống dòng</p>"


def test_van_ban_thuong_khong_bi_dung_toi():
    result = sanitize_html("Lãi 5 < 7 và A & B")
    assert "&lt;" in result and "&amp;" in result
