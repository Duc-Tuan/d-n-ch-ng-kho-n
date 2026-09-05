#!/usr/bin/env bash
#
# Dựng toàn bộ hệ thống: MySQL + ứng dụng (FastAPI + Next.js) qua docker compose.
# Lọc .env → build image → dựng/cập nhật container → chờ healthy → chạy migration.
#
# Chạy được cả trên Git Bash (Windows) lẫn trên server Linux.
#
#   ./deploy.sh                  # quy trình đầy đủ (cả MySQL)
#   ./deploy.sh --no-cache       # build lại từ số 0, không dùng layer cache
#   ./deploy.sh --skip-migrate   # bỏ qua `alembic upgrade head`
#   ./deploy.sh --skip-build     # dùng lại image cũ, chỉ dựng lại container
#   ./deploy.sh --db-only        # chỉ dựng MySQL, không đụng tới ứng dụng
#   ./deploy.sh --prune          # xoá luôn image mồ côi (dangling) sau khi build
#   ./deploy.sh --tag 1.2        # gắn thêm tag phiên bản ngoài `latest`
#   ./deploy.sh --logs           # bám log sau khi container đã healthy
#
# MySQL chạy trong container `stock-mysql`, dữ liệu nằm ở volume `stock_mysql_data`
# và KHÔNG BAO GIỜ bị script này xoá. Xem docker-compose.yml.

set -euo pipefail

# Git Bash/MSYS tự đổi `/app/backend/storage` thành đường dẫn Windows khi truyền
# cho docker.exe, làm hỏng tham số `-v` và `-w`. Hai biến này tắt hành vi đó.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

cd "$(dirname "$0")"

# ── Cấu hình ─────────────────────────────────────────────────────────────────
IMAGE="${IMAGE:-my-stock-system}"
CONTAINER="${CONTAINER:-stock}"              # phải khớp container_name của service `app`
DB_CONTAINER="${DB_CONTAINER:-stock-mysql}"  # ... và của service `db`
PORT_WEB="${PORT_WEB:-3000}"
PORT_API="${PORT_API:-8000}"
SRC_ENV="${SRC_ENV:-backend/.env}"
RUN_ENV="${RUN_ENV:-.env.docker}"

# Ghim tên project để tên volume/network không đổi theo tên thư mục chứa mã nguồn.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-stock}"

TAG=""
NO_CACHE=""
SKIP_MIGRATE=0
SKIP_BUILD=0
DB_ONLY=0
PRUNE=0
FOLLOW_LOGS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-cache)     NO_CACHE="--no-cache" ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --db-only)      DB_ONLY=1 ;;
    --prune)        PRUNE=1 ;;
    --logs)         FOLLOW_LOGS=1 ;;
    --tag)          TAG="${2:?--tag cần một giá trị, ví dụ: --tag 1.2}"; shift ;;
    -h|--help)      sed -n '3,18p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *)              echo "Tham số lạ: $1 (dùng --help)" >&2; exit 2 ;;
  esac
  shift
done

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# `docker compose` (v2, plugin) — không phải `docker-compose` (v1, đã ngừng phát triển).
dc() { docker compose --env-file "$RUN_ENV" "$@"; }

# ── 0. Kiểm tra tiền đề ──────────────────────────────────────────────────────
command -v docker >/dev/null || die "Không tìm thấy lệnh docker."
docker info >/dev/null 2>&1 || die "Docker daemon chưa chạy. Mở Docker Desktop rồi thử lại."
docker compose version >/dev/null 2>&1 \
  || die "Thiếu plugin 'docker compose' v2. Bản 'docker-compose' v1 không dùng được ở đây."
[ -f Dockerfile ]         || die "Không thấy Dockerfile ở $(pwd)."
[ -f docker-compose.yml ] || die "Không thấy docker-compose.yml ở $(pwd)."
[ -f "$SRC_ENV" ]         || die "Không thấy $SRC_ENV — cần file cấu hình thật để chạy."

