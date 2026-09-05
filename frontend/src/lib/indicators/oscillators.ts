import {
  atr as atrCalc,
  change,
  cumulative,
  ema,
  highest,
  lowest,
  movingAverage,
  rma,
  sma,
  source,
  stdev,
  trueRange,
  type Candle,
  type MaType,
  type Series,
} from '@/lib/indicators/math';
import { INDICATOR_COLORS as C, MA_TYPE_OPTIONS, SOURCE_PARAM } from '@/lib/indicators/overlays';
import { num, src, str, type IndicatorDef } from '@/lib/indicators/types';

const volumes = (candles: Candle[]): Series => candles.map((c) => c.volume);
const closes = (candles: Candle[]): Series => candles.map((c) => c.close);

/* ── RSI ────────────────────────────────────────────────────────────────── */

export function rsiCalc(values: Series, length: number): Series {
  const diff = change(values, 1);
  const gains = diff.map((v) => (v === null ? null : Math.max(v, 0)));
  const losses = diff.map((v) => (v === null ? null : Math.max(-v, 0)));
  const avgGain = rma(gains, length);
  const avgLoss = rma(losses, length);
  return avgGain.map((g, i) => {
    const l = avgLoss[i];
    if (g === null || l === null) return null;
    if (l === 0) return 100;
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  });
}

const rsi: IndicatorDef = {
  id: 'rsi',
  name: 'Relative Strength Index',
  short: 'RSI',
  category: 'momentum',
  placement: 'pane',
  fixedRange: { min: 0, max: 100 },
  precision: 2,
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 },
    SOURCE_PARAM,
    { key: 'maLength', label: 'Chu kỳ MA', type: 'number', default: 14, min: 1 },
  ],
  plots: [
    { key: 'rsi', label: 'RSI', type: 'line', color: C.purple, lineWidth: 2 },
    { key: 'ma', label: 'MA', type: 'line', color: C.yellow, lineWidth: 1, hidden: true },
  ],
  levels: [
    { value: 70, color: C.gray, lineStyle: 'dashed', label: 'Quá mua' },
    { value: 50, color: C.gray, lineStyle: 'dotted' },
    { value: 30, color: C.gray, lineStyle: 'dashed', label: 'Quá bán' },
  ],
  compute: (candles, p) => {
    const values = rsiCalc(source(candles, src(p)), num(p, 'length'));
    return { rsi: values, ma: sma(values, num(p, 'maLength')) };
  },
};

/* ── MACD ───────────────────────────────────────────────────────────────── */

const macd: IndicatorDef = {
  id: 'macd',
  name: 'MACD',
  short: 'MACD',
  category: 'momentum',
  placement: 'pane',
  precision: 5,
  params: [
    { key: 'fast', label: 'EMA nhanh', type: 'number', default: 12, min: 1 },
    { key: 'slow', label: 'EMA chậm', type: 'number', default: 26, min: 1 },
    { key: 'signal', label: 'Đường tín hiệu', type: 'number', default: 9, min: 1 },
    SOURCE_PARAM,
  ],
  plots: [
    {
      key: 'hist',
      label: 'Histogram',
      type: 'histogram',
      color: C.green,
      colorBySign: { positive: '#26A69A', negative: '#EF5350' },
    },
    { key: 'macd', label: 'MACD', type: 'line', color: C.blue, lineWidth: 2 },
    { key: 'signal', label: 'Signal', type: 'line', color: C.orange, lineWidth: 2 },
  ],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => {
    const values = source(candles, src(p));
    const fast = ema(values, num(p, 'fast'));
    const slow = ema(values, num(p, 'slow'));
    const macdLine = fast.map((v, i) => (v === null || slow[i] === null ? null : v - slow[i]!));
    const signalLine = ema(macdLine, num(p, 'signal'));
    const hist = macdLine.map((v, i) => (v === null || signalLine[i] === null ? null : v - signalLine[i]!));
    return { macd: macdLine, signal: signalLine, hist };
  },
};

