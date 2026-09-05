# syntax=docker/dockerfile:1
#
# Ảnh Docker gộp cả hai phần của hệ thống vào một container:
#   - FastAPI  (uvicorn)  cổng 8000  — API, scheduler, bể phân tích
#   - Next.js  (next start) cổng 3000 — giao diện, proxy /api/v1/* sang FastAPI
#
# Next.js gọi ngược lại FastAPI qua `API_ORIGIN` (xem `frontend/next.config.mjs`).
# Vì hai tiến trình nằm chung một network namespace nên mặc định
# http://127.0.0.1:8000 là đúng — không cần cấu hình gì thêm.
#
# Build:  docker build -t my-stock-system .
# Chạy:   docker run -d --name stock --env-file backend/.env \
#             -p 3000:3000 -p 8000:8000 \
#             -v stock_storage:/app/backend/storage my-stock-system
#
# LƯU Ý về `--env-file`: Docker KHÔNG cắt chú thích cuối dòng. `backend/.env`
# hiện có 26 dòng kiểu `KEY=value   # giải thích`, dùng thẳng sẽ nạp cả phần
# `# giải thích` vào giá trị. Hãy lọc trước khi deploy:
#   grep -vE "^[[:space:]]*#" backend/.env | sed -E "s/[[:space:]]+#.*$//" > .env.docker


# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — build giao diện Next.js
# ─────────────────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS frontend-build

WORKDIR /build

# Chép manifest trước, cài trước: lớp này chỉ vỡ cache khi package-lock đổi,
# nên sửa mã nguồn giao diện không phải cài lại toàn bộ node_modules.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./

# Build ở chế độ production. `next build` đọc next.config.mjs nhưng phần rewrites
# chỉ được đánh giá lúc chạy, nên không cần API_ORIGIN ở bước này.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Bỏ devDependencies (typescript, tailwind, @types…) — `next start` không cần.
RUN npm prune --omit=dev

# Claude Code CLI cài riêng vào /opt/claude-cli (không phải global mặc định của
# ảnh node) để copy gọn sang stage runtime — image đó không có `npm` đầy đủ.
RUN npm install -g --prefix /opt/claude-cli @anthropic-ai/claude-code


# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — ảnh chạy: Python 3.11 (khớp .venv của môi trường dev) + Node runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.11-slim-bookworm AS runtime

# Chỉ lấy đúng binary `node` từ ảnh Node chính thức thay vì cài cả bộ apt của
# NodeSource: cùng nền bookworm nên tương thích, mà ảnh cuối nhẹ hơn nhiều.
# Không cần `npm` lúc chạy vì ta gọi thẳng `node_modules/.bin/next`.
COPY --from=node:20-bookworm-slim /usr/local/bin/node /usr/local/bin/node

# `libstdc++6` là thư viện mà binary node liên kết động — ảnh python-slim không
# đảm bảo có sẵn. `curl` phục vụ HEALTHCHECK bên dưới.
# Toàn bộ thư viện trong requirements.txt đều có wheel manylinux cho cp311,
# nên không cần cài trình biên dịch.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && node --version

# Claude Code CLI — nhánh phân tích AI (app/services/analysis/runner.py) spawn
# `claude -p` bằng subprocess. Không cài thì `shutil.which("claude")` trả None
# và tiến trình chết ngay với FileNotFoundError trước khi kịp gọi model.
# Copy nguyên cây cài global từ stage frontend-build (đã cài ở /opt/claude-cli):
# giữ cấu trúc bin/ + lib/node_modules/ tương đối như lúc `npm install -g` sinh
# ra, vì shim trong bin/ require tương đối tới lib/node_modules/.
COPY --from=frontend-build /opt/claude-cli/bin/claude /usr/local/bin/claude
COPY --from=frontend-build /opt/claude-cli/lib/node_modules /usr/local/lib/node_modules
RUN claude --version

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

# Cổng nội bộ Next.js dùng để proxy /api/v1/* sang FastAPI (next.config.mjs).
ENV API_ORIGIN=http://127.0.0.1:8000