# ── 1. Lọc .env cho docker ───────────────────────────────────────────────────
# `--env-file` KHÔNG cắt chú thích cuối dòng: `KEY=giá_trị  # ghi chú` sẽ nạp cả
# phần ghi chú vào giá trị. Bỏ dòng trống, dòng chú thích, và phần `<khoảng
# trắng>#...` ở cuối. Giá trị dính liền `#` (mật khẩu kiểu `ab#cd`) được giữ
# nguyên vì không có khoảng trắng đứng trước.
step "Lọc $SRC_ENV → $RUN_ENV"
grep -vE '^[[:space:]]*(#|$)' "$SRC_ENV" \
  | sed -E 's/[[:space:]]+#.*$//' \
  | sed -E 's/[[:space:]]+$//' \
  | sed -E "s/^([A-Za-z_][A-Za-z0-9_]*)=\"(.*)\"\$/\1=\2/; s/^([A-Za-z_][A-Za-z0-9_]*)='(.*)'\$/\1=\2/" \
  > "$RUN_ENV"
echo "  $(grep -c . "$RUN_ENV") biến môi trường."

# ── Rà soát nhanh mấy lỗi hay gặp ────────────────────────────────────────────
if grep -qE '^APP_ENV=production' "$RUN_ENV" && ! grep -qE '^DEBUG=false' "$RUN_ENV"; then
  warn "APP_ENV=production nhưng DEBUG chưa đặt false — /docs sẽ vẫn mở."
fi

# MYSQL_ROOT_PASSWORD lấy từ DB_PASSWORD. Ảnh mysql từ chối khởi động với mật khẩu
# root rỗng (trừ khi bật MYSQL_ALLOW_EMPTY_PASSWORD — đừng).
DB_PASSWORD_VALUE="$(sed -nE 's/^DB_PASSWORD=(.*)$/\1/p' "$RUN_ENV" | head -1)"
[ -n "$DB_PASSWORD_VALUE" ] \
  || die "DB_PASSWORD trống trong $SRC_ENV — MySQL trong container bắt buộc phải có mật khẩu root."

# DB_HOST không cần sửa: docker-compose.yml đè thành `db` cho riêng container app,
# nên $SRC_ENV vẫn giữ 127.0.0.1 để chạy backend tay ngoài Docker như trước.
grep -qE '^DB_HOST=' "$RUN_ENV" \
  || warn "Không thấy DB_HOST trong $SRC_ENV — compose vẫn đè thành 'db', nhưng nên khai báo cho rõ."

# ── 2. Dọn container cũ chạy ngoài compose ───────────────────────────────────
# Bản deploy.sh trước dựng `stock` bằng `docker run` trần. Compose không nhận nó
# (thiếu nhãn project) và sẽ báo trùng tên — xoá đi để compose tự dựng lại.
if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
  owner="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null || true)"
  if [ -z "$owner" ]; then
    step "Xoá container '$CONTAINER' còn sót từ lần chạy không dùng compose"
    docker rm -f "$CONTAINER" >/dev/null
    echo "  Đã xoá. Các volume dữ liệu được giữ nguyên."
  fi
fi

# Volume MySQL chưa có nghĩa là đây là lần đầu — nhắc nạp dữ liệu ở cuối script.
FIRST_DB_RUN=0
docker volume inspect stock_mysql_data >/dev/null 2>&1 || FIRST_DB_RUN=1

# ── 3. Build image ứng dụng ──────────────────────────────────────────────────
# MySQL dùng ảnh chính thức `mysql:8.0`, không build gì — `up` tự kéo về.
if [ "$DB_ONLY" -eq 1 ]; then
  step "Chỉ dựng MySQL (--db-only) — bỏ qua build"
elif [ "$SKIP_BUILD" -eq 0 ]; then
  step "Build $IMAGE:latest${TAG:+ (+ $TAG)}"
  dc build $NO_CACHE app
  [ -n "$TAG" ] && docker tag "$IMAGE:latest" "$IMAGE:$TAG"
