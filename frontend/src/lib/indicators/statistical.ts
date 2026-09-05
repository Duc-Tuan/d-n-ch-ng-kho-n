import { source, sma, type Candle, type Series } from '@/lib/indicators/math';
import { INDICATOR_COLORS as C, SOURCE_PARAM } from '@/lib/indicators/overlays';
import { num, src, type IndicatorDef, type IndicatorShapes } from '@/lib/indicators/types';

/** Mẫu số dưới ngưỡng này thì phép chia vô nghĩa (chuỗi phẳng hoặc PnL sát 0). */
const EPSILON = 1e-9;

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/**
 * Chạy `fn` trên mọi cửa sổ trượt độ dài `length`, bỏ qua cửa sổ có `null`.
 * Trả `null` cho các vị trí chưa đủ dữ liệu — lightweight-charts tự bỏ trống.
 */
function rolling(values: Series, length: number, fn: (window: number[]) => number | null): Series {
  return values.map((_, i) => {
    if (i + 1 < length) return null;
    const window = values.slice(i + 1 - length, i + 1);
    if (window.some((v) => v === null)) return null;
    return fn(window as number[]);
  });
}

/* ── SLOPE — hệ số góc hồi quy tuyến tính ───────────────────────────────── */

/**
 * OLS trên cửa sổ, x = 0…n−1:  slope = Σ(xi − x̄)(yi − ȳ) / Σ(xi − x̄)²
 *
 * Cùng công thức với `lib/stats.ts` (panel phải), nhưng tính cho **mọi** nến
 * thay vì chỉ nến cuối. Đơn vị: đơn vị giá trên mỗi nến; dương = đang tăng.
 */
export function slopeSeries(values: Series, length: number): Series {
  const xMean = (length - 1) / 2;
  // Σ(xi − x̄)² chỉ phụ thuộc `length` → tính một lần.
  let denominator = 0;
  for (let i = 0; i < length; i++) denominator += (i - xMean) ** 2;

  return rolling(values, length, (window) => {
    if (denominator < EPSILON) return null;
    const yMean = mean(window);
    let numerator = 0;
    for (let i = 0; i < length; i++) numerator += (i - xMean) * (window[i] - yMean);
    return numerator / denominator;
  });
}

const slope: IndicatorDef = {
  id: 'slope',
  name: 'Linear Regression Slope',
  short: 'SLOPE',
  category: 'trend',
  placement: 'pane',
  precision: 4,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 2 }, SOURCE_PARAM],
  plots: [{ key: 'slope', label: 'Slope', type: 'line', color: C.blue, lineWidth: 2 }],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => ({ slope: slopeSeries(source(candles, src(p)), num(p, 'length')) }),
};

/* ── Z-SCORE ────────────────────────────────────────────────────────────── */

/**
 * Zt = (Pt − μn) / σn, với σ là độ lệch chuẩn population (chia n).
 * σ ≈ 0 (chuỗi đứng yên cả cửa sổ) → `null`, không phải ±∞.
 */
export function zScoreSeries(values: Series, length: number): Series {
  return rolling(values, length, (window) => {
    const avg = mean(window);
    const sigma = Math.sqrt(window.reduce((sum, v) => sum + (v - avg) ** 2, 0) / length);
    if (sigma < EPSILON) return null;
    return (window[length - 1] - avg) / sigma;
  });
}

const zScore: IndicatorDef = {
  id: 'zscore',
  name: 'Z-Score',
  short: 'Z',
  category: 'momentum',
  placement: 'pane',
  precision: 2,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 2 }, SOURCE_PARAM],
  plots: [{ key: 'zscore', label: 'Z-Score', type: 'line', color: C.purple, lineWidth: 2 }],
  // ±2σ ≈ 95% mẫu nếu phân phối chuẩn — ngưỡng quá mua/quá bán quy ước.
  levels: [
    { value: 2, color: C.red, lineStyle: 'dashed', label: '+2σ' },
    { value: 0, color: C.gray, lineStyle: 'dotted' },
    { value: -2, color: C.green, lineStyle: 'dashed', label: '−2σ' },
  ],
  compute: (candles, p) => ({ zscore: zScoreSeries(source(candles, src(p)), num(p, 'length')) }),
};

/* ── ADR — Average Daily Range ──────────────────────────────────────────── */

/**
 * Trung bình biên độ (high − low) của `length` nến gần nhất.
 *
 * Tên gọi "Daily" là quy ước: ADR cổ điển đo trên nến ngày. Ở đây nó tính trên
 * **khung đang xem**, nên xem chart H1 thì đây là biên độ trung bình mỗi giờ.
 */
