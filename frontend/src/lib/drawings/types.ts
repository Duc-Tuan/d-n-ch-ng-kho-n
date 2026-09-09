/**
 * Mô hình dữ liệu cho công cụ vẽ trên biểu đồ giá.
 *
 * Điểm neo lưu theo **(thời gian, giá)** chứ không phải toạ độ pixel, nên hình vẽ dính chặt vào
 * nến khi phóng to hay kéo ngang — giống hệt cách TradingView làm. Lưu theo pixel thì mỗi lần
 * đổi khoảng nhìn hình sẽ trôi đi một chỗ khác.
 */

export type DrawingTool =
  | 'cursor'
  | 'crosshair'
  | 'trendline'
  | 'ray'
  | 'extended'
  | 'hline'
  | 'hray'
  | 'vline'
  | 'channel'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'fib'
  | 'fibext'
  | 'longpos'
  | 'shortpos'
  | 'text'
  | 'note'
  | 'arrow'
  | 'brush'
  | 'measure';

/**
 * Mã giữ chỗ cho "mọi cổ phiếu" trong trường `Drawing.symbol`.
 *
 * Ghi chú dán trên khung neo theo **khung nhìn**, không theo giá, nên nó không thuộc về mã nào —
 * lọc theo mã như mọi hình khác thì đổi mã một cái là nó biến mất, và nó phải còn nguyên đó thì
 * mới có gì để đổi chữ theo.
 */
export const GLOBAL_SYMBOL = '*';

/**
 * Chỗ dành cho mã đang xem trong nội dung chữ.
 *
 * Bản lưu giữ **ký hiệu** chứ không giữ "VNM": thay sẵn thành mã lúc tạo thì sang mã khác không
 * còn dấu vết nào để biết đây vốn là nhãn động, và nó đóng băng ở mã của ngày tạo ra.
 */
export const SYMBOL_TOKEN = '{symbol}';

/** Thay ký hiệu mã trong chữ bằng mã đang xem. Chữ không có ký hiệu thì trả về nguyên vẹn. */
export function resolveText(text: string, symbol: string): string {
  return text.split(SYMBOL_TOKEN).join(symbol);
}

export interface Point {
  /** Giây unix — cùng thang với `Candle.time` của bộ chỉ báo. */
  time: number;
  price: number;
}

/**
 * Phông chữ cho công cụ văn bản.
 *
 * Lưu **tên nhóm** chứ không lưu cả chuỗi CSS: bản lưu trong máy người dùng sống lâu hơn quyết
 * định chọn phông của chúng ta, đổi chuỗi phông sau này thì mọi ghi chú cũ đi theo, còn lưu chuỗi
 * thì chúng đóng băng ở phông của ngày tạo ra.
 */
export type DrawingFont = 'system' | 'serif' | 'mono';

export const FONT_STACKS: Record<DrawingFont, string> = {
  system: '-apple-system, system-ui, "Segoe UI", sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export const FONT_LABELS: Record<DrawingFont, string> = {
  system: 'Thường',
  serif: 'Có chân',
  mono: 'Đều nét',
};

/** Cỡ chữ chọn được. Bốn bậc là đủ khoảng cách để nhìn ra khác biệt, nhiều hơn chỉ làm rối. */
export const FONT_SIZES = [12, 14, 18, 24];

export interface DrawingStyle {
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  /** 0–1, dùng cho rect/ellipse/channel/fib/vị thế. */
  fillOpacity: number;
  fontSize: number;
  /** Thiếu thì hiểu là `system` — ghi chú tạo trước khi có phần chọn phông. */
  fontFamily?: DrawingFont;
  text?: string;
}

export interface Drawing {
  id: string;
  /**
   * Mã cổ phiếu chứa hình này. Điểm neo lưu theo (thời gian, **giá**), mà mỗi mã một vùng giá
   * riêng — dùng chung hình giữa các mã sẽ vẽ lạc chỗ hoàn toàn.
   *
   * Ngoại lệ là `GLOBAL_SYMBOL`: hình hiện trên mọi mã, dành cho ghi chú dán trên khung. Chỉ hình
   * neo theo `pin` mới dùng chung được — hình neo theo giá mà dùng chung thì sang mã có vùng giá
   * khác là rơi thẳng ra ngoài khung nhìn.
   */
  symbol: string;
  tool: DrawingTool;
  points: Point[];
  /**
   * Vị trí neo theo **tỉ lệ khung vẽ** (0–1 theo cả hai chiều) — chỉ dùng cho `note`.
   *
   * Đây là điểm khác biệt duy nhất giữa `note` và `text`: `text` neo vào (thời gian, giá) nên trôi
   * theo nến khi kéo biểu đồ, còn `note` dán vào khung nên đứng yên. Lưu theo tỉ lệ chứ không theo
   * pixel để ghi chú giữ đúng chỗ khi khung đổi kích thước — mở rộng kín màn hình, thu lại, hay
   * bật thêm một cửa sổ chỉ báo bên dưới.
   */
  pin?: { x: number; y: number };
  style: DrawingStyle;
  locked: boolean;
  visible: boolean;
  /**
   * Chữ của hình vốn là nhãn động, và `style.text` bạn đang cầm đã được thay thành mã đang xem.
   *
   * Cờ **chỉ có lúc chạy**, do `useDrawings` gắn vào bản sao khi trả về; bản lưu không có nó. Nơi
   * sửa chữ đọc cờ này để biết người dùng đang sửa một nhãn động hay một dòng chữ cố định.
   */
  dynamicText?: boolean;
}

