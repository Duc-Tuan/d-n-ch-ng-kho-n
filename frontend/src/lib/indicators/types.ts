import type { Candle, PriceSource, Series } from '@/lib/indicators/math';

/* ── Định nghĩa tham số (sinh form Settings tự động) ────────────────────── */

export type ParamDef =
  | {
      key: string;
      label: string;
      type: 'number';
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | { key: string; label: string; type: 'source'; default: PriceSource }
  | { key: string; label: string; type: 'select'; default: string; options: { value: string; label: string }[] };

export type ParamValues = Record<string, number | string | boolean>;

/* ── Định nghĩa cách vẽ ─────────────────────────────────────────────────── */

export type PlotType = 'line' | 'histogram' | 'area' | 'baseline';

export interface PlotDef {
  /** Trùng key trong object trả về từ `compute`. */
  key: string;
  label: string;
  type: PlotType;
  color: string;
  lineWidth?: 1 | 2 | 3 | 4;
  lineStyle?: 'solid' | 'dotted' | 'dashed';
  /** Histogram đổi màu theo dấu (MACD hist, AO…). */
  colorBySign?: { positive: string; negative: string };
  /**
   * Histogram đổi màu theo **chiều nến** (`close >= open`), không theo dấu của
   * chính giá trị — dùng cho Volume, vốn luôn dương. Trước đây phải nhân volume
   * với −1 ở nến giảm để mượn `colorBySign`, làm sai lệch số liệu vẽ ra.
   */
  colorByCandle?: { up: string; down: string };
  /** Vẽ |value| nhưng vẫn lấy màu theo dấu — dùng cho Volume. */
  plotAbs?: boolean;
  /**
   * Màu nền tô từ đường xuống mức 0, chỉ dùng cho `type: 'baseline'`.
   *
   * Có mặt vì một dải mây không vẽ được bằng hai đường: mắt chỉ đọc ra "dải" khi khoảng giữa
   * hai biên được tô. Hai đường mảnh màu nhạt — cách làm trước đây — trên nền tối gần như biến
   * mất, và cửa sổ cộng hưởng mất hẳn mảng hình lớn nhất của nó.
   */
  fill?: string;
  /**
   * Ẩn đường này. Định nghĩa gốc đặt `true` cho các plot phụ (MA của RSI,
   * dải VWAP…); người dùng bật lên bằng cách ghi đè `hidden: false`.
   */
  hidden?: boolean;
}

/** Đường ngang cố định (RSI 70/30, CCI ±100…). */
export interface LevelDef {
  value: number;
  color: string;
  lineStyle?: 'solid' | 'dotted' | 'dashed';
  label?: string;
}

/* ── Hình khối (SMC: order block, FVG, cấu trúc thị trường) ─────────────── */

export interface Anchor {
  /** unix seconds; có thể vượt quá nến cuối để "kéo dài sang phải". */
  time: number;
  price: number;
}

export interface IndicatorBox {
  from: Anchor;
  to: Anchor;
  fill: string;
  border?: string;
  label?: string;
  labelColor?: string;
}

export interface IndicatorLine {
  from: Anchor;
  to: Anchor;
  color: string;
  lineStyle?: 'solid' | 'dashed' | 'dotted';
  label?: string;
  /**
   * Tô nền đặc cho nhãn ở đầu đường, kiểu thẻ giá `Entry: 4648.730`.
   *
   * Đường mức giá thường nằm đè lên nến hoặc lên hộp đã tô màu; chữ trần ở đó đọc rất khó, mà
   * đây lại đúng là những con số người dùng cần đọc chính xác nhất trên biểu đồ.
   */
  labelBackground?: string;
  /** Đẩy nhãn sang trái/phải để hai thẻ trên cùng một mức giá không đè nhau (px). */
  labelOffset?: number;
}

export interface IndicatorMarker {
  time: number;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
  color: string;
  text?: string;
}

/** Nhãn chữ neo tại một điểm bất kỳ (HH/HL/LH/LL, mức Fibonacci…). */
export interface IndicatorLabel {
  time: number;
  price: number;
  text: string;
  color: string;
  align?: 'left' | 'center' | 'right';
  /** Vị trí chữ so với `price`. */
  valign?: 'above' | 'middle' | 'below';
  fontSize?: number;
  /** Nền mờ tối để chữ đọc được trên nến. */
  background?: boolean;
  /** Nền đặc màu — dùng cho tag Buy/Sell. Ghi đè `background`. */
  backgroundColor?: string;
}

/**
 * Bảng số liệu dán ở một góc khung ("S/R Dashboard", "Regression Matrix"…).
 *
 * Khác mọi thứ còn lại ở đây: nó **không neo vào (thời gian, giá)** mà neo vào góc khung, nên
 * đứng yên khi kéo biểu đồ. Đó là điều kiện để nó dùng được — một bảng tổng kết trôi mất khỏi
 * khung nhìn ngay lần kéo đầu tiên thì không ai đọc.
 */
export type IndicatorTableRow =
  /**
   * Dòng tiêu đề khối — `──── MTF Matrix Monitor ────`.
   *
   * Cần thiết khi một bảng gom nhiều nhóm số không cùng loại: không có vạch ngăn thì mười lăm
   * dòng dính liền nhau và người đọc phải tự đoán dòng nào thuộc nhóm nào.
   */
  | { section: string }
  | {
      label: string;
      value: string;
      color?: string;
      /**
       * Dòng tiêu đề cột (`TF · Trend` — `Momentum Distribution`), không phải dữ liệu.
       *
       * Khác `section` ở chỗ nó vẫn có hai cột: nó đặt tên cho cột chứ không mở một khối mới.
       */
      header?: boolean;
      /**
       * Thanh bar mini vẽ trước phần giá trị, `ratio` trong khoảng 0–1.
       *
       * Dùng cho những con số mà **độ lớn tương đối** mới là thứ đáng đọc (cường độ động lượng,
       * độ nghiêng khối lượng). Một cột "19.1" đứng một mình không nói lên điều gì cho tới khi
       * mắt so được nó với 44.1 ở dòng dưới.
       */
      bar?: { ratio: number; color: string };
    };

export interface IndicatorTable {
  title?: string;
  rows: IndicatorTableRow[];
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
}

/** Dòng tiêu đề khối hay dòng số liệu — hẹp kiểu để nơi vẽ khỏi phải ép kiểu. */
export function isSectionRow(
  row: IndicatorTableRow,
): row is { section: string } {
  return 'section' in row;
}

/**
 * Đầu ra "phi chuỗi" của chỉ báo. Series thường (`compute`) đi vào
 * lightweight-charts; còn hộp/đường được vẽ tay lên canvas phủ, marker gắn vào
 * series giá qua `setMarkers`.
 */
/**
 * Thanh đo nằm ngang neo ở đáy khung, có dải màu và một mốc đánh dấu.
 *
 * Neo vào **góc khung** như `IndicatorTable`, không neo vào (thời gian, giá) — nó đo một trạng
 * thái hiện tại chứ không gắn với cây nến nào, nên phải đứng yên khi kéo biểu đồ.
 */
export interface IndicatorGauge {
  /** Vị trí mốc trên thanh, 0–1. */
  ratio: number;
  /** Chữ hiện ngay trên mốc — thường là chính tỉ lệ đó dạng phần trăm. */
  label?: string;
  /** Các chặng màu của dải, từ trái sang phải. */
  stops?: string[];
}

export interface IndicatorShapes {
  boxes?: IndicatorBox[];
  lines?: IndicatorLine[];
  markers?: IndicatorMarker[];
  labels?: IndicatorLabel[];
  tables?: IndicatorTable[];
  gauges?: IndicatorGauge[];
}

export interface IndicatorDef {
  id: string;
  name: string;
  /** Nhãn ngắn hiện trên legend chart: "RSI 14". */
  short: string;
  category: 'trend' | 'momentum' | 'volatility' | 'volume';
  /** `overlay` = vẽ đè lên nến; `pane` = pane riêng bên dưới. */
  placement: 'overlay' | 'pane';
  /**
   * Một dòng nói rõ chỉ báo này **là gì** — hiện ngay dưới tên ở màn chọn chỉ báo.
   *
   * Có mặt vì một vài chỉ báo không tự giải thích được bằng cái tên: bộ tổng hợp vẽ ra thẻ
   * Buy/Sell và mức dừng lỗ, và người dùng cần biết đó là công thức tính tại chỗ chứ không
   * phải khuyến nghị đã qua kiểm duyệt của hệ thống — hai thứ rất dễ nhìn thành một.
   */
  note?: string;
  params: ParamDef[];
  plots: PlotDef[];
  levels?: LevelDef[];
  /** Khoá trục giá của pane (RSI 0–100). */
  fixedRange?: { min: number; max: number };
  /** Số chữ số thập phân hiển thị trên trục pane. */
  precision?: number;
  /**
   * Param nào được in ra legend. Mặc định lấy mọi param kiểu number — với chỉ
   * báo nhiều tham số như bộ SMC thì legend sẽ dài lê thê, nên chỉ định rõ.
   */
  labelParams?: string[];
  compute: (candles: Candle[], params: ParamValues) => Record<string, Series>;
  /** Chỉ báo vẽ hộp/đường/marker (ZigZag, UT Bot, SMC) cài đặt thêm hàm này. */
  computeShapes?: (candles: Candle[], params: ParamValues) => IndicatorShapes;
}

/** Một chỉ báo đã được người dùng thêm vào chart (có param riêng). */
export interface IndicatorInstance {
  /** id duy nhất của instance (một chart có thể có 2 EMA khác length). */
  instanceId: string;
  defId: string;
  params: ParamValues;
  /** Ghi đè màu/độ dày từng plot. */
  styleOverrides: Record<string, Partial<PlotDef>>;
  visible: boolean;
}

/* Helper đọc param có ép kiểu, tránh `as number` rải rác trong compute(). */
export const num = (p: ParamValues, key: string): number => Number(p[key]);
export const bool = (p: ParamValues, key: string): boolean => Boolean(p[key]);
export const str = (p: ParamValues, key: string): string => String(p[key]);
export const src = (p: ParamValues, key = 'source'): PriceSource => p[key] as PriceSource;

export function defaultParams(def: IndicatorDef): ParamValues {
  return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}
