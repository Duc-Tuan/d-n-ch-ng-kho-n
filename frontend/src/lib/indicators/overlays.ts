import {
  atr,
  ema,
  highest,
  lowest,
  movingAverage,
  source,
  stdev,
  type Candle,
  type MaType,
  type Series,
} from '@/lib/indicators/math';
import { bool, num, src, str, type IndicatorDef } from '@/lib/indicators/types';

const C = {
  blue: '#2962FF',
  orange: '#FF9800',
  green: '#26A69A',
  red: '#EF5350',
  purple: '#7E57C2',
  cyan: '#00BCD4',
  yellow: '#FFEB3B',
  gray: '#787B86',
  pink: '#E040FB',
};

const SOURCE_PARAM = { key: 'source', label: 'Nguồn giá', type: 'source', default: 'close' } as const;

const MA_TYPE_OPTIONS = [
  { value: 'SMA', label: 'SMA' },
  { value: 'EMA', label: 'EMA' },
  { value: 'WMA', label: 'WMA' },
  { value: 'RMA', label: 'RMA (Wilder)' },
  { value: 'HMA', label: 'HMA' },
];

/* ── Moving Average ─────────────────────────────────────────────────────── */

const maIndicator: IndicatorDef = {
  id: 'ma',
  name: 'Moving Average',
  short: 'MA',
  category: 'trend',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1, max: 1000 },
    { key: 'type', label: 'Loại MA', type: 'select', default: 'SMA', options: MA_TYPE_OPTIONS },
    SOURCE_PARAM,
    { key: 'offset', label: 'Dịch (nến)', type: 'number', default: 0, min: -500, max: 500 },
  ],
  plots: [{ key: 'ma', label: 'MA', type: 'line', color: C.blue, lineWidth: 2 }],
  compute: (candles, p) => {
    const values = movingAverage(source(candles, src(p)), num(p, 'length'), str(p, 'type') as MaType);
    return { ma: shift(values, num(p, 'offset')) };
  },
};

/** Dịch series sang phải (offset > 0) hoặc trái, giữ nguyên độ dài. */
function shift(series: Series, offset: number): Series {
  if (!offset) return series;
  const out: Series = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    const target = i + offset;
    if (target >= 0 && target < series.length) out[target] = series[i];
  }
  return out;
}

/* ── Bollinger Bands ────────────────────────────────────────────────────── */

const bollingerBands: IndicatorDef = {
  id: 'bb',
  name: 'Bollinger Bands',
  short: 'BB',
  category: 'volatility',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 },
    { key: 'mult', label: 'Độ lệch chuẩn', type: 'number', default: 2, min: 0.1, step: 0.1 },
    { key: 'type', label: 'Loại MA', type: 'select', default: 'SMA', options: MA_TYPE_OPTIONS },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'upper', label: 'Dải trên', type: 'line', color: C.blue, lineWidth: 1 },
    { key: 'basis', label: 'Đường giữa', type: 'line', color: C.orange, lineWidth: 1 },
    { key: 'lower', label: 'Dải dưới', type: 'line', color: C.blue, lineWidth: 1 },
  ],
  compute: (candles, p) => {
    const values = source(candles, src(p));
    const length = num(p, 'length');
    const mult = num(p, 'mult');
    const basis = movingAverage(values, length, str(p, 'type') as MaType);
    const dev = stdev(values, length);
    return {
      basis,
      upper: basis.map((v, i) => (v === null || dev[i] === null ? null : v + mult * dev[i]!)),
      lower: basis.map((v, i) => (v === null || dev[i] === null ? null : v - mult * dev[i]!)),
    };
  },
};

/* ── Keltner Channels ───────────────────────────────────────────────────── */

const keltnerChannels: IndicatorDef = {
  id: 'keltner',
  name: 'Keltner Channels',
  short: 'KC',
  category: 'volatility',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 },
    { key: 'mult', label: 'Hệ số ATR', type: 'number', default: 2, min: 0.1, step: 0.1 },
    { key: 'atrLength', label: 'Chu kỳ ATR', type: 'number', default: 10, min: 1 },
  ],
  plots: [
    { key: 'upper', label: 'Dải trên', type: 'line', color: C.cyan, lineWidth: 1 },
    { key: 'basis', label: 'Đường giữa', type: 'line', color: C.cyan, lineWidth: 2 },
    { key: 'lower', label: 'Dải dưới', type: 'line', color: C.cyan, lineWidth: 1 },
  ],
  compute: (candles, p) => {
    const basis = ema(source(candles, 'close'), num(p, 'length'));
    const range = atr(candles, num(p, 'atrLength'));
    const mult = num(p, 'mult');
    return {
      basis,
      upper: basis.map((v, i) => (v === null || range[i] === null ? null : v + mult * range[i]!)),
      lower: basis.map((v, i) => (v === null || range[i] === null ? null : v - mult * range[i]!)),
    };
  },
};

