/** Định dạng số, tiền tệ và văn bản — dùng chung, không viết lại trong component. */

const VND = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const DECIMAL = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 2 });

/** 1.500.000.000 */
export function formatNumber(value: number | string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? VND.format(n) : fallback;
}

/** 1.500.000.000 ₫ */
export function formatCurrency(value: number | string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? `${VND.format(n)} ₫` : fallback;
}

/** Rút gọn số tiền lớn cho thẻ chỉ số: 1,5 tỷ · 250 triệu */
export function formatCompactCurrency(value: number | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${DECIMAL.format(value / 1e9)} tỷ`;
  if (abs >= 1e6) return `${DECIMAL.format(value / 1e6)} triệu`;
  if (abs >= 1e3) return `${DECIMAL.format(value / 1e3)} nghìn`;
  return VND.format(value);
}

/** 12,5% */
export function formatPercent(
  value: number | null | undefined,
  digits = 1,
  fallback = '—',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return fallback;
  return `${value.toFixed(digits).replace('.', ',')}%`;
}

/** +2,15R / −0,80R — dùng cho thống kê chiến lược. */
export function formatR(value: number | string | null | undefined, fallback = '—'): string {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2).replace('.', ',')}R`;
}

/** 2,4 MB */
/**
 * Thời **lượng** (không phải mốc thời gian): 95 → "1 phút", 3700 → "1 giờ 2 phút".
 *
 * Làm tròn tới phút khi đã quá một phút: mẻ phân tích chạy hàng chục phút, hiển thị tới từng
 * giây chỉ tạo ra một con số nhảy liên tục mà không ai đọc.
 */
export function formatDuration(seconds: number | null | undefined, fallback = '—'): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return fallback;
  const total = Math.round(seconds);
  if (total < 60) return `${total} giây`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} giờ ${rest} phút` : `${hours} giờ`;
}

export function formatFileSize(bytes: number | null | undefined, fallback = '—'): string {
  if (!bytes) return fallback;
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${DECIMAL.format(size)} ${units[unit]}`;
}

/** Che email khi hiển thị dữ liệu KH ở nơi không cần thiết phải lộ đầy đủ. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '—';
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const visible = name.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(name.length - 2, 0))}@${domain}`;
}

/** Cắt văn bản dài kèm dấu … */
export function truncate(text: string | null | undefined, max = 80): string {
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Ký tự đầu của họ tên — dùng cho avatar chữ. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Màu theo quy ước chứng khoán Việt Nam: tăng xanh lá, giảm đỏ, tham chiếu vàng. */
export function priceColor(change: number | null | undefined): string {
  if (change === null || change === undefined || change === 0) return 'text-ref';
  return change > 0 ? 'text-up' : 'text-down';
}
