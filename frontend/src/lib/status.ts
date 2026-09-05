/**
 * Từ điển trạng thái — Phần 1 của đặc tả.
 *
 * Một chỗ duy nhất định nghĩa nhãn tiếng Việt và màu sắc. Component chỉ đọc từ đây,
 * không tự viết `if status === 'ACTIVE' ...` rải rác.
 */

export type BadgeTone = 'gray' | 'blue' | 'green' | 'amber' | 'red' | 'cyan' | 'purple';

export type StatusMeta = {
  label: string;
  tone: BadgeTone;
  /** Mô tả ngắn dùng cho tooltip — giúp nhân viên mới hiểu ngay ý nghĩa trạng thái. */
  hint: string;
};

/** Trục THỜI HẠN — mục 1.1 */
export const SUBSCRIPTION_STATUS: Record<string, StatusMeta> = {
  PENDING_VERIFY: {
    label: 'Chờ xác thực',
    tone: 'gray',
    hint: 'Đã đăng ký nhưng chưa xác thực email. Chưa đăng nhập được.',
  },
  TRIAL: {
    label: 'Dùng thử',
    tone: 'cyan',
    hint: 'Đang trong 7 ngày dùng thử. Chưa áp điều kiện IB.',
  },
  TRIAL_EXPIRED: {
    label: 'Hết dùng thử',
    tone: 'amber',
    hint: 'Hết 7 ngày dùng thử, chưa mua gói. Chỉ vào được màn chọn gói.',
  },
  ACTIVE: {
    label: 'Đang hiệu lực',
    tone: 'green',
    hint: 'Gói trả phí còn hiệu lực.',
  },
  GRACE: {
    label: 'Ân hạn',
    tone: 'amber',
    hint: 'Vừa hết hạn, còn 3 ngày ân hạn. Vẫn truy cập được kèm banner cảnh báo.',
  },
  EXPIRED: {
    label: 'Hết hạn',
    tone: 'red',
    hint: 'Hết hạn và quá thời gian ân hạn. Chỉ vào được màn gia hạn.',
  },
};

/** Trục CHẤT LƯỢNG TÀI KHOẢN — mục 1.2 */
export const COMPLIANCE_STATUS: Record<string, StatusMeta> = {
  NOT_REQUIRED: {
    label: 'Không áp dụng',
    tone: 'gray',
    hint: 'Đang dùng thử, tuyến trả phí thuần, hoặc được miễn áp điều kiện IB.',
  },
  PENDING_LINK: {
    label: 'Chờ liên kết TK',
    tone: 'amber',
    hint: 'Đã mua gói nhưng chưa liên kết tài khoản chứng khoán dưới IB.',
  },
  OK: {
    label: 'Đạt điều kiện',
    tone: 'green',
    hint: 'Thoả mãn cả điều kiện NAV và điều kiện giao dịch.',
  },
  WARNING: {
    label: 'Cảnh báo',
    tone: 'amber',
    hint: 'Vi phạm ngưỡng, đang trong 7 ngày cảnh báo trước khi tạm dừng.',
  },
  SUSPENDED: {
    label: 'Tạm dừng',
    tone: 'red',
    hint: 'Bị tạm dừng do vi phạm điều kiện. Tự khôi phục khi đạt lại điều kiện.',
  },
  CLOSED: {
    label: 'Đã đóng',
    tone: 'gray',
    hint: 'Quản trị viên đóng vĩnh viễn. Chỉ admin mở lại được.',
  },
};

export const IB_LINK_STATUS: Record<string, StatusMeta> = {
  NONE: { label: 'Chưa khai', tone: 'gray', hint: 'Chưa cung cấp số tài khoản chứng khoán.' },
  PENDING_LINK: {
    label: 'Chờ đối chiếu',
    tone: 'amber',
    hint: 'Đã khai số tài khoản, chờ job đối chiếu dữ liệu nguồn cuối ngày.',
  },
  OK: { label: 'Đã xác nhận', tone: 'green', hint: 'Đã tìm thấy trong dữ liệu nguồn.' },
  REJECTED: {
    label: 'Không khớp',
    tone: 'red',
    hint: 'Không tìm thấy sau 7 ngày, cần admin duyệt tay.',
  },
};

