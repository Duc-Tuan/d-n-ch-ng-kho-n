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
#   ./deploy.sh --skip-seed      # bỏ qua nạp dữ liệu nền (clone SQL + seed.py)
#   ./deploy.sh --dump-clone     # chỉ dump lại file clone từ MySQL máy dev rồi thoát
#   ./deploy.sh --dump-all       # dump TRỌN VẸN database ra 1 file .sql để bê sang máy khác
#   ./deploy.sh --import-all F   # nạp file đó vào MySQL trong Docker (XOÁ dữ liệu đang có)
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
DB_SERVICE="${DB_SERVICE:-db}"               # tên SERVICE trong compose (khác container_name)
PORT_WEB="${PORT_WEB:-3000}"
PORT_API="${PORT_API:-8000}"
SRC_ENV="${SRC_ENV:-backend/.env}"
RUN_ENV="${RUN_ENV:-.env.docker}"

# Dữ liệu nền nạp sau migration, TÁCH LÀM HAI vì hai file có số phận khác nhau
# trên git (xem .gitignore):
#
#   symbols.sql   danh mục mã — dữ liệu tham chiếu công khai (mã, sàn, tên công
#                 ty, ngành), không có gì riêng tư. VÀO GIT, để máy nào clone về
#                 cũng chạy được ngay.
#   clone_accounts.sql
#                 tài khoản thật: hash mật khẩu bcrypt, secret TOTP, email khách
#                 hàng. KHÔNG VÀO GIT. Chỉ dùng khi bê dữ liệu giữa các máy của
#                 mình; máy khách không cần và không nên có file này — seed.py
#                 tự tạo Super Admin từ SEED_SUPER_ADMIN_* trong backend/.env.
#
# Cả hai sinh bằng `--dump-clone`; chú thích đầu mỗi file ghi rõ bảng nào và vì sao.
SYMBOLS_SQL="${SYMBOLS_SQL:-backend/seed_data/symbols.sql}"
SYMBOLS_TABLES="symbols"
CLONE_SQL="${CLONE_SQL:-backups/clone_accounts.sql}"
CLONE_TABLES="staff packages users subscriptions notification_preferences"

DEV_DB_HOST="${DEV_DB_HOST:-host.docker.internal}"
DEV_DB_PORT="${DEV_DB_PORT:-3306}"
DEV_DB_USER="${DEV_DB_USER:-root}"

# Ghim tên project để tên volume/network không đổi theo tên thư mục chứa mã nguồn.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-stock}"

TAG=""
NO_CACHE=""
SKIP_MIGRATE=0
SKIP_SEED=0
DUMP_CLONE=0
DUMP_ALL=0
IMPORT_ALL=""
ASSUME_YES=0
SKIP_BUILD=0
DB_ONLY=0
PRUNE=0
FOLLOW_LOGS=0

while [ $# -gt 0 ]; do
  case "$1" in
    --no-cache)     NO_CACHE="--no-cache" ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    --skip-seed)    SKIP_SEED=1 ;;
    --dump-clone)   DUMP_CLONE=1 ;;
    --dump-all)     DUMP_ALL=1 ;;
    --import-all)   IMPORT_ALL="${2:?--import-all cần đường dẫn file .sql}"; shift ;;
    --yes|-y)       ASSUME_YES=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    --db-only)      DB_ONLY=1 ;;
    --prune)        PRUNE=1 ;;
    --logs)         FOLLOW_LOGS=1 ;;
    --tag)          TAG="${2:?--tag cần một giá trị, ví dụ: --tag 1.2}"; shift ;;
    -h|--help)      sed -n '3,22p' "$0" | sed 's/^# \?//'; exit 0 ;;
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

# Tên schema — cần cho cả bước nạp clone lẫn `--dump-clone`. docker-compose.yml
# mặc định `stock_system` khi biến vắng mặt; giữ đúng mặc định đó.
DB_NAME_VALUE="$(sed -nE 's/^DB_NAME=(.*)$/\1/p' "$RUN_ENV" | head -1)"
DB_NAME_VALUE="${DB_NAME_VALUE:-stock_system}"

