"""RBAC theo quyền (BR-530).

Role là một *tập hợp quyền*; một nhân viên gán một hoặc nhiều role.
BR-533: kiểm tra quyền phải thực hiện ở backend trên **từng endpoint** — ẩn menu không phải phân quyền.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models.staff import Staff


@dataclass(frozen=True, slots=True)
class Perm:
    code: str
    name: str
    module: str


# ======================================================================
# DANH MỤC QUYỀN
# ======================================================================
PERMISSIONS: tuple[Perm, ...] = (
    # Dashboard & báo cáo
    Perm("dashboard.view", "Xem dashboard", "dashboard"),
    Perm("report.export", "Xuất báo cáo", "dashboard"),
    # Nội dung
    Perm("content.view", "Xem bài viết", "content"),
    Perm("content.create", "Tạo bài viết", "content"),
    Perm("content.edit", "Sửa bài viết của mình", "content"),
    Perm("content.edit_all", "Sửa mọi bài viết", "content"),
    Perm("content.submit", "Gửi duyệt bài viết", "content"),
    Perm("content.publish", "Xuất bản bài viết", "content"),
    Perm("content.delete", "Xoá bài viết", "content"),
    # Tài liệu
    Perm("doc.view", "Xem tài liệu", "document"),
    Perm("doc.upload", "Tải lên tài liệu", "document"),
    Perm("doc.edit", "Sửa tài liệu", "document"),
    Perm("doc.delete", "Xoá tài liệu", "document"),
    # Khách hàng
    Perm("customer.view", "Xem khách hàng", "customer"),
    Perm("customer.create", "Tạo tài khoản khách hàng", "customer"),
    Perm("customer.note", "Ghi chú chăm sóc", "customer"),
    Perm("customer.reset_password", "Gửi mã đặt lại mật khẩu", "customer"),
    Perm("customer.extend", "Gia hạn / cấp gói thủ công", "customer"),
    Perm("customer.suspend", "Tạm khoá / mở khoá tài khoản", "customer"),
    Perm("customer.close", "Đóng vĩnh viễn tài khoản", "customer"),
    Perm("customer.exempt", "Miễn áp điều kiện IB", "customer"),
    Perm("customer.export", "Xuất danh sách khách hàng", "customer"),
    # Chiến lược & tín hiệu
    Perm("strategy.view", "Xem chiến lược", "strategy"),
    Perm("strategy.manage", "Tạo/sửa chiến lược", "strategy"),
    Perm("signal.create", "Nhập tín hiệu", "strategy"),
    Perm("signal.cancel", "Huỷ tín hiệu", "strategy"),
    Perm("qa.answer", "Trả lời câu hỏi khách hàng", "strategy"),
    # Vận hành
    Perm("sync.view", "Xem trạng thái job đồng bộ", "ops"),
    Perm("sync.run", "Chạy lại job thủ công", "ops"),
    Perm("symbol.manage", "Thêm/sửa/xoá mã trong danh mục theo dõi", "ops"),
    Perm("notification.send", "Gửi thông báo thủ công", "ops"),
    Perm("telegram.view", "Xem thống kê Telegram", "ops"),
    # Quản trị hệ thống
    Perm("staff.view", "Xem nhân viên", "system"),
    Perm("staff.manage", "Quản lý nhân viên & phân quyền", "system"),
    Perm("audit.view", "Xem audit log", "system"),
    Perm("legal.manage", "Quản lý văn bản pháp lý", "system"),
)

PERMISSION_CODES: frozenset[str] = frozenset(p.code for p in PERMISSIONS)


# ======================================================================
# BỘ ROLE ĐỀ XUẤT — mục 3.5
# ======================================================================
SUPER_ADMIN = "SUPER_ADMIN"

ROLE_DEFINITIONS: dict[str, dict] = {
    SUPER_ADMIN: {
        "name": "Quản trị tối cao",
        "description": "Toàn quyền trên hệ thống",
        "permissions": ["*"],  # ký hiệu đặc biệt — xem has_permission()
    },
    "CONTENT_EDITOR": {
        "name": "Biên tập nội dung",
        "description": "Soạn bài viết, chỉ sửa bài của mình, không được xuất bản",
        "permissions": ["dashboard.view", "content.view", "content.create", "content.edit",
                        "content.submit"],
    },
    "CONTENT_MANAGER": {
        "name": "Quản lý nội dung",
        "description": "Toàn quyền bài viết, được xuất bản",
        "permissions": ["dashboard.view", "content.view", "content.create", "content.edit",
                        "content.edit_all", "content.submit", "content.publish", "content.delete"],
    },
    "DOC_MANAGER": {
        "name": "Quản lý tài liệu",
        "description": "Quản lý kho tài liệu phân tích",
        "permissions": ["dashboard.view", "doc.view", "doc.upload", "doc.edit", "doc.delete"],
    },
    "CUSTOMER_SUPPORT": {
        "name": "Chăm sóc khách hàng",
        "description": "Chỉ đọc hồ sơ KH và ghi chú",
        "permissions": ["dashboard.view", "customer.view", "customer.create",
                        "customer.note", "customer.reset_password"],
    },
    "SALES_IB": {
        "name": "Kinh doanh / Môi giới IB",
        "description": "Quản lý KH và màn hình cảnh báo WARNING",
        "permissions": ["dashboard.view", "customer.view", "customer.note", "customer.extend",
                        "customer.export", "notification.send", "telegram.view"],
    },
    "ANALYST": {
        "name": "Chuyên viên phân tích",
        "description": "Dashboard, chiến lược, trả lời hỏi đáp",
        # Danh mục theo dõi và tier là việc của phân tích, nên quyền quản lý mã nằm ở đây.
        "permissions": ["dashboard.view", "report.export", "strategy.view", "strategy.manage",
                        "signal.create", "qa.answer", "content.view", "content.create",
                        "content.submit", "sync.view", "symbol.manage"],
    },
}


# ======================================================================
def has_permission(staff: Staff, permission: str) -> bool:
    """SUPER_ADMIN có toàn quyền; các role khác xét theo tập quyền hợp nhất."""
    if any(r.code == SUPER_ADMIN for r in staff.roles):
        return True
    return permission in staff.permission_codes


def has_any_permission(staff: Staff, permissions: list[str]) -> bool:
    if any(r.code == SUPER_ADMIN for r in staff.roles):
        return True
    codes = staff.permission_codes
    return any(p in codes for p in permissions)


def is_super_admin(staff: Staff) -> bool:
    return any(r.code == SUPER_ADMIN for r in staff.roles)


def effective_permissions(staff: Staff) -> list[str]:
    """Trả về danh sách quyền để FE ẩn/hiện menu.

    Lưu ý: đây **chỉ là tiện ích giao diện**. Việc chặn thật nằm ở dependency
    `require_permission` trên từng endpoint (BR-533).
    """
    if is_super_admin(staff):
        return sorted(PERMISSION_CODES)
    return sorted(staff.permission_codes)