export const ARTICLE_STATUS: Record<string, StatusMeta> = {
  DRAFT: { label: 'Nháp', tone: 'gray', hint: 'Chưa gửi duyệt.' },
  PENDING_REVIEW: { label: 'Chờ duyệt', tone: 'amber', hint: 'Đang chờ người có quyền xuất bản.' },
  PUBLISHED: { label: 'Đã xuất bản', tone: 'green', hint: 'Đang hiển thị với khách hàng.' },
  ARCHIVED: { label: 'Lưu trữ', tone: 'gray', hint: 'Đã gỡ khỏi danh sách hiển thị.' },
};

export const SIGNAL_RESULT: Record<string, StatusMeta> = {
  OPEN: { label: 'Đang mở', tone: 'blue', hint: 'Chưa chốt kết quả.' },
  WIN: { label: 'Thắng', tone: 'green', hint: 'Đã chốt lời.' },
  LOSS: { label: 'Thua', tone: 'red', hint: 'Đã cắt lỗ.' },
  BE: { label: 'Hoà', tone: 'gray', hint: 'Đóng ở mức hoà vốn.' },
  CANCELLED: { label: 'Đã huỷ', tone: 'gray', hint: 'Bị huỷ, bản ghi gốc vẫn được giữ.' },
};

/** BR-841 — hai loại tín hiệu phải phân biệt tuyệt đối, không bao giờ gộp thống kê. */
export const SIGNAL_TYPE: Record<string, StatusMeta> = {
  LIVE: {
    label: 'Tín hiệu thực',
    tone: 'green',
    hint: 'Phát ra tại thời điểm thực, khách hàng đã nhận thông báo ngay lúc đó.',
  },
  BACKTEST: {
    label: 'Mô phỏng',
    tone: 'gray',
    hint: 'Tính lại trên dữ liệu lịch sử, chưa từng phát ra thực tế.',
  },
};

export const SYNC_JOB_STATUS: Record<string, StatusMeta> = {
  RUNNING: { label: 'Đang chạy', tone: 'blue', hint: '' },
  SUCCESS: { label: 'Thành công', tone: 'green', hint: '' },
  PARTIAL: {
    label: 'Có cảnh báo',
    tone: 'amber',
    hint: 'Chạy xong nhưng có dòng lỗi hoặc dữ liệu cũ — không dùng để xét compliance.',
  },
  FAILED: {
    label: 'Thất bại',
    tone: 'red',
    hint: 'Job compliance hôm nay sẽ không chạy. Không tài khoản nào bị đổi trạng thái.',
  },
  SKIPPED: { label: 'Bỏ qua', tone: 'gray', hint: 'Không phải ngày giao dịch.' },
};

/** Vòng đời một lượt phân tích theo yêu cầu — `app/core/constants.py: SymbolAnalysisStatus`. */
export const ANALYSIS_STATUS: Record<string, StatusMeta> = {
  QUEUED: {
    label: 'Đang xếp hàng',
    tone: 'gray',
    hint: 'Đã nhận yêu cầu, đang chờ tới lượt chạy.',
  },
  RUNNING: {
    label: 'Đang phân tích',
    tone: 'blue',
    hint: 'Máy đang đọc nến và tài liệu. Thường mất vài chục giây tới vài phút.',
  },
  DONE: { label: 'Đã xong', tone: 'green', hint: 'Kết quả dùng chung cho cả ngày hôm nay.' },
  FAILED: {
    label: 'Lỗi',
    tone: 'red',
    hint: 'Không phân tích được. Bấm Thử lại để chạy lại — lượt thử lại cũng tính vào hạn mức.',
  },
};

/** Nguồn sinh ra bản phân tích — suy từ loại chiến lược. */
export const ANALYSIS_SOURCE: Record<string, StatusMeta> = {
  ENGINE: {
    label: 'Bộ điều kiện',
    tone: 'cyan',
    hint: 'Máy chạy bộ điều kiện của chiến lược — tức thì, không tốn lượt phân tích nào.',
  },
  AI: {
    label: 'Hệ thống phân tích',
    tone: 'purple',
    hint: 'Claude đọc tài liệu chiến lược rồi viết nhận định. Mỗi lượt trừ một hạn mức.',
  },
};

/** Loại chiến lược — quyết định nút Phân tích chạy cái gì. */
export const STRATEGY_KIND: Record<string, StatusMeta> = {
  RULE: {
    label: 'Theo điều kiện',
    tone: 'cyan',
    hint: 'Dựng điều kiện vào/thoát lệnh. Phân tích chạy tức thì và không tốn hạn mức.',
  },
  DOCUMENT: {
    label: 'Theo tài liệu',
    tone: 'purple',
    hint: 'Tải tài liệu lên để AI đọc rồi viết nhận định. Mỗi lượt phân tích trừ một hạn mức.',
  },
};