/* ── Donchian Channels ──────────────────────────────────────────────────── */

const donchianChannels: IndicatorDef = {
  id: 'donchian',
  name: 'Donchian Channels',
  short: 'DC',
  category: 'volatility',
  placement: 'overlay',
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 }],
  plots: [
    { key: 'upper', label: 'Đỉnh', type: 'line', color: C.blue, lineWidth: 1 },
    { key: 'basis', label: 'Giữa', type: 'line', color: C.orange, lineWidth: 1 },
    { key: 'lower', label: 'Đáy', type: 'line', color: C.blue, lineWidth: 1 },
  ],
  compute: (candles, p) => {
    const length = num(p, 'length');
    const upper = highest(candles.map((c) => c.high), length);
    const lower = lowest(candles.map((c) => c.low), length);
    return {
      upper,
      lower,
      basis: upper.map((v, i) => (v === null || lower[i] === null ? null : (v + lower[i]!) / 2)),
    };
  },
};

/* ── Envelope ───────────────────────────────────────────────────────────── */

const envelope: IndicatorDef = {
  id: 'envelope',
  name: 'Envelope',
  short: 'ENV',
  category: 'volatility',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 },
    { key: 'percent', label: 'Biên độ (%)', type: 'number', default: 10, min: 0.1, step: 0.1 },
    { key: 'type', label: 'Loại MA', type: 'select', default: 'SMA', options: MA_TYPE_OPTIONS },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'upper', label: 'Trên', type: 'line', color: C.green, lineWidth: 1 },
    { key: 'basis', label: 'Giữa', type: 'line', color: C.gray, lineWidth: 1 },
    { key: 'lower', label: 'Dưới', type: 'line', color: C.red, lineWidth: 1 },
  ],
  compute: (candles, p) => {
    const basis = movingAverage(source(candles, src(p)), num(p, 'length'), str(p, 'type') as MaType);
    const k = num(p, 'percent') / 100;
    return {
      basis,
      upper: basis.map((v) => (v === null ? null : v * (1 + k))),
      lower: basis.map((v) => (v === null ? null : v * (1 - k))),
    };
  },
};

/* ── Ichimoku Cloud ─────────────────────────────────────────────────────── */

const ichimoku: IndicatorDef = {
  id: 'ichimoku',
  name: 'Ichimoku Cloud',
  short: 'Ichimoku',
  category: 'trend',
  placement: 'overlay',
  params: [
    { key: 'conversion', label: 'Tenkan-sen', type: 'number', default: 9, min: 1 },
    { key: 'base', label: 'Kijun-sen', type: 'number', default: 26, min: 1 },
    { key: 'spanB', label: 'Senkou Span B', type: 'number', default: 52, min: 1 },
    { key: 'displacement', label: 'Dịch chuyển', type: 'number', default: 26, min: 0 },
  ],
  plots: [
    { key: 'conversion', label: 'Tenkan', type: 'line', color: C.blue, lineWidth: 1 },
    { key: 'base', label: 'Kijun', type: 'line', color: C.red, lineWidth: 1 },
    { key: 'spanA', label: 'Senkou A', type: 'line', color: C.green, lineWidth: 1 },
    { key: 'spanB', label: 'Senkou B', type: 'line', color: C.red, lineWidth: 1 },
    { key: 'lagging', label: 'Chikou', type: 'line', color: C.purple, lineWidth: 1 },
  ],
  compute: (candles, p) => {
    const displacement = num(p, 'displacement');
    const conversion = donchianMid(candles, num(p, 'conversion'));
    const base = donchianMid(candles, num(p, 'base'));
    const spanB = donchianMid(candles, num(p, 'spanB'));
    const spanA = conversion.map((v, i) => (v === null || base[i] === null ? null : (v + base[i]!) / 2));
    const closes = candles.map((c) => c.close);

    return {
      conversion,
      base,
      // Hai span đẩy về tương lai; phần vượt quá nến cuối bị cắt bỏ vì
      // lightweight-charts không vẽ được ngoài vùng dữ liệu.
      spanA: shift(spanA, displacement),
      spanB: shift(spanB, displacement),
      lagging: shift(closes, -displacement),
    };
  },
};

