# HỆ THỐNG WEB TƯ VẤN CHỨNG KHOÁN

Hai site độc lập (Customer Site + Admin Site), backend FastAPI + MySQL, frontend Next.js.

> Đặc tả nghiệp vụ: [`docs/nghiep-vu-he-thong-chung-khoan.md`](docs/nghiep-vu-he-thong-chung-khoan.md)
> Các quyết định đã chốt: [`docs/quyet-dinh-ky-thuat.md`](docs/quyet-dinh-ky-thuat.md)
> **Tài khoản đăng nhập:** [`docs/tai-khoan-dang-nhap.md`](docs/tai-khoan-dang-nhap.md)

---

## 1. Cấu trúc

```
my-stock-system/
├── docs/                       Đặc tả nghiệp vụ và quyết định kỹ thuật
├── backend/                    FastAPI + SQLAlchemy 2.0 + Alembic
│   ├── app/
│   │   ├── core/               config, database, security, deps, pagination
│   │   ├── models/             43 bảng (Phần 5, 13.5, 14.4, 15.8)
│   │   ├── schemas/            Pydantic request/response
│   │   ├── services/           TOÀN BỘ nghiệp vụ nằm ở đây
│   │   ├── api/customer/       /api/v1/customer/*
│   │   ├── api/admin/          /api/v1/admin/*
│   │   ├── jobs/               8 job tự động (Phần 6) + scheduler
│   │   └── scripts/seed.py     Khởi tạo dữ liệu
│   ├── alembic/versions/       Migration
│   └── tests/                  94 test các quy tắc nghiệp vụ trọng yếu
└── frontend/                   Next.js 15 App Router + Tailwind + dayjs
    └── src/
        ├── components/ui/      Thư viện UI dùng chung
        ├── components/layout/  CustomerShell, AdminShell
        ├── components/domain/  StrategyChart (marker mua/bán)
        ├── hooks/              useApi, useSession, useToast, usePagination…
        ├── lib/                api client, datetime, format, status
        └── app/
            ├── (auth)/         đăng nhập, đăng ký, quên mật khẩu
            ├── (customer)/     Customer Site
            ├── admin/          Admin Site
            └── legal/          Văn bản pháp lý công khai
```

**Nguyên tắc tổ chức mã**

| Loại | Nơi đặt | Ghi chú |
|---|---|---|
| UI dùng chung | `frontend/src/components/ui/*` | Không component nào tự dựng button/modal/table riêng |
| Logic dùng chung FE | `frontend/src/hooks/*`, `frontend/src/lib/*` | Không gọi `fetch` trực tiếp trong component |
| Nghiệp vụ BE | `backend/app/services/*` | Router chỉ điều phối, không chứa logic |
| Từ điển trạng thái | `backend/app/core/constants.py` + `frontend/src/lib/status.ts` | Một chỗ duy nhất định nghĩa nhãn và màu |

---

## 2. Chạy nhanh bằng một cú click (Windows)

| File | Dùng khi |
|---|---|
| **`start.bat`** | **Lần đầu** — cài đặt đầy đủ rồi chạy, mỗi dịch vụ một cửa sổ cmd |
| **`dev.bat`** | **Hằng ngày** — mở Windows Terminal, mỗi dịch vụ một tab (chỉ khởi động, không cài đặt) |
| `start-demo.bat` | Xem thử ngay, dùng SQLite — không cần cài MySQL |
| `stop.bat` | Dừng cả backend và frontend |

`dev.bat` yêu cầu đã có sẵn `.venv` và `node_modules`, nên hãy chạy `start.bat` một lần trước.
Nếu thiếu, `dev.bat` sẽ báo rõ và không chạy tiếp.

`start.bat` tự làm hết những việc sau, nên lần đầu chỉ cần double-click:

