/**
 * Hai mục trong danh mục chỉ báo, dùng chung một lõi tính toán.
 *
 * Khung chỉ báo quy định mỗi `IndicatorDef` vẽ ở **một** chỗ — đè lên nến *hoặc* cửa sổ riêng
 * (`placement`). Bộ này cần cả hai, nên nó là hai mục:
 *
 * * `quantum_multi_engine` — lớp vẽ đè: vùng giá trị, hồ sơ khối lượng, thẻ tín hiệu, kế hoạch
 *   vào lệnh, bảng tổng hợp.
 * * `quantum_resonance` — cửa sổ riêng bên dưới: hai đường động lượng và cột lệch khối lượng.
 *
 * Cả hai gọi cùng `analyze()`, nên con số ở bảng và hình ở cửa sổ không bao giờ lệch nhau. Sửa
 * khung cho một def vẽ được hai chỗ là đụng `useChartSync`, `IndicatorPane`, `useIndicators` và
 * `PriceChart` — lớn hơn nhiều và không phục vụ chỉ báo nào khác.
 *
 * Mọi chữ hiển thị đều lấy từ `text.ts`; ở đây không có chuỗi tiếng Anh nào lọt ra biểu đồ.
 */
import { INDICATOR_COLORS as C } from '@/lib/indicators/overlays';
import {
  num,
  type IndicatorDef,
  type IndicatorLabel,
  type IndicatorShapes,
  type IndicatorTableRow,
  type ParamValues,
} from '@/lib/indicators/types';
import { medianInterval, type Candle, type Series } from '@/lib/indicators/math';

import {
  orderBlocks,
  structureLabels,
  supportResistance,
  swingPointLabels,
  thinLabels,
  volumeProfileLayer,
} from './layers';
import { QUANTUM_PARAMS, analyze, type QuantumState } from './state';
import {
  DIRECTION_TEXT,
  MARKET_TEXT,
  OUTCOME_TEXT,
  SIGNAL_TEXT,
  TREND_TEXT,
  barsAgoText,
  resonanceStateText,
  resonanceText,
  scoreText,
} from './text';

/* ── Bảng màu ───────────────────────────────────────────────────────────── */

const UP = C.green;
const DOWN = C.red;
const CLOUD = 'rgba(126, 87, 194, 0.45)';
/** Viền dải mây — mờ hơn hẳn phần tô, để hai đường động lượng vẫn là thứ mắt bắt trước. */
const CLOUD_LINE = 'rgba(126, 87, 194, 0.55)';
const NEUTRAL = C.gray;
/** Cam cho dừng lỗ đang trượt — phân biệt với đỏ của mức ban đầu, đúng như thiết kế gốc. */
const TRAIL = C.orange;

const dirColor = (direction: 'BULL' | 'BEAR') => (direction === 'BULL' ? UP : DOWN);

/* ── Tham số dùng chung cho cả hai mục ──────────────────────────────────── */

const PARAMS: IndicatorDef['params'] = [
  { key: 'fastLength', label: 'Động lượng nhanh', type: 'number', default: QUANTUM_PARAMS.fastLength, min: 2 },
  { key: 'slowLength', label: 'Động lượng chậm', type: 'number', default: QUANTUM_PARAMS.slowLength, min: 3 },
  { key: 'volumeLookback', label: 'Cửa sổ khối lượng', type: 'number', default: QUANTUM_PARAMS.volumeLookback, min: 5 },
  { key: 'zoneLookback', label: 'Cửa sổ vùng giá trị', type: 'number', default: QUANTUM_PARAMS.zoneLookback, min: 10 },
  { key: 'minScore', label: 'Ngưỡng cộng hưởng', type: 'number', default: QUANTUM_PARAMS.minScore, min: 1, max: 100 },
];

const RISK_PARAMS: IndicatorDef['params'] = [
  { key: 'stopAtr', label: 'Dừng lỗ (× ATR)', type: 'number', default: QUANTUM_PARAMS.stopAtr, min: 0.5, step: 0.5 },
  { key: 'target1Atr', label: 'Chốt lời 1 (× ATR)', type: 'number', default: QUANTUM_PARAMS.target1Atr, min: 0.5, step: 0.5 },
  { key: 'target2Atr', label: 'Chốt lời 2 (× ATR)', type: 'number', default: QUANTUM_PARAMS.target2Atr, min: 0.5, step: 0.5 },
];