const adr: IndicatorDef = {
  id: 'adr',
  name: 'Average Daily Range',
  short: 'ADR',
  category: 'volatility',
  placement: 'pane',
  precision: 5,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 }],
  plots: [
    { key: 'adr', label: 'ADR', type: 'line', color: C.orange, lineWidth: 2 },
    { key: 'range', label: 'Biên độ nến', type: 'histogram', color: C.gray, hidden: true },
  ],
  compute: (candles, p) => {
    const range: Series = candles.map((c) => c.high - c.low);
    return { adr: sma(range, num(p, 'length')), range };
  },
};

/* ── Volume Profile — khối lượng giao dịch theo giá ─────────────────────── */

const VP_MAX_WIDTH_RATIO = 0.28; // thanh dài nhất chiếm ~28% bề ngang chart

/**
 * Chia dải giá thành `bins` khoảng đều nhau, cộng dồn khối lượng của mọi nến
 * chạm vào từng khoảng, rồi vẽ thành histogram **ngang** neo ở mép trái.
 *
 * Phân bổ khối lượng của một nến đều cho các bin mà nó phủ (từ `low` tới
 * `high`) — xấp xỉ thô nhưng không cần dữ liệu tick, thứ mà `/symbols` không có.
 */
function volumeProfileShapes(candles: Candle[], bins: number, valueArea: number): IndicatorShapes {
  if (candles.length < 2) return {};

  const min = Math.min(...candles.map((c) => c.low));
  const max = Math.max(...candles.map((c) => c.high));
  const span = max - min;
  if (span < EPSILON) return {};

  const binSize = span / bins;
  const volumes = new Array<number>(bins).fill(0);

  for (const candle of candles) {
    const from = Math.max(0, Math.floor((candle.low - min) / binSize));
    const to = Math.min(bins - 1, Math.floor((candle.high - min) / binSize));
    const touched = to - from + 1;
    const share = (candle.volume || 0) / touched;
    for (let i = from; i <= to; i++) volumes[i] += share;
  }

  const maxVolume = Math.max(...volumes);
  if (maxVolume < EPSILON) return {};

  const firstTime = candles[0].time;
  const lastTime = candles[candles.length - 1].time;
  const timeSpan = lastTime - firstTime;

  // Point of Control: bin có khối lượng lớn nhất.
  const poc = volumes.indexOf(maxVolume);

  /**
   * Value Area: mở rộng từ POC sang hai bên, mỗi bước lấy phía có khối lượng
   * lớn hơn, cho tới khi gom đủ `valueArea`% tổng khối lượng.
   */
  const target = (volumes.reduce((sum, v) => sum + v, 0) * valueArea) / 100;
  let lower = poc;
  let upper = poc;
  let accumulated = volumes[poc];
  while (accumulated < target && (lower > 0 || upper < bins - 1)) {
    const below = lower > 0 ? volumes[lower - 1] : -1;
    const above = upper < bins - 1 ? volumes[upper + 1] : -1;
    if (above >= below) accumulated += volumes[++upper];
    else accumulated += volumes[--lower];
  }

  const boxes = volumes.map((volume, i) => {
    const inValueArea = i >= lower && i <= upper;
    const width = (volume / maxVolume) * VP_MAX_WIDTH_RATIO * timeSpan;
    return {
      from: { time: firstTime, price: min + i * binSize },
      to: { time: firstTime + width, price: min + (i + 1) * binSize },
      // POC nổi bật nhất, rồi tới value area, ngoài vùng thì mờ.
      fill: i === poc ? `${C.orange}B3` : inValueArea ? `${C.blue}66` : `${C.gray}33`,
    };
  });

  return {
    boxes,
    lines: [
      {
        from: { time: firstTime, price: min + (poc + 0.5) * binSize },
        to: { time: lastTime, price: min + (poc + 0.5) * binSize },
        color: C.orange,
        lineStyle: 'dashed',
        label: 'POC',
      },
    ],
  };
}

const volumeProfile: IndicatorDef = {
  id: 'volume_profile',
  name: 'Khối lượng giao dịch theo giá',
  short: 'VP',
  category: 'volume',
  placement: 'overlay',
  params: [
    { key: 'bins', label: 'Số khoảng giá', type: 'number', default: 24, min: 4, max: 100 },
    { key: 'valueArea', label: 'Value Area (%)', type: 'number', default: 70, min: 30, max: 100 },
  ],
  labelParams: ['bins'],
  // Không có series nào: chỉ báo này vẽ hoàn toàn bằng hộp trên canvas phủ.
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => volumeProfileShapes(candles, num(p, 'bins'), num(p, 'valueArea')),
};

export const STATISTICAL_INDICATORS: IndicatorDef[] = [slope, zScore, adr, volumeProfile];