# DB_HOST không cần sửa: docker-compose.yml đè thành `db` cho riêng container app,
# nên $SRC_ENV vẫn giữ 127.0.0.1 để chạy backend tay ngoài Docker như trước.
grep -qE '^DB_HOST=' "$RUN_ENV" \
  || warn "Không thấy DB_HOST trong $SRC_ENV — compose vẫn đè thành 'db', nhưng nên khai báo cho rõ."

# ── 1b. Chỉ dump lại hai file dữ liệu nền rồi thoát ──────────────────────────
# Dùng mysqldump CỦA CONTAINER mysql:8.0 chứ không đòi máy dev có sẵn client:
# máy Windows này chỉ cài MySQL Server + Workbench, mysqldump không nằm trên PATH.
#
# Giữ lại phần chú thích đầu file cũ (mọi dòng trước dòng `/*!...` đầu tiên do
# mysqldump sinh ra) — tài liệu nằm ở đó, dump lại không nên xoá mất.
dump_into() {
  local out="$1"; shift
  local head body
  head="$(mktemp)"; body="$(mktemp)"
  mkdir -p "$(dirname "$out")"

  if [ -f "$out" ]; then
    sed '/^\/\*!/,$d' "$out" > "$head"
  else
    printf -- '-- Sinh bằng: ./deploy.sh --dump-clone\n\n' > "$head"
  fi

  # MYSQL_PWD thay cho `-p<mật khẩu>`: tránh cảnh báo "using a password on the
  # command line", và mật khẩu không lộ trong danh sách tiến trình của container.
  dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" mysqldump \
    -h "$DEV_DB_HOST" -P "$DEV_DB_PORT" -u "$DEV_DB_USER" \
    --no-create-info --insert-ignore --complete-insert \
    --single-transaction --skip-add-locks --skip-disable-keys \
    --no-tablespaces --set-gtid-purged=OFF --skip-comments \
    --default-character-set=utf8mb4 \
    "$DB_NAME_VALUE" "$@" > "$body" \
    || { rm -f "$head" "$body"; die "mysqldump thất bại — MySQL máy dev có chạy ở $DEV_DB_HOST:$DEV_DB_PORT không?"; }

  # Ghi đè bằng file rỗng thì lần deploy sau mất sạch mà không ai biết.
  [ -s "$body" ] || { rm -f "$head" "$body"; die "mysqldump trả về rỗng — giữ nguyên $out cũ."; }

  cat "$head" "$body" > "$out"
  rm -f "$head" "$body"
  echo "  $out — $(wc -c < "$out") byte"
}

if [ "$DUMP_CLONE" -eq 1 ]; then
  step "Dump dữ liệu nền từ $DEV_DB_HOST:$DEV_DB_PORT"
  [ "$(docker inspect -f '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo gone)" = "running" ] \
    || die "Container '$DB_CONTAINER' không chạy. Chạy './deploy.sh --db-only' trước."

  dump_into "$SYMBOLS_SQL" $SYMBOLS_TABLES
  dump_into "$CLONE_SQL"   $CLONE_TABLES

  # `staff_roles` KHÔNG dump theo id: id bảng `permissions` giữa máy dev và bản
  # seed hiện tại đã lệch nhau (dev seed từ đợt cũ rồi mới thêm
  # customer.create/symbol.manage vào cuối), nên id bảng `roles` cũng có ngày
  # lệch theo. Sinh câu lệnh tra theo `username`/`code` để clone miễn nhiễm với
  # chuyện id — đây là mắt xích quyết định tài khoản quản trị có đúng quyền không.
  {
    printf -- '\n--\n-- staff_roles: gán vai trò theo username/code, không theo id.\n--\n'
    dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" \
      mysql -h "$DEV_DB_HOST" -P "$DEV_DB_PORT" -u "$DEV_DB_USER" \
      -N -B --default-character-set=utf8mb4 "$DB_NAME_VALUE" -e "
        SELECT CONCAT('INSERT IGNORE INTO staff_roles (staff_id, role_id) SELECT s.id, r.id FROM staff s, roles r WHERE s.username=', QUOTE(s.username), ' AND r.code=', QUOTE(r.code), ';')
        FROM staff_roles sr
        JOIN staff s ON s.id = sr.staff_id
        JOIN roles r ON r.id = sr.role_id
        ORDER BY s.id, r.code;"
  } >> "$CLONE_SQL" || die "Không sinh được phần staff_roles."

  echo
  echo "  $SYMBOLS_SQL vào git — nhớ commit."
  echo "  $CLONE_SQL KHÔNG vào git (hash mật khẩu, email khách) — chép tay khi đổi máy."
  exit 0