1. Kiểm tra Python và Node.js
2. Tạo môi trường ảo và cài thư viện nếu chưa có
3. Tạo `backend/.env` từ file mẫu và **tự sinh hai JWT secret ngẫu nhiên** cho hai site
4. Kiểm tra kết nối MySQL, tự tạo database nếu chưa tồn tại
5. Chạy migration và dữ liệu khởi tạo
6. Hỏi có tạo dữ liệu mẫu không (nếu chưa có khách hàng nào)
7. Chạy `npm install` nếu thiếu `node_modules`
8. Bật backend và frontend ở hai cửa sổ riêng, rồi mở trình duyệt

Nếu không kết nối được MySQL, script sẽ hỏi có muốn chuyển sang chế độ thử nghiệm bằng SQLite không.

> **Lưu ý khi chỉnh sửa file `.bat`:** phải giữ xuống dòng kiểu **CRLF**. File chỉ có LF sẽ khiến
> `cmd.exe` phân tích sai và báo những lỗi khó hiểu như `'M' is not recognized as an internal or
> external command`. File `.gitattributes` đã ép sẵn quy tắc này.

### Tài khoản để đăng nhập thử

Dữ liệu mẫu tạo sẵn 6 khách hàng ở đủ các trạng thái, **mật khẩu chung `demo1234`**:

| Email | Trạng thái minh hoạ |
|---|---|
| `trial@demo.vn` | Đang trong 7 ngày dùng thử |
| `active@demo.vn` | Gói 12 tháng, NAV tốt, đạt điều kiện |
| `warning@demo.vn` | NAV dưới ngưỡng, còn 4 ngày trước khi tạm dừng |
| `suspended@demo.vn` | Bị tạm dừng do NAV, gói đang đóng băng |
| `grace@demo.vn` | Vừa hết hạn, đang trong 3 ngày ân hạn |
| `expired@demo.vn` | Hết hạn và quá ân hạn |

Tạo lại bất cứ lúc nào: `python -m app.scripts.seed_demo` (script từ chối chạy ở môi trường production).

Tài khoản quản trị: `superadmin`, mật khẩu xem ở `SEED_SUPER_ADMIN_PASSWORD` trong `backend/.env`.

> Tài khoản quản trị **không đăng nhập được** vào trang khách hàng và ngược lại — hai bảng tài
> khoản, hai cookie, hai khoá ký token khác nhau. Nếu bạn thử đăng nhập chéo và nhận `401`, đó là
> hệ thống đang hoạt động đúng.

---

## 3. Cài đặt thủ công

### Yêu cầu
Python 3.11+ · Node.js 20+ · MySQL 8.0+

### Backend

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt

cp .env.example .env            # rồi điền thông tin MySQL và các secret
```

**Bắt buộc đổi trước khi chạy thật** trong `.env`:

```bash
# Sinh secret: python -c "import secrets; print(secrets.token_urlsafe(64))"
JWT_SECRET_CUSTOMER=...         # PHẢI khác JWT_SECRET_STAFF
JWT_SECRET_STAFF=...
DB_PASSWORD=...
SEED_SUPER_ADMIN_PASSWORD=...
```

Tạo database và chạy migration:

```sql
CREATE DATABASE stock_system CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

```bash
alembic upgrade head
python -m app.scripts.seed
uvicorn app.main:app --reload --port 8000
```

API docs: http://localhost:8000/docs (tự tắt ở môi trường production)

### Frontend

```bash
cd frontend
npm install
npm run dev
```

- Customer Site: http://localhost:3000
- Admin Site: http://localhost:3000/admin

`next.config.mjs` proxy `/api/v1/*` sang `http://localhost:8000` để cookie HttpOnly hoạt động
trên cùng origin. Đổi qua biến `API_ORIGIN` nếu backend chạy nơi khác.

---

## 4. Đăng nhập lần đầu

Tài khoản Super Admin được tạo bởi `seed.py` với thông tin trong `.env`.

Luồng đăng nhập Admin Site chỉ còn **1 bước**: nhập username + mật khẩu.
Bước nhập mã 6 số từ ứng dụng xác thực (2FA TOTP) đã được gỡ.

Sau khi vào được, việc cần làm ngay:
1. Đổi mật khẩu Super Admin
2. Rà soát nội dung 7 văn bản pháp lý (mục *Văn bản pháp lý*) với luật sư
3. Bổ sung ngày nghỉ lễ vào lịch giao dịch
4. Cấu hình Google Sheet để job đồng bộ NAV chạy được

