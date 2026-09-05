/**
 * ZigZag, UT Bot và bộ Smart Money Concepts.
 *
 * `smc_suite` ("Smc + ob + fvg + Reversal + UT Bot") gộp toàn bộ: cấu trúc
 * swing + internal, order block, fair value gap, tín hiệu UT Bot và bộ
 * Fibonacci tự động — mỗi phần bật/tắt riêng trong Cài đặt.
 *
 * ⚠️ Mọi thứ ở đây dựa trên pivot nên **vẽ lại phần đuôi**: một pivot chỉ được
 * xác nhận sau `swingLength` nến, và BoS/CHoCH chỉ xuất hiện khi nến phá cấu
 * trúc đã đóng. Đó là hành vi đúng, không phải lỗi.
 */
import { atr, ema, findPivots, medianInterval, type Candle, type Series } from '@/lib/indicators/math';
import {
  num,
  type IndicatorBox,
  type IndicatorDef,
  type IndicatorLabel,
  type IndicatorLine,
  type IndicatorMarker,
  type IndicatorShapes,
} from '@/lib/indicators/types';

const C = {
  bull: '#089981',
  bear: '#F23645',
  bullFill: 'rgba(8,153,129,0.16)',
  bearFill: 'rgba(242,54,69,0.16)',
  zigzag: '#2962FF',
  neutral: '#787B86',
};

const empty = (n: number): Series => new Array<number | null>(n).fill(null);
const bool = (p: Record<string, unknown>, key: string) => Boolean(p[key]);

/* ═══ ZigZag ════════════════════════════════════════════════════════════ */

export interface Leg {
  index: number;
  price: number;
  type: 'high' | 'low';
}

/** Lọc pivot thành chuỗi đỉnh–đáy xen kẽ, bỏ các đoạn nhỏ hơn `deviation` %. */
export function zigzagLegs(candles: Candle[], depth: number, deviation: number): Leg[] {
  const pivots = findPivots(candles, depth, depth);
  const legs: Leg[] = [];

  for (const pivot of pivots) {
    const leg: Leg = { index: pivot.index, price: pivot.price, type: pivot.type };
    const last = legs[legs.length - 1];

    if (!last) {
      legs.push(leg);
      continue;
    }

    if (last.type === leg.type) {
      // Hai pivot cùng chiều liên tiếp: chỉ giữ cái cực đoan hơn.
      const moreExtreme = leg.type === 'high' ? leg.price > last.price : leg.price < last.price;
      if (moreExtreme) legs[legs.length - 1] = leg;
      continue;
    }

    const move = last.price === 0 ? 0 : (Math.abs(leg.price - last.price) / Math.abs(last.price)) * 100;
    if (move >= deviation) legs.push(leg);
  }

  return legs;
}

/** 28.935M, 849.925K — đúng kiểu TradingView in khối lượng trên nhãn ZigZag. */
function compactVolume(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(3)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(3)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(3)}K`;
  return value.toFixed(2);
}

const signed = (value: number, digits: number) =>
  `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;

const zigzag: IndicatorDef = {
  id: 'zigzag',
  name: 'Sóng Zig Zag',
  short: 'Sóng Zig Zag',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['deviation', 'depth'],
  params: [
    { key: 'deviation', label: 'Biến động tối thiểu (%)', type: 'number', default: 5, min: 0, step: 0.1 },
    { key: 'depth', label: 'Độ sâu (nến mỗi bên)', type: 'number', default: 10, min: 1, max: 200 },
    { key: 'digits', label: 'Số chữ số thập phân', type: 'number', default: 2, min: 0, max: 8 },
    { key: 'showPrice', label: 'Hiện giá tại đỉnh/đáy', type: 'boolean', default: true },
    { key: 'showChange', label: 'Hiện biến động của sóng', type: 'boolean', default: true },
    { key: 'showVolume', label: 'Hiện khối lượng lũy kế', type: 'boolean', default: true },
    { key: 'extendLast', label: 'Kéo dài sóng đang chạy', type: 'boolean', default: true },
  ],
  plots: [{ key: 'zigzag', label: 'Sóng Zig Zag', type: 'line', color: C.zigzag, lineWidth: 2 }],
  compute: (candles, p) => {
    const out = empty(candles.length);
    // Chỉ đặt giá trị tại đỉnh/đáy; điểm `null` bị loại trước khi vào chart nên
    // series line sẽ nối thẳng các pivot lại với nhau.
    const legs = zigzagLegs(candles, num(p, 'depth'), num(p, 'deviation'));
    legs.forEach((leg) => {
      out[leg.index] = leg.price;
    });

    // Sóng cuối chưa xác nhận: nối chân sóng gần nhất tới nến hiện tại, để đường
    // ZigZag không "đứng lại" cách mép phải cả chục nến.
    const last = legs[legs.length - 1];
    if (bool(p, 'extendLast') && last && last.index < candles.length - 1) {
      const tail = candles[candles.length - 1];
      out[candles.length - 1] = last.type === 'high' ? tail.low : tail.high;
    }
    return { zigzag: out };
  },
  computeShapes: (candles, p) => {
    const labels: IndicatorLabel[] = [];
    const legs = zigzagLegs(candles, num(p, 'depth'), num(p, 'deviation'));
    const digits = num(p, 'digits');
    const showPrice = bool(p, 'showPrice');
    const showChange = bool(p, 'showChange');
    const showVolume = bool(p, 'showVolume');
    if (!showPrice && !showChange && !showVolume) return { labels };

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const previous = legs[i - 1];
      const rising = leg.type === 'high';

      const head: string[] = [];
      if (showPrice) head.push(leg.price.toFixed(digits));
      if (showChange && previous) head.push(`(${signed(leg.price - previous.price, digits)})`);

      const rows = [head.join(' ')].filter(Boolean);

      if (showVolume && previous) {
        // Khối lượng lũy kế của cả chân sóng, không phải của riêng nến pivot.
        let total = 0;
        for (let j = previous.index + 1; j <= leg.index; j++) total += candles[j].volume;
        if (total > 0) rows.push(compactVolume(total));
      }
      if (!rows.length) continue;

      labels.push({
        time: candles[leg.index].time,
        price: leg.price,
        text: rows.join('\n'),
        color: rising ? C.bull : C.bear,
        align: 'center',
        valign: rising ? 'above' : 'below',
        fontSize: 10,
        background: false,
      });
    }
    return { labels };
  },
};

