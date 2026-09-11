/**
 * Ghép chuỗi nến — phần logic thuần của biểu đồ giá.
 *
 * Tách khỏi `PriceChart` vì đây là chỗ **hỏng lặng lẽ nhất** của cả biểu đồ: ghép sai thì nến
 * vẫn hiện ra, vẫn có đủ bốn giá, chỉ là thiếu một đoạn quá khứ hoặc sai thứ tự — mà thư viện
 * biểu đồ thì bỏ qua phần lệch thứ tự chứ không báo lỗi. Ở đây nó chạy được độc lập nên kiểm
 * chứng được bằng `node`, thay vì phải mở trình duyệt ra kéo chuột rồi đoán.
 */
import type { Quote } from '@/hooks/useMarketRealtime';
import { local } from '@/lib/datetime';
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
 * Phủ giá đang chạy lên cây nến cuối chuỗi — BR-831.
 *
 * Máy chủ đã ghép sẵn một cây nến sống vào cuối chuỗi (`bars._with_live_tail`), nhưng chuỗi ấy
 * chỉ được gọi lại khi đổi mã hoặc đổi khung. Đứng yên một chỗ thì bảng giá bên trái chạy theo
 * WebSocket còn biểu đồ giữ nguyên con số của lúc mở trang — cùng một mã, cùng một màn hình,
 * hai con số khác nhau. Đây là bước phủ thứ hai, ở phía trình duyệt, đúng như bảng giá làm.
 *
 * Ba trường hợp, giống hệt phía máy chủ:
 *
 * * Cây cuối đã là phiên hôm nay → hợp nhất: giữ giá mở đã lưu (chính xác hơn giá lấy mẫu), nới
 *   biên cao/thấp, lấy giá đóng và khối lượng của gói tin mới nhất.
 * * Cây cuối là phiên cũ → nối thêm cây của hôm nay. Xảy ra khi trang được mở **trước** khớp
 *   lệnh đầu tiên: lúc gọi API kho giá chưa có gì để máy chủ ghép vào.
 * * Cây cuối mới hơn phiên của gói tin → để yên. Người dùng đang cuộn ở quá khứ, hoặc gói tin
 *   là của phiên đã đóng từ hôm trước.
 */
export function withLiveQuote(candles: Candle[], quote: Quote | undefined): Candle[] {
  if (!quote || quote.price === null) return candles;

  const price = quote.price;
  // Ngày giao dịch của gói tin theo giờ Việt Nam (BR-130) — `trade_date` của nến cũng vậy, nên
  // hai chuỗi "YYYY-MM-DD" này so trực tiếp được.
  const tradeDate = local(quote.as_of).format('YYYY-MM-DD');
  const last = candles[candles.length - 1];

  if (last && last.trade_date === tradeDate) {
    return [
      ...candles.slice(0, -1),
      {
        ...last,
        high: Math.max(last.high, quote.high ?? price, price),
        low: Math.min(last.low, quote.low ?? price, price),
        close: price,
        // Khối lượng luỹ kế chỉ tăng trong phiên, nhưng nến đã lưu có thể vừa được đồng bộ ở
        // một mốc muộn hơn gói tin đang giữ. Lấy số lớn hơn thì cột khối lượng không bao giờ
        // tụt xuống giữa phiên — một cột volume co lại đọc như dữ liệu hỏng.
        volume: Math.max(last.volume, quote.volume),
      },
    ];
  }

  if (last && last.trade_date > tradeDate) return candles;
  // Mã chưa khớp lệnh nào trong phiên: chưa có giá mở thì chưa có cây nến nào để vẽ.
  if (quote.open === null) return candles;

  return [
    ...candles,
    {
      // Cùng quy ước với nến ngày của máy chủ: neo ở nửa đêm **UTC** của ngày giao dịch.
      time: `${tradeDate}T00:00:00Z`,
      trade_date: tradeDate,
      open: quote.open,
      high: quote.high ?? price,
      low: quote.low ?? price,
      close: price,
      volume: quote.volume,
    },
  ];
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
