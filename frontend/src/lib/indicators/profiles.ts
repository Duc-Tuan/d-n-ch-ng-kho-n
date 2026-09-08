/**
 * Hồ sơ khối lượng theo giá (volume profile).
 *
 * Hai chỉ báo ở đây trả lời cùng một câu hỏi — **khối lượng đã dồn vào vùng giá nào** — nhưng
 * đóng khung câu hỏi khác nhau:
 *
 * * `weighted_volume_profile` chia khối lượng thành phần mua và phần bán rồi vẽ hai thanh cho
 *   mỗi dải giá, để thấy vùng nào bên mua áp đảo.
 * * `regression_volume_profile` gắn hồ sơ đó vào một kênh hồi quy (bậc 1 hoặc đa thức), để đọc
 *   vùng giá đông người giao dịch **trong bối cảnh xu hướng** chứ không phải một mình nó.
 *
 * ⚠️ Nến ngày chỉ có OHLCV, không có dữ liệu khớp lệnh từng mức giá. Khối lượng một phiên được
 * **rải đều** trên đoạn cao–thấp của phiên đó; đây là cách xấp xỉ tiêu chuẩn khi không có dữ
 * liệu tick, và nó đủ tốt để nhận ra vùng giá đông, nhưng đừng đọc nó như số liệu khớp thật.
 */
import { medianInterval, type Candle } from '@/lib/indicators/math';
import {
  bool,
  num,
  str,
  type IndicatorBox,
  type IndicatorDef,
  type IndicatorLabel,
  type IndicatorLine,
  type IndicatorTable,
} from '@/lib/indicators/types';

const C = {
  buy: 'rgba(8,153,129,0.85)',
  sell: 'rgba(242,54,69,0.8)',
  poc: '#F0B90B',
  curve: '#FF9800',
  band: 'rgba(120,123,134,0.75)',
  profile: 'rgba(255,152,0,0.9)',
  bull: '#089981',
  bear: '#F23645',
  ink: '#787B86',
};

/* ═══ Nền chung: rải khối lượng theo giá ════════════════════════════════ */

export interface VolumeBucket {
  low: number;
  high: number;
  mid: number;
  volume: number;
  /** Phần khối lượng quy cho bên mua — xem `buyShare`. */
  buy: number;
  sell: number;
}

/**
 * Tỉ lệ khối lượng quy cho bên mua trong một phiên.
 *
 * Đóng cửa sát đỉnh phiên ⇒ bên mua thắng thế cả phiên; sát đáy ⇒ ngược lại. Cách chia nhị phân
 * "phiên tăng thì toàn bộ là mua" làm mất hẳn thông tin của những phiên mở cao đóng thấp — vốn
 * là đúng loại phiên mà hồ sơ khối lượng cần chỉ ra.
 */
function buyShare(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range <= 0) return 0.5;
  return Math.min(1, Math.max(0, (candle.close - candle.low) / range));
}

export interface VolumeProfile {
  buckets: VolumeBucket[];
  /** Dải có khối lượng lớn nhất — Point of Control. */
  poc: VolumeBucket | null;
  maxVolume: number;
  totalVolume: number;
  low: number;
  high: number;
}

/**
 * Dựng hồ sơ khối lượng cho các nến trong `[start, end)`, chia thành `bins` dải giá đều nhau.
 *
 * Khối lượng mỗi phiên rải theo **phần giao nhau** giữa đoạn cao–thấp của phiên và từng dải, nên
 * một phiên biên độ rộng đóng góp vào nhiều dải thay vì dồn hết vào một chỗ.
 */