/* ═══ UT Bot ════════════════════════════════════════════════════════════ */

/** Trailing stop kiểu ATR của UT Bot (bám sát script gốc trên TradingView). */
export function utBotStop(candles: Candle[], keyValue: number, atrPeriod: number): Series {
  const out = empty(candles.length);
  const range = atr(candles, atrPeriod);
  let prev: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (range[i] === null) continue;

    const loss = keyValue * range[i]!;
    const close = candles[i].close;

    if (prev === null) {
      prev = close - loss; // khởi tạo như đang ở chiều mua
      out[i] = prev;
      continue;
    }

    const closePrev = candles[i - 1].close;
    let next: number;

    if (close > prev && closePrev > prev) next = Math.max(prev, close - loss);
    else if (close < prev && closePrev < prev) next = Math.min(prev, close + loss);
    else if (close > prev) next = close - loss;
    else next = close + loss;

    prev = next;
    out[i] = next;
  }
  return out;
}

/** Tách trailing stop thành hai chuỗi để tô màu theo chiều (như SuperTrend). */
function utBotSeries(candles: Candle[], keyValue: number, atrPeriod: number) {
  const stop = utBotStop(candles, keyValue, atrPeriod);
  const up = empty(candles.length);
  const down = empty(candles.length);

  for (let i = 0; i < candles.length; i++) {
    if (stop[i] === null) continue;
    if (candles[i].close > stop[i]!) up[i] = stop[i];
    else down[i] = stop[i];
  }
  return { stop, up, down };
}

interface UtSignal {
  index: number;
  side: 'Buy' | 'Sell';
}

/** Tín hiệu = giá đóng cửa cắt qua đường trailing stop. */
function utBotSignals(candles: Candle[], stop: Series): UtSignal[] {
  const signals: UtSignal[] = [];

  for (let i = 1; i < candles.length; i++) {
    const s = stop[i];
    const sPrev = stop[i - 1];
    if (s === null || sPrev === null) continue;

    const close = candles[i].close;
    const closePrev = candles[i - 1].close;

    if (closePrev <= sPrev && close > s) signals.push({ index: i, side: 'Buy' });
    else if (closePrev >= sPrev && close < s) signals.push({ index: i, side: 'Sell' });
  }
  return signals;
}

function utBotMarkers(candles: Candle[], stop: Series): IndicatorMarker[] {
  return utBotSignals(candles, stop).map((signal) => ({
    time: candles[signal.index].time,
    position: signal.side === 'Buy' ? ('belowBar' as const) : ('aboveBar' as const),
    shape: signal.side === 'Buy' ? ('arrowUp' as const) : ('arrowDown' as const),
    color: signal.side === 'Buy' ? C.bull : C.bear,
    text: signal.side,
  }));
}

/** Tag "Buy"/"Sell" nền đặc, bo góc — giống nhãn của script gốc. */
function utBotTags(candles: Candle[], stop: Series): IndicatorLabel[] {
  return utBotSignals(candles, stop).map((signal) => {
    const candle = candles[signal.index];
    const buy = signal.side === 'Buy';
    return {
      time: candle.time,
      price: buy ? candle.low : candle.high,
      text: signal.side,
      color: '#FFFFFF',
      backgroundColor: buy ? C.bull : C.bear,
      align: 'center' as const,
      valign: buy ? ('below' as const) : ('above' as const),
      fontSize: 9,
    };
  });
}

/** EMA tô màu theo vị trí giá so với trailing stop — đường dày xanh/đỏ bám giá. */
function trendMa(candles: Candle[], length: number, stop: Series) {
  const line = ema(candles.map((c) => c.close), length);
  const up = empty(candles.length);
  const down = empty(candles.length);

  for (let i = 0; i < candles.length; i++) {
    if (line[i] === null || stop[i] === null) continue;
    if (candles[i].close > stop[i]!) up[i] = line[i];
    else down[i] = line[i];
  }
  return { up, down };
}

const utBot: IndicatorDef = {
  id: 'utbot',
  name: 'UT Bot Alerts',
  short: 'UT Bot',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['keyValue', 'atrPeriod'],
  params: [
    { key: 'keyValue', label: 'Hệ số nhạy (a)', type: 'number', default: 1, min: 0.1, step: 0.1 },
    { key: 'atrPeriod', label: 'Chu kỳ ATR', type: 'number', default: 10, min: 1 },
  ],
  plots: [
    { key: 'up', label: 'Stop (tăng)', type: 'line', color: C.bull, lineWidth: 2 },
    { key: 'down', label: 'Stop (giảm)', type: 'line', color: C.bear, lineWidth: 2 },
  ],
  compute: (candles, p) => {
    const { up, down } = utBotSeries(candles, num(p, 'keyValue'), num(p, 'atrPeriod'));
    return { up, down };
  },
  computeShapes: (candles, p) => ({
    markers: utBotMarkers(candles, utBotStop(candles, num(p, 'keyValue'), num(p, 'atrPeriod'))),
  }),
};