/* ── Stochastic ─────────────────────────────────────────────────────────── */

function stochK(candles: Candle[], length: number): Series {
  const hi = highest(candles.map((c) => c.high), length);
  const lo = lowest(candles.map((c) => c.low), length);
  return candles.map((c, i) => {
    if (hi[i] === null || lo[i] === null) return null;
    const range = hi[i]! - lo[i]!;
    // Nến đi ngang tuyệt đối → quy ước 50 thay vì chia 0.
    if (range === 0) return 50;
    return ((c.close - lo[i]!) / range) * 100;
  });
}

const stochastic: IndicatorDef = {
  id: 'stoch',
  name: 'Stochastic',
  short: 'Stoch',
  category: 'momentum',
  placement: 'pane',
  fixedRange: { min: 0, max: 100 },
  precision: 2,
  params: [
    { key: 'k', label: '%K', type: 'number', default: 14, min: 1 },
    { key: 'smoothK', label: 'Làm mượt %K', type: 'number', default: 1, min: 1 },
    { key: 'd', label: '%D', type: 'number', default: 3, min: 1 },
  ],
  plots: [
    { key: 'k', label: '%K', type: 'line', color: C.blue, lineWidth: 2 },
    { key: 'd', label: '%D', type: 'line', color: C.orange, lineWidth: 1 },
  ],
  levels: [
    { value: 80, color: C.gray, lineStyle: 'dashed' },
    { value: 20, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const k = sma(stochK(candles, num(p, 'k')), num(p, 'smoothK'));
    return { k, d: sma(k, num(p, 'd')) };
  },
};

const stochasticRsi: IndicatorDef = {
  id: 'stochrsi',
  name: 'Stochastic RSI',
  short: 'Stoch RSI',
  category: 'momentum',
  placement: 'pane',
  fixedRange: { min: 0, max: 100 },
  precision: 2,
  params: [
    { key: 'rsiLength', label: 'Chu kỳ RSI', type: 'number', default: 14, min: 1 },
    { key: 'stochLength', label: 'Chu kỳ Stoch', type: 'number', default: 14, min: 1 },
    { key: 'k', label: '%K', type: 'number', default: 3, min: 1 },
    { key: 'd', label: '%D', type: 'number', default: 3, min: 1 },
    SOURCE_PARAM,
  ],
  plots: [
    { key: 'k', label: '%K', type: 'line', color: C.blue, lineWidth: 2 },
    { key: 'd', label: '%D', type: 'line', color: C.orange, lineWidth: 1 },
  ],
  levels: [
    { value: 80, color: C.gray, lineStyle: 'dashed' },
    { value: 20, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const rsiValues = rsiCalc(source(candles, src(p)), num(p, 'rsiLength'));
    const length = num(p, 'stochLength');
    const hi = highest(rsiValues, length);
    const lo = lowest(rsiValues, length);
    const raw = rsiValues.map((v, i) => {
      if (v === null || hi[i] === null || lo[i] === null) return null;
      const range = hi[i]! - lo[i]!;
      if (range === 0) return 50;
      return ((v - lo[i]!) / range) * 100;
    });
    const k = sma(raw, num(p, 'k'));
    return { k, d: sma(k, num(p, 'd')) };
  },
};

/* ── ATR / Standard Deviation ───────────────────────────────────────────── */

const atr: IndicatorDef = {
  id: 'atr',
  name: 'Average True Range',
  short: 'ATR',
  category: 'volatility',
  placement: 'pane',
  precision: 5,
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 },
    { key: 'type', label: 'Loại làm mượt', type: 'select', default: 'RMA', options: MA_TYPE_OPTIONS },
  ],
  plots: [{ key: 'atr', label: 'ATR', type: 'line', color: C.orange, lineWidth: 2 }],
  compute: (candles, p) => ({
    atr: movingAverage(trueRange(candles), num(p, 'length'), str(p, 'type') as MaType),
  }),
};