fi

# ── 1c. Dump trọn vẹn database ra một file rồi thoát ─────────────────────────
# Khác `--dump-clone` ở chỗ: file này là BẢN SAO Y HỆT, kèm CREATE TABLE, DROP
# TABLE, trigger, và cả `alembic_version` — dùng khi bê toàn bộ hệ thống sang
# máy khác chứ không phải để vá dữ liệu nền vào một DB đã dựng sẵn.
#
# Nguồn mặc định là MySQL máy dev. Muốn chụp chính DB trong Docker thì trỏ ngược
# vào nó (trong container mysql, 127.0.0.1:3306 là chính nó):
#     DEV_DB_HOST=127.0.0.1 DEV_DB_PORT=3306 ./deploy.sh --dump-all
if [ "$DUMP_ALL" -eq 1 ]; then
  out="backups/${DB_NAME_VALUE}_full_$(date +%Y%m%d_%H%M).sql"
  step "Dump trọn vẹn '$DB_NAME_VALUE' từ $DEV_DB_HOST:$DEV_DB_PORT → $out"
  [ "$(docker inspect -f '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo gone)" = "running" ] \
    || die "Container '$DB_CONTAINER' không chạy. Chạy './deploy.sh --db-only' trước."

  mkdir -p backups

  # --quick: đổ từng dòng một thay vì nạp cả bảng vào RAM. Bảng ohlcv_daily có
  #          nửa triệu dòng, thiếu cờ này là mysqldump ăn hết bộ nhớ container.
  # --databases: sinh kèm CREATE DATABASE + USE, nên lúc import không cần chỉ tên
  #          schema — bớt một chỗ gõ sai.
  # --add-drop-table: import là thay thế sạch, không chồng lên dữ liệu cũ.
  # --triggers: schema này có 1 trigger; mặc định đã bật, ghi rõ cho khỏi quên.
  dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" mysqldump \
    -h "$DEV_DB_HOST" -P "$DEV_DB_PORT" -u "$DEV_DB_USER" \
    --databases "$DB_NAME_VALUE" \
    --single-transaction --quick --add-drop-table --triggers --routines \
    --no-tablespaces --set-gtid-purged=OFF --default-character-set=utf8mb4 \
    > "$out" \
    || die "mysqldump thất bại — MySQL có chạy ở $DEV_DB_HOST:$DEV_DB_PORT không?"

  [ -s "$out" ] || { rm -f "$out"; die "mysqldump trả về rỗng."; }

  echo "  $(du -h "$out" | cut -f1)  ($(grep -c 'INSERT INTO' "$out") câu INSERT)"
  echo
  echo "  Bê file này sang máy khác, đặt vào thư mục dự án, rồi ở máy đó chạy:"
  echo "      ./deploy.sh --skip-seed          # dựng container + schema, chưa cần dữ liệu nền"
  echo "      ./deploy.sh --import-all $out"
  echo
  warn "File có hash mật khẩu, secret TOTP, email khách hàng — chép tay, đừng đẩy lên git."
  exit 0
fi