export function volumeByPrice(
  candles: Candle[],
  start: number,
  end: number,
  bins: number,
): VolumeProfile {
  const empty: VolumeProfile = {
    buckets: [],
    poc: null,
    maxVolume: 0,
    totalVolume: 0,
    low: 0,
    high: 0,
  };
  if (start >= end || bins < 1) return empty;

  let low = Infinity;
  let high = -Infinity;
  for (let i = start; i < end; i++) {
    low = Math.min(low, candles[i].low);
    high = Math.max(high, candles[i].high);
  }
  if (!Number.isFinite(low) || high <= low) return empty;

  const step = (high - low) / bins;
  const buckets: VolumeBucket[] = Array.from({ length: bins }, (_, i) => ({
    low: low + i * step,
    high: low + (i + 1) * step,
    mid: low + (i + 0.5) * step,
    volume: 0,
    buy: 0,
    sell: 0,
  }));

  for (let i = start; i < end; i++) {
    const candle = candles[i];
    const volume = candle.volume;
    if (!volume) continue;

    const share = buyShare(candle);
    const span = candle.high - candle.low;

    if (span <= 0) {
      // Phiên trần/sàn không biên độ: dồn cả vào dải chứa mức giá đó.
      const index = Math.min(bins - 1, Math.max(0, Math.floor((candle.close - low) / step)));
      buckets[index].volume += volume;
      buckets[index].buy += volume * share;
      buckets[index].sell += volume * (1 - share);
      continue;
    }

    const first = Math.min(bins - 1, Math.max(0, Math.floor((candle.low - low) / step)));
    const last = Math.min(bins - 1, Math.max(0, Math.floor((candle.high - low) / step)));

    for (let b = first; b <= last; b++) {
      const overlap =
        Math.min(candle.high, buckets[b].high) - Math.max(candle.low, buckets[b].low);
      if (overlap <= 0) continue;

      const part = (overlap / span) * volume;
      buckets[b].volume += part;
      buckets[b].buy += part * share;
      buckets[b].sell += part * (1 - share);
    }
  }

  let poc: VolumeBucket | null = null;
  let maxVolume = 0;
  let totalVolume = 0;
  for (const bucket of buckets) {
    totalVolume += bucket.volume;
    if (bucket.volume > maxVolume) {
      maxVolume = bucket.volume;
      poc = bucket;
    }
  }

  return { buckets, poc, maxVolume, totalVolume, low, high };
}