/* ═══ Cấu trúc thị trường ═══════════════════════════════════════════════ */

export interface StructureBreak {
  breakIndex: number;
  swingIndex: number;
  swingPrice: number;
  direction: 'bull' | 'bear';
  /** CHoCH = phá cấu trúc ngược xu hướng hiện tại → tín hiệu đảo chiều. */
  kind: 'BoS' | 'CHoCH';
}

/**
 * Duyệt nến theo thời gian, giữ swing high/low gần nhất **đã được xác nhận**.
 * Khi giá đóng cửa vượt qua swing đó thì ghi nhận một cú phá cấu trúc.
 */
export function structureBreaks(candles: Candle[], swingLength: number): StructureBreak[] {
  const pivots = findPivots(candles, swingLength, swingLength);
  const breaks: StructureBreak[] = [];
  if (!pivots.length) return breaks;

  let lastHigh: { index: number; price: number } | null = null;
  let lastLow: { index: number; price: number } | null = null;
  let trend: 'bull' | 'bear' | null = null;
  let pivotCursor = 0;

  for (let i = 0; i < candles.length; i++) {
    // Pivot tại index p chỉ "biết được" sau p + swingLength nến.
    while (pivotCursor < pivots.length && pivots[pivotCursor].index + swingLength <= i) {
      const pivot = pivots[pivotCursor++];
      if (pivot.type === 'high') lastHigh = { index: pivot.index, price: pivot.price };
      else lastLow = { index: pivot.index, price: pivot.price };
    }

    const close = candles[i].close;

    if (lastHigh && close > lastHigh.price) {
      breaks.push({
        breakIndex: i,
        swingIndex: lastHigh.index,
        swingPrice: lastHigh.price,
        direction: 'bull',
        kind: trend === 'bear' ? 'CHoCH' : 'BoS',
      });
      trend = 'bull';
      lastHigh = null; // đã phá thì không phá lại
    } else if (lastLow && close < lastLow.price) {
      breaks.push({
        breakIndex: i,
        swingIndex: lastLow.index,
        swingPrice: lastLow.price,
        direction: 'bear',
        kind: trend === 'bull' ? 'CHoCH' : 'BoS',
      });
      trend = 'bear';
      lastLow = null;
    }
  }

  return breaks;
}

function structureShapes(
  candles: Candle[],
  breaks: StructureBreak[],
  options: { prefix: string; dashed: boolean },
): { lines: IndicatorLine[]; labels: IndicatorLabel[] } {
  const lines: IndicatorLine[] = [];
  const labels: IndicatorLabel[] = [];

  for (const brk of breaks) {
    const color = brk.direction === 'bull' ? C.bull : C.bear;
    const from = { time: candles[brk.swingIndex].time, price: brk.swingPrice };
    const to = { time: candles[brk.breakIndex].time, price: brk.swingPrice };

    lines.push({ from, to, color, lineStyle: options.dashed ? 'dashed' : 'solid' });
    labels.push({
      time: candles[Math.floor((brk.swingIndex + brk.breakIndex) / 2)].time,
      price: brk.swingPrice,
      text: `${options.prefix}${brk.kind}`,
      color,
      align: 'center',
      valign: brk.direction === 'bull' ? 'above' : 'below',
      fontSize: 9,
    });
  }
  return { lines, labels };
}

/** Nhãn HH / HL / LH / LL tại các pivot đã xác nhận. */
function swingPointLabels(candles: Candle[], swingLength: number): IndicatorLabel[] {
  const pivots = findPivots(candles, swingLength, swingLength);
  const labels: IndicatorLabel[] = [];

  let prevHigh: number | null = null;
  let prevLow: number | null = null;

  for (const pivot of pivots) {
    let text: string;
    let color: string;

    if (pivot.type === 'high') {
      // Chưa có đỉnh trước để so sánh thì chưa gọi được là HH hay LH.
      if (prevHigh === null) {
        prevHigh = pivot.price;
        continue;
      }
      const higher = pivot.price > prevHigh;
      text = higher ? 'HH' : 'LH';
      color = higher ? C.bull : C.bear;
      prevHigh = pivot.price;
    } else {
      if (prevLow === null) {
        prevLow = pivot.price;
        continue;
      }
      const higher = pivot.price > prevLow;
      text = higher ? 'HL' : 'LL';
      color = higher ? C.bull : C.bear;
      prevLow = pivot.price;
    }

    labels.push({
      time: candles[pivot.index].time,
      price: pivot.price,
      text,
      color,
      align: 'center',
      valign: pivot.type === 'high' ? 'above' : 'below',
      fontSize: 10,
    });
  }
  return labels;
}

/* ═══ Order Block ═══════════════════════════════════════════════════════ */