const standardDeviation: IndicatorDef = {
  id: 'stddev',
  name: 'Standard Deviation',
  short: 'StdDev',
  category: 'volatility',
  placement: 'pane',
  precision: 5,
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 2 },
    SOURCE_PARAM,
  ],
  plots: [{ key: 'stddev', label: 'StdDev', type: 'line', color: C.cyan, lineWidth: 2 }],
  compute: (candles, p) => ({ stddev: stdev(source(candles, src(p)), num(p, 'length')) }),
};

/* ── ADX / DMI ──────────────────────────────────────────────────────────── */

const adx: IndicatorDef = {
  id: 'adx',
  name: 'ADX / DMI',
  short: 'ADX',
  category: 'trend',
  placement: 'pane',
  precision: 2,
  params: [
    { key: 'diLength', label: 'Chu kỳ DI', type: 'number', default: 14, min: 1 },
    { key: 'adxLength', label: 'Làm mượt ADX', type: 'number', default: 14, min: 1 },
  ],
  plots: [
    { key: 'adx', label: 'ADX', type: 'line', color: C.yellow, lineWidth: 2 },
    { key: 'plusDi', label: '+DI', type: 'line', color: C.green, lineWidth: 1 },
    { key: 'minusDi', label: '−DI', type: 'line', color: C.red, lineWidth: 1 },
  ],
  levels: [{ value: 25, color: C.gray, lineStyle: 'dashed', label: 'Xu hướng mạnh' }],
  compute: (candles, p) => {
    const diLength = num(p, 'diLength');
    const plusDm: Series = [];
    const minusDm: Series = [];

    for (let i = 0; i < candles.length; i++) {
      if (i === 0) {
        plusDm.push(0);
        minusDm.push(0);
        continue;
      }
      const upMove = candles[i].high - candles[i - 1].high;
      const downMove = candles[i - 1].low - candles[i].low;
      // Chỉ một trong hai chiều được ghi nhận mỗi nến.
      plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
      minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    }

    const smoothTr = rma(trueRange(candles), diLength);
    const smoothPlus = rma(plusDm, diLength);
    const smoothMinus = rma(minusDm, diLength);

    const plusDi = smoothPlus.map((v, i) =>
      v === null || !smoothTr[i] ? null : (100 * v) / smoothTr[i]!,
    );
    const minusDi = smoothMinus.map((v, i) =>
      v === null || !smoothTr[i] ? null : (100 * v) / smoothTr[i]!,
    );
    const dx = plusDi.map((v, i) => {
      const m = minusDi[i];
      if (v === null || m === null) return null;
      const sum = v + m;
      return sum === 0 ? 0 : (100 * Math.abs(v - m)) / sum;
    });

    return { adx: rma(dx, num(p, 'adxLength')), plusDi, minusDi };
  },
};

/* ── CCI ────────────────────────────────────────────────────────────────── */

