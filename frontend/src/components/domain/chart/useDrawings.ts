'use client';

/**
 * Hình vẽ tay của người dùng trên biểu đồ giá, kèm công cụ đang cầm và tuỳ chọn vẽ.
 *
 * Lưu vào `localStorage` chứ không lên máy chủ: đây là ghi chú riêng của một người trên một máy,
 * không phải dữ liệu nghiệp vụ và cũng không cần đồng bộ giữa các thiết bị.
 *
 * Hình **gắn với mã**, khác hẳn danh sách chỉ báo (xem `useIndicators`, giữ nguyên khi đổi mã).
 * Ngoại lệ duy nhất là ghi chú dán trên khung (`GLOBAL_SYMBOL`) — xem `add`.
 * Điểm neo lưu theo giá tuyệt đối, mà mỗi mã một vùng giá riêng — mang đường xu hướng của VNM
 * sang FPT thì nó rơi ra ngoài khung nhìn hoặc nằm lạc chỗ giữa biểu đồ.
 *
 * Ai muốn xem chồng hình của mọi mã thì bật `allSymbols`: hình của mã khác trả về ở `ghosts`, vẽ
 * mờ và **không bắt chuột** — đúng vì vùng giá của chúng không phải vùng giá đang hiện, kéo một
 * hình như thế ở đây là kéo theo một thang đo không phải của nó.
 *
 * Hình **không** gắn với khung thời gian: điểm neo là (thời gian, giá), cả hai đều không đổi khi
 * chuyển khung, nên một đường hỗ trợ vẽ ở khung Ngày vẫn đúng chỗ ở khung 1 giờ.
 *
 * Cách đọc/ghi `localStorage` theo đúng khuôn của `useIndicators`: đọc **sau khi** gắn vào DOM để
 * lượt dựng phía máy chủ không lệch nội dung, và chỉ ghi sau khi đã đọc xong — bỏ cờ này thì
 * lượt render đầu (danh sách còn rỗng) sẽ ghi đè mất bản đã lưu.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  DEFAULT_STYLE,
  GLOBAL_SYMBOL,
  resolveText,
  SYMBOL_TOKEN,
  type Drawing,
  type DrawingStyle,
  type DrawingTool,
} from '@/lib/drawings/types';

const STORAGE_KEY = 'stock.chart.drawings.v1';
const PREFS_KEY = 'stock.chart.drawings.prefs.v1';

interface Prefs {
  magnet: boolean;
  defaultStyle: DrawingStyle;
}

const DEFAULT_PREFS: Prefs = { magnet: false, defaultStyle: DEFAULT_STYLE };

function uid(): string {
  return `draw_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Bỏ đuôi khung thời gian ở bản lưu cũ.
 *
 * Khoá kho hình từng là `MÃ@khung`, nên vẽ ở khung Ngày rồi chuyển sang khung 1 giờ là mất hình.
 * Gộp về một bộ theo mã: điểm neo vốn không phụ thuộc khung, chỉ cái khoá là phụ thuộc.
 */
function liftTimeframe(item: Drawing): Drawing {
  const at = item.symbol.indexOf('@');
  return at < 0 ? item : { ...item, symbol: item.symbol.slice(0, at) };
}

/**
 * Kéo ghi chú dán trên khung ở bản lưu cũ lên dùng chung mọi mã.
 *
 * Trước đây chúng bị gắn vào mã đang xem lúc tạo, nên vẽ ở AAA rồi sang ACB là mất hút, quay về
 * AAA mới thấy lại. Chữ cũng đổi theo: ghi chú mà nội dung đúng bằng mã sở hữu thì vốn là một
 * nhãn mã, chuyển sang ký hiệu để nó tiếp tục đổi theo mã thay vì đóng băng ở "AAA".
 */
function liftNote(item: Drawing): Drawing {
  if (item.tool !== 'note' || item.symbol === GLOBAL_SYMBOL) return item;
  const text = item.style?.text?.trim();
  return {
    ...item,
    symbol: GLOBAL_SYMBOL,
    style: text && text === item.symbol ? { ...item.style, text: SYMBOL_TOKEN } : item.style,
  };
}

function loadDrawings(): Drawing[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Một mục hỏng (bản lưu cũ, thiếu trường) không được phép làm hỏng cả danh sách.
    return (parsed as Drawing[])
      .filter((item) => item?.id && item.symbol && item.tool && Array.isArray(item.points))
      // Thứ tự có ý nghĩa: `liftNote` so nội dung ghi chú với **mã**, nên đuôi khung phải rụng trước.
      .map((item) => liftNote(liftTimeframe(item)));
  } catch {
    return [];
  }
}