# Số worker uvicorn. GIỮ NGUYÊN = 1 trừ khi bạn đã tách scheduler ra tiến trình
# riêng: APScheduler và bể phân tích chạy in-process (app/main.py), nhân worker
# lên đồng nghĩa với mỗi job nghiệp vụ chạy lặp lại đúng bấy nhiêu lần.
ENV UVICORN_WORKERS=1

WORKDIR /app

# ── Backend ──────────────────────────────────────────────────────────────────
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

COPY backend/app        /app/backend/app
COPY backend/alembic    /app/backend/alembic
COPY backend/alembic.ini /app/backend/alembic.ini

# Cấu hình MCP cho `claude -p` (app/services/analysis/runner.py đọc ở
# /app/.claude/mcp-analysis.json). Sinh ngay lúc build vì cả hai đường dẫn tuyệt
# đối bên trong (python + server.py) đều cố định theo cấu trúc ảnh này — không
# phụ thuộc máy host, nên không cần chạy tay sau khi container đã lên như ở
# README (phần đó viết cho máy cài trực tiếp, không phải Docker).
RUN cd backend && python -m app.scripts.write_mcp_config

# ── Frontend (đã build) ──────────────────────────────────────────────────────
COPY --from=frontend-build /build/.next          /app/frontend/.next
COPY --from=frontend-build /build/public         /app/frontend/public
COPY --from=frontend-build /build/node_modules   /app/frontend/node_modules
COPY --from=frontend-build /build/package.json   /app/frontend/package.json
COPY --from=frontend-build /build/next.config.mjs /app/frontend/next.config.mjs

# ── Điểm khởi động: chạy song song hai tiến trình ────────────────────────────
# Container tự dừng nếu MỘT trong hai tiến trình chết, thay vì sống dở với API
# đã tắt còn giao diện vẫn trả trang trắng.
COPY <<'EOF' /usr/local/bin/entrypoint.sh
#!/usr/bin/env bash
set -uo pipefail

api_pid=""
web_pid=""

# Docker gửi SIGTERM khi dừng container. Chuyển tiếp xuống hai tiến trình con để
# lifespan của FastAPI kịp chạy phần dọn dẹp (tắt scheduler, đóng pool HTTP,
# dừng bể phân tích — xem app/main.py).
shutdown() {
  kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
  wait "$api_pid" "$web_pid" 2>/dev/null || true
  exit 0
}
trap shutdown TERM INT

cd /app/backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "${UVICORN_WORKERS:-1}" &
api_pid=$!

cd /app/frontend
node_modules/.bin/next start --hostname 0.0.0.0 --port 3000 &
web_pid=$!

# `wait -n` trả về ngay khi tiến trình ĐẦU TIÊN kết thúc. Container dừng hẳn thay
# vì sống dở với API đã chết còn giao diện vẫn trả trang trắng — để orchestrator
# (docker restart policy / Kubernetes) khởi động lại sạch sẽ.
code=0
wait -n "$api_pid" "$web_pid" || code=$?
echo "entrypoint: một tiến trình đã kết thúc (mã $code) — dừng container." >&2
kill -TERM "$api_pid" "$web_pid" 2>/dev/null || true
exit "$code"
EOF

RUN chmod +x /usr/local/bin/entrypoint.sh

# ── Người dùng không phải root ───────────────────────────────────────────────
# `storage` và `.next/cache` cần quyền ghi lúc chạy.
RUN useradd --create-home --shell /usr/sbin/nologin appuser \
 && mkdir -p /app/backend/storage \
 && chown -R appuser:appuser /app
USER appuser

# Thư mục file khách hàng tải lên, và home của appuser — gắn volume để không mất
# khi dựng lại container. Home phải có volume riêng vì `claude login` ghi hồ sơ
# OAuth vào ~/.claude*: không mount thì container mất đăng nhập ở lần build kế
# tiếp, và job phân tích AI lại chết với đúng lỗi "Không chạy được Claude Code CLI".
VOLUME ["/app/backend/storage", "/home/appuser"]

EXPOSE 3000 8000

# Đo sức khoẻ ở phía API: giao diện vẫn trả trang khi backend chết, còn API thì không.
# `GET /` là route meta của FastAPI (app/main.py) — không cần xác thực.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8000/ || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
