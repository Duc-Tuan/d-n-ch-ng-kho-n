/**
 * Lõi tính toán của bộ chỉ báo tổng hợp **Quantum Multi-Engine**.
 *
 * Một hàm `analyze()` trả về **toàn bộ** trạng thái, và cả hai mục trong danh mục chỉ báo (lớp
 * vẽ đè và cửa sổ Resonance) đều đọc từ đúng kết quả đó. Tính hai lần ở hai chỗ là cách chắc
 * chắn nhất để bảng dashboard nói "Bullish" trong khi cửa sổ bên dưới vẽ đường đi xuống — sai
 * kiểu đó không bao giờ báo lỗi, chỉ làm người đọc mất niềm tin vào cả hai.
 *
 * > **"Quantum AI" không có AI nào bên trong.** Đó là tên thương mại của chỉ báo gốc trên
 * > TradingView; toàn bộ ở đây là công thức tất định. Hệ thống có một nút *AI phân tích* gọi mô
 * > hình ngôn ngữ thật ở chỗ khác — để trùng chữ "AI" sẽ khiến khách hiểu nhầm hai thứ là một,
 * > nên tên hiển thị bỏ hẳn chữ đó.
 *
 * Thiết kế gốc chạy trên nến 5 phút của một sản phẩm ngoại hối. Chuyển sang cổ phiếu Việt Nam
 * thì **số tín hiệu ít hơn hàng chục lần** và "2 Bars Ago" mang nghĩa khác hẳn, nên tham số mặc
 * định ở đây được đặt lại theo thang nến ngày chứ không bê nguyên con số trong ảnh.
 */
import {
  atr,
  ema,
  medianInterval,
  type Candle,
  type Series,
} from '@/lib/indicators/math';

/* ══════════════════════════════════════════════════════════════════════════
   Khung thời gian
   ══════════════════════════════════════════════════════════════════════════ */

/** Thang khung thời gian, khớp `app/services/market_data/timeframes.py` của backend. */
const LADDER: { seconds: number; label: string }[] = [
  { seconds: 60, label: '1m' },
  { seconds: 180, label: '3m' },
  { seconds: 300, label: '5m' },
  { seconds: 900, label: '15m' },
  { seconds: 1800, label: '30m' },
  { seconds: 3600, label: '1h' },
  { seconds: 7200, label: '2h' },
  { seconds: 14400, label: '4h' },
  { seconds: 86400, label: '1D' },
  { seconds: 604800, label: '1W' },
  { seconds: 2592000, label: '1M' },
];

/**
 * Các bậc **ưu tiên** cho bảng đa khung, tính bằng số bước trên thang kể từ khung đang xem.
 *
 * `[0, 1, 3, 5, 6]` không phải con số tuỳ tiện: đứng ở 5 phút nó cho ra đúng bộ 5m · 15m · 1h ·
 * 4h · 1D của thiết kế gốc. Nhảy đều từng bậc (0,1,2,3,4) sẽ ra 5m·15m·30m·1h·2h — năm khung
 * gần nhau tới mức luôn cùng chiều, và một bảng lúc nào cũng năm dòng giống hệt nhau thì không
 * nói thêm được gì so với một dòng.
 *
 * Nhưng đứng ở nến ngày thì bộ này chỉ với tới 1D và 1W: bậc 3 đã vượt khỏi thang. Vì vậy
 * `mtfMatrix` lấy bộ ưu tiên trước, rồi **vét nốt các bậc còn lại** cho đủ `MTF_ROWS` dòng. Nếu
 * không, người dùng khung ngày — tức gần như toàn bộ người dùng của hệ thống này — chỉ thấy hai
 * dòng ở đúng cái bảng mà thiết kế dựng để so năm khung.
 */
const MTF_STEPS = [0, 1, 3, 5, 6];

/** Số dòng bảng nhắm tới, đúng bằng số dòng trong thiết kế gốc. */
const MTF_ROWS = 5;

/** Khung đang xem, suy ra từ khoảng cách giữa các nến.
 *
 *  Khung chỉ báo (`compute(candles, params)`) không nhận mã khung, và đó là điều đúng: chỉ báo
 *  phải chạy được trên bất kỳ chuỗi nến nào. Nên khung được đọc từ chính dữ liệu.
 */
export function timeframeOf(candles: Candle[]): { seconds: number; label: string; index: number } {
  const step = medianInterval(candles);
  let index = 0;
  let best = Infinity;
  for (let i = 0; i < LADDER.length; i++) {
    const distance = Math.abs(Math.log(LADDER[i].seconds / Math.max(1, step)));
    if (distance < best) {
      best = distance;
      index = i;
    }
  }
  return { ...LADDER[index], index };
}

/**
 * Mốc mở ô chứa `time` ở khung `seconds`.
 *
 * Nến đã được cộng lệch múi giờ trước khi tới đây (xem `toIndicatorCandles`), nên chia lấy
 * nguyên theo UTC chính là chia theo **nửa đêm giờ Việt Nam** — đúng cách backend gộp nến, nên
 * nến tuần ở bảng MTF trùng khít nến tuần vẽ trên biểu đồ.
 */