/* ══════════════════════════════════════════════════════════════════════════
   Cửa sổ cộng hưởng
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Cửa sổ phụ **không vẽ được** hộp hay nhãn: `PriceChart` chỉ gọi `computeShapes` cho chỉ báo
 * `overlay`. Nên mọi bảng — kể cả bảng cộng hưởng của chính cửa sổ này — do mục vẽ đè phát ra.
 * Ở đây chỉ còn các đường và cột.
 */
const resonancePane: IndicatorDef = {
  id: 'quantum_resonance',
  name: 'Quantum · Bộ cộng hưởng',
  short: 'QRE',
  category: 'momentum',
  placement: 'pane',
  note: 'Cửa sổ đi kèm Quantum Multi-Engine: hai máy chấm điểm động lượng và khối lượng.',
  precision: 1,
  labelParams: ['fastLength', 'slowLength'],
  params: PARAMS,
  plots: [
    // Hai dải tô về mức 0, chồng lên nhau thành mảng mây tím ôm lấy hai đường động lượng.
    { key: 'cloudTop', label: 'Dải trên', type: 'baseline', color: CLOUD_LINE, fill: CLOUD, lineWidth: 1 },
    { key: 'cloudBottom', label: 'Dải dưới', type: 'baseline', color: CLOUD_LINE, fill: CLOUD, lineWidth: 1 },
    { key: 'slowLine', label: 'Động lượng mượt', type: 'line', color: '#E8E8EF', lineWidth: 2 },
    { key: 'fastLine', label: 'Động lượng nhanh', type: 'line', color: C.cyan, lineWidth: 2 },
    {
      key: 'imbalance',
      label: 'Lệch khối lượng',
      type: 'histogram',
      color: DOWN,
      colorBySign: { positive: UP, negative: DOWN },
    },
  ],
  levels: [{ value: 0, color: NEUTRAL, lineStyle: 'dotted' }],

  compute: (candles, params) => {
    if (!candles.length) {
      return { cloudTop: [], cloudBottom: [], slowLine: [], fastLine: [], imbalance: [] };
    }

    const state = analyze(candles, params);
    const { fast, slow, atr } = state.series;

    // Chuẩn hoá về cùng thang với cột lệch khối lượng (−100…100) để hai thứ đọc được trên cùng
    // một trục. Vẽ nguyên giá trị tuyệt đối thì đường động lượng của mã 120.000đ đè bẹp cột.
    const fastLine: Series = [];
    const slowLine: Series = [];
    const cloudTop: Series = [];
    const cloudBottom: Series = [];

    for (let i = 0; i < candles.length; i++) {
      const f = fast[i];
      const s = slow[i];
      const r = atr[i];
      if (f === null || s === null || !r) {
        fastLine.push(null);
        slowLine.push(null);
        cloudTop.push(null);
        cloudBottom.push(null);
        continue;
      }
      const spread = Math.tanh((f - s) / r) * 100;
      fastLine.push(Math.round(spread * 10) / 10);
      slowLine.push(Math.round(Math.tanh((f - s) / r / 2) * 1000) / 10);
      // Dải mây bám quanh đường mượt, rộng theo chính độ biến động đang đo.
      const width = Math.min(45, (r / Math.max(1e-9, candles[i].close)) * 2500);
      cloudTop.push(Math.round((spread + width) * 10) / 10);
      cloudBottom.push(Math.round((spread - width) * 10) / 10);
    }

    return { cloudTop, cloudBottom, slowLine, fastLine, imbalance: state.series.imbalance };
  },
};

/* ══════════════════════════════════════════════════════════════════════════
   Lớp vẽ đè + bảng tổng hợp
   ══════════════════════════════════════════════════════════════════════════ */

const fmt = (value: number): string => {
  const abs = Math.abs(value);
  return value.toFixed(abs >= 1000 ? 0 : abs >= 100 ? 1 : 2);
};

/** Bảng đa khung: mỗi khung một dòng, kèm thanh bar cho cường độ động lượng. */
function mtfRows(state: QuantumState): IndicatorTableRow[] {
  const rows: IndicatorTableRow[] = [
    { section: 'Giám sát đa khung' },
    { label: 'Khung · Xu hướng', value: 'Phân bổ động lượng', header: true },
  ];
  if (!state.mtf.length) {
    rows.push({ label: 'Dữ liệu', value: 'chưa đủ nến', color: NEUTRAL });
    return rows;
  }
  for (const row of state.mtf) {
    rows.push({
      label: `${row.label}  ${DIRECTION_TEXT[row.trend]}`,
      value: scoreText(row.momentum),
      color: dirColor(row.trend),
      bar: { ratio: row.momentum / 50, color: dirColor(row.trend) },
    });
  }
  return rows;
}

