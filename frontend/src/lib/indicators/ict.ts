/**
 * Hai mẫu hình theo trường phái ICT, đọc trên **nhiều khung thời gian cùng lúc**.
 *
 * Bảng giá của hệ thống chỉ có nến ngày, nên "khung lớn hơn" ở đây được dựng bằng cách gộp N
 * nến ngày liền nhau thành một nến — 5 nến ≈ một tuần giao dịch, 20 nến ≈ một tháng. Cách này
 * không thay được dữ liệu tuần/tháng thật (một tuần lễ Tết chỉ có 2 phiên vẫn bị gộp thành 5),
 * nhưng nó giữ đúng cái mà cả hai mẫu hình cần: hình dạng của một đoạn giá dài hơn một phiên.
 */
import { medianInterval, type Candle } from '@/lib/indicators/math';
import {
  bool,
  num,
  type IndicatorBox,
  type IndicatorDef,
  type IndicatorLabel,
  type IndicatorLine,
  type IndicatorMarker,
} from '@/lib/indicators/types';

const C = {
  bull: '#089981',
  bear: '#F23645',
  sweep: '#2962FF',
  ink: '#787B86',
};

const price = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Một nến của khung lớn, kèm khoảng nến gốc đã gộp vào nó. */
interface Grouped {
  open: number;
  high: number;
  low: number;
  close: number;
  start: number;
  end: number;
  /** Nến gốc tạo ra đỉnh và đáy của nhóm — chỗ đặt dấu, thay vì đặt bừa ở giữa nhóm. */
  highIndex: number;
  lowIndex: number;
}

/**
 * Gộp nến theo lô `size`, **căn từ nến mới nhất về quá khứ**.
 *
 * Căn từ đầu dữ liệu thì mỗi lần tải thêm lịch sử, ranh giới các nhóm dịch đi và toàn bộ tín
 * hiệu vẽ lại ở chỗ khác — người dùng thấy chỉ báo "nhảy" dù không đổi tham số gì.
 */
function groupCandles(candles: Candle[], size: number): Grouped[] {
  const step = Math.max(1, Math.round(size));
  if (step === 1) {
    return candles.map((candle, i) => ({
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      start: i,
      end: i,
      highIndex: i,
      lowIndex: i,
    }));
  }

  const groups: Grouped[] = [];
  const offset = candles.length % step;

  for (let start = offset ? offset - step : 0; start < candles.length; start += step) {
    const from = Math.max(0, start);
    const to = Math.min(candles.length - 1, start + step - 1);
    if (to < from) continue;

    let highIndex = from;
    let lowIndex = from;
    for (let i = from + 1; i <= to; i++) {
      if (candles[i].high > candles[highIndex].high) highIndex = i;
      if (candles[i].low < candles[lowIndex].low) lowIndex = i;
    }

    groups.push({
      open: candles[from].open,
      high: candles[highIndex].high,
      low: candles[lowIndex].low,
      close: candles[to].close,
      start: from,
      end: to,
      highIndex,
      lowIndex,
    });
  }

  return groups;
}

/* ═══ FVG Crossfire | Flux Charts ═══════════════════════════════════════ */

interface Gap {
  top: number;
  bottom: number;
  /** Nến gốc nơi khoảng trống hình thành. */
  index: number;
  bullish: boolean;
  /** Nến gốc đầu tiên lấp đầy khoảng trống, `null` nếu còn nguyên. */
  filledAt: number | null;
}

/**
 * Khoảng trống giá trị hợp lý: nến giữa chạy nhanh tới mức nến trước và nến sau không chạm nhau.
 *
 * Xét trên nhóm nến (`groups`) nên cùng một hàm dùng được cho mọi khung: khung ngày là nhóm
 * kích thước 1.
 */
