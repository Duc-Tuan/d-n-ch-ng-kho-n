"""Điểm khởi động ứng dụng FastAPI."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.router import api_router
from app.core.config import settings
from app.core.exceptions import AppError

logging.basicConfig(
    level=logging.DEBUG if settings.debug else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s | %(message)s",
)
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    from app.core.http import close_client
    from app.jobs.scheduler import shutdown_scheduler, start_scheduler
    from app.services.analysis import worker as analysis_worker
    from app.services.storage_service import storage_root

    storage_root()  # đảm bảo thư mục lưu trữ tồn tại và nằm ngoài vùng public
    start_scheduler()

    # Bể phân tích khởi động **không phụ thuộc** `ENABLE_SCHEDULER`: nút Phân tích là chức năng
    # khách hàng trả tiền để dùng, không phải một job vận hành có thể tắt.
    analysis_worker.start()
    try:
        # Việc còn kẹt từ lần chạy trước (backend tắt giữa chừng) phải được xếp lại, nếu không
        # người đã bấm sẽ chờ một tiến trình đã chết từ lâu.
        analysis_worker.requeue_stale()
    except Exception:  # noqa: BLE001 — CSDL chưa sẵn sàng không được chặn tiến trình khởi động
        log.warning("Không xếp lại được lượt phân tích còn dở", exc_info=True)

    log.info("%s khởi động ở môi trường %s", settings.app_name, settings.app_env)
    yield
    shutdown_scheduler()
    analysis_worker.shutdown()
    close_client()  # trả lại pool kết nối HTTP ra ngoài


app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    description=(
        "API hệ thống tư vấn chứng khoán.\n\n"
        "**BR-000** — Customer Site (`/customer/*`) và Admin Site (`/admin/*`) dùng hai bảng "
        "tài khoản, hai cookie và hai secret ký JWT khác nhau. Token của bên này không bao giờ "
        "dùng được ở bên kia."
    ),
    docs_url="/docs" if not settings.is_production else None,
    redoc_url=None,
    openapi_url="/openapi.json" if not settings.is_production else None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,  # cần cho cookie HttpOnly
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if settings.is_production:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response


# ----------------------------------------------------------------------
# Chuẩn hoá thân lỗi: FE luôn đọc được {code, message, details}
# ----------------------------------------------------------------------
@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content=exc.detail)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": "HTTP_ERROR", "message": str(exc.detail), "details": {}},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    field = ".".join(str(p) for p in first.get("loc", []) if p not in ("body", "query"))
    return JSONResponse(
        status_code=422,
        content={
            "code": "VALIDATION_ERROR",
            "message": first.get("msg", "Dữ liệu không hợp lệ"),
            "details": {"field": field, "errors": exc.errors()[:10]},
        },
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    log.exception("Lỗi không xử lý được tại %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={
            "code": "INTERNAL_ERROR",
            # Không lộ chi tiết lỗi ra ngoài ở production.
            "message": (
                f"{type(exc).__name__}: {exc}" if settings.debug
                else "Đã có lỗi xảy ra. Vui lòng thử lại hoặc liên hệ hỗ trợ."
            ),
            "details": {},
        },
    )


app.include_router(api_router, prefix=settings.api_prefix)


@app.get("/", tags=["meta"])
def root() -> dict:
    return {
        "app": settings.app_name,
        "env": settings.app_env,
        "api": settings.api_prefix,
        "docs": "/docs" if not settings.is_production else None,
    }