else
  step "Bỏ qua build, dùng lại $IMAGE:latest"
  docker image inspect "$IMAGE:latest" >/dev/null 2>&1 \
    || die "Chưa có image $IMAGE:latest — bỏ --skip-build đi."
fi

# ── 4. Dựng/cập nhật container ───────────────────────────────────────────────
# `up -d` tự tạo network + volume, và chỉ dựng lại service nào thực sự đổi (image
# mới, biến môi trường mới) — khác hẳn bản cũ xoá trắng container mỗi lần deploy.
# `--no-build` để chắc chắn không có bước build ngầm ngoài bước 3.
# Service `app` khai báo depends_on: db → service_healthy, nên compose tự chờ
# MySQL nhận kết nối thật trước khi khởi động FastAPI (lần đầu mất ~30s khởi tạo
# data directory; không chờ thì scheduler chết ngay trong lifespan).
if [ "$DB_ONLY" -eq 1 ]; then
  step "Khởi động MySQL '$DB_CONTAINER'"
  dc up -d --no-build db
else
  step "Khởi động '$DB_CONTAINER' + '$CONTAINER'"
  dc up -d --no-build --remove-orphans
  echo "  Web http://localhost:$PORT_WEB   API http://localhost:$PORT_API"
fi

# ── 5. Chờ HEALTHCHECK chuyển sang healthy ───────────────────────────────────
wait_healthy() {
  local name="$1" label="$2" state health i
  step "Chờ $label sẵn sàng"
  for i in $(seq 1 60); do
    state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null || echo gone)"
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$name" 2>/dev/null || echo none)"

    if [ "$state" != "running" ]; then
      echo
      docker logs --tail 60 "$name" 2>&1 || true
      die "Container '$name' đã dừng (trạng thái: $state). Log 60 dòng cuối ở trên."
    fi
    if [ "$health" = "healthy" ]; then echo "  healthy sau ${i}0 giây."; return 0; fi

    printf '.'
    sleep 10
    if [ "$i" -eq 60 ]; then echo; docker logs --tail 60 "$name"; die "Quá 10 phút '$name' vẫn chưa healthy."; fi
  done
}

wait_healthy "$DB_CONTAINER" "MySQL"
if [ "$DB_ONLY" -eq 0 ]; then wait_healthy "$CONTAINER" "ứng dụng"; fi

# ── 6. Migration ─────────────────────────────────────────────────────────────
if [ "$DB_ONLY" -eq 1 ]; then
  step "Bỏ qua migration (--db-only)"
elif [ "$SKIP_MIGRATE" -eq 0 ]; then
  step "alembic upgrade head"
  dc exec -T -w /app/backend app alembic upgrade head
else
  step "Bỏ qua migration (--skip-migrate)"
fi

# ── 7. Dọn image mồ côi ──────────────────────────────────────────────────────
# Chỉ động vào image dangling (không tag) — là bản build cũ vừa bị thay thế.
if [ "$PRUNE" -eq 1 ]; then
  step "Dọn image mồ côi"
  docker image prune -f
fi

step "Xong"
dc ps

if [ "$FIRST_DB_RUN" -eq 1 ]; then
  echo
  warn "Lần đầu dựng MySQL — cơ sở dữ liệu mới chỉ có bảng rỗng do alembic tạo."
  warn "Nạp dữ liệu cũ từ MySQL trên máy (lịch sử giá từ 2000 nằm ở đó):"
  warn "  mysqldump -h 127.0.0.1 -P 3306 -u root -p --single-transaction \\"
  warn "    --default-character-set=utf8mb4 --databases stock_system > backups/stock_system_\$(date +%Y%m%d_%H%M).sql"
  warn "  docker compose exec -T db mysql -uroot -p stock_system < backups/<file>.sql"
fi

if [ "$FOLLOW_LOGS" -eq 1 ]; then
  echo
  dc logs -f
fi