export function orderBlockBoxes(
  candles: Candle[],
  breaks: StructureBreak[],
  options: { swingLength: number; extendBars: number; maxBoxes: number; hideMitigated: boolean },
): IndicatorBox[] {
  const interval = medianInterval(candles);
  const extend = options.extendBars * interval;
  const bullish: IndicatorBox[] = [];
  const bearish: IndicatorBox[] = [];

  for (const brk of breaks) {
    // Order block = nến ngược chiều CUỐI CÙNG trước cú phá cấu trúc.
    const wantBearishCandle = brk.direction === 'bull';
    let obIndex = -1;
    for (let i = brk.breakIndex - 1; i >= Math.max(0, brk.swingIndex - options.swingLength); i--) {
      const isBearishCandle = candles[i].close < candles[i].open;
      if (isBearishCandle === wantBearishCandle) {
        obIndex = i;
        break;
      }
    }
    if (obIndex < 0) continue;

    const ob = candles[obIndex];
    const isBull = brk.direction === 'bull';

    // Mitigated = giá đóng cửa xuyên qua hẳn khối lệnh → khối đó hết hiệu lực.
    let mitigatedAt: number | null = null;
    for (let i = brk.breakIndex; i < candles.length; i++) {
      const broken = isBull ? candles[i].close < ob.low : candles[i].close > ob.high;
      if (broken) {
        mitigatedAt = candles[i].time;
        break;
      }
    }
    if (mitigatedAt !== null && options.hideMitigated) continue;

    const box: IndicatorBox = {
      from: { time: ob.time, price: ob.high },
      to: {
        time: mitigatedAt ?? candles[brk.breakIndex].time + extend,
        price: ob.low,
      },
      fill: isBull ? C.bullFill : C.bearFill,
      border: isBull ? C.bull : C.bear,
      labelColor: isBull ? C.bull : C.bear,
    };
    (isBull ? bullish : bearish).push(box);
  }

  return [...bullish.slice(-options.maxBoxes), ...bearish.slice(-options.maxBoxes)];
}

/* ═══ Fair Value Gap ════════════════════════════════════════════════════ */

export function fvgBoxes(
  candles: Candle[],
  options: { extendBars: number; minSize: number; hideFilled: boolean },
): IndicatorBox[] {
  const boxes: IndicatorBox[] = [];
  if (candles.length < 3) return boxes;

  const interval = medianInterval(candles);

  for (let i = 2; i < candles.length; i++) {
    const left = candles[i - 2];
    const right = candles[i];

    // Khoảng trống 3 nến: nến giữa nhảy qua, hai nến biên không chạm nhau.
    const bullish = right.low > left.high;
    const bearish = right.high < left.low;
    if (!bullish && !bearish) continue;

    const top = bullish ? right.low : left.low;
    const bottom = bullish ? left.high : right.high;
    const size = bottom === 0 ? 0 : ((top - bottom) / Math.abs(bottom)) * 100;
    if (size < options.minSize) continue;

    // Lấp đầy = nến sau đi xuyên hết vùng gap (chạm mép xa của nó).
    let filledAt: number | null = null;
    for (let j = i + 1; j < candles.length; j++) {
      const filled = bullish ? candles[j].low <= bottom : candles[j].high >= top;
      if (filled) {
        filledAt = candles[j].time;
        break;
      }
    }
    if (filledAt !== null && options.hideFilled) continue;

    boxes.push({
      from: { time: left.time, price: top },
      to: { time: filledAt ?? right.time + options.extendBars * interval, price: bottom },
      fill: bullish ? C.bullFill : C.bearFill,
      border: bullish ? C.bull : C.bear,
      label: filledAt ? undefined : 'FVG',
      labelColor: bullish ? C.bull : C.bear,
    });
  }
  return boxes;
}

/* ═══ Equal Highs / Equal Lows ══════════════════════════════════════════ */

/** Hai đỉnh (hoặc hai đáy) liên tiếp gần bằng nhau → vùng thanh khoản EQH/EQL. */
function equalLevels(
  candles: Candle[],
  swingLength: number,
  threshold: number,
): { lines: IndicatorLine[]; labels: IndicatorLabel[] } {
  const lines: IndicatorLine[] = [];
  const labels: IndicatorLabel[] = [];

  const pivots = findPivots(candles, swingLength, swingLength);
  const atrValues = atr(candles, 14);

  // Phải tách riêng chuỗi đỉnh và chuỗi đáy: trong danh sách chung, pivot gần
  // như luôn xen kẽ high/low nên hai phần tử liền kề hiếm khi cùng loại.
  for (const type of ['high', 'low'] as const) {
    const sameType = pivots.filter((pivot) => pivot.type === type);

    for (let i = 1; i < sameType.length; i++) {
      const a = sameType[i - 1];
      const b = sameType[i];

      // Ngưỡng theo ATR để "gần bằng nhau" có nghĩa như nhau ở mọi mức giá.
      const scale = atrValues[b.index];
      if (scale === null || scale === 0) continue;
      if (Math.abs(a.price - b.price) > threshold * scale) continue;

      const isHigh = type === 'high';
      const color = isHigh ? C.bear : C.bull;

      lines.push({
        from: { time: candles[a.index].time, price: a.price },
        to: { time: candles[b.index].time, price: b.price },
        color,
        lineStyle: 'dotted',
      });
      labels.push({
        time: candles[b.index].time,
        price: b.price,
        text: isHigh ? 'EQH' : 'EQL',
        color,
        align: 'left',
        valign: isHigh ? 'above' : 'below',
        fontSize: 9,
      });
    }
  }
  return { lines, labels };
}

/* ═══ Premium / Equilibrium / Discount + Strong-Weak ════════════════════ */

/** Đỉnh và đáy swing đã xác nhận gần nhất — mốc để chia vùng giá. */
function latestSwingRange(candles: Candle[], swingLength: number) {
  const pivots = findPivots(candles, swingLength, swingLength);
  let high: { index: number; price: number } | null = null;
  let low: { index: number; price: number } | null = null;

  for (const pivot of pivots) {
    if (pivot.type === 'high') high = { index: pivot.index, price: pivot.price };
    else low = { index: pivot.index, price: pivot.price };
  }
  return high && low ? { high, low } : null;
}