# ── 1d. Nạp một file dump trọn vẹn vào MySQL trong Docker ────────────────────
# XOÁ TRẮNG dữ liệu đang có: file dump chứa DROP TABLE cho từng bảng.
if [ -n "$IMPORT_ALL" ]; then
  step "Nạp $IMPORT_ALL vào '$DB_NAME_VALUE' trong container '$DB_CONTAINER'"
  [ -f "$IMPORT_ALL" ] || die "Không thấy file $IMPORT_ALL."
  [ "$(docker inspect -f '{{.State.Status}}' "$DB_CONTAINER" 2>/dev/null || echo gone)" = "running" ] \
    || die "Container '$DB_CONTAINER' không chạy. Chạy './deploy.sh --db-only' trước."

  existing="$(dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" \
    mysql -N -B -u root -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB_NAME_VALUE'" 2>/dev/null | tr -d '\r' || echo 0)"

  if [ "${existing:-0}" -gt 0 ] && [ "$ASSUME_YES" -eq 0 ]; then
    warn "Database '$DB_NAME_VALUE' đang có $existing bảng. File dump sẽ XOÁ và dựng lại toàn bộ."
    printf 'Gõ đúng chữ "xoa" để tiếp tục: '
    read -r answer </dev/tty || answer=""
    [ "$answer" = "xoa" ] || die "Đã huỷ, không đụng gì tới database."
  fi

  dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" \
    mysql -u root --default-character-set=utf8mb4 < "$IMPORT_ALL" \
    || die "Nạp thất bại."

  echo "  Xong. Kiểm nhanh:"
  dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" mysql -u root "$DB_NAME_VALUE" -e \
    "SELECT 'staff' bang, COUNT(*) so_dong FROM staff
     UNION ALL SELECT 'users', COUNT(*) FROM users
     UNION ALL SELECT 'symbols', COUNT(*) FROM symbols
     UNION ALL SELECT 'ohlcv_daily', COUNT(*) FROM ohlcv_daily"
  exit 0
fi

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

# ── 7. Dữ liệu nền: seed → symbols → tài khoản ───────────────────────────────
# Thiếu bước này thì alembic chỉ để lại bảng rỗng: bảng `staff` không có dòng nào
# nên MỌI lần đăng nhập trả 401 INVALID_CREDENTIALS, và vì không có cookie phiên
# nên mọi request sau đó cũng 401 theo — đúng triệu chứng gặp hôm 2026-09-05.
#
# seed.py chạy TRƯỚC vì nó là nguồn sự thật của permissions/roles/role_permissions
# (tra theo `code`, gán lại mỗi lần chạy) và của packages/categories/template/văn
# bản pháp lý/lịch giao dịch. Hai file .sql chạy SAU, chỉ mang thứ seed không biết.
# Riêng phần staff_roles trong file tài khoản tra theo username/code nên bắt buộc
# phải có bảng `roles` sẵn — thêm một lý do nữa để seed đi trước.
load_sql() {
  dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" \
    mysql -u root --default-character-set=utf8mb4 "$DB_NAME_VALUE" < "$1" \
    || die "Nạp $1 thất bại."
}

if [ "$DB_ONLY" -eq 1 ]; then
  step "Bỏ qua dữ liệu nền (--db-only)"
elif [ "$SKIP_SEED" -eq 1 ]; then
  step "Bỏ qua dữ liệu nền (--skip-seed)"
else
  step "python -m app.scripts.seed"
  dc exec -T -w /app/backend app python -m app.scripts.seed || die "seed thất bại."

  # Danh mục mã — có trong git, máy nào clone về cũng phải thấy file này.
  if [ -f "$SYMBOLS_SQL" ]; then
    step "Nạp $SYMBOLS_SQL (danh mục mã)"
    load_sql "$SYMBOLS_SQL"
    echo "  $(dc exec -T -e MYSQL_PWD="$DB_PASSWORD_VALUE" "$DB_SERVICE" mysql -N -B -u root -e "select count(*) from $DB_NAME_VALUE.symbols" | tr -d '\r') mã trong bảng symbols."
  else
    warn "Không thấy $SYMBOLS_SQL — bảng symbols sẽ rỗng, màn hình thị trường không có gì."
    warn "File này ĐÁNG LẼ có trong git. Sinh lại bằng: ./deploy.sh --dump-clone"
  fi

  # Tài khoản thật — KHÔNG có trong git. Máy khách không có file này là đúng.
  if [ -f "$CLONE_SQL" ]; then
    step "Nạp $CLONE_SQL (tài khoản)"
    load_sql "$CLONE_SQL"
    echo "  Toàn bộ là INSERT IGNORE — dòng đã có trong Docker giữ nguyên, không bị đè."
  else
    step "Không có $CLONE_SQL — bỏ qua phần tài khoản"
    echo "  Bình thường trên máy mới: tài khoản duy nhất là Super Admin do seed.py tạo"
    echo "  từ SEED_SUPER_ADMIN_* trong $SRC_ENV. Đăng nhập xong ĐỔI MẬT KHẨU ngay."
  fi
fi

# ── 8. Dọn image mồ côi ──────────────────────────────────────────────────────
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
