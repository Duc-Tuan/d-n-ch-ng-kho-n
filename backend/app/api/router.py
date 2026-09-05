"""Gom router. Hai vùng `/customer/*` và `/admin/*` tách biệt hoàn toàn (BR-000)."""

from fastapi import APIRouter

from app.api import media, public, webhooks, websockets
from app.api.admin import auth as admin_auth
from app.api.admin import content as admin_content
from app.api.admin import customers as admin_customers
from app.api.admin import dashboard as admin_dashboard
from app.api.admin import inbox as admin_inbox
from app.api.admin import market as admin_market
from app.api.admin import news as admin_news
from app.api.admin import operations as admin_operations
from app.api.admin import settings as admin_settings
from app.api.admin import staff as admin_staff
from app.api.customer import account as customer_account
from app.api.customer import analysis as customer_analysis
from app.api.customer import auth as customer_auth
from app.api.customer import content as customer_content
from app.api.customer import market as customer_market
from app.api.customer import news as customer_news
from app.api.customer import my_strategies as customer_my_strategies
from app.api.customer import notifications as customer_notifications
from app.api.customer import strategies as customer_strategies

api_router = APIRouter()

# ---------- Công khai (không cần đăng nhập) ----------
api_router.include_router(public.router)
api_router.include_router(webhooks.router)
api_router.include_router(websockets.router)
# Ảnh bài viết: cả hai site cùng đọc, nên nằm ngoài hai vùng tách biệt (xem app/api/media.py).
api_router.include_router(media.router)

# ---------- Customer Site ----------
customer = APIRouter(prefix="/customer")
customer.include_router(customer_auth.router)
customer.include_router(customer_account.router)
customer.include_router(customer_content.router)
customer.include_router(customer_analysis.router)
customer.include_router(customer_market.router)
customer.include_router(customer_strategies.router)
customer.include_router(customer_my_strategies.router)
customer.include_router(customer_news.router)
customer.include_router(customer_notifications.router)
api_router.include_router(customer)

# ---------- Admin Site ----------
admin = APIRouter(prefix="/admin")
admin.include_router(admin_auth.router)
admin.include_router(admin_dashboard.router)
admin.include_router(admin_inbox.router)
admin.include_router(admin_customers.router)
admin.include_router(admin_content.router)
admin.include_router(admin_staff.router)
admin.include_router(admin_settings.router)
admin.include_router(admin_operations.router)
admin.include_router(admin_market.router)
admin.include_router(admin_news.router)
api_router.include_router(admin)