/** (highest(high, n) + lowest(low, n)) / 2 — "donchian" theo cách gọi của Pine. */
function donchianMid(candles: Candle[], length: number): Series {
  const hi = highest(candles.map((c) => c.high), length);
  const lo = lowest(candles.map((c) => c.low), length);
  return hi.map((v, i) => (v === null || lo[i] === null ? null : (v + lo[i]!) / 2));
}

/* ── Parabolic SAR ──────────────────────────────────────────────────────── */

const parabolicSar: IndicatorDef = {
  id: 'psar',
  name: 'Parabolic SAR',
  short: 'PSAR',
  category: 'trend',
  placement: 'overlay',
  params: [
    { key: 'start', label: 'Bắt đầu', type: 'number', default: 0.02, min: 0.001, step: 0.001 },
    { key: 'increment', label: 'Gia số', type: 'number', default: 0.02, min: 0.001, step: 0.001 },
    { key: 'max', label: 'Tối đa', type: 'number', default: 0.2, min: 0.01, step: 0.01 },
  ],
  plots: [{ key: 'psar', label: 'SAR', type: 'line', color: C.blue, lineWidth: 1, lineStyle: 'dotted' }],
  compute: (candles, p) => {
    const out: Series = new Array(candles.length).fill(null);
    if (candles.length < 2) return { psar: out };

    const start = num(p, 'start');
    const increment = num(p, 'increment');
    const maxAf = num(p, 'max');

    let isLong = candles[1].close >= candles[0].close;
    let af = start;
    let ep = isLong ? candles[0].high : candles[0].low;
    let sar = isLong ? candles[0].low : candles[0].high;

    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      sar = sar + af * (ep - sar);

      if (isLong) {
        // SAR không được vượt lên trên đáy của 2 nến gần nhất.
        sar = Math.min(sar, prev.low, candles[i - 2]?.low ?? prev.low);
        if (c.low < sar) {
          isLong = false;
          sar = ep;
          ep = c.low;
          af = start;
        } else if (c.high > ep) {
          ep = c.high;
          af = Math.min(af + increment, maxAf);
        }
      } else {
        sar = Math.max(sar, prev.high, candles[i - 2]?.high ?? prev.high);
        if (c.high > sar) {
          isLong = true;
          sar = ep;
          ep = c.high;
          af = start;
        } else if (c.low < ep) {
          ep = c.low;
          af = Math.min(af + increment, maxAf);
        }
      }
      out[i] = sar;
    }
    return { psar: out };
  },
};

/* ── SuperTrend ─────────────────────────────────────────────────────────── */

const superTrend: IndicatorDef = {
  id: 'supertrend',
  name: 'SuperTrend',
  short: 'ST',
  category: 'trend',
  placement: 'overlay',
  params: [
    { key: 'length', label: 'Chu kỳ ATR', type: 'number', default: 10, min: 1 },
    { key: 'factor', label: 'Hệ số', type: 'number', default: 3, min: 0.1, step: 0.1 },
  ],
  plots: [
    { key: 'up', label: 'Tăng', type: 'line', color: C.green, lineWidth: 2 },
    { key: 'down', label: 'Giảm', type: 'line', color: C.red, lineWidth: 2 },
  ],
  compute: (candles, p) => {
    const factor = num(p, 'factor');
    const range = atr(candles, num(p, 'length'));
    const up: Series = new Array(candles.length).fill(null);
    const down: Series = new Array(candles.length).fill(null);

    let finalUpper: number | null = null;
    let finalLower: number | null = null;
    let trendUp = true;

    for (let i = 0; i < candles.length; i++) {
      if (range[i] === null) continue;
      const c = candles[i];
      const mid = (c.high + c.low) / 2;
      const rawUpper = mid + factor * range[i]!;
      const rawLower = mid - factor * range[i]!;

      if (finalUpper === null || finalLower === null) {
        // Nến đầu tiên có ATR: khởi tạo band, mặc định coi là xu hướng tăng.
        finalUpper = rawUpper;
        finalLower = rawLower;
        trendUp = true;
      } else {
        const prevClose = candles[i - 1].close;
        // Band chỉ siết vào; chỉ nới ra khi nến trước đã phá vỡ band cũ.
        finalUpper = rawUpper < finalUpper || prevClose > finalUpper ? rawUpper : finalUpper;
        finalLower = rawLower > finalLower || prevClose < finalLower ? rawLower : finalLower;
        trendUp = trendUp ? c.close >= finalLower : c.close > finalUpper;
      }

      if (trendUp) up[i] = finalLower;
      else down[i] = finalUpper;
    }
    return { up, down };
  },
};