/** 132.262M, 849.925K — cùng cách in khối lượng với nhãn ZigZag. */
export function compactVolume(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(3)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(3)}M`;
  if (abs >= 1e3) return `${(value / 1e3).toFixed(3)}K`;
  return value.toFixed(0);
}

const price = (value: number) => value.toLocaleString('vi-VN', { maximumFractionDigits: 2 });

/** Cửa sổ nến được xét: `length` nến cuối, kẹp trong dữ liệu đang có. */
function window(candles: Candle[], length: number): { start: number; end: number } {
  const end = candles.length;
  return { start: Math.max(0, end - Math.max(2, length)), end };
}

/* ═══ Weighted Volume Profile | Flux Charts ═════════════════════════════ */

const weightedVolumeProfile: IndicatorDef = {
  id: 'weighted_volume_profile',
  name: 'Weighted Volume Profile | Flux Charts',
  short: 'Weighted VP',
  category: 'volume',
  placement: 'overlay',
  labelParams: ['length', 'rows'],
  params: [
    { key: 'length', label: 'Số phiên xét', type: 'number', default: 200, min: 10, max: 2000 },
    { key: 'rows', label: 'Số dải giá', type: 'number', default: 30, min: 5, max: 120 },
    {
      key: 'position',
      label: 'Vẽ hồ sơ ở phía',
      type: 'select',
      default: 'left',
      options: [
        { value: 'left', label: 'Trái cửa sổ' },
        { value: 'right', label: 'Phải cửa sổ' },
      ],
    },
    { key: 'widthPct', label: 'Bề rộng hồ sơ (% cửa sổ)', type: 'number', default: 30, min: 5, max: 90 },
    { key: 'showPoc', label: 'Kẻ đường POC ngang biểu đồ', type: 'boolean', default: true },
    { key: 'showValueArea', label: 'Tô vùng giá trị 70%', type: 'boolean', default: true },
  ],
  plots: [],
  compute: () => ({}),
  computeShapes: (candles, p) => {
    const boxes: IndicatorBox[] = [];
    const lines: IndicatorLine[] = [];
    const labels: IndicatorLabel[] = [];
    if (candles.length < 5) return {};

    const { start, end } = window(candles, num(p, 'length'));
    const profile = volumeByPrice(candles, start, end, num(p, 'rows'));
    if (!profile.poc || !profile.maxVolume) return {};

    const interval = medianInterval(candles);
    const bars = end - start;
    const widthBars = Math.max(3, Math.round((bars * num(p, 'widthPct')) / 100));
    const toRight = str(p, 'position') === 'left';

    // Gốc của mọi thanh. Vẽ ở phía trái thì thanh mọc sang phải và ngược lại — hồ sơ luôn nằm
    // **trong** cửa sổ đang xét, không thò ra vùng nến mà nó không tính.
    const anchor = toRight ? candles[start].time : candles[end - 1].time;
    const direction = toRight ? 1 : -1;

    // Vùng giá trị: các dải quanh POC gom đủ 70% khối lượng — quy ước chuẩn của market profile.
    const valueArea = new Set<number>();
    if (bool(p, 'showValueArea')) {
      const ordered = profile.buckets
        .map((bucket, index) => ({ bucket, index }))
        .sort((a, b) => b.bucket.volume - a.bucket.volume);
      let sum = 0;
      for (const item of ordered) {
        if (sum >= profile.totalVolume * 0.7) break;
        sum += item.bucket.volume;
        valueArea.add(item.index);
      }
    }

    profile.buckets.forEach((bucket, index) => {
      if (!bucket.volume) return;

      const inValueArea = valueArea.has(index);
      const opacity = inValueArea ? 1 : 0.45;

      // Mỗi dải hai thanh: nửa trên là mua, nửa dưới là bán. Xếp chồng thành một thanh duy nhất
      // thì không còn đọc được bên nào áp đảo, mà đó chính là điểm của chữ "weighted".
      const pairs: { volume: number; from: number; to: number; color: string }[] = [
        { volume: bucket.buy, from: bucket.mid, to: bucket.high, color: C.buy },
        { volume: bucket.sell, from: bucket.low, to: bucket.mid, color: C.sell },
      ];

      for (const pair of pairs) {
        if (pair.volume <= 0) continue;
        const length = (pair.volume / profile.maxVolume) * widthBars;
        if (length < 0.05) continue;

        boxes.push({
          from: { time: anchor, price: pair.from },
          to: { time: anchor + direction * length * interval, price: pair.to },
          fill: opacity === 1 ? pair.color : pair.color.replace(/0\.\d+\)$/, '0.35)'),
        });
      }
    });

    if (bool(p, 'showPoc')) {
      const poc = profile.poc;
      lines.push({
        from: { time: candles[0].time, price: poc.mid },
        to: { time: candles[end - 1].time + interval * 6, price: poc.mid },
        color: C.poc,
      });
      labels.push({
        time: candles[end - 1].time + interval * 6,
        price: poc.mid,
        text: `POC ${price(poc.mid)} · ${compactVolume(poc.volume)}`,
        color: C.poc,
        align: 'right',
        valign: 'above',
        background: true,
      });
    }

    return { boxes, lines, labels };
  },
};

/* ═══ Polynomial / Linear Regression Volume Profile [BigBeluga] ═════════ */

/**
 * Hồi quy bình phương tối thiểu bậc `degree` trên `y`, với x chuẩn hoá về `[0, 1]`.
 *
 * Chuẩn hoá x là bắt buộc chứ không phải cho gọn: với 200 nến và bậc 3, ma trận chuẩn tắc chứa
 * tổng của x⁶ ≈ 10¹⁴ — đủ để phép khử Gauss trên số thực 64 bit mất sạch chữ số có nghĩa và trả
 * về một đường cong bậy bạ.
 */
function polyFit(y: number[], degree: number): number[] {
  const n = y.length;
  const order = Math.min(degree, n - 1);
  if (order < 1) return [y.reduce((sum, value) => sum + value, 0) / Math.max(1, n)];

  const size = order + 1;
  // Ma trận chuẩn tắc AᵀA | Aᵀy, dựng thẳng từ tổng luỹ thừa thay vì nhân ma trận đầy đủ.
  const powerSums = new Array<number>(2 * order + 1).fill(0);
  const targets = new Array<number>(size).fill(0);

  for (let i = 0; i < n; i++) {
    const x = n === 1 ? 0 : i / (n - 1);
    let power = 1;
    for (let k = 0; k <= 2 * order; k++) {
      powerSums[k] += power;
      if (k <= order) targets[k] += power * y[i];
      power *= x;
    }
  }

  const matrix: number[][] = Array.from({ length: size }, (_, row) =>
    Array.from({ length: size + 1 }, (_, col) =>
      col === size ? targets[row] : powerSums[row + col],
    ),
  );

  // Khử Gauss có chọn trụ theo cột — không chọn trụ thì một hàng có hệ số đầu bằng 0 là chia cho 0.
  for (let col = 0; col < size; col++) {
    let pivot = col;
    for (let row = col + 1; row < size; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-12) continue;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];

    for (let row = 0; row < size; row++) {
      if (row === col) continue;
      const factor = matrix[row][col] / matrix[col][col];
      for (let k = col; k <= size; k++) matrix[row][k] -= factor * matrix[col][k];
    }
  }

  return matrix.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[size] / row[i]));
}

function evalPoly(coefficients: number[], x: number): number {
  let result = 0;
  let power = 1;
  for (const coefficient of coefficients) {
    result += coefficient * power;
    power *= x;
  }
  return result;
}

const regressionVolumeProfile: IndicatorDef = {
  id: 'regression_volume_profile',
  name: 'Polynomial/Linear Regression Volume Profile [BigBeluga]',
  short: 'Regression VP',
  category: 'volume',
  placement: 'overlay',
  labelParams: ['length', 'degree', 'bins'],
  params: [
    { key: 'source', label: 'Nguồn giá', type: 'source', default: 'hl2' },
    { key: 'length', label: 'Số phiên xét', type: 'number', default: 200, min: 20, max: 2000 },
    {
      key: 'model',
      label: 'Dạng hồi quy',
      type: 'select',
      default: 'poly',
      options: [
        { value: 'poly', label: 'Đa thức' },
        { value: 'linear', label: 'Tuyến tính' },
      ],
    },
    { key: 'degree', label: 'Bậc đa thức', type: 'number', default: 2, min: 2, max: 5 },
    { key: 'bins', label: 'Số dải giá của hồ sơ', type: 'number', default: 20, min: 5, max: 80 },
    { key: 'widthPct', label: 'Bề rộng hồ sơ (% cửa sổ)', type: 'number', default: 12, min: 3, max: 60 },
    { key: 'showBands', label: 'Kẻ dải ±1/±2/±3 độ lệch chuẩn', type: 'boolean', default: true },
    { key: 'showTable', label: 'Hiện bảng tổng kết', type: 'boolean', default: true },
  ],
  compute: () => ({}),
  plots: [],
  computeShapes: (candles, p) => {
    const lines: IndicatorLine[] = [];
    const boxes: IndicatorBox[] = [];
    const labels: IndicatorLabel[] = [];
    const tables: IndicatorTable[] = [];
    if (candles.length < 20) return {};

    const { start, end } = window(candles, num(p, 'length'));
    const size = end - start;
    if (size < 10) return {};

    const sourceKey = str(p, 'source');
    const values: number[] = [];
    for (let i = start; i < end; i++) {
      const candle = candles[i];
      values.push(
        sourceKey === 'hl2'
          ? (candle.high + candle.low) / 2
          : sourceKey === 'hlc3'
            ? (candle.high + candle.low + candle.close) / 3
            : sourceKey === 'ohlc4'
              ? (candle.open + candle.high + candle.low + candle.close) / 4
              : sourceKey === 'open'
                ? candle.open
                : sourceKey === 'high'
                  ? candle.high
                  : sourceKey === 'low'
                    ? candle.low
                    : candle.close,
      );
    }

    const degree = str(p, 'model') === 'linear' ? 1 : num(p, 'degree');
    const coefficients = polyFit(values, degree);
    const fitted = values.map((_, i) => evalPoly(coefficients, i / (size - 1)));

    // Độ lệch chuẩn của phần dư — bề rộng kênh, chứ không phải độ lệch của chính giá.
    let sumSquares = 0;
    for (let i = 0; i < size; i++) sumSquares += (values[i] - fitted[i]) ** 2;
    const deviation = Math.sqrt(sumSquares / size);

    // Vẽ thưa bớt: 200 nến × 7 đường là 1.400 đoạn phải vẽ lại sau mỗi lần kéo biểu đồ, trong
    // khi đường cong bậc hai thì cứ vài nến mới lệch được một điểm ảnh.
    const step = Math.max(1, Math.floor(size / 120));
    const band = (offset: number, color: string, style: 'solid' | 'dashed') => {
      for (let i = step; i < size; i += step) {
        const from = i - step;
        lines.push({
          from: { time: candles[start + from].time, price: fitted[from] + offset },
          to: { time: candles[start + i].time, price: fitted[i] + offset },
          color,
          lineStyle: style,
        });
      }
    };

    band(0, C.curve, 'solid');
    if (bool(p, 'showBands')) {
      for (const multiple of [1, 2, 3]) {
        band(deviation * multiple, C.band, 'dashed');
        band(-deviation * multiple, C.band, 'dashed');
      }
    }

    /* Hồ sơ khối lượng, mọc sang phải từ nến cuối — chỗ trống duy nhất không đè lên nến. */
    const profile = volumeByPrice(candles, start, end, num(p, 'bins'));
    const interval = medianInterval(candles);
    const widthBars = Math.max(3, Math.round((size * num(p, 'widthPct')) / 100));
    const anchor = candles[end - 1].time;

    if (profile.poc && profile.maxVolume) {
      for (const bucket of profile.buckets) {
        if (!bucket.volume) continue;
        const length = (bucket.volume / profile.maxVolume) * widthBars;
        if (length < 0.05) continue;

        const isPoc = bucket === profile.poc;
        boxes.push({
          from: { time: anchor, price: bucket.low },
          to: { time: anchor + length * interval, price: bucket.high },
          // Dải càng nhiều khối lượng càng đậm: mắt bắt được hình dạng hồ sơ trước khi đọc số.
          fill: isPoc
            ? C.profile
            : `rgba(255,152,0,${(0.15 + 0.6 * (bucket.volume / profile.maxVolume)).toFixed(2)})`,
        });
      }

      labels.push({
        time: anchor + widthBars * interval,
        price: profile.poc.mid,
        text: `POC ${compactVolume(profile.poc.volume)}`,
        color: C.profile,
        align: 'left',
        valign: 'middle',
        background: true,
      });
    }

    if (bool(p, 'showTable')) {
      const slope = fitted[size - 1] - fitted[Math.max(0, size - 1 - step)];
      const bullish = slope >= 0;
      tables.push({
        title: 'Ma trận hồi quy',
        corner: 'top-right',
        rows: [
          {
            label: 'Xu hướng',
            value: bullish ? 'Tăng' : 'Giảm',
            color: bullish ? C.bull : C.bear,
          },
          { label: 'Mức POC', value: profile.poc ? price(profile.poc.mid) : '—', color: C.profile },
          {
            label: 'Khối lượng POC',
            value: profile.poc ? compactVolume(profile.poc.volume) : '—',
            color: C.profile,
          },
          {
            label: 'Biên kênh (±3σ)',
            value: `${price(fitted[size - 1] + deviation * 3)} / ${price(fitted[size - 1] - deviation * 3)}`,
          },
        ],
      });
    }

    return { lines, boxes, labels, tables };
  },
};

export const PROFILE_INDICATORS: IndicatorDef[] = [
  weightedVolumeProfile,
  regressionVolumeProfile,
];
