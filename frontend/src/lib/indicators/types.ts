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
 * Đầu ra "phi chuỗi" của chỉ báo. Series thường (`compute`) đi vào
 * lightweight-charts; còn hộp/đường được vẽ tay lên canvas phủ, marker gắn vào
 * series giá qua `setMarkers`.
 */
export interface IndicatorShapes {
  boxes?: IndicatorBox[];
  lines?: IndicatorLine[];
  markers?: IndicatorMarker[];
  labels?: IndicatorLabel[];
}

export interface IndicatorDef {
  id: string;
  name: string;
  /** Nhãn ngắn hiện trên legend chart: "RSI 14". */
  short: string;
  category: 'trend' | 'momentum' | 'volatility' | 'volume';
  /** `overlay` = vẽ đè lên nến; `pane` = pane riêng bên dưới. */
  placement: 'overlay' | 'pane';
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
