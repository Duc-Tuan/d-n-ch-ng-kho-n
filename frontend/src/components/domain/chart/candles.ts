/**
 * Ghép chuỗi nến — phần logic thuần của biểu đồ giá.
 *
 * Tách khỏi `PriceChart` vì đây là chỗ **hỏng lặng lẽ nhất** của cả biểu đồ: ghép sai thì nến
 * vẫn hiện ra, vẫn có đủ bốn giá, chỉ là thiếu một đoạn quá khứ hoặc sai thứ tự — mà thư viện
 * biểu đồ thì bỏ qua phần lệch thứ tự chứ không báo lỗi. Ở đây nó chạy được độc lập nên kiểm
 * chứng được bằng `node`, thay vì phải mở trình duyệt ra kéo chuột rồi đoán.
 */
import type { Candle } from '@/types';

/** Mốc nhận dạng một nến. `time` là mốc mở nến; `trade_date` chỉ là đường lui cho dữ liệu cũ. */
export function candleKey(candle: Candle): string {
  return candle.time ?? candle.trade_date;
}

/**
 * Mốc mở nến ở dạng số, để so sánh và sắp xếp.
 *
 * Không so trực tiếp chuỗi của `candleKey`: `time` là "2026-09-08T02:15:00Z" còn `trade_date`
 * là "2026-09-08", và một mảng lẫn hai kiểu chuỗi ấy sắp xếp theo bảng chữ cái sẽ ra sai thứ tự.
 */
export function candleTime(candle: Candle): number {
  return Date.parse(candle.time ?? candle.trade_date);
}

/**
 * Gộp chuỗi nến mới nhận được vào chuỗi đang giữ, **không đụng tới phần lịch sử đã cuộn về**.
 *
 * Màn cha nạp lại nến ngày theo chu kỳ của nó, và mỗi lần như thế nó chỉ đưa về vài trăm phiên
 * gần nhất. Gán thẳng chuỗi đó vào biểu đồ là xoá sạch phần quá khứ người dùng vừa kéo chuột để
 * tải — họ cuộn về, thấy nến hiện ra, rồi thấy nó biến mất, và kết luận là cuộn không tải được
 * gì. Ở đây chuỗi mới chỉ làm hai việc: cập nhật những nến đã có (nến cuối phiên còn đang chạy
 * thì giá đóng của nó đổi) và nối thêm nến mới hơn.
 */
export function mergeCandles(current: Candle[], incoming: Candle[]): Candle[] {
  if (!current.length) return incoming;
  if (!incoming.length) return current;

  const fresh = new Map(incoming.map((c) => [candleKey(c), c]));
  const merged = current.map((c) => fresh.get(candleKey(c)) ?? c);

  const known = new Set(merged.map(candleKey));
  for (const candle of incoming) {
    if (!known.has(candleKey(candle))) merged.push(candle);
  }

  // Chuỗi phải tăng dần theo thời gian, nếu không thư viện biểu đồ bỏ qua phần lệch thứ tự.
  merged.sort((a, b) => candleTime(a) - candleTime(b));
  return merged;
}

/**
 * Nối phần lịch sử vừa tải vào **trước** chuỗi đang có, khử nến trùng ở mép.
 *
 * Trả về `null` khi không có gì mới — nơi gọi hiểu đó là đã hết lịch sử và ngừng hỏi tiếp, thay
 * vì gọi lại vô hạn mỗi lần người dùng chạm mép trái.
 */
export function prependOlder(current: Candle[], older: Candle[]): Candle[] | null {
  if (!older.length) return null;

  const seen = new Set(current.map(candleKey));
  const fresh = older.filter((c) => !seen.has(candleKey(c)));
  if (!fresh.length) return null;

  const merged = [...fresh, ...current];
  merged.sort((a, b) => candleTime(a) - candleTime(b));
  return merged;
}
