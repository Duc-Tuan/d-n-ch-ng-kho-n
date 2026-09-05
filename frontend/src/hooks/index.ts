'use client';

/** Các hook tiện ích nhỏ dùng chung. */
import { useCallback, useEffect, useRef, useState } from 'react';

export { useApiQuery, useApiMutation, fieldError } from './useApi';
export { useAction, useConfirmAction } from './useAction';
export { useFormErrors } from './useFormErrors';
export { useList } from './useList';
export { SessionProvider, useSession, useAccessBanner } from './useSession';
export { StaffSessionProvider, useStaffSession } from './useStaffSession';
export { ToastProvider, useToast } from './useToast';
export { useRealtime, useNotificationSound, type RealtimeEvent } from './useRealtime';
export { useContentRealtime } from './useContentRealtime';
export { useStrategyRun, useRuleCatalog } from './useStrategyRun';

/**
 * Ghim bảng màu cho vùng đang đứng.
 *
 * Script trong `app/layout.tsx` đã đặt đúng từ lượt tải đầu; hook này lo phần còn lại — điều
 * hướng bằng router phía trình duyệt không tải lại trang, nên script đó không chạy lại. Gọi ở
 * khung của từng vùng (`CustomerShell`, `AdminShell`) chứ không ở từng trang: khung mới là thứ
 * biết mình thuộc vùng nào.
 */
export function useThemeArea(theme: 'dark' | 'light') {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}

/** Hoãn giá trị — dùng cho ô tìm kiếm để không gọi API mỗi lần gõ phím. */
export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Quản lý phân trang cho mọi màn danh sách. */
export function usePagination(initialSize = 20) {
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);

  const reset = useCallback(() => setPage(1), []);
  const next = useCallback(() => setPage((p) => p + 1), []);
  const prev = useCallback(() => setPage((p) => Math.max(p - 1, 1)), []);

  return { page, size, setPage, setSize, reset, next, prev };
}

/**
 * Theo dõi breakpoint — mục 11.2 có màn xử lý khác nhau giữa mobile và desktop
 * (bảng giá chuyển dạng thẻ, popup marker mở dạng bottom sheet…).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useIsMobile() {
  return useMediaQuery('(max-width: 639px)');
}

/** Đếm ngược tới một mốc thời gian — dùng cho banner cảnh báo WARNING/GRACE. */
export function useCountdown(target: string | null | undefined) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    if (!target) {
      setRemaining(null);
      return;
    }
    const tick = () => {
      const diff = new Date(target).getTime() - Date.now();
      setRemaining(Math.max(diff, 0));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [target]);

  if (remaining === null) return null;
  const totalSeconds = Math.floor(remaining / 1000);
  return {
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
    expired: remaining === 0,
  };
}

/** Đóng khi bấm ra ngoài — dùng cho dropdown, popover. */
export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const handler = (event: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', handler);
    // BR-821 — mọi tương tác phải dùng được bằng chạm, không chỉ chuột.
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [onOutside]);

  return ref;
}

/** Khoá cuộn nền khi mở modal / bottom sheet (BR-846). */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [locked]);
}

/** Lưu trạng thái nhỏ vào localStorage (bộ lọc đã chọn, cột đang hiện…). */
export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      /* dữ liệu hỏng thì dùng giá trị mặc định */
    }
  }, [key]);

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* hết dung lượng — bỏ qua, không chặn luồng người dùng */
      }
    },
    [key],
  );

  return [value, update] as const;
}