const cci: IndicatorDef = {
  id: 'cci',
  name: 'Commodity Channel Index',
  short: 'CCI',
  category: 'momentum',
  placement: 'pane',
  precision: 2,
  params: [
    { key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 },
    { key: 'source', label: 'Nguồn giá', type: 'source', default: 'hlc3' },
  ],
  plots: [{ key: 'cci', label: 'CCI', type: 'line', color: C.blue, lineWidth: 2 }],
  levels: [
    { value: 100, color: C.gray, lineStyle: 'dashed' },
    { value: 0, color: C.gray, lineStyle: 'dotted' },
    { value: -100, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const length = num(p, 'length');
    const tp = source(candles, src(p));
    const ma = sma(tp, length);
    const out: Series = new Array(candles.length).fill(null);

    for (let i = length - 1; i < candles.length; i++) {
      const mean = ma[i];
      if (mean === null) continue;
      // CCI dùng độ lệch tuyệt đối trung bình, không phải độ lệch chuẩn.
      let sumDev = 0;
      for (let j = 0; j < length; j++) sumDev += Math.abs((tp[i - j] ?? 0) - mean);
      const meanDev = sumDev / length;
      out[i] = meanDev === 0 ? 0 : ((tp[i] ?? 0) - mean) / (0.015 * meanDev);
    }
    return { cci: out };
  },
};

/* ── Momentum, ROC, Williams %R ─────────────────────────────────────────── */

const momentum: IndicatorDef = {
  id: 'mom',
  name: 'Momentum',
  short: 'MOM',
  category: 'momentum',
  placement: 'pane',
  precision: 5,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 10, min: 1 }, SOURCE_PARAM],
  plots: [{ key: 'mom', label: 'MOM', type: 'line', color: C.blue, lineWidth: 2 }],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => ({ mom: change(source(candles, src(p)), num(p, 'length')) }),
};

const roc: IndicatorDef = {
  id: 'roc',
  name: 'Rate of Change',
  short: 'ROC',
  category: 'momentum',
  placement: 'pane',
  precision: 2,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 9, min: 1 }, SOURCE_PARAM],
  plots: [{ key: 'roc', label: 'ROC', type: 'line', color: C.purple, lineWidth: 2 }],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => {
    const values = source(candles, src(p));
    const length = num(p, 'length');
    return {
      roc: values.map((v, i) => {
        const prev = values[i - length];
        if (v === null || i - length < 0 || !prev) return null;
        // Mẫu số là |prev|, không phải prev: chuỗi ở đây là PnL tài khoản nên có
        // giá trị âm, và chia cho số âm sẽ đảo dấu — PnL đi từ −50 lên −10 (tốt
        // lên) lại hiện ra là ROC âm. Khớp với `lib/stats.ts:roc`.
        return ((v - prev) / Math.abs(prev)) * 100;
      }),
    };
  },
};

const williamsR: IndicatorDef = {
  id: 'willr',
  name: 'Williams %R',
  short: '%R',
  category: 'momentum',
  placement: 'pane',
  fixedRange: { min: -100, max: 0 },
  precision: 2,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 }],
  plots: [{ key: 'willr', label: '%R', type: 'line', color: C.pink, lineWidth: 2 }],
  levels: [
    { value: -20, color: C.gray, lineStyle: 'dashed' },
    { value: -80, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const length = num(p, 'length');
    const hi = highest(candles.map((c) => c.high), length);
    const lo = lowest(candles.map((c) => c.low), length);
    return {
      willr: candles.map((c, i) => {
        if (hi[i] === null || lo[i] === null) return null;
        const range = hi[i]! - lo[i]!;
        if (range === 0) return 0;
        return ((hi[i]! - c.close) / range) * -100;
      }),
    };
  },
};

/* ── Awesome Oscillator, TRIX, Ultimate Oscillator ──────────────────────── */

const awesomeOscillator: IndicatorDef = {
  id: 'ao',
  name: 'Awesome Oscillator',
  short: 'AO',
  category: 'momentum',
  placement: 'pane',
  precision: 5,
  params: [
    { key: 'fast', label: 'Chu kỳ nhanh', type: 'number', default: 5, min: 1 },
    { key: 'slow', label: 'Chu kỳ chậm', type: 'number', default: 34, min: 1 },
  ],
  plots: [
    {
      key: 'ao',
      label: 'AO',
      type: 'histogram',
      color: C.green,
      colorBySign: { positive: '#26A69A', negative: '#EF5350' },
    },
  ],
  compute: (candles, p) => {
    const hl2 = source(candles, 'hl2');
    const fast = sma(hl2, num(p, 'fast'));
    const slow = sma(hl2, num(p, 'slow'));
    return { ao: fast.map((v, i) => (v === null || slow[i] === null ? null : v - slow[i]!)) };
  },
};

