"""Seed dữ liệu khởi tạo.

Chạy:  python -m app.scripts.seed

Tạo: quyền & vai trò (mục 3.5) · tài khoản Super Admin · gói dịch vụ (mục 2.4) ·
danh mục bài viết/tài liệu (mục 3.2, 3.3) · template thông báo (BR-811) ·
văn bản pháp lý bản nháp (Phần 9) · lịch giao dịch năm hiện tại (BR-402).

Script idempotent — chạy lại nhiều lần không tạo dữ liệu trùng.
"""

from __future__ import annotations

import sys
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select

from app.core.config import settings
from app.core.constants import (
    CategoryType,
    LegalDocType,
    NotificationChannel,
    NotificationCode,
    StaffStatus,
)
from app.core.database import session_scope
from app.core.security import hash_password
from app.models.content import Category
from app.models.nav import TradingCalendar
from app.models.notification import LegalDocument, NotificationTemplate
from app.models.staff import Permission, Role, Staff
from app.models.user import Package
from app.services import rbac


def seed_permissions_and_roles(db) -> None:
    existing = {p.code for p in db.scalars(select(Permission)).all()}
    for perm in rbac.PERMISSIONS:
        if perm.code not in existing:
            db.add(Permission(code=perm.code, name=perm.name, module=perm.module))
    db.flush()

    all_perms = {p.code: p for p in db.scalars(select(Permission)).all()}

    for code, definition in rbac.ROLE_DEFINITIONS.items():
        role = db.scalar(select(Role).where(Role.code == code))
        if not role:
            role = Role(
                code=code, name=definition["name"], description=definition["description"],
                is_system=True,
            )
            db.add(role)
            db.flush()

        # SUPER_ADMIN dùng ký hiệu "*" — quyền được xử lý ở rbac.has_permission(), không gán bảng.
        if definition["permissions"] == ["*"]:
            continue
        role.permissions = [all_perms[c] for c in definition["permissions"] if c in all_perms]
    db.flush()
    print(f"  ✓ {len(rbac.PERMISSIONS)} quyền, {len(rbac.ROLE_DEFINITIONS)} vai trò")


def seed_super_admin(db) -> None:
    username = settings.seed_super_admin_username.lower()
    if db.scalar(select(Staff).where(Staff.username == username)):
        print("  · Tài khoản Super Admin đã tồn tại, bỏ qua")
        return

    role = db.scalar(select(Role).where(Role.code == rbac.SUPER_ADMIN))
    staff = Staff(
        username=username,
        email=settings.seed_super_admin_email.lower(),
        full_name="Quản trị hệ thống",
        password_hash=hash_password(settings.seed_super_admin_password),
        status=StaffStatus.ACTIVE,
        # BR-532 — phải thiết lập 2FA ở lần đăng nhập đầu tiên.
        totp_enabled=False,
        must_change_password=True,
    )
    staff.roles = [role] if role else []
    db.add(staff)
    db.flush()
    print(f"  ✓ Super Admin: {username} (BẮT BUỘC đổi mật khẩu + thiết lập 2FA lần đầu)")