function coreRows(state: QuantumState): IndicatorTableRow[] {
  const lead = state.volume.direction === 'BULL' ? state.volume.bullPct : state.volume.bearPct;
  return [
    { section: 'Dữ liệu lõi & rủi ro' },
    {
      label: 'Cộng hưởng tức thời',
      value: resonanceStateText(state.resonance),
      color: state.resonance.direction ? dirColor(state.resonance.direction) : NEUTRAL,
    },
    {
      label: 'Trạng thái thị trường',
      value: MARKET_TEXT[state.market],
      color: state.market === 'Trending' ? C.blue : NEUTRAL,
    },
    {
      label: 'Cán cân khối lượng',
      value: `${state.volume.direction === 'BULL' ? 'Bên mua' : 'Bên bán'} dẫn (${lead.toFixed(0)}%)`,
      color: dirColor(state.volume.direction),
      bar: { ratio: (lead - 50) / 50, color: dirColor(state.volume.direction) },
    },
  ];
}

function signalRows(state: QuantumState): IndicatorTableRow[] {
  const rows: IndicatorTableRow[] = [{ section: 'Tín hiệu' }];
  const latest = state.latest;

  rows.push({
    label: 'Tín hiệu gần nhất',
    value: latest ? SIGNAL_TEXT[latest.kind] : '—',
    color: latest ? dirColor(latest.direction) : NEUTRAL,
  });
  rows.push({
    label: 'Điểm tín hiệu',
    value: latest ? `${latest.score.toFixed(1)} điểm` : '—',
    color: latest ? dirColor(latest.direction) : NEUTRAL,
  });
  rows.push({
    label: 'Động lượng hiện tại',
    value: scoreText(state.momentum.score),
    color: dirColor(state.momentum.direction),
    bar: { ratio: state.momentum.score / 50, color: dirColor(state.momentum.direction) },
  });
  rows.push({ label: 'Kích hoạt gần nhất', value: barsAgoText(state.barsSinceSignal) });
  rows.push({
    // Hai máy cùng chiều **và** đủ mạnh thì tín hiệu đã qua bộ lọc; còn lại là trạng thái để
    // người đọc tự cân nhắc — đúng nghĩa "discretionary" của thiết kế gốc.
    label: 'Trạng thái bộ lọc',
    value: state.resonance.high ? 'Đã xác nhận' : 'Tự cân nhắc',
    color: state.resonance.high ? UP : NEUTRAL,
  });
  return rows;
}

/**
 * Khối theo dõi vị thế.
 *
 * Đây là phần đi xa nhất khỏi nghĩa "chỉ báo" — nó nói có đang cầm lệnh hay không và dừng lỗ ở
 * đâu. Vì vậy phần mô tả chỉ báo luôn ghi rõ đây là kết quả công thức, không phải khuyến nghị
 * chính thức của hệ thống: tín hiệu chính thức đi qua chiến lược, có backtest và có audit log.
 */
function positionRows(state: QuantumState): IndicatorTableRow[] {
  const open = state.openPosition;
  const rows: IndicatorTableRow[] = [{ section: 'Theo dõi vị thế' }];

  if (!open) {
    const done = state.positions[state.positions.length - 1];
    rows.push({ label: 'Trạng thái', value: 'Không có vị thế', color: NEUTRAL });
    if (done) rows.push({ label: 'Lệnh gần nhất', value: OUTCOME_TEXT[done.outcome] });
    return rows;
  }

  rows.push({
    label: 'Trạng thái',
    value: `Đang mở · ${open.direction === 'BULL' ? 'Mua' : 'Bán'}`,
    color: dirColor(open.direction),
  });
  rows.push({ label: 'Giá vào lệnh', value: fmt(open.entry) });
  rows.push({ label: 'Dừng lỗ hiện tại', value: fmt(open.currentStop), color: TRAIL });
  if (open.hitTarget1) {
    // Tách riêng mức ban đầu: nhìn thấy dừng lỗ đã rời khỏi chỗ cũ mới biết lệnh hết khả năng lỗ.
    rows.push({ label: 'Dừng lỗ ban đầu', value: fmt(open.stop), color: DOWN });
  }
  rows.push({ label: 'Chốt lời 1 / 2', value: `${fmt(open.target1)} · ${fmt(open.target2)}` });
  return rows;
}