---

## 5. Cấu hình đồng bộ NAV

1. Tạo Service Account trên Google Cloud, tải file JSON về `backend/secrets/service-account.json`
2. Chia sẻ Google Sheet cho email của service account ở quyền **Viewer**
   (không dùng link chia sẻ công khai — NAV là dữ liệu tài chính cá nhân)
3. Điền vào `.env`:

```bash
GOOGLE_SHEET_ID=<id trong URL của sheet>
GOOGLE_SHEET_RANGE=NAV!A2:G
GOOGLE_SERVICE_ACCOUNT_FILE=./secrets/service-account.json
```

**Cấu trúc sheet bắt buộc** (dòng 1 là tiêu đề):

| A | B | C | D | E | F | G |
|---|---|---|---|---|---|---|
| `email` | `so_tai_khoan` | `ho_ten` | `nav` | `ngay_giao_dich_gan_nhat` | `so_lenh_30_ngay` | `ngay_cap_nhat` |

Cột bắt buộc: `email` (khoá đối chiếu), `so_tai_khoan`, `nav`, `ngay_giao_dich_gan_nhat`, `ngay_cap_nhat`.
NAV chấp nhận cả `1500000000` và `1,500,000,000`. Ngày chấp nhận `yyyy-mm-dd` và `dd/mm/yyyy`.

---

## 5b. Dữ liệu giá và danh mục mã theo dõi

**Nguồn giá** đặt ở `MARKET_DATA_PROVIDER` trong `.env`:

| Nguồn | Lịch sử có từ | Ghi chú |
|---|---|---|
| `VPS` *(đang dùng)* | **2000-07-28** | Phiên đầu tiên của thị trường chứng khoán Việt Nam |
| `VNDIRECT` | 2013-01-02 | Xin xa hơn cũng chỉ nhận được bấy nhiêu |

Danh mục mã lấy từ SSI iBoard cho cả hai nguồn. Đổi nguồn thì phải **nạp lại toàn bộ**:

```bash
python -m app.scripts.backfill_ohlcv     # ~2,5 phút cho 150 mã, ~521k nến
```

> ⚠️ **Không trộn hai nguồn.** Chúng áp hệ số điều chỉnh cổ tức khác nhau — trên FPT và HPG, hơn
> 2.000 trong 3.392 phiên trùng nhau cho giá lệch hẳn. Ghép lại sẽ tạo một cú nhảy giá giả ở mốc
> giao nhau và máy chạy chiến lược đọc thành tín hiệu. Đổi nguồn là xoá sạch rồi tải lại, không
> phải vá thêm phần thiếu.

**Danh mục mã theo dõi** — nguồn sự thật là bảng `symbols`, quản lý ở Admin Site →
*Dữ liệu thị trường → Danh mục mã* (cần quyền `symbol.manage`):

- **Thêm mã**: mã được đối chiếu với nhà cung cấp trước khi ghi nên gõ nhầm bị chặn ngay; sàn và
  tên doanh nghiệp tự điền. Thêm xong hệ thống **tải luôn toàn bộ giá lịch sử** ở chạy nền.
- **Sửa**: ngành, tier, bật/tắt theo dõi. Không sửa được mã và sàn — đổi mã tức là đổi sang doanh
  nghiệp khác, giá lịch sử đang gắn với mã cũ sẽ thành vô nghĩa.
- **Xoá**: bắt buộc nhập lý do (ghi audit log). Mã **đã từng phát tín hiệu thì không xoá** mà chỉ
  tắt theo dõi — tín hiệu đã gửi cho khách là dữ liệu bất biến, xoá mã đi thì màn tra cứu khiếu
  nại sẽ trống đúng lúc cần nhất.