def seed_packages(db) -> None:
    """Mục 2.4 — 4 gói. Hạn mức Telegram theo BR-860, hạn mức hỏi đáp AI theo BR-856."""
    packages = [
        {
            "code": "TRIAL", "name": "Gói 0 — Dùng thử", "duration_months": 0, "duration_days": 7,
            "price": 0, "is_trial": True, "tier": 1, "sort_order": 0,
            "max_telegram_alerts": 5, "max_ai_questions_per_day": 5,
            "description": "7 ngày trải nghiệm đầy đủ chức năng. Mỗi tài khoản một lần duy nhất.",
        },
        {
            "code": "PKG3M", "name": "Gói 1 — 3 tháng", "duration_months": 3, "duration_days": 0,
            "price": 2_400_000, "is_trial": False, "tier": 2, "sort_order": 1,
            "max_telegram_alerts": 20, "max_ai_questions_per_day": 20,
            "description": "Toàn bộ chức năng, 20 lượt đăng ký nhận tín hiệu Telegram.",
        },
        {
            "code": "PKG6M", "name": "Gói 2 — 6 tháng", "duration_months": 6, "duration_days": 0,
            "price": 4_200_000, "is_trial": False, "tier": 3, "sort_order": 2,
            "max_telegram_alerts": 50, "max_ai_questions_per_day": 35,
            "description": "Tiết kiệm hơn gói 3 tháng, 50 lượt đăng ký nhận tín hiệu.",
        },
        {
            "code": "PKG12M", "name": "Gói 3 — 12 tháng", "duration_months": 12, "duration_days": 0,
            "price": 7_200_000, "is_trial": False, "tier": 4, "sort_order": 3,
            "max_telegram_alerts": -1, "max_ai_questions_per_day": 50,
            "description": "Không giới hạn lượt đăng ký tín hiệu và toàn bộ chiến lược cao cấp.",
        },
    ]
    created = 0
    for data in packages:
        if not db.scalar(select(Package).where(Package.code == data["code"])):
            db.add(Package(**data, is_active=True))
            created += 1
    db.flush()
    print(f"  ✓ Gói dịch vụ: {created} mới / {len(packages)} tổng")


def seed_categories(db) -> None:
    """Danh mục ánh xạ đúng các mục trong phác thảo (mục 3.2, 3.3)."""
    article_categories = [
        ("MARKET_COMMENT", "Bình luận thị trường"),
        ("MACRO", "Vĩ mô"),
        ("COMPANY_ANALYSIS", "Phân tích doanh nghiệp"),
        ("PORTFOLIO_REPORT", "Báo cáo danh mục"),
        ("STRATEGIC_STOCK", "Cổ phiếu chiến lược"),
        ("NEWS", "Tin tức"),
        ("BASIC_KNOWLEDGE", "Kiến thức cơ bản"),
    ]
    document_categories = [
        ("SMC", "SMC"),
        ("ICT", "ICT"),
        ("PRICE_ACTION", "Price Action"),
        ("QUANT", "Quant"),
        ("INDICATOR", "Chỉ báo"),
        ("FUNDAMENTAL", "Phân tích cơ bản"),
    ]

    created = 0
    for order, (code, name) in enumerate(article_categories):
        exists = db.scalar(
            select(Category).where(Category.code == code, Category.type == CategoryType.ARTICLE)
        )
        if not exists:
            db.add(Category(code=code, name=name, type=CategoryType.ARTICLE, sort_order=order))
            created += 1
    for order, (code, name) in enumerate(document_categories):
        exists = db.scalar(
            select(Category).where(Category.code == code, Category.type == CategoryType.DOCUMENT)
        )
        if not exists:
            db.add(Category(code=code, name=name, type=CategoryType.DOCUMENT, sort_order=order))
            created += 1
    db.flush()
    print(f"  ✓ Danh mục: {created} mới")