function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      magnet: Boolean(parsed.magnet),
      defaultStyle: { ...DEFAULT_STYLE, ...parsed.defaultStyle },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export interface DrawingStore {
  /** Chỉ hình của mã đang xem (kể cả hình dùng chung). Đây là danh sách **bắt chuột được**. */
  drawings: Drawing[];
  /**
   * Hình của những mã khác, chỉ có khi bật `allSymbols`. Vẽ ra để đối chiếu, nhưng nằm ngoài mọi
   * phép chọn/kéo/xoá — xem chú thích đầu tệp.
   */
  ghosts: Drawing[];
  activeTool: DrawingTool;
  setActiveTool: (tool: DrawingTool) => void;
  selectedId: string | null;
  select: (id: string | null) => void;
  magnet: boolean;
  toggleMagnet: () => void;
  lockAll: boolean;
  toggleLockAll: () => void;
  hideAll: boolean;
  toggleHideAll: () => void;
  allSymbols: boolean;
  toggleAllSymbols: () => void;
  defaultStyle: DrawingStyle;
  setDefaultStyle: (patch: Partial<DrawingStyle>) => void;
  /** Trả về id của hình vừa thêm, hoặc `null` nếu chưa chọn mã nào. */
  add: (drawing: Omit<Drawing, 'id' | 'symbol'>) => string | null;
  update: (id: string, patch: Partial<Drawing>) => void;
  updateStyle: (id: string, patch: Partial<DrawingStyle>) => void;
  duplicate: (id: string) => void;
  remove: (id: string) => void;
  /** Xoá toàn bộ hình của mã đang xem. */
  clear: () => void;
}