`app/data/symbol_universe.py` chỉ còn là **danh sách hạt giống** cho lần dựng hệ thống đầu tiên
(`python -m app.scripts.sync_symbol_universe`). Sửa file đó không ảnh hưởng hệ thống đang chạy, và
script chạy mặc định chỉ thêm mã còn thiếu chứ không đụng mã đã có. Cờ `--prune` khôi phục hành vi
xoá cũ — nó xoá cả những mã quản trị viên vừa thêm, nên chỉ dùng khi thật sự muốn ép về đúng file.

---

## 6. Job tự động

| Job | Lịch chạy | Nhiệm vụ |
|---|---|---|
| `sync_nav` | 15:15 ngày giao dịch | Đọc Google Sheet → validate → ghi `nav_daily` |
| `check_compliance` | 16:30 ngày giao dịch | Xét NAV/giao dịch → cảnh báo / tạm dừng / khôi phục |
| `check_subscription` | 00:05 hằng ngày | TRIAL→TRIAL_EXPIRED, ACTIVE→GRACE→EXPIRED |
| `notify_expiry` | 09:00 hằng ngày | Nhắc T-15/7/3/1 và ngày hết hạn |
| `notify_warning` | 09:00 hằng ngày | Nhắc KH đang cảnh báo + đẩy danh sách cho môi giới |
| `sync_market` | 16:00 thứ 2–6 | Cập nhật danh mục mã và giá cuối ngày cho toàn bộ 150 mã theo dõi |
| `ai_analysis` | 16:15 thứ 2–6 | Phân tích từng (chiến lược × mã) → hàng chờ duyệt ở `/admin/ai-analysis` |
| `close_signals` | 16:00 ngày giao dịch | Chốt kết quả tín hiệu |
| `cleanup` | 02:00 hằng ngày | Xoá OTP/session hết hạn, tài khoản chưa verify quá 7 ngày |
| `notification_worker` | mỗi 60 giây | Gửi email/SMS từ hàng đợi |
| `telegram_worker` | mỗi 10 giây | Gửi tín hiệu Telegram có điều tiết tốc độ |
| `telegram_digest` | 16:00 | Tin tổng hợp cuối phiên cho KH vượt hạn mức |

Scheduler chạy in-process. Khi triển khai nhiều instance, **chỉ bật `ENABLE_SCHEDULER=true` ở
đúng một instance** để job không chạy trùng.

> **Hệ quả của việc chạy in-process:** job chỉ nổ khi tiến trình backend còn sống đúng lúc đó.
> Tắt backend qua đêm thì `check_subscription` (00:05) và `cleanup` (02:00) không chạy; tắt máy
> lúc 16:00 thì `sync_market` không lấy giá phiên đó. Job lỡ được chạy bù nếu backend bật lại
> trong vòng 1 giờ (`misfire_grace_time`), sau đó thì mất phiên — riêng `sync_market` tự lấy lại
> ở lần sau nhờ đệm 30 phiên. Kiểm tra job có thật sự chạy: bảng `sync_jobs`, hoặc Admin Site →
> *Đồng bộ dữ liệu*.

Chạy lại job thủ công: Admin Site → *Đồng bộ dữ liệu* → *Chạy job thủ công*.

### Chốt chặn an toàn của job compliance

Đây là phần dễ gây sự cố nghiêm trọng nhất, nên có nhiều lớp bảo vệ:

- Sheet không đọc được / 0 dòng / số dòng giảm quá 20% → **dừng, không ghi gì**, cảnh báo admin
- `sync_nav` thất bại → job compliance **không chạy**, không tài khoản nào đổi trạng thái
- Dữ liệu trong sheet là dữ liệu cũ → ghi nhận nhưng **không dùng để xét compliance**
- Không tìm thấy NAV của một khách hàng → **bỏ qua khách hàng đó**, ghi log, không coi là vi phạm
- Không khoá đột ngột: luôn qua vòng cảnh báo 7 ngày trước khi tạm dừng
- Khi tạm dừng, thời hạn gói **đóng băng** và được bù đủ khi khôi phục

---

## 7. Telegram