/**
 * Thẻ tín hiệu trên nến — nền đặc để đọc được khi nằm đè lên thân nến.
 *
 * Giữ nguyên `Buy` / `Sell` / `Bullish` / `Bearish` như thiết kế gốc: chữ đi kèm nến nằm chen
 * giữa các cây nến nên phải thật ngắn, mà đây cũng đúng là bộ từ người đọc biểu đồ đã quen mặt.
 * Bảng thông tin bên phải mới là chỗ diễn giải chúng ra tiếng Việt.
 */
function signalLabels(state: QuantumState, keep: number): IndicatorLabel[] {
  return state.signals.slice(-keep).map((signal) => {
    const bull = signal.direction === 'BULL';
    return {
      time: signal.time,
      price: signal.price,
      text: signal.kind,
      color: '#FFFFFF',
      align: 'center' as const,
      valign: bull ? ('below' as const) : ('above' as const),
      fontSize: 11,
      backgroundColor: bull ? UP : DOWN,
    };
  });
}

const multiEngine: IndicatorDef = {
  id: 'quantum_multi_engine',
  name: 'Quantum Multi-Engine',
  short: 'QME',
  category: 'trend',
  placement: 'overlay',
  note:
    'Bộ chỉ báo tổng hợp bằng công thức, không dùng AI. Thẻ Mua/Bán và các mức vào lệnh, chốt '
    + 'lời, dừng lỗ ở đây là kết quả tính trên máy bạn theo khung và tham số đang chọn — không '
    + 'phải khuyến nghị đầu tư đã qua kiểm duyệt của hệ thống.',
  labelParams: ['fastLength', 'slowLength'],
  params: [
    ...PARAMS,
    ...RISK_PARAMS,
    { key: 'swingLength', label: 'Độ dài sóng (cấu trúc)', type: 'number', default: 10, min: 2 },
    { key: 'showZones', label: 'Vùng đắt / cân bằng / rẻ', type: 'boolean', default: true },
    { key: 'showStructure', label: 'Khối lệnh · cấu trúc · hỗ trợ/kháng cự', type: 'boolean', default: true },
    { key: 'showSwingPoints', label: 'Nhãn đỉnh đáy', type: 'boolean', default: true },
    { key: 'showProfile', label: 'Hồ sơ khối lượng mua/bán', type: 'boolean', default: true },
    { key: 'profileBins', label: 'Số dải giá của hồ sơ', type: 'number', default: 26, min: 5, max: 80 },
    { key: 'profileWidth', label: 'Bề rộng hồ sơ (% cửa sổ)', type: 'number', default: 45, min: 5, max: 100 },
    { key: 'showGauge', label: 'Thanh đo vị trí giá', type: 'boolean', default: true },
    { key: 'showSignals', label: 'Thẻ tín hiệu trên nến', type: 'boolean', default: true },
    { key: 'showPlan', label: 'Kế hoạch vào lệnh', type: 'boolean', default: true },
    { key: 'maxSignals', label: 'Số thẻ tín hiệu giữ lại', type: 'number', default: 6, min: 1, max: 50 },
  ],

  /**
   * Đường nền tách làm **hai** plot thay vì một.
   *
   * Thư viện biểu đồ không đổi được màu giữa chừng một đường; muốn đường bám giá đổi màu theo
   * chiều thị trường thì phải là hai đường chồng nhau, mỗi đường để trống ở đoạn của đường kia.
   */
  plots: [
    { key: 'baselineBull', label: 'Đường nền · tăng', type: 'line', color: UP, lineWidth: 2 },
    { key: 'baselineBear', label: 'Đường nền · giảm', type: 'line', color: DOWN, lineWidth: 2 },
  ],

  compute: (candles, params) => {
    if (!candles.length) return { baselineBull: [], baselineBear: [] };

    const { series } = analyze(candles, params);
    const bull: (number | null)[] = [];
    const bear: (number | null)[] = [];

    for (let i = 0; i < candles.length; i++) {
      const value = series.slow[i];
      const up = series.resonance[i] !== 'BEAR';
      // Nối liền chỗ giao nhau: để trống cả hai ở nến chuyển tiếp thì đường bị đứt một khoảng
      // đúng chỗ người dùng đang muốn nhìn kỹ nhất.
      const prevUp = i > 0 ? series.resonance[i - 1] !== 'BEAR' : up;
      bull.push(up || prevUp ? value : null);
      bear.push(!up || !prevUp ? value : null);
    }
    return { baselineBull: bull, baselineBear: bear };
  },

  computeShapes: (candles, params): IndicatorShapes => {
    if (candles.length < 5) return {};

    const state = analyze(candles, params);
    const p = params as ParamValues;
    const showZones = p.showZones !== false;
    const showSignals = p.showSignals !== false;
    const showPlan = p.showPlan !== false;
    const keep = Math.max(1, num(p, 'maxSignals') || 8);

    const step = medianInterval(candles);
    const rightEdge = candles[candles.length - 1].time + step * 8;

    const boxes: NonNullable<IndicatorShapes['boxes']> = [];
    const lines: NonNullable<IndicatorShapes['lines']> = [];
    const labels: NonNullable<IndicatorShapes['labels']> = [];

    /* ── Vùng đắt / cân bằng / rẻ ─────────────────────────────────────── */
    const zones = state.zones;
    if (showZones && zones) {
      boxes.push({
        from: { time: zones.fromTime, price: zones.high },
        to: { time: rightEdge, price: zones.eqTop },
        fill: 'rgba(239, 83, 80, 0.07)',
        label: 'Premium',
        labelColor: DOWN,
      });
      boxes.push({
        from: { time: zones.fromTime, price: zones.eqTop },
        to: { time: rightEdge, price: zones.eqBottom },
        fill: 'rgba(120, 123, 134, 0.10)',
        label: 'Equilibrium',
        labelColor: NEUTRAL,
      });
      boxes.push({
        from: { time: zones.fromTime, price: zones.eqBottom },
        to: { time: rightEdge, price: zones.low },
        fill: 'rgba(38, 166, 154, 0.07)',
        label: 'Discount',
        labelColor: UP,
      });
    }

    /* ── Kế hoạch vào lệnh của vị thế đang mở ─────────────────────────── */
    const open = state.openPosition;
    if (showPlan && open) {
      const from = { time: candles[open.openedIndex].time, price: open.entry };

      // Thẻ mang **cả tên lẫn giá**: đây là những con số duy nhất trên biểu đồ mà đọc lệch một
      // chữ số là hỏng cả lệnh, nên không để người dùng phải dóng sang trục giá bên phải.
      const plan: { price: number; color: string; text: string; solid?: boolean }[] = [
        { price: open.target2, color: UP, text: `TP2: ${fmt(open.target2)}` },
        { price: open.target1, color: UP, text: `TP1: ${fmt(open.target1)}` },
        { price: open.entry, color: C.cyan, text: `Entry: ${fmt(open.entry)}`, solid: true },
        { price: open.stop, color: DOWN, text: `SL: ${fmt(open.stop)}`, solid: true },
      ];

      for (const level of plan) {
        lines.push({
          from: { ...from, price: level.price },
          to: { time: rightEdge, price: level.price },
          color: level.color,
          lineStyle: level.solid ? 'solid' : 'dashed',
          label: level.text,
          labelBackground: level.color,
        });
      }

      // Dừng lỗ đang trượt vẽ thành thẻ riêng cạnh thẻ dừng lỗ gốc, đúng như thiết kế: hai con
      // số trùng nhau lúc chưa trượt, và tách ra ngay khi lệnh đã được đẩy về hoà vốn.
      if (open.hitTarget1) {
        lines.push({
          from: { ...from, price: open.currentStop },
          to: { time: rightEdge, price: open.currentStop },
          color: TRAIL,
          lineStyle: 'solid',
          label: `Trailing SL: ${fmt(open.currentStop)}`,
          labelBackground: TRAIL,
          labelOffset: 112,
        });
      }
    }

    /* ── Khối lệnh, cấu trúc, hỗ trợ/kháng cự ─────────────────────────── */
    const swingLength = Math.max(2, num(p, 'swingLength') || 10);
    // Cấu trúc nội bộ đọc bằng nửa độ dài sóng: đó là định nghĩa của "nội bộ" — những nhịp nằm
    // gọn bên trong một đợt sóng chính, chứ không phải một bộ tham số thứ hai cần chỉnh tay.
    const internalLength = Math.max(2, Math.round(swingLength / 2));

    /**
     * Bốn lớp nhãn, xếp theo mức quan trọng giảm dần.
     *
     * Tất cả đều neo vào cùng một tập đỉnh đáy nên chúng đè lên nhau rất nhiều; `thinLabels` chỉ
     * giữ lớp đứng trước ở mỗi ô lưới. Vì vậy thứ tự trong mảng này chính là thứ tự nhường chỗ.
     */
    const signalTags = showSignals ? signalLabels(state, keep) : [];
    const volumeTags: IndicatorLabel[] = [];
    const structureTags: IndicatorLabel[] = [];
    const levelTags: IndicatorLabel[] = [];
    const swingTags: IndicatorLabel[] = [];

    if (p.showStructure !== false) {
      const common = {
        timeframeLabel: state.timeframe.label,
        lookback: num(p, 'volumeLookback') || QUANTUM_PARAMS.volumeLookback,
      };

      // Lớp chính vẽ trước để lớp nội bộ nằm đè lên — nội bộ mới là thứ đang có hiệu lực gần.
      for (const block of orderBlocks(candles, { ...common, swingLength, maxBoxes: 2, scope: 'swing' })) {
        boxes.push(block.box);
        volumeTags.push(block.label);
      }
      for (const block of orderBlocks(candles, {
        ...common,
        swingLength: internalLength,
        maxBoxes: 2,
        scope: 'internal',
      })) {
        boxes.push(block.box);
        volumeTags.push(block.label);
      }

      structureTags.push(...structureLabels(candles, { swingLength: internalLength, max: 4 }));
      levelTags.push(...supportResistance(candles, { swingLength, max: 3 }));
    }

    if (p.showSwingPoints !== false) {
      const taken = new Set(levelTags.map((label) => label.time));
      swingTags.push(...swingPointLabels(candles, { swingLength, max: 5, exclude: taken }));
    }

    labels.push(
      ...thinLabels(candles, [signalTags, volumeTags, levelTags, structureTags, swingTags], {
        // Lưới thô: 16 cột × 14 hàng trên toàn bộ chuỗi. Đủ để hai nhãn cạnh nhau không dính,
        // mà vẫn giữ được nhãn ở hai vùng giá khác nhau tại cùng một quãng thời gian.
        columns: 16,
        rows: 14,
      }),
    );

    /* ── Hồ sơ khối lượng hai chiều ───────────────────────────────────── */
    if (p.showProfile !== false) {
      const profile = volumeProfileLayer(candles, {
        bins: num(p, 'profileBins') || 26,
        lookback: num(p, 'zoneLookback') || QUANTUM_PARAMS.zoneLookback,
        widthPct: num(p, 'profileWidth') || 45,
      });
      boxes.push(...profile.boxes);
      lines.push(...profile.lines);
      labels.push(...profile.labels);
    }

    /* ── Bảng ─────────────────────────────────────────────────────────── */
    const dashboard: IndicatorTableRow[] = [
      ...mtfRows(state),
      ...coreRows(state),
      ...signalRows(state),
      ...positionRows(state),
    ];

    /* ── Thanh đo vị trí giá trong biên độ ────────────────────────────── */
    const gauges: NonNullable<IndicatorShapes['gauges']> =
      zones && p.showGauge !== false
        ? [{ ratio: zones.position, label: `${(zones.position * 100).toFixed(2)}%` }]
        : [];

    return {
      boxes,
      lines,
      labels,
      gauges,
      tables: [
        { title: `Quantum Multi-Engine · ${state.timeframe.label}`, rows: dashboard, corner: 'top-right' },
        {
          // Bảng của cửa sổ cộng hưởng, nhưng do mục này phát ra — cửa sổ phụ không vẽ được bảng.
          rows: [
            { section: 'Hai máy độc lập' },
            {
              label: 'Hồ sơ khối lượng',
              value: TREND_TEXT[state.volume.direction],
              color: dirColor(state.volume.direction),
            },
            {
              label: 'Xu hướng động lượng',
              value: state.momentum.strength === 'Weak'
                ? 'Trung tính'
                : TREND_TEXT[state.momentum.direction],
              color: state.momentum.strength === 'Weak' ? NEUTRAL : dirColor(state.momentum.direction),
            },
            { section: 'Cộng hưởng lõi' },
            {
              label: 'Thiên hướng thị trường',
              value: resonanceText(state.resonance),
              color: state.resonance.direction ? dirColor(state.resonance.direction) : NEUTRAL,
            },
          ],
          // Cùng góc với bảng chính để hai bảng xếp chồng như thiết kế, và để góc dưới trái
          // trả lại cho cột khối lượng — đặt ở đó thì bảng che mất đúng phần nó đang mô tả.
          corner: 'top-right',
        },
      ],
    };
  },
};

export const QUANTUM_INDICATORS: IndicatorDef[] = [multiEngine, resonancePane];
