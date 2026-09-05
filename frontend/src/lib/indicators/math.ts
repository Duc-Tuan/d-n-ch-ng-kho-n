/**
 * Hàm toán dùng chung cho mọi chỉ báo.
 *
 * Quy ước: mọi hàm nhận mảng `Series` (có thể chứa `null` ở đầu khi chưa đủ dữ
 * liệu) và trả về mảng **cùng độ dài**, phần tử chưa tính được là `null`.
 * Nhờ vậy index luôn khớp 1-1 với index của nến, không cần offset thủ công.
 */
export type Series = (number | null)[];

export interface Candle {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const nulls = (n: number): Series => new Array<number | null>(n).fill(null);

/* ── Nguồn giá ──────────────────────────────────────────────────────────── */

export type PriceSource = 'open' | 'high' | 'low' | 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4';

export const PRICE_SOURCES: { value: PriceSource; label: string }[] = [
  { value: 'close', label: 'Close' },
  { value: 'open', label: 'Open' },
  { value: 'high', label: 'High' },
  { value: 'low', label: 'Low' },
  { value: 'hl2', label: 'HL2' },
  { value: 'hlc3', label: 'HLC3' },
  { value: 'ohlc4', label: 'OHLC4' },
  { value: 'hlcc4', label: 'HLCC4' },
];

export function source(candles: Candle[], src: PriceSource = 'close'): Series {
  return candles.map((c) => {
    switch (src) {
      case 'open':
        return c.open;
      case 'high':
        return c.high;
      case 'low':
        return c.low;
      case 'hl2':
        return (c.high + c.low) / 2;
      case 'hlc3':
        return (c.high + c.low + c.close) / 3;
      case 'ohlc4':
        return (c.open + c.high + c.low + c.close) / 4;
      case 'hlcc4':
        return (c.high + c.low + c.close * 2) / 4;
      default:
        return c.close;
    }
  });
}

/* ── Trung bình động ────────────────────────────────────────────────────── */

export function sma(src: Series, length: number): Series {
  const out = nulls(src.length);
  if (length <= 0) return out;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < src.length; i++) {
    const value = src[i];
    if (value === null) {
      // Gặp gap → reset cửa sổ, tránh trộn dữ liệu hai đoạn rời nhau.
      sum = 0;
      count = 0;
      continue;
    }
    sum += value;
    count++;
    if (count > length) {
      const drop = src[i - length];
      if (drop !== null) sum -= drop;
      count = length;
    }
    if (count === length) out[i] = sum / length;
  }
  return out;
}