function premiumDiscountZones(
  candles: Candle[],
  swingLength: number,
  extendBars: number,
): { boxes: IndicatorBox[]; labels: IndicatorLabel[] } {
  const boxes: IndicatorBox[] = [];
  const labels: IndicatorLabel[] = [];

  const range = latestSwingRange(candles, swingLength);
  if (!range) return { boxes, labels };

  const { high, low } = range;
  const span = high.price - low.price;
  if (span <= 0) return { boxes, labels };

  const interval = medianInterval(candles);
  const fromTime = candles[Math.min(high.index, low.index)].time;
  const toTime = candles[candles.length - 1].time + extendBars * interval;

  const zones: { top: number; bottom: number; fill: string; color: string; text: string }[] = [
    { top: high.price, bottom: high.price - span * 0.05, fill: C.bearFill, color: C.bear, text: 'Premium' },
    {
      top: low.price + span * 0.525,
      bottom: low.price + span * 0.475,
      fill: 'rgba(120,123,134,0.16)',
      color: C.neutral,
      text: 'Equilibrium',
    },
    { top: low.price + span * 0.05, bottom: low.price, fill: C.bullFill, color: C.bull, text: 'Discount' },
  ];

  for (const zone of zones) {
    boxes.push({
      from: { time: fromTime, price: zone.top },
      to: { time: toTime, price: zone.bottom },
      fill: zone.fill,
    });
    labels.push({
      time: toTime,
      price: (zone.top + zone.bottom) / 2,
      text: zone.text,
      color: zone.color,
      align: 'right',
      valign: 'middle',
      fontSize: 9,
      background: true,
    });
  }
  return { boxes, labels };
}

/**
 * Trong xu hướng tăng, đáy khởi phát là "Strong Low" còn các đỉnh chỉ là
 * "Weak High" (chưa được bảo vệ) — và ngược lại.
 */
function strongWeakLabels(
  candles: Candle[],
  swingLength: number,
  breaks: StructureBreak[],
): IndicatorLabel[] {
  const range = latestSwingRange(candles, swingLength);
  if (!range) return [];

  const trend = breaks.length ? breaks[breaks.length - 1].direction : 'bull';
  const bull = trend === 'bull';

  return [
    {
      time: candles[range.high.index].time,
      price: range.high.price,
      text: bull ? 'Weak High' : 'Strong High',
      color: bull ? C.neutral : C.bear,
      align: 'center',
      valign: 'above',
      fontSize: 9,
      background: true,
    },
    {
      time: candles[range.low.index].time,
      price: range.low.price,
      text: bull ? 'Strong Low' : 'Weak Low',
      color: bull ? C.bull : C.neutral,
      align: 'center',
      valign: 'below',
      fontSize: 9,
      background: true,
    },
  ];
}

/* ═══ Mức đỉnh/đáy khung thời gian lớn (MTF) ════════════════════════════ */

/**
 * Đỉnh/đáy của phiên **đã đóng** gần nhất ở khung `bucketSeconds`
 * (nhãn `1DH`/`1DL`, `240H`/`240L` như trên TradingView).
 *
 * Bỏ qua khi khung hiện tại không nhỏ hơn khung mục tiêu — lúc đó mỗi nến đã là
 * một phiên, mức này vô nghĩa.
 */
function mtfLevels(
  candles: Candle[],
  bucketSeconds: number,
  prefix: string,
): { lines: IndicatorLine[]; labels: IndicatorLabel[] } {
  const lines: IndicatorLine[] = [];
  const labels: IndicatorLabel[] = [];

  const interval = medianInterval(candles);
  if (!candles.length || interval >= bucketSeconds) return { lines, labels };

  const currentBucket = Math.floor(candles[candles.length - 1].time / bucketSeconds);
  const previous = candles.filter((c) => Math.floor(c.time / bucketSeconds) === currentBucket - 1);
  if (!previous.length) return { lines, labels };

  const high = Math.max(...previous.map((c) => c.high));
  const low = Math.min(...previous.map((c) => c.low));
  const fromTime = previous[0].time;
  const toTime = candles[candles.length - 1].time;

  for (const [price, suffix, color] of [
    [high, 'H', C.bear],
    [low, 'L', C.bull],
  ] as const) {
    lines.push({ from: { time: fromTime, price }, to: { time: toTime, price }, color, lineStyle: 'dashed' });
    labels.push({
      time: toTime,
      price,
      text: `${prefix}${suffix}`,
      color,
      align: 'left',
      valign: 'middle',
      fontSize: 9,
      background: true,
    });
  }
  return { lines, labels };
}

/* ═══ Trendline tự động ═════════════════════════════════════════════════ */

/** Nối hai đỉnh (và hai đáy) xác nhận gần nhất, kéo dài sang phải. */
function autoTrendlines(
  candles: Candle[],
  swingLength: number,
  extendBars: number,
): IndicatorLine[] {
  const pivots = findPivots(candles, swingLength, swingLength);
  const lines: IndicatorLine[] = [];
  const interval = medianInterval(candles);

  for (const type of ['high', 'low'] as const) {
    const same = pivots.filter((p) => p.type === type).slice(-2);
    if (same.length < 2) continue;

    const [a, b] = same;
    if (b.index === a.index) continue;

    const slope = (b.price - a.price) / (b.index - a.index);
    const lastIndex = candles.length - 1 + extendBars;
    const endTime = candles[candles.length - 1].time + extendBars * interval;

    lines.push({
      from: { time: candles[a.index].time, price: a.price },
      to: { time: endTime, price: a.price + slope * (lastIndex - a.index) },
      color: type === 'high' ? C.bear : C.bull,
      lineStyle: 'solid',
    });
  }
  return lines;
}

