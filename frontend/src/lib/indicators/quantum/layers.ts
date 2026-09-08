/**
 * Các lớp vẽ đè lấy từ phân tích cấu trúc: khối lệnh, phá cấu trúc, đỉnh đáy, hỗ trợ/kháng cự,
 * và hồ sơ khối lượng chia hai bên mua/bán.
 *
 * Dùng lại `structureBreaks`, `findPivots` của bộ SMC và `volumeByPrice` của bộ hồ sơ khối lượng
 * thay vì viết lại — hai chỗ cùng đọc một cấu trúc mà tính bằng hai công thức thì bật cả hai chỉ
 * báo lên sẽ thấy hai bộ mốc lệch nhau vài cây nến, và không có cách nào biết bên nào đúng.
 *
 * Riêng khối lệnh phải có bản riêng ở đây: bản dùng chung (`orderBlockBoxes`) trả về hộp đã hoàn
 * chỉnh và **bỏ mất chỉ số cây nến gốc**, trong khi thiết kế cần đúng cây nến đó để in khối lượng
 * và tỉ trọng của nó — `9.197K (37%)`.
 */
import { findPivots, medianInterval, type Candle } from '@/lib/indicators/math';
import { compactVolume, volumeByPrice } from '@/lib/indicators/profiles';
import { structureBreaks } from '@/lib/indicators/smc';
import type { IndicatorBox, IndicatorLabel, IndicatorLine } from '@/lib/indicators/types';

const BULL = '38, 166, 154';
const BEAR = '239, 83, 80';

/** Hai màu của hồ sơ khối lượng, lấy đúng cặp lơ / hồng của thiết kế gốc. */
const BUY_RGB = '0, 188, 212';
const SELL_RGB = '224, 64, 251';

export interface OrderBlock {
  box: IndicatorBox;
  label: IndicatorLabel;
}

/**
 * Khối lệnh kèm nhãn khối lượng và tỉ trọng.
 *
 * `scope` chỉ đổi **chữ trên nhãn**, còn công thức thì giống hệt nhau — thứ làm nên khác biệt
 * giữa khối lệnh nội bộ và khối lệnh chính là `swingLength` mà nơi gọi truyền vào. Thiết kế gốc
 * vẽ cả hai lớp cùng lúc: lớp chính giữ khung của cả đợt sóng, lớp nội bộ bắt những nhịp nhỏ bên
 * trong nó. Chỉ vẽ một lớp thì hoặc mất hết mốc nhỏ, hoặc mất hẳn cái khung.
 *
 * Tỉ trọng tính trên **tổng khối lượng của cửa sổ đang xét**, không trên toàn chuỗi: chuỗi càng
 * dài thì mọi tỉ lệ càng bé dần về 0, và tới lúc đó con số 37% trong thiết kế sẽ thành 0,4% —
 * đúng về số học và vô dụng khi đọc.
 */
