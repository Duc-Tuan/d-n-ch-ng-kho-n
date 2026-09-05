"""Nhân viên, RBAC và audit log (mục 3.5, 3.6)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.constants import StaffStatus
from app.models.base import Base, CreatedAtMixin, IdMixin, PKType, TimestampMixin

staff_roles_cols = ("staff_id", "role_id")


class Staff(Base, IdMixin, TimestampMixin):
    """Tài khoản quản trị — bảng riêng, không dùng chung với `users` (BR-000)."""

    __tablename__ = "staff"

    username: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    email: Mapped[str] = mapped_column(String(190), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(150), nullable=False)
    phone: Mapped[str | None] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(10), nullable=False, default=StaffStatus.ACTIVE, index=True)

    # BR-532 — 2FA bắt buộc cho toàn bộ tài khoản Admin Site
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    totp_enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    totp_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)

    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    failed_login_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime)
    must_change_password: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    roles: Mapped[list["Role"]] = relationship(secondary="staff_roles", back_populates="staff_members")

    @property
    def permission_codes(self) -> set[str]:
        """Tập quyền hợp nhất từ tất cả role được gán (BR-530)."""
        codes: set[str] = set()
        for role in self.roles:
            codes.update(p.code for p in role.permissions)
        return codes


class Role(Base, IdMixin, TimestampMixin):
    __tablename__ = "roles"

    code: Mapped[str] = mapped_column(String(40), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    description: Mapped[str | None] = mapped_column(String(255))
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    permissions: Mapped[list["Permission"]] = relationship(
        secondary="role_permissions", back_populates="roles"
    )
    staff_members: Mapped[list[Staff]] = relationship(secondary="staff_roles", back_populates="roles")


class Permission(Base, IdMixin):
    __tablename__ = "permissions"

    code: Mapped[str] = mapped_column(String(60), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(150), nullable=False)
    module: Mapped[str] = mapped_column(String(40), nullable=False, index=True)

    roles: Mapped[list[Role]] = relationship(secondary="role_permissions", back_populates="permissions")


class RolePermission(Base):
    __tablename__ = "role_permissions"

    role_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )
    permission_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("permissions.id", ondelete="CASCADE"), primary_key=True
    )


class StaffRole(Base):
    __tablename__ = "staff_roles"

    staff_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("staff.id", ondelete="CASCADE"), primary_key=True
    )
    role_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True
    )


class StaffSession(Base, IdMixin, CreatedAtMixin):
    __tablename__ = "staff_sessions"

    staff_id: Mapped[int] = mapped_column(
        PKType, ForeignKey("staff.id", ondelete="CASCADE"), nullable=False, index=True
    )
    session_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)
    refresh_token_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(400))
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime)


class AuditLog(Base, IdMixin, CreatedAtMixin):
    """Mục 3.6 — ghi mọi hành động thay đổi dữ liệu trên Admin Site.

    Bắt buộc với: gia hạn/cấp gói thủ công, khoá/mở tài khoản, xoá bài viết,
    thay đổi phân quyền, miễn áp điều kiện IB.
    """

    __tablename__ = "audit_logs"

    actor_id: Mapped[int | None] = mapped_column(PKType, index=True)
    actor_type: Mapped[str] = mapped_column(String(10), nullable=False, default="STAFF")
    actor_name: Mapped[str | None] = mapped_column(String(150))
    action: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    target_type: Mapped[str | None] = mapped_column(String(40), index=True)
    target_id: Mapped[str | None] = mapped_column(String(40), index=True)
    old_value: Mapped[dict | None] = mapped_column(nullable=True)
    new_value: Mapped[dict | None] = mapped_column(nullable=True)
    reason: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(400))

    __table_args__ = (Index("ix_audit_target", "target_type", "target_id"),)


class StaffNotification(Base, IdMixin, CreatedAtMixin):
    """Thông báo vận hành gửi tới nhân viên.

    Tách khỏi bảng `notifications` của khách hàng vì hai đối tượng hoàn toàn khác nhau (BR-000):
    khác bảng tài khoản, khác vòng đời, khác quyền đọc. Gộp chung sẽ phải thêm cột phân biệt và
    mọi truy vấn đều phải nhớ lọc — sớm muộn cũng có chỗ quên.

    `staff_id = NULL` nghĩa là thông báo chung cho mọi nhân viên có quyền tương ứng.
    """

    __tablename__ = "staff_notifications"

    staff_id: Mapped[int | None] = mapped_column(PKType, index=True)
    #: Quyền cần có để đọc thông báo này (ví dụ 'qa.answer'). NULL = mọi nhân viên.
    required_permission: Mapped[str | None] = mapped_column(String(60))

    code: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    body: Mapped[str | None] = mapped_column(Text)
    #: Đường dẫn mở khi bấm vào thông báo.
    link: Mapped[str | None] = mapped_column(String(255))
    level: Mapped[str] = mapped_column(String(10), nullable=False, default="info")

    read_at: Mapped[datetime | None] = mapped_column(DateTime, index=True)

    __table_args__ = (Index("ix_staff_notif_unread", "staff_id", "read_at"),)


class StaffPasswordChange(Base, IdMixin, CreatedAtMixin):
    """Yêu cầu đổi mật khẩu đang chờ xác nhận bằng mã gửi qua email.

    Vì sao phải có bảng riêng thay vì đổi thẳng:

    Mật khẩu quản trị mở được toàn bộ dữ liệu khách hàng. Nếu ai đó chiếm được phiên đang mở của
    nhân viên (máy không khoá màn hình, cookie bị lấy), họ vẫn cần **mật khẩu cũ** để đổi — nhưng
    nếu chỉ có vậy thì một lần nhìn trộm bàn phím là đủ. Bước xác nhận qua email buộc kẻ tấn công
    phải kiểm soát thêm hòm thư, và quan trọng hơn: **chủ tài khoản thật nhận được email** nên
    biết ngay có người đang cố đổi mật khẩu của mình.

    Mật khẩu mới được băm ngay khi tạo yêu cầu — bảng này không bao giờ giữ mật khẩu dạng thô.
    """

    __tablename__ = "staff_password_changes"

    staff_id: Mapped[int] = mapped_column(PKType, nullable=False, index=True)
    #: Băm bcrypt của mật khẩu mới, chỉ áp dụng khi xác nhận đúng mã.
    new_password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    otp_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    request_ip: Mapped[str | None] = mapped_column(String(45))