function findGaps(candles: Candle[], groups: Grouped[]): Gap[] {
  const gaps: Gap[] = [];

  for (let i = 2; i < groups.length; i++) {
    const before = groups[i - 2];
    const current = groups[i];

    const bullish = current.low > before.high;
    const bearish = current.high < before.low;
    if (!bullish && !bearish) continue;

    const gap: Gap = {
      top: bullish ? current.low : before.low,
      bottom: bullish ? before.high : current.high,
      index: current.end,
      bullish,
      filledAt: null,
    };

    // Lấp đầy tính trên nến gốc, không tính trên nhóm: giá chạm vào giữa tuần thì khoảng trống
    // đã mất tác dụng rồi, đợi hết tuần mới ghi nhận là trễ mất mấy phiên.
    for (let j = gap.index + 1; j < candles.length; j++) {
      const done = gap.bullish ? candles[j].low <= gap.bottom : candles[j].high >= gap.top;
      if (done) {
        gap.filledAt = j;
        break;
      }
    }

    gaps.push(gap);
  }

  return gaps;
}

const fvgCrossfire: IndicatorDef = {
  id: 'fvg_crossfire',
  name: 'FVG Crossfire | Flux Charts',
  short: 'FVG Crossfire',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['htf1', 'htf2'],
  params: [
    { key: 'htf1', label: 'Khung trung bình (số nến gộp)', type: 'number', default: 5, min: 2, max: 60 },
    { key: 'htf2', label: 'Khung lớn (số nến gộp)', type: 'number', default: 20, min: 3, max: 200 },
    { key: 'showBase', label: 'Vẽ cả khoảng trống khung ngày', type: 'boolean', default: true },
    { key: 'maxBoxes', label: 'Số khoảng trống tối đa mỗi khung', type: 'number', default: 12, min: 1, max: 60 },
    { key: 'showFilled', label: 'Giữ lại khoảng trống đã lấp', type: 'boolean', default: false },
    { key: 'extend', label: 'Kéo dài sang phải (số phiên)', type: 'number', default: 10, min: 0, max: 200 },
  ],
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => {
    const boxes: IndicatorBox[] = [];
    if (candles.length < 10) return {};

    const interval = medianInterval(candles);
    const rightEdge = candles[candles.length - 1].time + interval * num(p, 'extend');
    const maxBoxes = num(p, 'maxBoxes');
    const showFilled = bool(p, 'showFilled');

    /* Ba khung chồng lên nhau — chỗ nào nhiều khung cùng chỉ vào thì màu tự cộng dồn thành đậm
       hơn hẳn. Đó là toàn bộ ý của chữ "crossfire": vùng đáng chú ý là vùng giao nhau, và mắt
       nhận ra nó mà không cần đọc chú thích nào. */
    const timeframes = [
      { size: 1, alpha: 0.07, enabled: bool(p, 'showBase') },
      { size: num(p, 'htf1'), alpha: 0.1, enabled: true },
      { size: num(p, 'htf2'), alpha: 0.13, enabled: true },
    ];

    for (const timeframe of timeframes) {
      if (!timeframe.enabled) continue;

      const gaps = findGaps(candles, groupCandles(candles, timeframe.size))
        .filter((gap) => showFilled || gap.filledAt === null)
        .slice(-maxBoxes);

      for (const gap of gaps) {
        const rgb = gap.bullish ? '8,153,129' : '242,54,69';
        boxes.push({
          from: { time: candles[gap.index].time, price: gap.top },
          to: {
            time: gap.filledAt === null ? rightEdge : candles[gap.filledAt].time,
            price: gap.bottom,
          },
          fill: `rgba(${rgb},${timeframe.alpha})`,
        });
      }
    }

    return { boxes };
  },
};

/* ═══ CRT | Turtle Soup (ICT) ═══════════════════════════════════════════ */