export function orderBlocks(
  candles: Candle[],
  options: {
    swingLength: number;
    maxBoxes: number;
    timeframeLabel: string;
    lookback: number;
    scope: 'internal' | 'swing';
  },
): OrderBlock[] {
  if (candles.length < options.swingLength * 3) return [];

  const breaks = structureBreaks(candles, options.swingLength);
  if (!breaks.length) return [];

  const window = candles.slice(-Math.max(20, options.lookback));
  const windowVolume = window.reduce((sum, c) => sum + Math.max(0, c.volume), 0);
  const interval = medianInterval(candles);
  const rightEdge = candles[candles.length - 1].time + interval * 6;
  const scopeText = options.scope === 'internal' ? 'Internal OB' : 'Swing OB';

  const out: OrderBlock[] = [];

  for (const brk of breaks.slice(-options.maxBoxes * 2)) {
    const wantBearishCandle = brk.direction === 'bull';
    let obIndex = -1;
    for (let i = brk.breakIndex - 1; i >= Math.max(0, brk.swingIndex - options.swingLength); i--) {
      const bearishCandle = candles[i].close < candles[i].open;
      if (bearishCandle === wantBearishCandle) {
        obIndex = i;
        break;
      }
    }
    if (obIndex < 0) continue;

    const ob = candles[obIndex];
    const isBull = brk.direction === 'bull';

    // Khối lệnh đã bị giá đóng cửa xuyên qua hẳn thì hết hiệu lực — không vẽ nữa.
    let mitigated = false;
    for (let i = brk.breakIndex; i < candles.length; i++) {
      if (isBull ? candles[i].close < ob.low : candles[i].close > ob.high) {
        mitigated = true;
        break;
      }
    }
    if (mitigated) continue;

    const share = windowVolume ? Math.round((ob.volume / windowVolume) * 100) : 0;
    const rgb = isBull ? BULL : BEAR;
    // Lớp chính đậm hơn lớp nội bộ: chồng hai hộp cùng độ đậm lên nhau thì chỗ giao nhau tối
    // gấp đôi và trông như một vùng thứ ba mà thật ra không tồn tại.
    const alpha = options.scope === 'swing' ? 0.16 : 0.1;

    out.push({
      box: {
        from: { time: ob.time, price: ob.high },
        to: { time: rightEdge, price: ob.low },
        fill: `rgba(${rgb},${alpha})`,
        border: `rgb(${rgb})`,
        label: `${scopeText} ${isBull ? 'Bullish' : 'Bearish'}`,
        labelColor: `rgb(${rgb})`,
      },
      label: {
        time: ob.time,
        price: (ob.high + ob.low) / 2,
        text: `${compactVolume(ob.volume)} (${share}%)\n${options.timeframeLabel}`,
        color: `rgb(${rgb})`,
        align: 'left',
        valign: 'middle',
        fontSize: 10,
      },
    });
  }

  return out.slice(-options.maxBoxes);
}

/** Nhãn `CHoCH` / `BOS` tại điểm giá vượt qua đỉnh đáy gần nhất. */
export function structureLabels(
  candles: Candle[],
  options: { swingLength: number; max: number },
): IndicatorLabel[] {
  if (candles.length < options.swingLength * 3) return [];

  return structureBreaks(candles, options.swingLength)
    .slice(-options.max)
    .map((brk) => ({
      time: candles[brk.breakIndex].time,
      price: brk.swingPrice,
      text: brk.kind === 'CHoCH' ? 'CHoCH' : 'BOS',
      color: brk.direction === 'bull' ? `rgb(${BULL})` : `rgb(${BEAR})`,
      align: 'center' as const,
      valign: brk.direction === 'bull' ? ('above' as const) : ('below' as const),
      fontSize: 9,
      background: true,
    }));
}

/**
 * Nhãn `HH / HL / LH / LL`: đỉnh đáy so với đỉnh đáy cùng loại liền trước.
 *
 * Đây mới là chỗ đọc ra được xu hướng đang hình thành: giá tạo đỉnh cao hơn *và* đáy cao hơn là
 * còn tăng; một đỉnh thấp hơn xuất hiện trước khi có nhãn phá cấu trúc là cảnh báo sớm. Chỉ có
 * mốc phá cấu trúc thì người đọc biết chuyện đã xảy ra, không biết nó đang đến.
 */
export function swingPointLabels(
  candles: Candle[],
  options: { swingLength: number; max: number; exclude?: Set<number> },
): IndicatorLabel[] {
  const pivots = findPivots(candles, options.swingLength, options.swingLength);
  const out: IndicatorLabel[] = [];

  let previousHigh: number | null = null;
  let previousLow: number | null = null;

  for (const pivot of pivots) {
    const isHigh = pivot.type === 'high';
    const previous = isHigh ? previousHigh : previousLow;
    if (isHigh) previousHigh = pivot.price;
    else previousLow = pivot.price;
    // Mốc đầu tiên của mỗi loại không có gì để so — bỏ qua thay vì gọi bừa là "cao hơn".
    if (previous === null) continue;

    // Mốc đã mang chấm hỗ trợ/kháng cự thì bỏ qua: hai nhãn cùng neo vào một cây nến, cùng
    // lệch lên trên hay xuống dưới, sẽ chồng khít lên nhau thành một vệt chữ không đọc được.
    const time = candles[pivot.index].time;
    if (options.exclude?.has(time)) continue;

    const higher = pivot.price > previous;
    out.push({
      time,
      price: pivot.price,
      text: isHigh ? (higher ? 'HH' : 'LH') : higher ? 'HL' : 'LL',
      // Màu theo **ý nghĩa** chứ không theo loại mốc: đáy cao hơn là tin tốt dù nó là đáy.
      color: higher ? `rgb(${BULL})` : `rgb(${BEAR})`,
      align: 'center',
      valign: isHigh ? 'above' : 'below',
      fontSize: 9,
      background: true,
    });
  }

  return out.slice(-options.max);
}

