/**
 * Cấu hình dùng chung cho biểu đồ giá và các cửa sổ chỉ báo bên dưới nó.
 *
 * Tách ra một chỗ vì hai lý do, và cả hai đều nhìn thấy được ngay trên màn hình nếu làm sai:
 *
 * 1. **Thẳng hàng.** Mỗi cửa sổ chỉ báo là một `chart` riêng (lightweight-charts v4 chưa hỗ trợ
 *    nhiều pane trong một chart — phải lên v5). Cột giá tự co giãn theo nhãn dài nhất, nên
 *    "1.250,5" ở biểu đồ giá và "-0,05" ở cửa sổ MACD cho ra hai bề rộng khác nhau và mép phải
 *    lệch nhau. `PRICE_SCALE_MIN_WIDTH` là mức sàn chung, phần còn lại do `useChartSync` cân.
 * 2. **Cùng một bảng màu.** Lưới, chữ và viền phải giống hệt nhau, nếu không các cửa sổ xếp
 *    chồng trông như ghép từ hai giao diện khác nhau.
 */
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  type ChartOptions,
  type DeepPartial,
} from 'lightweight-charts';

/**
 * Màu lấy từ **biến CSS**, không viết cứng ở đây.
 *
 * `lightweight-charts` vẽ lên canvas nên không nhận class Tailwind — nó cần chuỗi màu thật. Mà
 * site khách hàng chạy nền tối còn site quản trị nền sáng, nên "thật" là bao nhiêu chỉ biết
 * được lúc chạy. Đọc thẳng từ `:root` giữ cho biểu đồ và phần giao diện quanh nó luôn cùng một
 * bảng màu: sửa `globals.css` là biểu đồ đi theo, không phải nhớ sửa thêm chỗ này.
 *
 * Đọc lúc **tạo biểu đồ** chứ không phải lúc nạp module: ở lượt dựng phía máy chủ không có
 * `document`, và giá trị lấy được khi đó sẽ đóng băng vào biến module.
 */
function themeRgb(token: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(`--${token}`).trim();
  return raw || fallback;
}

/**
 * Trả về `rgb(r, g, b)` / `rgba(r, g, b, a)` — dạng **có dấu phẩy**, không phải CSS Color 4.
 *
 * Biến trong `globals.css` lưu ba số cách nhau bằng dấu cách (`145 145 157`) vì Tailwind cần
 * dạng đó để ghép độ mờ (`bg-surface/70`). Nhưng bộ phân tích màu của `lightweight-charts`
 * tự viết, không dùng của trình duyệt, và nó chỉ hiểu cú pháp cũ: đưa thẳng
 * `rgb(145 145 157)` vào thì nó ném `Cannot parse color` và hỏng cả biểu đồ. Vì vậy phải tách
 * ba thành phần rồi ghép lại ở đây.
 */
export function chartColor(token: string, fallback: string, alpha = 1): string {
  const parts = themeRgb(token, fallback).split(/[\s,/]+/).filter(Boolean);
  const [r, g, b] = parts.length >= 3 ? parts : fallback.split(/\s+/);
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Quy ước thị trường Việt Nam, khớp với `up`/`down` trong `tailwind.config.ts`. */
export const up = (alpha = 1) => chartColor('up', '22 163 74', alpha);
export const down = (alpha = 1) => chartColor('down', '220 38 38', alpha);

export function chartColors() {
  return {
    background: chartColor('surface', '255 255 255'),
    text: chartColor('ink-500', '113 113 127'),
    grid: chartColor('ink-100', '238 238 240'),
    border: chartColor('line', '217 217 222'),
    crosshair: chartColor('ink-400', '143 143 155'),
  };
}

/**
 * Bề rộng tối thiểu của cột giá. Đủ chỗ cho nhãn khối lượng dạng "1.234,5K"; cửa sổ nào cần
 * rộng hơn thì `useChartSync` nới **tất cả** lên cùng một số.
 */
export const PRICE_SCALE_MIN_WIDTH = 72;

export const LINE_STYLE_MAP = {
  solid: LineStyle.Solid,
  dotted: LineStyle.Dotted,
  dashed: LineStyle.Dashed,
} as const;

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Trộn **sâu**, không phải `{...base, ...overrides}`.
 *
 * Ghi đè nông một nhánh như `timeScale: { visible: false }` sẽ xoá sạch `borderColor`,
 * `rightOffset`… và trục rơi về mặc định của thư viện.
 */
function deepMerge<T extends PlainObject>(base: T, overrides: PlainObject): T {
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const current = out[key];
    out[key] = isPlainObject(value) && isPlainObject(current) ? deepMerge(current, value) : value;
  }
  return out as T;
}

export function baseChartOptions(
  overrides: DeepPartial<ChartOptions> = {},
): DeepPartial<ChartOptions> {
  const colors = chartColors();
  const base: DeepPartial<ChartOptions> = {
    layout: {
      background: { type: ColorType.Solid, color: colors.background },
      textColor: colors.text,
      fontSize: 11,
      // Logo TradingView nổi đè lên góc dưới phải, đúng chỗ nến mới nhất và nhãn giá — thứ
      // người dùng nhìn nhiều nhất. Giấy phép Apache-2.0 của lightweight-charts đòi giữ phần
      // ghi công, nhưng không đòi giữ đúng cái logo đó: dòng dẫn nguồn dưới biểu đồ gánh phần
      // này (xem `PriceChart`), nên tắt logo không làm mất ghi công.
      attributionLogo: false,
    },
    grid: {
      vertLines: { color: colors.grid },
      horzLines: { color: colors.grid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: { color: colors.crosshair, width: 1, style: LineStyle.LargeDashed },
      horzLine: { color: colors.crosshair, width: 1, style: LineStyle.LargeDashed },
    },
    rightPriceScale: {
      borderColor: colors.border,
      scaleMargins: { top: 0.08, bottom: 0.26 },
      minimumWidth: PRICE_SCALE_MIN_WIDTH,
    },
    timeScale: { borderColor: colors.border, timeVisible: false, rightOffset: 4 },
  };

  return deepMerge(base as PlainObject, overrides as PlainObject) as DeepPartial<ChartOptions>;
}