export function bucketOf(time: number, seconds: number): number {
  if (seconds >= 2592000) {
    const d = new Date(time * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
  }
  if (seconds >= 604800) {
    // Mốc 0 của Unix là thứ Năm; cộng 3 ngày để ô tuần bắt đầu vào thứ Hai.
    const shifted = time + 3 * 86400;
    return Math.floor(shifted / 604800) * 604800 - 3 * 86400;
  }
  return Math.floor(time / seconds) * seconds;
}

/** Gộp nến lên khung lớn hơn theo **mốc thời gian**, không theo số lượng.
 *
 *  Gộp theo số lượng (cứ 12 nến 5 phút thành một nến 1 giờ) sai ngay từ phiên đầu tiên: một
 *  phiên của thị trường Việt Nam chỉ có 4 giờ 45 phút, nên đếm đủ 12 nến sẽ vắt qua giờ nghỉ
 *  trưa rồi vắt sang cả ngày hôm sau.
 */
export function groupByBucket(candles: Candle[], seconds: number): Candle[] {
  if (!candles.length) return [];

  const out: Candle[] = [];
  let current: Candle | null = null;
  let bucket = NaN;

  for (const candle of candles) {
    const key = bucketOf(candle.time, seconds);
    if (!current || key !== bucket) {
      if (current) out.push(current);
      bucket = key;
      current = { ...candle, time: key };
      continue;
    }
    current.high = Math.max(current.high, candle.high);
    current.low = Math.min(current.low, candle.low);
    current.close = candle.close;
    current.volume += candle.volume;
  }
  if (current) out.push(current);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════
   Hai máy chấm điểm độc lập
   ══════════════════════════════════════════════════════════════════════════ */

export type Direction = 'BULL' | 'BEAR';
export type Strength = 'Weak' | 'Medium' | 'Strong';

const last = (series: Series): number | null => {
  for (let i = series.length - 1; i >= 0; i--) {
    const v = series[i];
    if (v !== null && Number.isFinite(v)) return v;
  }
  return null;
};

/** Xếp hạng cường độ. Ngưỡng theo thang nến ngày, không theo con số trong ảnh gốc. */
export function strengthOf(score: number): Strength {
  if (score >= 35) return 'Strong';
  if (score >= 20) return 'Medium';
  return 'Weak';
}

/**
 * Máy 1 — **động lượng**. Trả về điểm 0–100 và chiều.
 *
 * Chênh lệch hai đường trung bình, chuẩn hoá theo ATR để một mã giá 7.000đ và một mã giá
 * 120.000đ cho ra cùng thang điểm. Không chuẩn hoá thì mọi ngưỡng đều phải đặt riêng cho từng
 * mã, và bảng MTF hết so sánh được giữa các mã.
 */
export function momentumEngine(
  candles: Candle[],
  fastLength: number,
  slowLength: number,
): { score: number; direction: Direction; strength: Strength; fast: Series; slow: Series } {
  const close = candles.map((c) => c.close);
  const fast = ema(close, fastLength);
  const slow = ema(close, slowLength);
  const range = atr(candles, Math.max(2, slowLength));

  const f = last(fast);
  const s = last(slow);
  const r = last(range);

  if (f === null || s === null || !r) {
    return { score: 0, direction: 'BULL', strength: 'Weak', fast, slow };
  }

  const spread = (f - s) / r;
  // `tanh` ép về (−1, 1) một cách trơn tru: cắt cứng ở ±1 sẽ làm mọi trạng thái mạnh trông
  // giống hệt nhau, còn chia tuyến tính thì một phiên biến động lớn đẩy điểm vọt lên 100.
  const score = Math.round(Math.abs(Math.tanh(spread)) * 1000) / 10;

  return {
    score,
    direction: spread >= 0 ? 'BULL' : 'BEAR',
    strength: strengthOf(score),
    fast,
    slow,
  };
}

/**
 * Máy 2 — **phân bổ khối lượng**. Bên mua hay bên bán đang dẫn, và dẫn bao nhiêu.
 *
 * Khối lượng của nến tăng tính cho bên mua, nến giảm tính cho bên bán. Nến đứng giá chia đôi —
 * bỏ hẳn nó đi thì những mã ít thanh khoản (rất nhiều phiên tham chiếu) cho ra tỉ lệ dựng trên
 * một nhúm phiên, và con số nhảy loạn mỗi lần thêm một nến.
 */
export function volumeEngine(
  candles: Candle[],
  lookback: number,
): { bullPct: number; bearPct: number; direction: Direction } {
  const window = candles.slice(-Math.max(2, lookback));

  let bull = 0;
  let bear = 0;
  for (const candle of window) {
    const volume = Math.max(0, candle.volume);
    if (candle.close > candle.open) bull += volume;
    else if (candle.close < candle.open) bear += volume;
    else {
      bull += volume / 2;
      bear += volume / 2;
    }
  }

  const total = bull + bear;
  if (!total) return { bullPct: 50, bearPct: 50, direction: 'BULL' };

  const bullPct = Math.round((bull / total) * 1000) / 10;
  return {
    bullPct,
    bearPct: Math.round((100 - bullPct) * 10) / 10,
    direction: bullPct >= 50 ? 'BULL' : 'BEAR',
  };
}

/** Chiều xu hướng theo hai đường trung bình. */
export function trendOf(candles: Candle[], fastLength: number, slowLength: number): Direction {
  const close = candles.map((c) => c.close);
  const f = last(ema(close, fastLength));
  const s = last(ema(close, slowLength));
  if (f === null || s === null) return 'BULL';
  return f >= s ? 'BULL' : 'BEAR';
}

/**
 * Thị trường đang có xu hướng hay đi ngang, đo bằng **hệ số hiệu quả** của Kaufman.
 *
 * Quãng đường thẳng chia cho tổng quãng đường đã đi. Đi thẳng một mạch cho tỉ số gần 1; lên
 * xuống loanh quanh rồi về chỗ cũ cho tỉ số gần 0. Chọn cách này thay vì ADX vì nó đọc được
 * bằng một câu và không cần thêm ba đường trung bình trung gian.
 */
export function marketType(candles: Candle[], lookback: number): 'Trending' | 'Ranging' {
  const window = candles.slice(-Math.max(3, lookback));
  if (window.length < 3) return 'Ranging';

  const net = Math.abs(window[window.length - 1].close - window[0].close);
  let path = 0;
  for (let i = 1; i < window.length; i++) {
    path += Math.abs(window[i].close - window[i - 1].close);
  }
  if (!path) return 'Ranging';
  return net / path >= 0.3 ? 'Trending' : 'Ranging';
}

/* ══════════════════════════════════════════════════════════════════════════
   Bảng đa khung
   ══════════════════════════════════════════════════════════════════════════ */

export interface MtfRow {
  /** Nhãn khung: `5m`, `1D` — dùng nguyên, không dịch. */
  label: string;
  trend: Direction;
  momentum: number;
  strength: Strength;
}

/**
 * Bảng đa khung: khung đang xem cộng các bậc cao hơn, nhắm tới năm dòng.
 *
 * Bậc nào vượt quá thang (đang xem nến tháng thì không còn gì cao hơn) sẽ bị bỏ, nên bảng ngắn
 * đi chứ không bịa ra một khung không tồn tại.
 */
export function mtfMatrix(
  candles: Candle[],
  fastLength: number,
  slowLength: number,
): MtfRow[] {
  const current = timeframeOf(candles);
  const reach = LADDER.length - 1 - current.index;

  // Bậc ưu tiên trước, rồi vét các bậc còn lại theo thứ tự gần → xa cho đủ số dòng.
  const steps: number[] = [];
  for (const step of MTF_STEPS) {
    if (step <= reach) steps.push(step);
  }
  for (let step = 0; step <= reach && steps.length < MTF_ROWS; step++) {
    if (!steps.includes(step)) steps.push(step);
  }
  steps.sort((a, b) => a - b);

  const rows: MtfRow[] = [];
  for (const step of steps) {
    if (rows.length >= MTF_ROWS) break;
    const target = LADDER[current.index + step];

    const grouped = step === 0 ? candles : groupByBucket(candles, target.seconds);
    // Ô chưa đủ nến để tính thì bỏ — thà bảng ba dòng đúng còn hơn năm dòng trong đó hai dòng
    // dựng trên ba cây nến.
    if (grouped.length < slowLength + 1) continue;

    const engine = momentumEngine(grouped, fastLength, slowLength);
    rows.push({
      label: target.label,
      trend: trendOf(grouped, fastLength, slowLength),
      momentum: engine.score,
      strength: engine.strength,
    });
  }

  return rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   Cộng hưởng
   ══════════════════════════════════════════════════════════════════════════ */

export interface Resonance {
  direction: Direction | null;
  /** Cả hai máy cùng chiều **và** đủ mạnh. */
  high: boolean;
}

/**
 * Ý tưởng trung tâm của cả chỉ báo: hai máy chấm điểm **độc lập** cùng chỉ một chiều.
 *
 * Lệch chiều thì không kết luận gì — bảng ghi "Chờ tín hiệu". Đây là chỗ chỉ báo này khác một bộ
 * đèn tín hiệu thông thường: nó có quyền nói "chưa biết", và phần lớn thời gian nó nói vậy.
 */
export function resonanceOf(
  momentum: { direction: Direction; score: number },
  volume: { direction: Direction; bullPct: number },
  minScore: number,
): Resonance {
  if (momentum.direction !== volume.direction) {
    return { direction: null, high: false };
  }

  const lead = Math.abs(volume.bullPct - 50) * 2;
  const high = momentum.score >= minScore && lead >= minScore;

  return { direction: momentum.direction, high };
}