def seed_notification_templates(db) -> None:
    """BR-811 — admin sửa nội dung email không cần lập trình viên deploy lại."""
    templates: list[tuple[str, str, str | None, str]] = [
        (
            NotificationCode.VERIFY_EMAIL, NotificationChannel.EMAIL,
            "Xác thực email đăng ký {{ app_name }}",
            "Chào {{ full_name }},\n\n"
            "Cảm ơn bạn đã đăng ký. Vui lòng bấm vào link dưới đây để xác thực email và "
            "bắt đầu {{ ttl_hours }} giờ.\n\n{{ verify_url }}\n\n"
            "Lưu ý: thời gian dùng thử chỉ bắt đầu tính sau khi bạn xác thực email thành công.\n\n"
            "Nếu bạn không thực hiện đăng ký này, vui lòng bỏ qua email.",
        ),
        (
            NotificationCode.WELCOME, NotificationChannel.EMAIL,
            "Chào mừng bạn tới {{ app_name }}",
            "Chào {{ full_name }},\n\n"
            "Tài khoản của bạn đã kích hoạt. Bạn có {{ trial_days }} ngày trải nghiệm đầy đủ.\n\n"
            "Ba việc nên làm đầu tiên:\n"
            "1. Xem bình luận thị trường hôm nay\n"
            "2. Mở một chiến lược và xem điểm mua/bán trên biểu đồ\n"
            "3. Kết nối Telegram để nhận tín hiệu ngay khi phát sinh\n\n"
            "{{ site_url }}",
        ),
        (
            NotificationCode.WELCOME, NotificationChannel.IN_APP,
            "Chào mừng bạn!",
            "Bạn có {{ trial_days }} ngày dùng thử đầy đủ chức năng. Bắt đầu từ mục Chiến lược.",
        ),
        (
            NotificationCode.PASSWORD_RESET_OTP, NotificationChannel.EMAIL,
            "Mã đặt lại mật khẩu {{ app_name }}",
            "Chào {{ full_name }},\n\n"
            "Mã xác thực đặt lại mật khẩu của bạn là: {{ otp }}\n"
            "Mã có hiệu lực trong {{ ttl_minutes }} phút và chỉ dùng được một lần.\n\n"
            "Nếu bạn không yêu cầu, vui lòng bỏ qua email này và đổi mật khẩu để đảm bảo an toàn.",
        ),
        (
            NotificationCode.PASSWORD_CHANGED, NotificationChannel.EMAIL,
            "Mật khẩu của bạn vừa được thay đổi",
            "Chào {{ full_name }},\n\n"
            "Mật khẩu tài khoản của bạn vừa được thay đổi lúc {{ time }}. "
            "Toàn bộ phiên đăng nhập đã được đăng xuất.\n\n"
            "Nếu không phải bạn thực hiện, hãy liên hệ ngay bộ phận hỗ trợ.",
        ),
        (
            NotificationCode.NEW_DEVICE_LOGIN, NotificationChannel.EMAIL,
            "Cảnh báo bảo mật tài khoản",
            "Chào {{ full_name }},\n\n{{ event }}.\n"
            "Địa chỉ IP: {{ ip }}\nThời điểm: {{ time }}\n\n"
            "Nếu không phải bạn, hãy đổi mật khẩu ngay.",
        ),
        (
            NotificationCode.EXPIRY_T7, NotificationChannel.EMAIL,
            "Gói {{ package_name }} còn {{ days_left }} ngày",
            "Chào {{ full_name }},\n\n"
            "Gói {{ package_name }} của bạn sẽ hết hạn ngày {{ expires_at }} "
            "(còn {{ days_left }} ngày).\n\nGia hạn tại: {{ renew_url }}",
        ),
        (
            NotificationCode.EXPIRY_T3, NotificationChannel.SMS, None,
            "{{ app_name }}: goi dich vu con {{ days_left }} ngay (het han {{ expires_at }}). "
            "Gia han: {{ renew_url }}",
        ),
        (
            NotificationCode.COMPLIANCE_WARNING, NotificationChannel.EMAIL,
            "Cảnh báo điều kiện duy trì tài khoản",
            "Chào {{ full_name }},\n\n"
            "Tài khoản của bạn hiện chưa thoả mãn điều kiện duy trì dịch vụ:\n{{ reason }}\n\n"
            "NAV trung bình hiện tại: {{ nav_avg }}đ (mức tối thiểu: {{ nav_min }}đ)\n\n"
            "Bạn còn {{ days_left }} ngày để khôi phục trước khi tài khoản tạm dừng. "
            "Trong thời gian tạm dừng, thời hạn gói được đóng băng và không bị mất ngày sử dụng.\n\n"
            "Liên hệ môi giới phụ trách: {{ broker_name }} — {{ broker_phone }}",
        ),
        (
            NotificationCode.COMPLIANCE_WARNING, NotificationChannel.SMS, None,
            "{{ app_name }}: tai khoan chua dat dieu kien duy tri, con {{ days_left }} ngay "
            "truoc khi tam dung. LH: {{ broker_phone }}",
        ),
        (
            NotificationCode.COMPLIANCE_SUSPENDED, NotificationChannel.EMAIL,
            "Tài khoản của bạn đã tạm dừng",
            "Chào {{ full_name }},\n\n"
            "Tài khoản của bạn đã tạm dừng do: {{ reason }}\n\n"
            "Thời hạn gói dịch vụ đã được **đóng băng** — bạn không mất ngày sử dụng nào "
            "trong thời gian này. Tài khoản sẽ tự động mở lại ngay khi điều kiện được khôi phục.\n\n"
            "Liên hệ: {{ broker_name }} — {{ broker_phone }}",
        ),
        (
            NotificationCode.COMPLIANCE_RESTORED, NotificationChannel.EMAIL,
            "Tài khoản đã được khôi phục",
            "Chào {{ full_name }},\n\n"
            "Tài khoản của bạn đã thoả mãn điều kiện duy trì và được mở lại. "
            "Thời hạn gói được bù thêm {{ frozen_days }} ngày bị đóng băng.\n\n"
            "Chúc bạn giao dịch thuận lợi.",
        ),
        (
            NotificationCode.PAYMENT_SUCCESS, NotificationChannel.EMAIL,
            "Kích hoạt gói {{ package_name }} thành công",
            "Chào {{ full_name }},\n\n"
            "Gói {{ package_name }} đã được kích hoạt, hiệu lực tới {{ expires_at }}.\n\n"
            "Cảm ơn bạn đã tin tưởng sử dụng dịch vụ.",
        ),
        (
            NotificationCode.QA_ANSWERED, NotificationChannel.EMAIL,
            "Câu hỏi của bạn đã được trả lời",
            "Chào {{ full_name }},\n\n"
            'Câu hỏi "{{ question }}" đã được chuyên viên phân tích trả lời.\n\n'
            "Xem tại: {{ site_url }}/strategies",
        ),
        (
            NotificationCode.ADMIN_BROADCAST, NotificationChannel.EMAIL,
            "{{ subject }}",
            "Chào {{ full_name }},\n\n{{ message }}",
        ),
        (
            NotificationCode.ADMIN_BROADCAST, NotificationChannel.IN_APP,
            "{{ subject }}",
            "{{ message }}",
        ),
        (
            NotificationCode.ACCOUNT_CREATED, NotificationChannel.EMAIL,
            "Tài khoản {{ app_name }} của bạn đã được tạo",
            "Chào {{ full_name }},\n\n"
            "{{ staff_name }} đã tạo tài khoản cho bạn trên hệ thống {{ app_name }}.\n\n"
            "Thông tin đăng nhập:\n"
            "  Địa chỉ  : {{ login_url }}\n"
            "  Email    : {{ email }}\n"
            "  Mật khẩu : {{ password }}\n\n"
            "Gói dịch vụ: {{ package_name }}\n\n"
            "VÌ LÝ DO BẢO MẬT: hãy đăng nhập và đổi mật khẩu ngay. Không chia sẻ mật khẩu "
            "này cho bất kỳ ai, kể cả nhân viên của chúng tôi.\n\n"
            "Lưu ý: mỗi tài khoản chỉ dùng cho một người và chỉ duy trì một phiên đăng "
            "nhập tại một thời điểm.",
        ),
        (
            NotificationCode.IB_LINK_REMINDER, NotificationChannel.EMAIL,
            "Nhắc hoàn tất liên kết tài khoản chứng khoán",
            "Chào {{ full_name }},\n\n"
            "Bạn chưa hoàn tất liên kết tài khoản chứng khoán mở dưới IB. "
            "Hạn chót: {{ deadline }}.\n\n"
            "Sau thời hạn này, tài khoản sẽ tạm dừng cho tới khi hoàn tất liên kết "
            "(thời hạn gói được đóng băng, không mất ngày sử dụng).\n\n"
            "Liên kết tại: {{ site_url }}/account/ib-link",
        ),
        (
            NotificationCode.TRIAL_EXPIRED, NotificationChannel.EMAIL,
            "Thời gian dùng thử đã kết thúc",
            "Chào {{ full_name }},\n\n"
            "Thời gian dùng thử của bạn đã kết thúc. Chọn gói phù hợp để tiếp tục sử dụng:\n"
            "{{ site_url }}/pricing",
        ),
        (
            NotificationCode.GRACE_END, NotificationChannel.EMAIL,
            "Gói dịch vụ đã hết thời gian ân hạn",
            "Chào {{ full_name }},\n\n"
            "Gói dịch vụ của bạn đã hết hạn và hết cả thời gian ân hạn. "
            "Gia hạn để khôi phục quyền truy cập: {{ site_url }}/pricing",
        ),
    ]

    created = 0
    for code, channel, subject, body in templates:
        exists = db.scalar(
            select(NotificationTemplate).where(
                NotificationTemplate.code == code, NotificationTemplate.channel == channel
            )
        )
        if not exists:
            db.add(
                NotificationTemplate(
                    code=str(code), channel=str(channel), subject=subject, body=body,
                    is_active=True,
                )
            )
            created += 1
    db.flush()
    print(f"  ✓ Template thông báo: {created} mới / {len(templates)} tổng")