export interface ToolMeta {
  tool: DrawingTool;
  label: string;
  /** Số lần bấm để hoàn thành hình. `freehand` = vẽ tự do, kết thúc khi thả chuột. */
  points: number | 'freehand';
  group: 'cursor' | 'lines' | 'shapes' | 'fib' | 'position' | 'annotation' | 'measure';
  /** Phím tắt, theo thói quen của TradingView khi có. */
  shortcut?: string;
}

export const TOOL_META: Record<DrawingTool, ToolMeta> = {
  cursor: { tool: 'cursor', label: 'Con trỏ', points: 0, group: 'cursor' },
  crosshair: { tool: 'crosshair', label: 'Chữ thập', points: 0, group: 'cursor' },

  trendline: { tool: 'trendline', label: 'Đường xu hướng', points: 2, group: 'lines', shortcut: 'Alt+T' },
  ray: { tool: 'ray', label: 'Tia', points: 2, group: 'lines' },
  extended: { tool: 'extended', label: 'Đường kéo dài', points: 2, group: 'lines' },
  hline: { tool: 'hline', label: 'Đường ngang', points: 1, group: 'lines', shortcut: 'Alt+H' },
  hray: { tool: 'hray', label: 'Tia ngang', points: 1, group: 'lines' },
  vline: { tool: 'vline', label: 'Đường dọc', points: 1, group: 'lines', shortcut: 'Alt+V' },
  channel: { tool: 'channel', label: 'Kênh song song', points: 3, group: 'lines' },

  rect: { tool: 'rect', label: 'Hình chữ nhật', points: 2, group: 'shapes' },
  ellipse: { tool: 'ellipse', label: 'Hình elip', points: 2, group: 'shapes' },
  triangle: { tool: 'triangle', label: 'Tam giác', points: 3, group: 'shapes' },

  fib: { tool: 'fib', label: 'Fibonacci thoái lui', points: 2, group: 'fib', shortcut: 'Alt+F' },
  fibext: { tool: 'fibext', label: 'Fibonacci mở rộng', points: 3, group: 'fib' },

  longpos: { tool: 'longpos', label: 'Dự báo vị thế mua', points: 2, group: 'position' },
  shortpos: { tool: 'shortpos', label: 'Dự báo vị thế bán', points: 2, group: 'position' },

  text: { tool: 'text', label: 'Văn bản theo nến', points: 1, group: 'annotation' },
  note: { tool: 'note', label: 'Ghi chú dán trên khung', points: 1, group: 'annotation' },
  arrow: { tool: 'arrow', label: 'Mũi tên', points: 2, group: 'annotation' },
  brush: { tool: 'brush', label: 'Bút vẽ', points: 'freehand', group: 'annotation' },

  measure: { tool: 'measure', label: 'Thước đo', points: 2, group: 'measure' },
};

export const DEFAULT_STYLE: DrawingStyle = {
  color: '#2962FF',
  lineWidth: 2,
  lineStyle: 'solid',
  fillOpacity: 0.15,
  fontSize: 14,
  fontFamily: 'system',
};

/** Bảng màu gợi ý cho hình vẽ — đủ tương phản trên cả nền sáng lẫn nền tối. */
export const DRAWING_COLORS = [
  '#2962FF',
  '#089981',
  '#F23645',
  '#FF9800',
  '#7E57C2',
  '#00BCD4',
  '#787B86',
  '#131722',
];

/** Mức Fibonacci thoái lui mặc định — tỉ lệ và màu tương ứng. */
export const FIB_LEVELS: { ratio: number; color: string }[] = [
  { ratio: 0, color: '#787B86' },
  { ratio: 0.236, color: '#F23645' },
  { ratio: 0.382, color: '#FF9800' },
  { ratio: 0.5, color: '#4CAF50' },
  { ratio: 0.618, color: '#089981' },
  { ratio: 0.786, color: '#00BCD4' },
  { ratio: 1, color: '#787B86' },
];

export const FIB_EXT_LEVELS: { ratio: number; color: string }[] = [
  { ratio: 0, color: '#787B86' },
  { ratio: 0.618, color: '#089981' },
  { ratio: 1, color: '#787B86' },
  { ratio: 1.618, color: '#F23645' },
  { ratio: 2.618, color: '#FF9800' },
  { ratio: 4.236, color: '#7E57C2' },
];