1. Tạo bot với [@BotFather](https://t.me/BotFather), lấy token và username
2. Điền `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` vào `.env`
3. Đăng ký webhook:

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://api.tenmien.vn/api/v1/webhooks/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Khách hàng kết nối bằng luồng deep-link: bấm “Kết nối Telegram” trên web → mở Telegram → bấm
“Bắt đầu”. Hệ thống lấy chat ID trực tiếp từ Telegram nên luôn đúng người, và bước “Bắt đầu”
cũng chính là điều kiện để bot được phép nhắn tin.

**Trước mỗi lần gửi**, hệ thống kiểm tra lại trạng thái gói, trạng thái điều kiện duy trì, kết nối
Telegram và quyền xem chiến lược theo gói. Đây là chốt chặn ngăn khách hàng hết hạn vẫn nhận tín
hiệu trả phí mà không cần đăng nhập lại.

---

## 7b. Phân tích hằng ngày bằng AI (MCP + `claude -p`)

Mỗi ngày sau khi nến mới về, hệ thống tự chạy phân tích cho từng cặp (chiến lược × mã), lưu kết
quả theo ngày, chờ quản trị duyệt, rồi công bố cho khách theo hai kiểu: **đọc dạng tin tức** ở
`/analyses` và **điểm mua/bán trên biểu đồ** qua marker có sẵn.

```
16:00  sync_market            → nến mới của ngày T
16:15  ai_analysis
         ├─ cổng chặn: ≥90% mã đã có nến ngày T, không thì SKIPPED
         ├─ chiến lược có rules_json → strategy_engine chạy tại chỗ   (source=ENGINE)
         └─ chiến lược có tài liệu   → chia lô 8 mã, mỗi lô một tiến
                                       trình `claude -p` gọi MCP       (source=AI)
                       ↓
   /admin/ai-analysis — sửa entry/SL/TP · viết lại bản tin · Duyệt / Từ chối
                       ↓
     Duyệt → daily_analyses.status=PUBLISHED  → khách ĐỌC bản tin
           + có setup → signal_service.create_signal(LIVE)
                        → marker trên chart · danh sách lệnh · Telegram
```

**Bảng `signals` và luồng tín hiệu phía khách không đổi một dòng nào.** Kết quả phân tích sống ở
`daily_analyses` — bảng **sửa được** — cho tới khi analyst bấm Duyệt. Đó là chỗ duy nhất tín hiệu
thật sinh ra. MCP server tuyệt đối không ghi vào `signals`.

### Điều kiện vận hành

Claude Code CLI phải được cài và **đăng nhập bằng chính người dùng hệ điều hành đang chạy
backend** — hồ sơ OAuth lưu theo user. Chạy backend dưới một service account khác thì `claude -p`
sẽ không có thông tin đăng nhập.

Không cần `ANTHROPIC_API_KEY`: job dùng gói thuê bao. Điều kiện là **không** dùng cờ `--bare`, vì
bare mode cố tình bỏ qua OAuth và đòi API key.

```bash
claude --version          # đã cài chưa
claude mcp get stock-analysis   # MCP server có kết nối được không
```

### Cấu hình (`.env`)

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `JOB_AI_ANALYSIS_CRON` | `15 16 * * mon-fri` | Giờ chạy. Job tự kiểm tra độ tươi dữ liệu nên đổi giờ là an toàn |
| `AI_CLAUDE_CLI_PATH` | `claude` | Đường dẫn Claude Code CLI |
| `AI_MCP_CONFIG_PATH` | `.claude/mcp-analysis.json` | Cấu hình MCP cho `claude -p` |
| `AI_BATCH_SIZE` | `8` | Số mã mỗi lô |
| `AI_CANDLES_PER_SYMBOL` | `300` | Số phiên gửi cho mô hình đọc |
| `AI_BATCH_TIMEOUT_SECONDS` | `900` | Quá giờ thì huỷ lô, đánh dấu lỗi rồi đi tiếp |
| `AI_PREFILTER_WITH_RULES` | `true` | Chiến lược vừa có bộ lọc vừa có tài liệu: bộ lọc chọn trước, chỉ đẩy sang AI mã có tín hiệu |

`AI_PREFILTER_WITH_RULES` là thứ giữ cho hạn mức gói thuê bao không vỡ. Trên dữ liệu thật, bộ lọc
bắn tín hiệu ở khoảng **2/149 mã** mỗi phiên — cắt khối lượng gọi AI đi hai bậc, miễn phí.

### MCP server

Sinh cấu hình MCP (chạy lại sau khi đổi vị trí thư mục dự án hoặc tạo lại `.venv`):

```bash
cd backend
.venv/Scripts/python.exe -m app.scripts.write_mcp_config
```

Script ghi `.claude/mcp-analysis.json` (cho `claude -p`) và in sẵn khối để chép vào
`claude_desktop_config.json`. Chạy tay để xem lỗi khởi động:

```bash
.venv/Scripts/python.exe app/mcp/server.py     # transport stdio
```

**Hai bẫy trên Windows, cả hai đều chỉ hiện ra là "Server disconnected":**

* `command` **phải là đường dẫn tuyệt đối**. `CreateProcess` không giải được đường dẫn tương đối
  kể cả khi file có thật — `os.path.exists` trả `True` mà vẫn `WinError 2`.
* **Claude Desktop bỏ qua khoá `cwd`**, nên `-m app.mcp.server` chết với
  `ModuleNotFoundError: No module named 'app'`. Vì vậy cấu hình truyền **đường dẫn file**
  `app/mcp/server.py` trong `args`, và `server.py` tự nạp thư mục `backend` vào `sys.path`.

Năm tool, tất cả mở phiên CSDL riêng:

| Tool | Việc |
|---|---|
| `lay_boi_canh_chien_luoc` | tên · trường phái · tóm tắt quy tắc · toàn văn tài liệu đã bóc |
| `lay_lo_viec` | lô việc PENDING kèm 300 nến mỗi mã (CSV gọn) |
| `luu_phan_tich` | ghi kết quả, kiểm SL/TP **trước khi** ghi |
| `bao_loi` | đánh dấu một việc lỗi mà không làm hỏng cả lô |
| `tao_me_phan_tich` | tạo mẻ tay để phân tích từ Claude Desktop |

Dùng từ **Claude Desktop**: chép khối do script in ra vào `claude_desktop_config.json`, Quit hẳn
app từ khay hệ thống rồi mở lại, sau đó bảo nó: *"tạo mẻ phân tích cho chiến lược #8 với 5 mã
FPT,HPG,VNM,MWG,VCB rồi phân tích từng mã"*.

Bản cài từ Microsoft Store để config ở
`%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, **không** phải `%APPDATA%\Claude\`.
Log của từng server: `…\Claude\logs\mcp-server-stock-analysis.log`.

Hai điều về kích thước kết quả: Claude Code cảnh báo khi một kết quả MCP vượt 10.000 token và
**cắt ở 25.000** — cắt âm thầm, giữa câu. Nên tài liệu chiến lược đi riêng khỏi dữ liệu nến, và
job đặt `MAX_MCP_OUTPUT_TOKENS=50000` cho tiến trình con.

### Bóc chữ tài liệu

PDF được bóc bằng `pypdf` và **cache vào `strategy_kb_docs.extracted_text`** — bóc một lần, mọi
lô nhận cùng một bối cảnh nên kết quả giữa các mã mới so sánh được. Đọc file gốc, không đóng dấu
chìm (`watermark_pdf` chỉ dành cho lượt tải của khách).

`docx/xlsx/pptx` chưa bóc được và PDF quét ảnh bóc ra rỗng — cả hai được ghi vào `index_status`
và **liệt kê tên file** ở phần Chi tiết của mẻ chạy. Không im lặng bỏ qua: chiến lược mất tài
liệu nền vẫn cho ra phân tích trôi chảy, chỉ là chung chung, và không cách nào nhận ra từ kết quả.

### Chạy lại được và nối tiếp được

Hàng đợi là các dòng `PENDING` trong CSDL, không phải trong bộ nhớ tiến trình. Chạm giới hạn sử
dụng của gói thuê bao giữa chừng thì mẻ dừng ở `PARTIAL`, **lần chạy sau làm nốt phần còn lại** —
mẻ dở của cùng ngày được chạy tiếp chứ không tạo mẻ mới.

## 8. Kiểm thử

```bash
cd backend
python -m pytest tests -q
```

94 test bao phủ các quy tắc dễ làm sai nhất:

- Thứ tự ưu tiên khi chặn truy cập (compliance chặn trước subscription)
- Cộng theo tháng lịch (31/01 + 3 tháng = 30/04)
- Gia hạn cộng dồn, không ghi đè; thời gian dùng thử không cộng dồn vào gói trả phí
- Đóng băng và bù ngày khi tài khoản bị tạm dừng
- NAV trung bình lọc được nhiễu ngắn hạn; đúng ngưỡng thì không bị khoá
- Thiếu dữ liệu **không** bị coi là vi phạm và **không** làm đổi trạng thái
- Thống kê tín hiệu thực và mô phỏng không bao giờ gộp chung
- Tín hiệu không sửa được sau khi chốt kết quả
- Thông báo không gửi trùng khi job chạy lại
- Token của hai site không dùng chéo được

**Máy chạy chiến lược** — nhóm test quan trọng nhất, vì sai ở đây không có gì báo lỗi: hệ thống
vẫn chạy, vẫn ra số đẹp, chỉ có điều số đó là bịa và khách hàng ra quyết định bằng tiền thật:

- Vào lệnh ở **phiên kế tiếp**, không nhìn trước tương lai
- Cùng phiên chạm cả cắt lỗ lẫn chốt lời thì tính **cắt lỗ** (chọn phía bất lợi)
- Lệnh còn mở không tính vào thống kê thắng thua
- Đỉnh/đáy N phiên không tính phiên hiện tại — nếu tính, điều kiện phá đỉnh không bao giờ đúng
- Bộ lọc sai cấu trúc bị chặn kèm thông báo tiếng Việt; không có đường nào chạy mã tuỳ ý

**Lọc HTML bài viết** — chặn XSS lưu trữ: thẻ `<script>`, thuộc tính sự kiện (`onerror`,
`onclick`…), giao thức `javascript:`/`data:`/`vbscript:`, `<iframe>`/`<object>`/`<svg>`,
`style`, `<meta refresh>`, `<form>` giả. Đồng thời kiểm tra nội dung hợp lệ **không** bị lọc oan.

---

## 9. Triển khai production

**Trước khi lên production**

- [ ] Đổi toàn bộ secret trong `.env`, hai JWT secret phải khác nhau
- [ ] `APP_ENV=production`, `DEBUG=false` (tự tắt `/docs`)
- [ ] Chạy sau HTTPS — cookie đặt `Secure` khi `APP_ENV=production`
- [ ] `CORS_ORIGINS` chỉ liệt kê domain thật
- [ ] Thư mục `STORAGE_DIR` nằm **ngoài** vùng phục vụ tĩnh của web server
- [ ] Không commit `.env` và `secrets/service-account.json`
- [ ] Sao lưu database hằng ngày, giữ tối thiểu 30 ngày
- [ ] **Dựng môi trường staging và test job compliance ở đó trước** — logic khoá tài khoản là loại
      logic tuyệt đối phải thử trước khi chạy thật
- [ ] Rà soát văn bản pháp lý với luật sư chuyên ngành chứng khoán

**Gợi ý cấu hình**

```
Nginx  →  /            → Next.js (port 3000)
       →  /api/v1/*    → FastAPI (port 8000)
```

```bash
# Backend
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4

# Frontend
npm run build && npm run start
```

---

## 10. Phạm vi đã làm và chưa làm

**Đã hoàn thiện**

- Xác thực hai site tách biệt, RBAC theo quyền, audit log
- Vòng đời gói dịch vụ đầy đủ: dùng thử, mua, gia hạn cộng dồn, ân hạn, đóng băng
- Đồng bộ NAV, job compliance với toàn bộ chốt chặn an toàn
- Hệ thống thông báo có hàng đợi, chống gửi trùng, giờ yên lặng, trung tâm tuỳ chọn
- CMS bài viết với quy trình duyệt và lịch sử phiên bản
- Kho tài liệu: hạn chế theo gói, link tải ngắn hạn, watermark PDF, nhật ký tải
- Chiến lược + marker mua/bán trên biểu đồ, thống kê tách LIVE/BACKTEST
- Hỏi đáp có chuyên viên trả lời, cam kết SLA, duyệt trước khi công khai
- Telegram: deep-link, đăng ký theo cặp (chiến lược × mã), hàng đợi có điều tiết tốc độ
- Quản lý văn bản pháp lý theo phiên bản, lưu bằng chứng đồng ý
- Bảng giá và biểu đồ nến toàn bộ mã HOSE/HNX/UPCOM, tự tải thêm lịch sử khi cuộn về quá khứ
- Quản lý danh mục mã theo dõi trên giao diện: thêm/sửa/xoá từng mã, thêm mã là tải luôn giá lịch
  sử, mã đã phát tín hiệu được bảo vệ khỏi thao tác xoá
- **Máy chạy chiến lược**: dựng bộ lọc bằng chỉ báo trên giao diện, chạy lên mã bất kỳ, sinh
  điểm mua bán trên biểu đồ kèm thống kê từng lệnh — cho cả chiến lược hệ thống và chiến lược
  khách hàng tự tạo
- Chiến lược cá nhân của khách hàng: tự tạo, chia sẻ đích danh hoặc bằng link, thu hồi được
- Trình soạn thảo WYSIWYG cho bài viết (TipTap), upload ảnh, thư viện ảnh dùng lại, xem trước
  đúng như bản đã đăng
- Lọc HTML bài viết ở máy chủ, chặn XSS lưu trữ
- Hỏi đáp thời gian thực bằng WebSocket, thông báo có âm thanh cho người trực trang quản trị
- Cấu hình hệ thống sửa được trên giao diện (Google Sheet, ngưỡng compliance, Telegram, email)
- Toàn bộ giao diện mobile-first, PWA cơ bản

**Chưa làm (cần quyết định hoặc thuộc giai đoạn sau)**

| Hạng mục | Vì sao chưa | Cần gì để làm tiếp |
|---|---|---|
| Thanh toán tự động (VNPay/MoMo) | Chưa chốt cổng thanh toán | Hiện tạo đơn `PENDING`, admin xác nhận thủ công |
| SMS / Zalo ZNS | Chưa đấu nối nhà cung cấp | Điểm cắm sẵn ở `notification_service.send_sms()` |
| Chốt kết quả tín hiệu LIVE tự động theo giá | Đã có OHLCV, còn cần chốt quy tắc khớp giá trong phiên | Job `close_signals` đã có khung; logic thoát lệnh dùng lại được từ `strategy_engine/runner.py` |
| Bot tự động phát tín hiệu LIVE theo lịch | Cần chốt quy trình duyệt trước khi phát ra khách | Máy chạy chiến lược đã có; còn thiếu khâu duyệt và job phát định kỳ |
| Hỏi đáp bằng AI | Cần kho FAQ tích luỹ trước | Mô hình có chuyên viên trả lời đang chạy sẽ tạo dữ liệu nền |

---

## 11. Ghi chú vận hành

**Không sửa dữ liệu trực tiếp trong database.** Toàn bộ ràng buộc nghiệp vụ nằm ở tầng service:
sửa thẳng SQL sẽ bỏ qua audit log, bỏ qua việc đóng băng thời hạn gói, và có thể vi phạm ràng
buộc bất biến của bảng tín hiệu (có trigger chặn ở tầng CSDL).

**Khi khách hàng khiếu nại “tôi không nhận được tín hiệu”:** tra ở Admin Site → *Telegram* →
mục lý do bỏ qua. Mỗi lần bỏ qua đều được ghi kèm nguyên nhân cụ thể.

**Khi khách hàng khiếu nại “tôi có đủ NAV mà sao bị khoá”:** mở hồ sơ khách hàng → tab *Nhật ký
trạng thái*. Mỗi lần đổi trạng thái đều lưu NAV trung bình và số ngày không giao dịch tại đúng
thời điểm đó.