def seed_legal_documents(db) -> None:
    """Phần 9 — tạo bản nháp v1.0 để hệ thống chạy được.

    NỘI DUNG PHẢI ĐƯỢC LUẬT SƯ RÀ SOÁT trước khi vận hành thật (Phần 16).
    """
    now = datetime.now(timezone.utc)
    documents = [
        (
            LegalDocType.TOS, "Điều khoản sử dụng",
            "## 1. Định nghĩa dịch vụ\n"
            "Đây là dịch vụ cung cấp thông tin, công cụ và tài liệu tham khảo phục vụ nghiên cứu "
            "thị trường chứng khoán. Dịch vụ **không phải** khuyến nghị mua bán chứng khoán. "
            "Khách hàng tự chịu trách nhiệm với mọi quyết định đầu tư của mình.\n\n"
            "## 2. Điều kiện duy trì tài khoản\n"
            f"Với khách hàng thuộc tuyến mở tài khoản chứng khoán dưới IB:\n"
            f"- NAV trung bình {settings.compliance_nav_window} phiên gần nhất phải đạt từ "
            f"{settings.compliance_nav_min:,.0f}đ trở lên.\n"
            f"- Phải có phát sinh giao dịch trong vòng {settings.compliance_no_trade_days} ngày.\n"
            f"- Khi chưa đạt, hệ thống cảnh báo trước {settings.compliance_warning_days} ngày "
            "trước khi tạm dừng tài khoản.\n"
            "- Trong thời gian tạm dừng, **thời hạn gói được đóng băng** và được bù đủ số ngày "
            "khi tài khoản khôi phục.\n"
            "- Tài khoản tự động mở lại khi điều kiện được đáp ứng trở lại.\n\n"
            "## 3. Chính sách hoàn tiền\n"
            "Dịch vụ không hoàn tiền khi tài khoản bị tạm dừng do không đạt điều kiện duy trì. "
            "Thay vào đó, thời hạn gói được đóng băng vô thời hạn: khách hàng khôi phục điều kiện "
            "lúc nào thì tiếp tục sử dụng lúc đó.\n\n"
            "## 4. Cấm chia sẻ tài khoản\n"
            "Mỗi tài khoản chỉ được sử dụng bởi một cá nhân, giới hạn một phiên đăng nhập tại "
            "một thời điểm. Vi phạm sẽ bị khoá vĩnh viễn và **không hoàn tiền**.\n\n"
            "## 5. Cấm sao chép và phát tán\n"
            "Nghiêm cấm sao chép, phát tán tài liệu, tín hiệu và báo cáo ra ngoài. Tài liệu tải "
            "xuống được đóng dấu định danh phục vụ truy vết nguồn phát tán.\n\n"
            "## 6. Giới hạn trách nhiệm\n"
            "Mức bồi thường tối đa trong mọi trường hợp không vượt quá phí dịch vụ khách hàng "
            "đã thanh toán trong 12 tháng gần nhất.\n\n"
            "## 7. Quyền sửa đổi điều khoản\n"
            "Thay đổi trọng yếu được thông báo trước tối thiểu 15 ngày và yêu cầu khách hàng "
            "đồng ý lại trước khi tiếp tục sử dụng.\n\n"
            "## 8. Luật áp dụng\n"
            "Điều khoản này được điều chỉnh bởi pháp luật Việt Nam.\n\n"
            "> ⚠️ BẢN NHÁP — cần luật sư chuyên ngành chứng khoán rà soát trước khi vận hành.",
        ),
        (
            LegalDocType.PRIVACY, "Chính sách bảo mật",
            "## Dữ liệu thu thập\n"
            "Email, số điện thoại, họ tên, số tài khoản chứng khoán, **NAV**, "
            "**lịch sử giao dịch**, nhật ký truy cập, địa chỉ IP, thông tin thiết bị, "
            "và Chat ID Telegram (nếu bạn kết nối).\n\n"
            "## Nguồn dữ liệu\n"
            "NAV và lịch sử giao dịch được lấy từ hệ thống của công ty chứng khoán thông qua "
            "cơ chế IB, với sự đồng ý riêng của bạn.\n\n"
            "## Mục đích sử dụng\n"
            "Xác thực tài khoản, xét điều kiện duy trì dịch vụ, chăm sóc khách hàng, "
            "cải thiện chất lượng dịch vụ.\n\n"
            "## Chia sẻ với bên thứ ba\n"
            "Cổng thanh toán · dịch vụ gửi email/SMS · nhà cung cấp dữ liệu giá · "
            "nền tảng Telegram (nếu bạn bật nhận tín hiệu qua Telegram).\n\n"
            "## Quyền của khách hàng\n"
            "Truy cập, chỉnh sửa, rút lại đồng ý, yêu cầu xoá tài khoản. Khi xoá, dữ liệu định "
            "danh được ẩn danh hoá; bản ghi thanh toán và nhật ký hệ thống được giữ lại theo "
            "nghĩa vụ lưu trữ chứng từ kế toán.\n\n"
            "> ⚠️ BẢN NHÁP — cần rà soát theo quy định bảo vệ dữ liệu cá nhân đang có hiệu lực.",
        ),
        (
            LegalDocType.REFUND, "Chính sách thanh toán & hoàn tiền",
            "## Thanh toán\n"
            "Gói dịch vụ được kích hoạt sau khi thanh toán được xác nhận.\n\n"
            "## Gia hạn\n"
            "Gia hạn khi gói chưa hết hạn: thời gian mới được **cộng dồn** vào ngày hết hạn "
            "hiện tại. Gia hạn sau khi đã hết hạn: tính từ ngày thanh toán.\n\n"
            "## Hoàn tiền\n"
            "Dịch vụ không hoàn tiền sau khi gói đã kích hoạt. Trường hợp tài khoản bị tạm dừng "
            "do không đạt điều kiện duy trì, thời hạn gói được đóng băng và bù đủ khi khôi phục.\n\n"
            "> ⚠️ BẢN NHÁP — cần luật sư rà soát.",
        ),
        (
            LegalDocType.DISCLAIMER, "Tuyên bố miễn trừ trách nhiệm đầu tư",
            "Toàn bộ nội dung, tín hiệu, báo cáo và công cụ trên hệ thống mang tính **tham khảo**, "
            "không phải khuyến nghị mua bán chứng khoán.\n\n"
            "Hiệu suất trong quá khứ không đảm bảo kết quả trong tương lai. Thống kê tín hiệu "
            "thực (LIVE) và tín hiệu mô phỏng (BACKTEST) được trình bày tách biệt.\n\n"
            "Khách hàng tự chịu trách nhiệm hoàn toàn với mọi quyết định đầu tư của mình.",
        ),
        (
            LegalDocType.COOKIE, "Chính sách cookie",
            "Hệ thống sử dụng cookie kỹ thuật để duy trì phiên đăng nhập và bảo vệ tài khoản. "
            "Cookie phiên là bắt buộc để dịch vụ hoạt động và không thể tắt.",
        ),
        (
            LegalDocType.TELEGRAM_CONSENT, "Đồng ý nhận tín hiệu qua Telegram",
            "Bạn cho phép hệ thống gửi thông tin tín hiệu giao dịch tới tài khoản Telegram của "
            "bạn. Telegram là dịch vụ của bên thứ ba nằm ngoài kiểm soát của chúng tôi; "
            "Chat ID Telegram của bạn sẽ được lưu để phục vụ việc gửi tin.\n\n"
            "Bạn có thể ngắt kết nối bất cứ lúc nào trên website hoặc bằng lệnh /stop trong "
            "Telegram.",
        ),
    ]

    created = 0
    for doc_type, title, content in documents:
        exists = db.scalar(
            select(LegalDocument).where(
                LegalDocument.type == doc_type, LegalDocument.version == "1.0"
            )
        )
        if not exists:
            db.add(
                LegalDocument(
                    type=str(doc_type), version="1.0", title=title, content=content,
                    effective_from=now, is_current=True, requires_reconsent=False,
                )
            )
            created += 1
    db.flush()
    print(f"  ✓ Văn bản pháp lý: {created} bản nháp v1.0 (CẦN LUẬT SƯ RÀ SOÁT)")