/**
 * Chấm hỗ trợ / kháng cự tại các đỉnh đáy đã được xác nhận.
 *
 * Chỉ lấy những mức **chưa bị xuyên qua**: một mức kháng cự đã bị vượt từ hai mươi phiên trước
 * không còn là kháng cự, và để lại nó trên biểu đồ chỉ làm rối đúng vùng giá đang giao dịch.
 */
export function supportResistance(
  candles: Candle[],
  options: { swingLength: number; max: number },
): IndicatorLabel[] {
  const pivots = findPivots(candles, options.swingLength, options.swingLength);
  const out: IndicatorLabel[] = [];

  for (const pivot of pivots) {
    const isHigh = pivot.type === 'high';
    let broken = false;
    for (let i = pivot.index + options.swingLength; i < candles.length; i++) {
      if (isHigh ? candles[i].close > pivot.price : candles[i].close < pivot.price) {
        broken = true;
        break;
      }
    }
    if (broken) continue;

    out.push({
      time: candles[pivot.index].time,
      price: pivot.price,
      // Chấm tròn đi liền chữ: thiết kế gốc đánh dấu đúng cây nến bằng một chấm màu, mà lớp vẽ
      // ở đây không có kiểu hình "điểm" riêng — nên chấm nằm luôn trong chuỗi chữ.
      text: isHigh ? '● Resistance' : '● Support',
      color: isHigh ? '#FFB300' : '#26A69A',
      align: 'center',
      valign: isHigh ? 'above' : 'below',
      fontSize: 9,
      background: true,
    });
  }

  return out.slice(-options.max);
}

export interface VolumeProfileLayer {
  boxes: IndicatorBox[];
  lines: IndicatorLine[];
  labels: IndicatorLabel[];
}

/**
 * Hồ sơ khối lượng chia hai bên — mảng hình lớn nhất còn thiếu so với thiết kế.
 *
 * Mỗi dải giá vẽ **hai** thanh: nửa trên là phần khối lượng quy cho bên mua, nửa dưới cho bên
 * bán. Vẽ một thanh tổng thì hình dạng hồ sơ vẫn đúng nhưng mất hẳn thứ mà thiết kế dựng cả bảng
 * màu hai tông để nói — ở vùng giá này ai đang là người chịu mua vào.
 *
 * Thanh mọc **sang trái** từ mép phải, đè lên vùng nến gần nhất. Thiết kế gốc đặt hồ sơ ra khoảng
 * trống bên phải cây nến cuối, nhưng biểu đồ ở đây chỉ chừa 4 nến khoảng trống (`rightOffset`
 * trong `chartTheme`), nên đặt như vậy thì gần như toàn bộ hồ sơ nằm ngoài màn hình. Đổi lại,
 * nền của thanh phải để nhạt để nến bên dưới còn đọc được.
 */
