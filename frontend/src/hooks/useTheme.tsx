'use client';

/**
 * Chọn bảng màu cho site khách hàng.
 *
 * Trước đây bảng màu là **thuộc tính của vùng**: `/admin/*` sáng, còn lại tối, suy thẳng từ
 * đường dẫn. Giờ nó tách làm hai trục độc lập:
 *
 *   * `data-area` — khách hàng hay quản trị. Vẫn suy từ đường dẫn, vẫn là danh tính (BR-000),
 *     người dùng không đổi được.
 *   * `data-theme` — sáng hay tối. Là **tùy chọn của người dùng** trên site khách hàng, lưu ở
 *     `localStorage`. Site quản trị vẫn ghim sáng.
 *
 * Ba lựa chọn chứ không phải công tắc hai nấc. `system` không thừa: nó là lựa chọn duy nhất
 * đổi theo giờ trong ngày nếu máy người dùng đặt vậy, và là mặc định đúng cho người chưa từng
 * bấm gì. Công tắc hai nấc buộc họ chọn cứng một bên ngay lần đầu.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

/**
 * Khoá `localStorage`.
 *
 * Script đồng bộ ở `app/layout.tsx` đọc **đúng chuỗi này**. Đổi ở một chỗ mà quên chỗ kia thì
 * trang sẽ vẽ bằng bảng màu mặc định rồi nhảy sang bảng màu đã lưu ngay sau khi React chạy —
 * đúng cú chớp mà cả cơ chế này sinh ra để tránh.
 */
export const THEME_STORAGE_KEY = 'ck.theme';

/**
 * Mặc định của site khách hàng khi chưa có lựa chọn nào được lưu.
 *
 * `dark` chứ không phải `system`: nền tối là diện mạo sản phẩm đang có, và bảng giá sáu mươi
 * dòng với nến xanh/đỏ đọc trên nền tối vẫn là thứ người dùng chứng khoán quen mắt. Ai muốn
 * khác thì bấm một lần, và lựa chọn đó được nhớ.
 */
export const DEFAULT_MODE: ThemeMode = 'dark';

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemTheme(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : DEFAULT_MODE;
  } catch {
    // Chặn cookie/storage trong chế độ riêng tư — dùng mặc định, đừng làm hỏng cả trang.
    return DEFAULT_MODE;
  }
}

type ThemeContextValue = {
  /** Lựa chọn của người dùng, kể cả `system`. Đây là thứ nút chọn nên hiển thị đang bật. */
  mode: ThemeMode;
  /** Bảng màu đang thật sự hiển thị — `system` đã được quy về sáng hoặc tối. */
  resolved: ResolvedTheme;
  setMode: (mode: ThemeMode) => void;
  /** Đảo nhanh sáng ↔ tối. Đang ở `system` thì nhảy sang phía ngược với hệ thống. */
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Ghi bảng màu lên thẻ `<html>`.
 *
 * Class `theme-switching` bật hiệu ứng chuyển nền **chỉ trong khoảnh khắc đổi** (xem
 * `globals.css`): để nó thường trực thì mọi hiệu ứng rê chuột trên toàn site cũng bị kéo dài
 * theo. `animate` để `false` ở lượt đồng bộ đầu tiên — lúc đó không có gì để chuyển, và bật
 * hiệu ứng sẽ cho ra một cú tan màu ngay khi trang vừa mở.
 */
function applyTheme(theme: ResolvedTheme, animate: boolean) {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;

  if (!animate) {
    root.dataset.theme = theme;
    return;
  }

  root.classList.add('theme-switching');
  root.dataset.theme = theme;
  window.setTimeout(() => root.classList.remove('theme-switching'), 260);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  /**
   * Khởi tạo bằng hằng số chứ không đọc `localStorage` ngay trong `useState`.
   *
   * Lượt dựng trên máy chủ không có `localStorage`, nên đọc ở đây sẽ cho ra hai kết quả khác
   * nhau giữa máy chủ và trình duyệt và React báo lệch hydrate. Giá trị thật được nạp ở
   * effect đầu tiên bên dưới; trong quãng vài mili giây đó thẻ `<html>` vẫn mang đúng bảng
   * màu do script đồng bộ đặt, nên người dùng không thấy gì nhấp nháy.
   */
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>('dark');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setModeState(readStoredMode());
    setSystemResolved(systemTheme());
    setHydrated(true);
  }, []);

  // Người dùng đổi bảng màu của hệ điều hành khi trang đang mở — chỉ có ý nghĩa với `system`,
  // nhưng vẫn theo dõi liên tục để lúc họ chuyển sang `system` là có sẵn giá trị đúng.
  useEffect(() => {
    const mql = window.matchMedia(DARK_QUERY);
    const handler = (event: MediaQueryListEvent) =>
      setSystemResolved(event.matches ? 'dark' : 'light');
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  const resolved: ResolvedTheme = mode === 'system' ? systemResolved : mode;

  useEffect(() => {
    // Vùng khách hàng: đánh dấu để `globals.css` giữ màu hành động chính là xanh thương hiệu
    // ở cả hai bảng màu.
    document.documentElement.dataset.area = 'customer';
  }, []);

  useEffect(() => {
    applyTheme(resolved, hydrated);
  }, [resolved, hydrated]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Không lưu được thì lựa chọn chỉ sống trong phiên này — vẫn hơn là chặn cú bấm.
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved,
      setMode,
      toggle: () => setMode(resolved === 'dark' ? 'light' : 'dark'),
    }),
    [mode, resolved, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme phải nằm trong <ThemeProvider>');
  return ctx;
}

/**
 * Bảng màu đang hiển thị, **không cần provider**.
 *
 * Dành cho những chỗ vẽ lên canvas và vì vậy phải biết màu thật: biểu đồ giá, các cửa sổ chỉ
 * báo. Chúng dùng chung giữa hai site, mà site quản trị không bọc `ThemeProvider` — nên đọc
 * thẳng thuộc tính trên `<html>` và theo dõi nó bằng `MutationObserver` thay vì đi qua
 * context. Cách này cũng bắt được cả lần đổi do script đồng bộ đặt, không chỉ lần do người
 * dùng bấm.
 */
export function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setTheme(root.dataset.theme === 'light' ? 'light' : 'dark');

    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  return theme;
}