def seed_trading_calendar(db) -> None:
    """BR-402 — thứ 7, chủ nhật là ngày nghỉ. Ngày lễ cần admin bổ sung thủ công hằng năm."""
    year = date.today().year
    start, end = date(year, 1, 1), date(year, 12, 31)
    existing = {
        row[0] for row in db.execute(
            select(TradingCalendar.trade_date).where(
                TradingCalendar.trade_date.between(start, end)
            )
        ).all()
    }

    created = 0
    current = start
    while current <= end:
        if current not in existing:
            is_weekend = current.weekday() >= 5
            db.add(
                TradingCalendar(
                    trade_date=current,
                    is_trading_day=not is_weekend,
                    note="Cuối tuần" if is_weekend else None,
                )
            )
            created += 1
        current += timedelta(days=1)
    db.flush()
    print(f"  ✓ Lịch giao dịch {year}: {created} ngày (⚠️ cần bổ sung ngày lễ thủ công)")


def main() -> int:
    # Console Windows mặc định dùng codepage cp1258 — ép UTF-8 để in được tiếng Việt.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    print(f"\nSeed dữ liệu — {settings.app_name} [{settings.app_env}]\n" + "=" * 60)
    with session_scope() as db:
        seed_permissions_and_roles(db)
        seed_super_admin(db)
        seed_packages(db)
        seed_categories(db)
        seed_notification_templates(db)
        seed_legal_documents(db)
        seed_trading_calendar(db)

    print("=" * 60)
    print("Hoàn tất.\n")
    print("Việc cần làm ngay sau khi seed:")
    print("  1. Đăng nhập Admin Site và ĐỔI MẬT KHẨU Super Admin")
    print("  2. Thiết lập 2FA (bắt buộc — BR-532)")
    print("  3. Rà soát nội dung văn bản pháp lý với luật sư (Phần 16)")
    print("  4. Bổ sung ngày nghỉ lễ vào lịch giao dịch (BR-402)")
    print("  5. Cấu hình GOOGLE_SHEET_ID và service account để job đồng bộ NAV chạy được\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