const trix: IndicatorDef = {
  id: 'trix',
  name: 'TRIX',
  short: 'TRIX',
  category: 'momentum',
  placement: 'pane',
  precision: 4,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 18, min: 1 }],
  plots: [{ key: 'trix', label: 'TRIX', type: 'line', color: C.cyan, lineWidth: 2 }],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => {
    const length = num(p, 'length');
    const triple = ema(ema(ema(closes(candles), length), length), length);
    return {
      trix: triple.map((v, i) => {
        const prev = triple[i - 1];
        if (v === null || !prev) return null;
        return ((v - prev) / prev) * 10000;
      }),
    };
  },
};

const ultimateOscillator: IndicatorDef = {
  id: 'uo',
  name: 'Ultimate Oscillator',
  short: 'UO',
  category: 'momentum',
  placement: 'pane',
  fixedRange: { min: 0, max: 100 },
  precision: 2,
  params: [
    { key: 'fast', label: 'Chu kỳ nhanh', type: 'number', default: 7, min: 1 },
    { key: 'mid', label: 'Chu kỳ giữa', type: 'number', default: 14, min: 1 },
    { key: 'slow', label: 'Chu kỳ chậm', type: 'number', default: 28, min: 1 },
  ],
  plots: [{ key: 'uo', label: 'UO', type: 'line', color: C.blue, lineWidth: 2 }],
  levels: [
    { value: 70, color: C.gray, lineStyle: 'dashed' },
    { value: 30, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const bp: Series = [];
    const tr: Series = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = i === 0 ? c.close : candles[i - 1].close;
      const trueLow = Math.min(c.low, prevClose);
      bp.push(c.close - trueLow);
      tr.push(Math.max(c.high, prevClose) - trueLow);
    }

    const avg = (length: number) => {
      const sumBp = sma(bp, length);
      const sumTr = sma(tr, length);
      return sumBp.map((v, i) => (v === null || !sumTr[i] ? null : v / sumTr[i]!));
    };

    const a1 = avg(num(p, 'fast'));
    const a2 = avg(num(p, 'mid'));
    const a3 = avg(num(p, 'slow'));

    return {
      uo: a1.map((v, i) => {
        if (v === null || a2[i] === null || a3[i] === null) return null;
        return (100 * (4 * v + 2 * a2[i]! + a3[i]!)) / 7;
      }),
    };
  },
};

/* ── Nhóm khối lượng ────────────────────────────────────────────────────── */

/**
 * Khối lượng thô từ `/symbols` — vẽ đúng `candle.volume`, không suy diễn gì.
 *
 * Trước đây chỉ báo này đảo dấu volume theo nến tăng/giảm để `colorBySign` tô
 * màu, rồi `plotAbs` vẽ ngược lại thành cột dương; kèm một đường MA. Nay màu do
 * `colorByCandle` lo ở tầng vẽ, nên `compute` trả lại đúng số liệu gốc.
 */
const volumeIndicator: IndicatorDef = {
  id: 'volume',
  name: 'Volume',
  short: 'Vol',
  category: 'volume',
  placement: 'pane',
  precision: 0,
  params: [],
  plots: [
    {
      key: 'volume',
      label: 'Volume',
      type: 'histogram',
      color: C.gray,
      colorByCandle: { up: 'rgba(38,166,154,0.6)', down: 'rgba(239,83,80,0.6)' },
    },
  ],
  compute: (candles) => ({ volume: volumes(candles) }),
};

const obv: IndicatorDef = {
  id: 'obv',
  name: 'On Balance Volume',
  short: 'OBV',
  category: 'volume',
  placement: 'pane',
  precision: 0,
  params: [],
  plots: [{ key: 'obv', label: 'OBV', type: 'line', color: C.blue, lineWidth: 2 }],
  compute: (candles) => {
    const flow: Series = candles.map((c, i) => {
      if (i === 0) return 0;
      const prevClose = candles[i - 1].close;
      if (c.close > prevClose) return c.volume;
      if (c.close < prevClose) return -c.volume;
      return 0;
    });
    return { obv: cumulative(flow) };
  },
};