export function ema(src: Series, length: number): Series {
  const out = nulls(src.length);
  if (length <= 0) return out;
  const k = 2 / (length + 1);
  // Seed bằng SMA của `length` giá trị đầu tiên hợp lệ — giống TradingView.
  const seed = sma(src, length);
  let prev: number | null = null;
  for (let i = 0; i < src.length; i++) {
    const value = src[i];
    if (value === null) continue;
    if (prev === null) {
      if (seed[i] === null) continue;
      prev = seed[i]!;
    } else {
      prev = value * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

/** Trung bình động Wilder (dùng trong RSI, ATR, ADX). alpha = 1/length. */
export function rma(src: Series, length: number): Series {
  const out = nulls(src.length);
  if (length <= 0) return out;
  const alpha = 1 / length;
  const seed = sma(src, length);
  let prev: number | null = null;
  for (let i = 0; i < src.length; i++) {
    const value = src[i];
    if (value === null) continue;
    if (prev === null) {
      if (seed[i] === null) continue;
      prev = seed[i]!;
    } else {
      prev = alpha * value + (1 - alpha) * prev;
    }
    out[i] = prev;
  }
  return out;
}

export function wma(src: Series, length: number): Series {
  const out = nulls(src.length);
  const denom = (length * (length + 1)) / 2;
  for (let i = length - 1; i < src.length; i++) {
    let sum = 0;
    let ok = true;
    for (let j = 0; j < length; j++) {
      const value = src[i - j];
      if (value === null) {
        ok = false;
        break;
      }
      sum += value * (length - j);
    }
    if (ok) out[i] = sum / denom;
  }
  return out;
}

/** Hull MA: WMA(2*WMA(n/2) − WMA(n), sqrt(n)) */
export function hma(src: Series, length: number): Series {
  const half = wma(src, Math.max(1, Math.floor(length / 2)));
  const full = wma(src, length);
  const diff = half.map((v, i) => (v === null || full[i] === null ? null : 2 * v - full[i]!));
  return wma(diff, Math.max(1, Math.round(Math.sqrt(length))));
}

/** Volume-weighted MA. */
export function vwma(src: Series, volume: Series, length: number): Series {
  const pv = src.map((v, i) => (v === null || volume[i] === null ? null : v * volume[i]!));
  const sumPv = sma(pv, length);
  const sumV = sma(volume, length);
  return sumPv.map((v, i) => (v === null || !sumV[i] ? null : v / sumV[i]!));
}

export type MaType = 'SMA' | 'EMA' | 'WMA' | 'RMA' | 'HMA';

export function movingAverage(src: Series, length: number, type: MaType): Series {
  switch (type) {
    case 'EMA':
      return ema(src, length);
    case 'WMA':
      return wma(src, length);
    case 'RMA':
      return rma(src, length);
    case 'HMA':
      return hma(src, length);
    default:
      return sma(src, length);
  }
}

/* ── Thống kê ───────────────────────────────────────────────────────────── */

/** Độ lệch chuẩn tổng thể (chia n) — đúng như `ta.stdev` của Pine. */
export function stdev(src: Series, length: number): Series {
  const out = nulls(src.length);
  const means = sma(src, length);
  for (let i = length - 1; i < src.length; i++) {
    const mean = means[i];
    if (mean === null) continue;
    let sumSq = 0;
    let ok = true;
    for (let j = 0; j < length; j++) {
      const value = src[i - j];
      if (value === null) {
        ok = false;
        break;
      }
      sumSq += (value - mean) ** 2;
    }
    if (ok) out[i] = Math.sqrt(sumSq / length);
  }
  return out;
}

export function highest(src: Series, length: number): Series {
  const out = nulls(src.length);
  for (let i = length - 1; i < src.length; i++) {
    let max = -Infinity;
    let ok = true;
    for (let j = 0; j < length; j++) {
      const value = src[i - j];
      if (value === null) {
        ok = false;
        break;
      }
      if (value > max) max = value;
    }
    if (ok) out[i] = max;
  }
  return out;
}

export function lowest(src: Series, length: number): Series {
  const out = nulls(src.length);
  for (let i = length - 1; i < src.length; i++) {
    let min = Infinity;
    let ok = true;
    for (let j = 0; j < length; j++) {
      const value = src[i - j];
      if (value === null) {
        ok = false;
        break;
      }
      if (value < min) min = value;
    }
    if (ok) out[i] = min;
  }
  return out;
}

/** src[i] − src[i−n] */
export function change(src: Series, n = 1): Series {
  return src.map((v, i) => {
    const prev = src[i - n];
    if (v === null || i - n < 0 || prev === null || prev === undefined) return null;
    return v - prev;
  });
}

export function cumulative(src: Series): Series {
  let sum = 0;
  return src.map((v) => {
    if (v === null) return null;
    sum += v;
    return sum;
  });
}

/* ── Biến động ──────────────────────────────────────────────────────────── */

export function trueRange(candles: Candle[]): Series {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function atr(candles: Candle[], length: number): Series {
  return rma(trueRange(candles), length);
}

/* ── Pivot (đỉnh/đáy cục bộ) ────────────────────────────────────────────── */

export interface Pivot {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/**
 * Đỉnh cục bộ: `high[i]` lớn nhất trong cửa sổ `left` nến trái + `right` nến phải.
 *
 * Chỉ xác nhận được sau `right` nến, nên `right` nến cuối cùng KHÔNG bao giờ
 * được coi là pivot — đó là lý do các chỉ báo dựa trên pivot (ZigZag, SMC) luôn
 * "vẽ lại" phần đuôi khi có nến mới.
 */
export function findPivots(candles: Candle[], left: number, right: number): Pivot[] {
  const pivots: Pivot[] = [];
  if (left < 1 || right < 1) return pivots;

  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      // Dùng `>=` phía trái và `>` phía phải để hai nến bằng nhau chỉ sinh một pivot.
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }

    if (isHigh) pivots.push({ index: i, price: candles[i].high, type: 'high' });
    if (isLow) pivots.push({ index: i, price: candles[i].low, type: 'low' });
  }

  return pivots.sort((a, b) => a.index - b.index);
}

/** Bước thời gian trung vị giữa hai nến — để kéo dài hộp sang phải. */
export function medianInterval(candles: Candle[]): number {
  if (candles.length < 2) return 60;
  const diffs: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 50); i++) {
    diffs.push(candles[i].time - candles[i - 1].time);
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 60;
}

/** Chuyển Series → mảng {time, value} cho lightweight-charts (bỏ null). */
export function toLineData(candles: Candle[], series: Series) {
  const data: { time: number; value: number }[] = [];
  for (let i = 0; i < series.length; i++) {
    const value = series[i];
    if (value === null || !Number.isFinite(value)) continue;
    data.push({ time: candles[i].time, value });
  }
  return data;
}