export function volumeProfileLayer(
  candles: Candle[],
  options: { bins: number; lookback: number; widthPct: number },
): VolumeProfileLayer {
  const out: VolumeProfileLayer = { boxes: [], lines: [], labels: [] };
  const end = candles.length;
  const start = Math.max(0, end - Math.max(10, options.lookback));
  const bars = end - start;
  if (bars < 10) return out;

  const profile = volumeByPrice(candles, start, end, Math.max(5, options.bins));
  if (!profile.poc || !profile.maxVolume) return out;

  const widthBars = Math.min(bars - 1, Math.max(4, Math.round((bars * options.widthPct) / 100)));

  /**
   * Mốc trái của một thanh dài `k` nến, lấy **thẳng từ mảng nến**.
   *
   * Không tính bằng `anchor - k * medianInterval`. Mốc thời gian tính kiểu đó không rơi trúng
   * cây nến nào, nên nó phải đi qua nhánh nội suy của `timeToLogical`, mà bước thời gian trung
   * vị lại không phải bước thật giữa hai phiên: nghỉ cuối tuần và nghỉ lễ làm khoảng cách lịch
   * giãn ra gấp nhiều lần khoảng cách theo chỉ số nến. Bản trước tính như vậy và cả hồ sơ kéo
   * dài ngang hết biểu đồ thay vì gọn ở mép phải. Lấy `candles[i].time` thì mốc trùng khít một
   * nến có thật, và `k` là đúng `k` cây nến — không còn phụ thuộc vào lịch nghỉ.
   */
  const timeAt = (k: number) => candles[Math.max(0, end - 1 - k)].time;
  const anchor = candles[end - 1].time;

  for (const bucket of profile.buckets) {
    if (!bucket.volume) continue;
    const isPoc = bucket === profile.poc;

    for (const side of [
      { value: bucket.buy, rgb: BUY_RGB, top: bucket.high, bottom: bucket.mid },
      { value: bucket.sell, rgb: SELL_RGB, top: bucket.mid, bottom: bucket.low },
    ]) {
      const k = Math.round((side.value / profile.maxVolume) * widthBars);
      if (k < 1) continue;
      out.boxes.push({
        from: { time: timeAt(k), price: side.top },
        to: { time: anchor, price: side.bottom },
        // Nhạt, vì hồ sơ nằm đè lên chính vùng nến gần nhất — xem ghi chú ở đầu hàm.
        fill: `rgba(${side.rgb},${isPoc ? 0.5 : 0.26})`,
      });
    }
  }

  // Trục dựng của hồ sơ: không có nó thì mắt không có mốc nào để so độ dài các thanh với nhau.
  out.lines.push({
    from: { time: anchor, price: profile.high },
    to: { time: anchor, price: profile.low },
    color: 'rgba(120, 123, 134, 0.55)',
  });

  out.labels.push({
    time: timeAt(widthBars),
    price: profile.poc.mid,
    // Nhãn đặt ở **đầu trái** của hồ sơ: đầu phải là chỗ các thẻ giá vào lệnh và dừng lỗ đứng.
    text: `POC ${compactVolume(profile.poc.volume)}`,
    color: '#FFB300',
    align: 'right',
    valign: 'middle',
    fontSize: 10,
    background: true,
  });

  return out;
}

/**
 * Bỏ bớt nhãn chồng lên nhau, giữ theo thứ tự ưu tiên.
 *
 * Bốn lớp nhãn (thẻ tín hiệu, hỗ trợ/kháng cự, cấu trúc, đỉnh đáy) đều neo vào **cùng một tập
 * đỉnh đáy**, nên chúng rơi trúng nhau là chuyện thường xuyên chứ không phải rủi ro hiếm gặp:
 * bản trước vẽ hết và cả vùng bên phải biểu đồ đặc kín chữ đè lên nhau, không đọc được chữ nào.
 *
 * Chia khung thành lưới thô rồi mỗi ô chỉ giữ nhãn đến trước. `groups` xếp theo thứ tự quan
 * trọng giảm dần, nên khi hai nhãn tranh nhau một ô thì cái bị bỏ luôn là cái ít giá trị hơn.
 *
 * Lưới đo bằng **số nến và biên độ giá**, không bằng điểm ảnh — lúc tính hình chưa biết biểu đồ
 * đang phóng to cỡ nào. Đây là xấp xỉ, nhưng là xấp xỉ đúng hướng ở mọi mức phóng.
 */
export function thinLabels(
  candles: Candle[],
  groups: IndicatorLabel[][],
  options: { columns: number; rows: number },
): IndicatorLabel[] {
  if (!candles.length) return [];

  const index = new Map<number, number>();
  let high = -Infinity;
  let low = Infinity;
  for (let i = 0; i < candles.length; i++) {
    index.set(candles[i].time, i);
    high = Math.max(high, candles[i].high);
    low = Math.min(low, candles[i].low);
  }

  const columnSize = Math.max(1, candles.length / Math.max(1, options.columns));
  const rowSize = Math.max(1e-9, (high - low) / Math.max(1, options.rows));

  const taken = new Set<string>();
  const out: IndicatorLabel[] = [];

  for (const group of groups) {
    for (const label of group) {
      const bar = index.get(label.time) ?? candles.length - 1;
      const cell = `${Math.floor(bar / columnSize)}:${Math.floor((label.price - low) / rowSize)}`;
      if (taken.has(cell)) continue;
      taken.add(cell);
      out.push(label);
    }
  }

  return out;
}