/* ═══ Fibonacci tự động trên chân sóng gần nhất ═════════════════════════ */

const FIB_RATIOS: { ratio: number; color: string }[] = [
  { ratio: 0.236, color: '#9598A1' },
  { ratio: 0.382, color: '#089981' },
  { ratio: 0.5, color: '#F7931A' },
  { ratio: 0.618, color: '#FF9800' },
  { ratio: 0.786, color: '#F23645' },
  { ratio: 0.886, color: '#9C27B0' },
  { ratio: 1.13, color: '#2962FF' },
  { ratio: 1.27, color: '#00BCD4' },
  { ratio: 1.41, color: '#E91E63' },
  { ratio: 1.618, color: '#7E57C2' },
];

/** Độ dài đoạn Fibonacci, tính bằng số nến. Chỉ báo gốc vẽ đoạn ngắn sát mép phải. */
const FIB_SEGMENT_BARS = 20;

/** Chiếu các mức Fibonacci từ chân sóng xác nhận cuối cùng, vẽ sát mép phải. */
function fibShapes(
  candles: Candle[],
  swingLength: number,
  extendBars: number,
): { lines: IndicatorLine[]; labels: IndicatorLabel[] } {
  const lines: IndicatorLine[] = [];
  const labels: IndicatorLabel[] = [];

  const legs = zigzagLegs(candles, swingLength, 0);
  if (legs.length < 2) return { lines, labels };

  const start = legs[legs.length - 2];
  const end = legs[legs.length - 1];
  const range = end.price - start.price;
  if (range === 0) return { lines, labels };

  const interval = medianInterval(candles);
  const toTime = candles[candles.length - 1].time + extendBars * interval;
  // Đoạn ngắn neo ở mép phải, nhưng không bao giờ lùi quá chân sóng sinh ra nó.
  const fromTime = Math.max(
    candles[end.index].time,
    toTime - FIB_SEGMENT_BARS * interval,
  );

  for (const { ratio, color } of FIB_RATIOS) {
    const price = start.price + range * ratio;
    lines.push({
      from: { time: fromTime, price },
      to: { time: toTime, price },
      color,
      lineStyle: 'solid',
    });
    labels.push({
      time: toTime,
      price,
      text: String(ratio),
      color,
      // Canh phải để nhãn nằm gọn trong pane — `ShapesLayer` xén ở mép cột giá.
      align: 'right',
      valign: 'middle',
      fontSize: 10,
      background: true,
    });
  }
  return { lines, labels };
}

/* ═══ Chỉ báo tổng hợp ══════════════════════════════════════════════════ */