export const TELEGRAM_STATUS: Record<string, StatusMeta> = {
  NOT_CONNECTED: { label: 'Chưa kết nối', tone: 'gray', hint: '' },
  PENDING: { label: 'Chờ xác thực', tone: 'amber', hint: 'Đã tạo yêu cầu, chưa hoàn tất.' },
  VERIFIED: { label: 'Đã kết nối', tone: 'green', hint: 'Đang nhận tín hiệu bình thường.' },
  BLOCKED: {
    label: 'Đã ngừng do bị chặn',
    tone: 'red',
    hint: 'Bot bị chặn. Bỏ chặn bot và kết nối lại để tiếp tục nhận.',
  },
  DISCONNECTED: { label: 'Đã ngắt', tone: 'gray', hint: 'Bạn đã chủ động ngắt kết nối.' },
};

export const PAYMENT_STATUS: Record<string, StatusMeta> = {
  PENDING: { label: 'Chờ thanh toán', tone: 'amber', hint: '' },
  PAID: { label: 'Đã thanh toán', tone: 'green', hint: '' },
  FAILED: { label: 'Thất bại', tone: 'red', hint: '' },
  REFUNDED: { label: 'Đã hoàn tiền', tone: 'gray', hint: '' },
  CANCELLED: { label: 'Đã huỷ', tone: 'gray', hint: '' },
};

export const CUSTOMER_TYPE: Record<string, StatusMeta> = {
  IB_LINKED: {
    label: 'Dưới IB',
    tone: 'blue',
    hint: 'Mở tài khoản chứng khoán dưới IB — chịu điều kiện NAV và giao dịch.',
  },
  PAID_ONLY: {
    label: 'Trả phí thuần',
    tone: 'purple',
    hint: 'Không thuộc tuyến IB — chỉ chịu ràng buộc thời hạn gói.',
  },
};

const FALLBACK: StatusMeta = { label: '—', tone: 'gray', hint: '' };

export function statusMeta(map: Record<string, StatusMeta>, code: string | null | undefined) {
  if (!code) return FALLBACK;
  return map[code] ?? { label: code, tone: 'gray' as BadgeTone, hint: '' };
}

export type SelectOption = { value: string; label: string };

/**
 * Đổi một từ điển trạng thái thành danh sách lựa chọn cho `<Select>`.
 *
 * Mỗi màn có bộ lọc đều tự viết `Object.entries(MAP).map(([value, meta]) => ({ value, label:
 * meta.label }))`. Cùng một dòng ấy lặp ở tám chỗ, và ở hai chỗ nó lại viết khác đi
 * (`([value, label]) => …` cho từ điển chuỗi) — nên thêm một trạng thái mới là phải nhớ sửa
 * đúng những nơi nào.
 *
 * Nhận cả `Record<string, StatusMeta>` lẫn `Record<string, string>` để dùng được với
 * `SCHOOL_LABEL` và các từ điển nhãn thuần.
 */
export function statusOptions(
  map: Record<string, StatusMeta | string>,
  only?: string[],
): SelectOption[] {
  const entries = only
    ? only.filter((code) => code in map).map((code) => [code, map[code]] as const)
    : Object.entries(map);
  return entries.map(([value, meta]) => ({
    value,
    label: typeof meta === 'string' ? meta : meta.label,
  }));
}

/** Nhãn tiếng Việt cho lý do bỏ qua gửi tín hiệu — BR-883. */
export const SKIP_REASON_LABEL: Record<string, string> = {
  SUBSCRIPTION_INACTIVE: 'Gói dịch vụ không còn hiệu lực',
  COMPLIANCE_BLOCKED: 'Tài khoản đang bị tạm dừng',
  PACKAGE_TOO_LOW: 'Chiến lược vượt mức gói hiện tại',
  TELEGRAM_NOT_VERIFIED: 'Chưa kết nối Telegram hoặc đã chặn bot',
  DAILY_LIMIT: 'Vượt hạn mức tin nhắn trong ngày (gom vào tin tổng hợp)',
  OUTSIDE_WINDOW: 'Ngoài khung giờ gửi tín hiệu',
  ALERT_TYPE_DISABLED: 'Khách hàng đã tắt loại thông báo này',
};

/** Nhãn trường phái chiến lược. */
export const SCHOOL_LABEL: Record<string, string> = {
  SMC: 'SMC',
  ICT: 'ICT',
  PRICE_ACTION: 'Price Action',
  QUANT: 'Quant',
  INDICATOR: 'Chỉ báo',
};