/** @param symbol Mã đang xem. Vừa là khoá kho hình, vừa là chữ thay vào nhãn động `{symbol}`. */
export function useDrawings(symbol: string | undefined): DrawingStore {
  const [all, setAll] = useState<Drawing[]>([]);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [hydrated, setHydrated] = useState(false);

  const [activeTool, setActiveToolState] = useState<DrawingTool>('cursor');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [lockAll, setLockAll] = useState(false);
  const [hideAll, setHideAll] = useState(false);
  const [allSymbols, setAllSymbols] = useState(false);

  useEffect(() => {
    setAll(loadDrawings());
    setPrefs(loadPrefs());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Chế độ riêng tư hoặc hết dung lượng — chỉ mất phần ghi nhớ, biểu đồ vẫn vẽ được.
    }
  }, [hydrated, all, prefs]);

  // Đổi mã là bắt đầu lại từ khung sạch: bỏ chọn, trả về con trỏ, tắt xem chồng.
  //
  // Hình đang chọn thuộc mã cũ, và giữ nguyên công cụ đang cầm sẽ khiến cú bấm đầu tiên trên mã
  // mới vẽ ra một hình ngoài ý muốn. Xem chồng mọi mã cũng vậy: nó là một lượt đối chiếu tại chỗ,
  // không phải chế độ mang theo — sang mã mới mà màn hình còn đầy hình của mã cũ thì không còn
  // chỗ trống nào để vẽ.
  useEffect(() => {
    setSelectedId(null);
    setActiveToolState('cursor');
    setAllSymbols(false);
  }, [symbol]);

  const { drawings, ghosts } = useMemo(() => {
    if (!symbol) return { drawings: [], ghosts: [] };

    // Thay mã **ở đây**, một chỗ duy nhất, chứ không ở lớp vẽ: mọi nơi đọc `drawings` — lớp vẽ,
    // phép bắt chuột, thanh chỉnh kiểu — đều cần đúng một chuỗi chữ, và đo hộp chữ theo ký hiệu
    // `{symbol}` thì vùng bấm rộng hơn hẳn chữ đang hiện.
    const resolve = (item: Drawing, label: string): Drawing => {
      const text = item.style.text;
      if (!text?.includes(SYMBOL_TOKEN)) return item;
      return { ...item, dynamicText: true, style: { ...item.style, text: resolveText(text, label) } };
    };

    const mine: Drawing[] = [];
    const others: Drawing[] = [];
    for (const item of all) {
      if (item.symbol === symbol || item.symbol === GLOBAL_SYMBOL) mine.push(resolve(item, symbol));
      // Nhãn động của hình mã khác thay bằng **mã chủ của nó**, không phải mã đang xem: một ghi
      // chú của VNM mà hiện chữ "HPG" thì đọc xong hiểu sai hẳn.
      else if (allSymbols) others.push(resolve(item, item.symbol));
    }
    return { drawings: mine, ghosts: others };
  }, [all, symbol, allSymbols]);

  const setActiveTool = useCallback((tool: DrawingTool) => {
    setActiveToolState(tool);
    // Cầm công cụ vẽ thì bỏ chọn hình cũ, nếu không thanh chỉnh kiểu vẫn treo giữa màn hình.
    if (tool !== 'cursor' && tool !== 'crosshair') setSelectedId(null);
  }, []);

  const add = useCallback(
    (drawing: Omit<Drawing, 'id' | 'symbol'>) => {
      if (!symbol) return null;
      // Trả về id để nơi gọi chọn luôn hình vừa tạo — vẽ xong là thanh chỉnh kiểu hiện ra ngay,
      // khỏi phải bấm lại vào hình một lần nữa mới đổi được màu hay xoá.
      const id = uid();
      // Ghi chú dán trên khung dùng chung mọi mã; phần còn lại neo theo giá nên phải theo mã.
      const owner = drawing.tool === 'note' ? GLOBAL_SYMBOL : symbol;
      setAll((current) => [...current, { ...drawing, id, symbol: owner }]);
      return id;
    },
    [symbol],
  );

  const update = useCallback((id: string, patch: Partial<Drawing>) => {
    setAll((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const updateStyle = useCallback((id: string, patch: Partial<DrawingStyle>) => {
    setAll((current) =>
      current.map((item) =>
        item.id === id ? { ...item, style: { ...item.style, ...patch } } : item,
      ),
    );
  }, []);

  const duplicate = useCallback((id: string) => {
    const copyId = uid();
    setAll((current) => {
      const source = current.find((item) => item.id === id);
      if (!source) return current;
      return [
        ...current,
        {
          ...source,
          id: copyId,
          // Lệch giá một chút để bản sao không nằm đè khít lên bản gốc.
          points: source.points.map((p) => ({ ...p, price: p.price * 1.005 })),
        },
      ];
    });
    // Chuyển lựa chọn sang bản sao: người dùng vừa nhân bản thì thứ họ định chỉnh tiếp là bản mới.
    setSelectedId(copyId);
  }, []);

  const remove = useCallback((id: string) => {
    setAll((current) => current.filter((item) => item.id !== id));
    setSelectedId((current) => (current === id ? null : current));
  }, []);

  const clear = useCallback(() => {
    if (!symbol) return;
    // Xoá cả hình dùng chung: người dùng bấm "xoá hết" khi đang nhìn thấy chúng, để lại một cái
    // nhãn vẫn nằm giữa biểu đồ thì đúng là nút bấm hỏng.
    //
    // Nhưng **không** đụng tới hình của mã khác, kể cả khi đang bật xem chồng: một nút trong
    // thanh công cụ không được phép quét sạch hình của cả chục mã người dùng không hề mở.
    setAll((current) =>
      current.filter((item) => item.symbol !== symbol && item.symbol !== GLOBAL_SYMBOL),
    );
    setSelectedId(null);
  }, [symbol]);

  const setDefaultStyle = useCallback((patch: Partial<DrawingStyle>) => {
    setPrefs((current) => ({ ...current, defaultStyle: { ...current.defaultStyle, ...patch } }));
  }, []);

  const toggleMagnet = useCallback(
    () => setPrefs((current) => ({ ...current, magnet: !current.magnet })),
    [],
  );

  return {
    drawings,
    ghosts,
    activeTool,
    setActiveTool,
    selectedId,
    select: setSelectedId,
    magnet: prefs.magnet,
    toggleMagnet,
    lockAll,
    toggleLockAll: useCallback(() => setLockAll((on) => !on), []),
    hideAll,
    toggleHideAll: useCallback(() => setHideAll((on) => !on), []),
    allSymbols,
    toggleAllSymbols: useCallback(() => setAllSymbols((on) => !on), []),
    defaultStyle: prefs.defaultStyle,
    setDefaultStyle,
    add,
    update,
    updateStyle,
    duplicate,
    remove,
    clear,
  };
}
