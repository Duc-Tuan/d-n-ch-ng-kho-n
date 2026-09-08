"""Đường dẫn mở khi khách hàng bấm vào một thông báo, và mức độ khẩn của nó.

Vì sao cần một chỗ riêng thay vì thêm hai cột vào bảng `notifications`:

* Thông báo được ghi vào hàng đợi ở **rất nhiều nơi** (`auth_service`, `compliance_service`,
  `jobs/tasks`, ba màn quản trị). Bắt mỗi chỗ tự nghĩ ra đường dẫn nghĩa là sớm muộn có chỗ quên,
  và triệu chứng là một thông báo bấm vào không đi đâu cả — người dùng không báo lỗi, họ chỉ thôi
  không bấm nữa.
* Đường dẫn là chuyện của **giao diện**, mà giao diện đổi route thì hàng nghìn dòng đã lưu trong
  CSDL vẫn giữ đường dẫn cũ và dẫn thẳng vào trang 404. Tính lúc đọc thì đổi route chỉ phải sửa
  đúng file này.

Bảng thông báo của nhân viên (`staff_notifications`) đi đường khác: nó **có** cột `link`, vì bên
đó mỗi thông báo sinh ra từ một sự kiện vận hành cụ thể và nơi tạo biết chính xác cần mở màn nào.
Bên khách hàng thì cùng một mã dùng lại cho nhiều tình huống, nên phải suy ra.

Điểm mấu chốt khi đọc file này: **`reference_id` mới là thứ phân biệt, không phải `code`.**
`ADMIN_BROADCAST` đang gánh năm tình huống khác hẳn nhau (chia sẻ chiến lược, gỡ chiến lược,
Telegram bị chặn, yêu cầu xoá tài khoản, đổi phạm vi theo dõi) — chỉ tiền tố của `reference_id`
mới tách được chúng ra.
"""

from __future__ import annotations

from app.core.constants import NotificationCode
from app.models.notification import Notification

#: Màn hình mặc định khi không suy ra được gì cụ thể hơn.
INBOX = "/notifications"


def _ref_parts(reference_id: str) -> tuple[str, list[str]]:
    """Tách `"scope:12:HPG"` thành `("scope", ["12", "HPG"])`."""
    if not reference_id:
        return "", []
    head, _, rest = reference_id.partition(":")
    return head, [part for part in rest.split(":") if part]


def link_for(notification: Notification) -> str | None:
    """Đường dẫn nội bộ nên mở, hoặc `None` nếu thông báo không dẫn đi đâu cả.

    Trả `None` chứ không trả `INBOX` khi không có đích thật: giao diện dựa vào đó để **không** vẽ
    mũi tên và không đổi con trỏ chuột. Một thông báo bấm vào rồi quay lại đúng chỗ cũ gây khó
    chịu hơn hẳn một thông báo trông rõ ràng là chỉ để đọc.
    """
    payload = notification.payload or {}
    prefix, parts = _ref_parts(notification.reference_id or "")

    # ── Phân theo reference_id trước ────────────────────────────────────
    if prefix == "qa":
        # Hỏi đáp nằm trong màn chiến lược chứ không có màn riêng, nên phải biết chiến lược nào.
        strategy_id = payload.get("strategy_id")
        return f"/strategies/{strategy_id}" if strategy_id else "/strategies"
    if prefix == "scope" and parts:
        return f"/strategies/{parts[0]}"
    if prefix == "share" and parts:
        return f"/strategies/{parts[0]}"
    if prefix == "strategy_removed":
        # Chiến lược đã bị gỡ khỏi danh sách của khách — mở trang chi tiết là vào đúng chỗ 404.
        return "/strategies"
    if prefix == "tg_blocked":
        return "/account/notifications"
    if prefix == "delete_req":
        return "/account"

    # ── Rồi mới tới mã thông báo ────────────────────────────────────────
    code = notification.code

    if code in (
        NotificationCode.COMPLIANCE_WARNING,
        NotificationCode.COMPLIANCE_WARNING_D3,
        NotificationCode.COMPLIANCE_WARNING_D1,
        NotificationCode.COMPLIANCE_RESTORED,
    ):
        return "/account/compliance"
    if code == NotificationCode.COMPLIANCE_SUSPENDED:
        # Tài khoản đang bị khoá: mọi màn khác đều đẩy về đây, dẫn thẳng cho đỡ một nhịp.
        return "/account/blocked"

    if code in (
        NotificationCode.EXPIRY_T15,
        NotificationCode.EXPIRY_T7,
        NotificationCode.EXPIRY_T3,
        NotificationCode.EXPIRY_T1,
        NotificationCode.EXPIRY_T0,
        NotificationCode.GRACE_END,
        NotificationCode.TRIAL_D5,
        NotificationCode.TRIAL_D6,
        NotificationCode.TRIAL_D7,
        NotificationCode.TRIAL_EXPIRED,
        NotificationCode.IB_LINK_REMINDER,
    ):
        # Việc cần làm là gia hạn, nên dẫn tới bảng giá chứ không tới trang thông tin tài khoản.
        return "/pricing"

    if code in (
        NotificationCode.PAYMENT_SUCCESS,
        NotificationCode.ACCOUNT_CREATED,
        NotificationCode.WELCOME,
        NotificationCode.VERIFY_EMAIL,
        NotificationCode.PASSWORD_CHANGED,
        NotificationCode.NEW_DEVICE_LOGIN,
    ):
        return "/account"

    if code == NotificationCode.NEW_SIGNAL:
        strategy_id = payload.get("strategy_id")
        return f"/strategies/{strategy_id}" if strategy_id else "/strategies"

    if code == NotificationCode.NEW_ARTICLE:
        slug = payload.get("slug")
        return f"/articles/{slug}" if slug else "/articles"

    # NEW_DOCUMENT và ADMIN_BROADCAST chung chung: chưa có màn đích chắc chắn nên không dẫn đi
    # đâu, thay vì đoán một đường dẫn có thể 404.
    return None


#: Mã thông báo cần người đọc **hành động ngay**, không chỉ để biết.
_DANGER = frozenset(
    {
        NotificationCode.COMPLIANCE_SUSPENDED,
        NotificationCode.GRACE_END,
        NotificationCode.TRIAL_EXPIRED,
        NotificationCode.EXPIRY_T0,
    }
)

#: Mã cần chú ý nhưng chưa tới mức mất quyền dùng.
_WARNING = frozenset(
    {
        NotificationCode.COMPLIANCE_WARNING,
        NotificationCode.COMPLIANCE_WARNING_D3,
        NotificationCode.COMPLIANCE_WARNING_D1,
        NotificationCode.EXPIRY_T15,
        NotificationCode.EXPIRY_T7,
        NotificationCode.EXPIRY_T3,
        NotificationCode.EXPIRY_T1,
        NotificationCode.TRIAL_D5,
        NotificationCode.TRIAL_D6,
        NotificationCode.TRIAL_D7,
        NotificationCode.NEW_DEVICE_LOGIN,
        NotificationCode.PASSWORD_CHANGED,
    }
)


def level_for(notification: Notification) -> str:
    """`info` | `warning` | `danger` — cùng thang với hộp thông báo của nhân viên.

    Có mặt để hai site đọc được bằng cùng một mắt: cùng bộ màu, cùng ý nghĩa. Không có nó thì mọi
    thông báo trông giống hệt nhau, và cái báo "tài khoản đã bị khoá" nằm lẫn giữa những cái báo
    "chào mừng bạn".
    """
    if notification.code in _DANGER:
        return "danger"
    if notification.code in _WARNING:
        return "warning"
    return "info"