const smcSuite: IndicatorDef = {
  id: 'smc_suite',
  name: 'Smc + ob + fvg + Reversal + UT Bot',
  short: 'SMC',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['swingLength', 'internalLength'],
  params: [
    { key: 'swingLength', label: 'Độ dài swing', type: 'number', default: 50, min: 2, max: 200 },
    { key: 'internalLength', label: 'Độ dài cấu trúc nội bộ', type: 'number', default: 5, min: 2, max: 100 },
    { key: 'extendBars', label: 'Kéo dài (nến)', type: 'number', default: 12, min: 0, max: 200 },

    { key: 'showSwingPoints', label: 'Nhãn HH / HL / LH / LL', type: 'boolean', default: true },
    { key: 'showSwingStructure', label: 'Cấu trúc swing (BoS / CHoCH)', type: 'boolean', default: true },
    { key: 'showInternalStructure', label: 'Cấu trúc nội bộ (I-BoS / I-CHoCH)', type: 'boolean', default: true },
    { key: 'showStrongWeak', label: 'Nhãn Strong / Weak High-Low', type: 'boolean', default: true },

    { key: 'showOrderBlocks', label: 'Order Block', type: 'boolean', default: true },
    { key: 'obCount', label: 'Số order block mỗi chiều', type: 'number', default: 5, min: 1, max: 20 },
    { key: 'obHideMitigated', label: 'Ẩn order block đã bị phá', type: 'boolean', default: true },

    { key: 'showFvg', label: 'Fair Value Gap', type: 'boolean', default: true },
    { key: 'fvgHideFilled', label: 'Ẩn FVG đã lấp đầy', type: 'boolean', default: true },

    { key: 'showEqualLevels', label: 'Equal High / Equal Low', type: 'boolean', default: true },
    { key: 'eqThreshold', label: 'Ngưỡng EQH/EQL (× ATR)', type: 'number', default: 0.2, min: 0.01, step: 0.01 },

    { key: 'showZones', label: 'Vùng Premium / Equilibrium / Discount', type: 'boolean', default: true },

    { key: 'showUtBot', label: 'Tín hiệu UT Bot', type: 'boolean', default: true },
    { key: 'utKeyValue', label: 'UT Bot — hệ số nhạy', type: 'number', default: 1, min: 0.1, step: 0.1 },
    { key: 'utAtrPeriod', label: 'UT Bot — chu kỳ ATR', type: 'number', default: 10, min: 1 },
    { key: 'showTrendMa', label: 'Đường MA theo xu hướng', type: 'boolean', default: true },
    { key: 'maLength', label: 'Chu kỳ MA xu hướng', type: 'number', default: 9, min: 1, max: 200 },

    { key: 'showTrendlines', label: 'Trendline tự động', type: 'boolean', default: true },
    { key: 'showFib', label: 'Fibonacci tự động', type: 'boolean', default: true },
    { key: 'showMtf', label: 'Mức đỉnh/đáy 1D & 4H', type: 'boolean', default: true },
  ],
  plots: [
    { key: 'stopUp', label: 'UT Bot stop (tăng)', type: 'line', color: C.bull, lineWidth: 1 },
    { key: 'stopDown', label: 'UT Bot stop (giảm)', type: 'line', color: C.bear, lineWidth: 1 },
    { key: 'maUp', label: 'MA xu hướng (tăng)', type: 'line', color: C.bull, lineWidth: 3 },
    { key: 'maDown', label: 'MA xu hướng (giảm)', type: 'line', color: C.bear, lineWidth: 3 },
  ],
  compute: (candles, p) => {
    const blank = {
      stopUp: empty(candles.length),
      stopDown: empty(candles.length),
      maUp: empty(candles.length),
      maDown: empty(candles.length),
    };
    if (!bool(p, 'showUtBot') && !bool(p, 'showTrendMa')) return blank;

    const keyValue = num(p, 'utKeyValue');
    const atrPeriod = num(p, 'utAtrPeriod');
    const { stop, up, down } = utBotSeries(candles, keyValue, atrPeriod);

    const ma = bool(p, 'showTrendMa')
      ? trendMa(candles, num(p, 'maLength'), stop)
      : { up: blank.maUp, down: blank.maDown };

    return {
      stopUp: bool(p, 'showUtBot') ? up : blank.stopUp,
      stopDown: bool(p, 'showUtBot') ? down : blank.stopDown,
      maUp: ma.up,
      maDown: ma.down,
    };
  },
  computeShapes: (candles, p) => {
    const boxes: IndicatorBox[] = [];
    const lines: IndicatorLine[] = [];
    const labels: IndicatorLabel[] = [];
    const markers: IndicatorMarker[] = [];

    const swingLength = num(p, 'swingLength');
    const internalLength = num(p, 'internalLength');
    const extendBars = num(p, 'extendBars');

    const swingBreaks = structureBreaks(candles, swingLength);

    // Vùng giá vẽ trước để nằm dưới cùng, không che order block / FVG.
    if (bool(p, 'showZones')) {
      const out = premiumDiscountZones(candles, swingLength, extendBars);
      boxes.push(...out.boxes);
      labels.push(...out.labels);
    }

    if (bool(p, 'showOrderBlocks')) {
      boxes.push(
        ...orderBlockBoxes(candles, swingBreaks, {
          swingLength,
          extendBars,
          maxBoxes: num(p, 'obCount'),
          hideMitigated: bool(p, 'obHideMitigated'),
        }),
      );
    }

    if (bool(p, 'showFvg')) {
      boxes.push(
        ...fvgBoxes(candles, { extendBars, minSize: 0, hideFilled: bool(p, 'fvgHideFilled') }),
      );
    }

    if (bool(p, 'showSwingPoints')) labels.push(...swingPointLabels(candles, swingLength));
    if (bool(p, 'showStrongWeak')) labels.push(...strongWeakLabels(candles, swingLength, swingBreaks));

    if (bool(p, 'showSwingStructure')) {
      const out = structureShapes(candles, swingBreaks, { prefix: '', dashed: false });
      lines.push(...out.lines);
      labels.push(...out.labels);
    }

    if (bool(p, 'showInternalStructure')) {
      const out = structureShapes(candles, structureBreaks(candles, internalLength), {
        prefix: 'I-',
        dashed: true,
      });
      lines.push(...out.lines);
      labels.push(...out.labels);
    }

    if (bool(p, 'showEqualLevels')) {
      const out = equalLevels(candles, internalLength, num(p, 'eqThreshold'));
      lines.push(...out.lines);
      labels.push(...out.labels);
    }

    if (bool(p, 'showTrendlines')) lines.push(...autoTrendlines(candles, swingLength, extendBars));

    if (bool(p, 'showFib')) {
      const out = fibShapes(candles, swingLength, extendBars);
      lines.push(...out.lines);
      labels.push(...out.labels);
    }

    if (bool(p, 'showMtf')) {
      for (const [seconds, prefix] of [
        [86_400, '1D'],
        [14_400, '240'],
      ] as const) {
        const out = mtfLevels(candles, seconds, prefix);
        lines.push(...out.lines);
        labels.push(...out.labels);
      }
    }

    if (bool(p, 'showUtBot')) {
      // Chỉ báo gốc chỉ vẽ tag "Buy"/"Sell" nền đặc, không kèm mũi tên rời.
      const stop = utBotStop(candles, num(p, 'utKeyValue'), num(p, 'utAtrPeriod'));
      labels.push(...utBotTags(candles, stop));
    }

    return { boxes, lines, labels, markers };
  },
};

/* ═══ Ziv Ghost Pivot ═══════════════════════════════════════════════════ */

const GHOST = {
  high: '#E91E63',
  low: '#7E57C2',
  line: '#26A69A',
};

/** Một mức pivot còn "nguyên" — chưa bị giá xuyên qua kể từ lúc xác nhận. */
interface GhostLevel {
  /** Nến sinh ra pivot. */
  pivot: number;
  /** Nến đầu tiên vẽ ký tự (pivot đã được xác nhận). */
  from: number;
  /** Nến cuối còn vẽ: nến ngay trước lúc bị phá, hoặc nến cuối cùng. */
  to: number;
  price: number;
  broken: boolean;
}

/**
 * Pivot "ma": mức đỉnh/đáy được chiếu sang phải cho tới khi giá xuyên qua.
 *
 * ⚠️ Script gốc trên TradingView không công khai, nên đây là dựng lại theo đúng
 * những gì ảnh cho thấy: một hàng ký tự `m` (đỉnh) / `w` (đáy) chạy ngang ở mức
 * pivot, bắt đầu sau khi pivot được xác nhận và **dừng ngay tại nến phá mức**.
 */