const turtleSoup: IndicatorDef = {
  id: 'crt_turtle_soup',
  name: 'CRT | Turtle Soup (ICT)',
  short: 'CRT / Turtle Soup',
  category: 'trend',
  placement: 'overlay',
  labelParams: ['groupSize'],
  params: [
    { key: 'groupSize', label: 'Số nến gộp thành một nến lớn', type: 'number', default: 5, min: 1, max: 60 },
    { key: 'maxSignals', label: 'Số tín hiệu gần nhất', type: 'number', default: 20, min: 1, max: 100 },
    { key: 'minSweep', label: 'Quét tối thiểu (% biên độ nến trước)', type: 'number', default: 0, min: 0, max: 50, step: 0.5 },
    { key: 'showRange', label: 'Tô khoảng của nến bị quét', type: 'boolean', default: true },
    { key: 'showLevel', label: 'Kẻ mức thanh khoản bị quét', type: 'boolean', default: true },
  ],
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => {
    const boxes: IndicatorBox[] = [];
    const lines: IndicatorLine[] = [];
    const labels: IndicatorLabel[] = [];
    const markers: IndicatorMarker[] = [];
    if (candles.length < 10) return {};

    const groups = groupCandles(candles, num(p, 'groupSize'));
    const minSweep = num(p, 'minSweep') / 100;
    const showRange = bool(p, 'showRange');
    const showLevel = bool(p, 'showLevel');

    interface Signal {
      group: Grouped;
      previous: Grouped;
      bullish: boolean;
      level: number;
      barIndex: number;
    }
    const signals: Signal[] = [];

    for (let i = 1; i < groups.length; i++) {
      const previous = groups[i - 1];
      const current = groups[i];
      const span = previous.high - previous.low;
      const need = span * minSweep;

      /* Turtle Soup: giá **đâm qua** đỉnh (hoặc đáy) của đoạn trước rồi đóng cửa lại trong đoạn
         đó. Bóng nến vượt ra là để quét lệnh dừng lỗ nằm sẵn ngoài biên; đóng cửa quay vào trong
         nghĩa là cú vượt không được chấp nhận, nên hướng đi tiếp thường là hướng ngược lại. */
      const sweptHigh = current.high > previous.high + need && current.close < previous.high;
      const sweptLow = current.low < previous.low - need && current.close > previous.low;

      if (sweptHigh) {
        signals.push({
          group: current,
          previous,
          bullish: false,
          level: previous.high,
          barIndex: current.highIndex,
        });
      } else if (sweptLow) {
        signals.push({
          group: current,
          previous,
          bullish: true,
          level: previous.low,
          barIndex: current.lowIndex,
        });
      }
    }

    for (const signal of signals.slice(-num(p, 'maxSignals'))) {
      const color = signal.bullish ? C.bull : C.bear;

      markers.push({
        time: candles[signal.barIndex].time,
        position: signal.bullish ? 'belowBar' : 'aboveBar',
        shape: 'circle',
        color: C.sweep,
      });

      if (showRange) {
        boxes.push({
          from: { time: candles[signal.previous.start].time, price: signal.previous.high },
          to: { time: candles[signal.previous.end].time, price: signal.previous.low },
          fill: signal.bullish ? 'rgba(8,153,129,0.08)' : 'rgba(242,54,69,0.08)',
          border: `rgba(120,123,134,0.5)`,
        });
      }

      if (showLevel) {
        lines.push({
          from: { time: candles[signal.previous.start].time, price: signal.level },
          to: { time: candles[signal.group.end].time, price: signal.level },
          color,
          lineStyle: 'dashed',
        });
      }

      labels.push({
        time: candles[signal.group.end].time,
        price: signal.level,
        text: `TS ${price(signal.level)}`,
        color,
        align: 'left',
        valign: signal.bullish ? 'below' : 'above',
        fontSize: 9,
        background: true,
      });
    }

    return { boxes, lines, labels, markers };
  },
};

export const ICT_INDICATORS: IndicatorDef[] = [fvgCrossfire, turtleSoup];