const moneyFlowIndex: IndicatorDef = {
  id: 'mfi',
  name: 'Money Flow Index',
  short: 'MFI',
  category: 'volume',
  placement: 'pane',
  fixedRange: { min: 0, max: 100 },
  precision: 2,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 }],
  plots: [{ key: 'mfi', label: 'MFI', type: 'line', color: C.green, lineWidth: 2 }],
  levels: [
    { value: 80, color: C.gray, lineStyle: 'dashed' },
    { value: 20, color: C.gray, lineStyle: 'dashed' },
  ],
  compute: (candles, p) => {
    const tp = source(candles, 'hlc3');
    const positive: Series = [];
    const negative: Series = [];

    for (let i = 0; i < candles.length; i++) {
      const rawFlow = (tp[i] ?? 0) * candles[i].volume;
      if (i === 0) {
        positive.push(0);
        negative.push(0);
        continue;
      }
      const up = (tp[i] ?? 0) > (tp[i - 1] ?? 0);
      const down = (tp[i] ?? 0) < (tp[i - 1] ?? 0);
      positive.push(up ? rawFlow : 0);
      negative.push(down ? rawFlow : 0);
    }

    const length = num(p, 'length');
    const posSum = sma(positive, length);
    const negSum = sma(negative, length);

    return {
      mfi: posSum.map((v, i) => {
        const n = negSum[i];
        if (v === null || n === null) return null;
        if (n === 0) return 100;
        return 100 - 100 / (1 + v / n);
      }),
    };
  },
};

const chaikinMoneyFlow: IndicatorDef = {
  id: 'cmf',
  name: 'Chaikin Money Flow',
  short: 'CMF',
  category: 'volume',
  placement: 'pane',
  precision: 4,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 20, min: 1 }],
  plots: [{ key: 'cmf', label: 'CMF', type: 'line', color: C.cyan, lineWidth: 2 }],
  levels: [{ value: 0, color: C.gray, lineStyle: 'dotted' }],
  compute: (candles, p) => {
    const mfv: Series = candles.map((c) => {
      const range = c.high - c.low;
      if (range === 0) return 0;
      return (((c.close - c.low) - (c.high - c.close)) / range) * c.volume;
    });
    const length = num(p, 'length');
    const sumMfv = sma(mfv, length);
    const sumVol = sma(volumes(candles), length);
    return { cmf: sumMfv.map((v, i) => (v === null || !sumVol[i] ? null : v / sumVol[i]!)) };
  },
};

/** ATR dạng % giá — tiện so sánh biến động giữa các symbol. */
const atrPercent: IndicatorDef = {
  id: 'atrp',
  name: 'ATR %',
  short: 'ATR%',
  category: 'volatility',
  placement: 'pane',
  precision: 2,
  params: [{ key: 'length', label: 'Chu kỳ', type: 'number', default: 14, min: 1 }],
  plots: [{ key: 'atrp', label: 'ATR %', type: 'line', color: C.orange, lineWidth: 2 }],
  compute: (candles, p) => {
    const range = atrCalc(candles, num(p, 'length'));
    return {
      atrp: range.map((v, i) => (v === null || !candles[i].close ? null : (v / candles[i].close) * 100)),
    };
  },
};

export const OSCILLATOR_INDICATORS: IndicatorDef[] = [
  rsi,
  macd,
  stochastic,
  stochasticRsi,
  adx,
  cci,
  momentum,
  roc,
  williamsR,
  awesomeOscillator,
  trix,
  ultimateOscillator,
  atr,
  atrPercent,
  standardDeviation,
  volumeIndicator,
  obv,
  moneyFlowIndex,
  chaikinMoneyFlow,
];