function ghostLevels(
  candles: Candle[],
  type: 'high' | 'low',
  left: number,
  right: number,
  breakOnClose: boolean,
  maxBars: number,
): GhostLevel[] {
  const out: GhostLevel[] = [];
  const lastIndex = candles.length - 1;

  for (const pivot of findPivots(candles, left, right)) {
    if (pivot.type !== type) continue;

    const from = Math.min(pivot.index + right, lastIndex);
    const limit = Math.min(lastIndex, from + maxBars);
    let to = limit;
    let broken = false;

    for (let i = from + 1; i <= limit; i++) {
      const probe =
        type === 'high'
          ? breakOnClose
            ? candles[i].close
            : candles[i].high
          : breakOnClose
            ? candles[i].close
            : candles[i].low;
      const crossed = type === 'high' ? probe > pivot.price : probe < pivot.price;
      if (crossed) {
        to = i - 1;
        broken = true;
        break;
      }
    }

    if (to > from) out.push({ pivot: pivot.index, from, to, price: pivot.price, broken });
  }

  return out;
}

/** Trần số nhãn ký tự — mỗi nến của mỗi mức là một nhãn, dễ bùng nổ. */
const GHOST_MAX_LABELS = 6000;

const ghostPivot: IndicatorDef = {
  id: 'ziv_ghost_pivot',
  name: 'Ziv Ghost Pivot',
  short: 'Ghost Pivots',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['leftBars', 'rightBars'],
  params: [
    { key: 'leftBars', label: 'Nến trái của pivot', type: 'number', default: 5, min: 1, max: 100 },
    { key: 'rightBars', label: 'Nến phải của pivot', type: 'number', default: 5, min: 1, max: 100 },
    { key: 'maxBars', label: 'Kéo dài tối đa (nến)', type: 'number', default: 200, min: 5, max: 2000 },
    { key: 'breakOnClose', label: 'Phá mức theo giá đóng cửa', type: 'boolean', default: false },
    { key: 'showGhostHigh', label: 'Hiện mức đỉnh (m)', type: 'boolean', default: true },
    { key: 'showGhostLow', label: 'Hiện mức đáy (w)', type: 'boolean', default: true },
    { key: 'hideBroken', label: 'Ẩn mức đã bị phá', type: 'boolean', default: false },
    { key: 'showPivotWick', label: 'Vạch dọc tại nến pivot', type: 'boolean', default: true },
    { key: 'showZigzag', label: 'Nối các pivot', type: 'boolean', default: true },
  ],
  plots: [
    { key: 'zigzag', label: 'Đường nối pivot', type: 'line', color: GHOST.line, lineWidth: 1 },
    { key: 'ghostHigh', label: 'Mức đỉnh', type: 'line', color: GHOST.high, lineWidth: 1, hidden: true },
    { key: 'ghostLow', label: 'Mức đáy', type: 'line', color: GHOST.low, lineWidth: 1, hidden: true },
  ],
  compute: (candles, p) => {
    const zig = empty(candles.length);
    const ghostHigh = empty(candles.length);
    const ghostLow = empty(candles.length);

    const left = num(p, 'leftBars');
    const right = num(p, 'rightBars');
    const maxBars = num(p, 'maxBars');
    const onClose = bool(p, 'breakOnClose');

    if (bool(p, 'showZigzag')) {
      for (const pivot of findPivots(candles, left, right)) zig[pivot.index] = pivot.price;
    }

    for (const [type, series] of [
      ['high', ghostHigh],
      ['low', ghostLow],
    ] as const) {
      for (const level of ghostLevels(candles, type, left, right, onClose, maxBars)) {
        for (let i = level.from; i <= level.to; i++) series[i] = level.price;
      }
    }

    return { zigzag: zig, ghostHigh, ghostLow };
  },
  computeShapes: (candles, p) => {
    const labels: IndicatorLabel[] = [];
    const lines: IndicatorLine[] = [];

    const left = num(p, 'leftBars');
    const right = num(p, 'rightBars');
    const maxBars = num(p, 'maxBars');
    const onClose = bool(p, 'breakOnClose');
    const hideBroken = bool(p, 'hideBroken');

    const wanted: ('high' | 'low')[] = [];
    if (bool(p, 'showGhostHigh')) wanted.push('high');
    if (bool(p, 'showGhostLow')) wanted.push('low');

    for (const type of wanted) {
      const char = type === 'high' ? 'm' : 'w';
      const color = type === 'high' ? GHOST.high : GHOST.low;

      for (const level of ghostLevels(candles, type, left, right, onClose, maxBars)) {
        if (hideBroken && level.broken) continue;

        for (let i = level.from; i <= level.to && labels.length < GHOST_MAX_LABELS; i++) {
          labels.push({
            time: candles[i].time,
            price: level.price,
            text: char,
            color,
            align: 'center',
            valign: 'middle',
            fontSize: 9,
            background: false,
          });
        }

        // Vạch dọc mảnh tại chính nến pivot — nhìn như "bóng ma" của cây nến đó.
        if (bool(p, 'showPivotWick')) {
          const bar = candles[level.pivot];
          lines.push({
            from: { time: bar.time, price: bar.high },
            to: { time: bar.time, price: bar.low },
            color,
            lineStyle: 'solid',
          });
        }
      }
    }

    return { labels, lines };
  },
};

export const SMC_INDICATORS: IndicatorDef[] = [smcSuite, zigzag, ghostPivot, utBot];