/* ── VWAP (reset theo phiên ngày) ───────────────────────────────────────── */

const vwap: IndicatorDef = {
  id: 'vwap',
  name: 'VWAP',
  short: 'VWAP',
  category: 'volume',
  placement: 'overlay',
  params: [
    SOURCE_PARAM,
    { key: 'showBands', label: 'Hiện dải lệch chuẩn', type: 'boolean', default: false },
    { key: 'mult', label: 'Hệ số dải', type: 'number', default: 1, min: 0.1, step: 0.1 },
  ],
  plots: [
    { key: 'vwap', label: 'VWAP', type: 'line', color: C.blue, lineWidth: 2 },
    { key: 'upper', label: 'Dải trên', type: 'line', color: C.gray, lineWidth: 1, hidden: true },
    { key: 'lower', label: 'Dải dưới', type: 'line', color: C.gray, lineWidth: 1, hidden: true },
  ],
  compute: (candles, p) => {
    const prices = source(candles, src(p));
    const line: Series = new Array(candles.length).fill(null);
    const upper: Series = new Array(candles.length).fill(null);
    const lower: Series = new Array(candles.length).fill(null);
    const showBands = bool(p, 'showBands');
    const mult = num(p, 'mult');

    let sumPv = 0;
    let sumV = 0;
    let sumPv2 = 0;
    let currentDay = -1;

    for (let i = 0; i < candles.length; i++) {
      const price = prices[i];
      if (price === null) continue;
      const day = Math.floor(candles[i].time / 86400);
      if (day !== currentDay) {
        currentDay = day;
        sumPv = 0;
        sumV = 0;
        sumPv2 = 0;
      }
      // Nếu BE không trả volume, coi mỗi nến trọng số 1 → VWAP thoái hoá về TWAP.
      const vol = candles[i].volume || 1;
      sumPv += price * vol;
      sumPv2 += price * price * vol;
      sumV += vol;
      if (sumV === 0) continue;

      const value = sumPv / sumV;
      line[i] = value;
      if (showBands) {
        const variance = Math.max(0, sumPv2 / sumV - value * value);
        const dev = Math.sqrt(variance) * mult;
        upper[i] = value + dev;
        lower[i] = value - dev;
      }
    }
    return { vwap: line, upper, lower };
  },
};

/* ── Volume-weighted MA & Hull (dạng riêng cho tiện chọn) ───────────────── */

const smaCross: IndicatorDef = {
  id: 'ma_cross',
  name: 'MA Cross (2 đường)',
  short: 'MA×2',
  category: 'trend',
  placement: 'overlay',
  params: [
    { key: 'fast', label: 'Chu kỳ nhanh', type: 'number', default: 9, min: 1 },
    { key: 'slow', label: 'Chu kỳ chậm', type: 'number', default: 21, min: 1 },
    { key: 'type', label: 'Loại MA', type: 'select', default: 'EMA', options: MA_TYPE_OPTIONS },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'fast', label: 'Nhanh', type: 'line', color: C.orange, lineWidth: 2 },
    { key: 'slow', label: 'Chậm', type: 'line', color: C.blue, lineWidth: 2 },
  ],
  compute: (candles, p) => {
    const values = source(candles, src(p));
    const type = str(p, 'type') as MaType;
    return {
      fast: movingAverage(values, num(p, 'fast'), type),
      slow: movingAverage(values, num(p, 'slow'), type),
    };
  },
};

export const OVERLAY_INDICATORS: IndicatorDef[] = [
  maIndicator,
  smaCross,
  bollingerBands,
  keltnerChannels,
  donchianChannels,
  envelope,
  ichimoku,
  parabolicSar,
  superTrend,
  vwap,
];

export { C as INDICATOR_COLORS, shift, SOURCE_PARAM, MA_TYPE_OPTIONS };
