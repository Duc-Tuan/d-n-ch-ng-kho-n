'use client';

/**
 * Ô tìm kiếm dùng chung.
 *
 * Gọi `onSearch` sau khi người dùng **ngừng gõ 300ms**, không gọi mỗi lần bấm phím. Nếu gọi
 * theo từng phím, gõ "HPG" sẽ tạo 3 request và kết quả có thể về không đúng thứ tự — ô tìm
 * kiếm sẽ nhấp nháy kết quả cũ.
 *
 * Component tự quản lý giá trị đang gõ, nên màn hình gọi nó chỉ cần xử lý giá trị đã ổn định.
 */
import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { Icon } from './Icon';

export function SearchInput({
  value,
  onSearch,
  placeholder = 'Tìm kiếm…',
  delay = 300,
  className,
  autoFocus = false,
  label,
  hint,
}: {
  /** Giá trị khởi tạo hoặc giá trị do bên ngoài áp đặt (ví dụ khi xoá bộ lọc). */
  value?: string;
  onSearch: (value: string) => void;
  placeholder?: string;
  delay?: number;
  className?: string;
  autoFocus?: boolean;
  label?: string;
  hint?: string;
}) {
  const [text, setText] = useState(value ?? '');
  const onSearchRef = useRef(onSearch);
  const lastEmitted = useRef(value ?? '');

  // Giữ callback mới nhất mà không làm timer chạy lại mỗi lần component render.
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  // Bên ngoài đổi giá trị (xoá bộ lọc) thì đồng bộ vào ô nhập.
  useEffect(() => {
    if (value !== undefined && value !== lastEmitted.current) {
      setText(value);
      lastEmitted.current = value;
    }
  }, [value]);

  useEffect(() => {
    const trimmed = text.trim();
    if (trimmed === lastEmitted.current) return;

    const timer = setTimeout(() => {
      lastEmitted.current = trimmed;
      onSearchRef.current(trimmed);
    }, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  function clear() {
    setText('');
    lastEmitted.current = '';
    onSearchRef.current('');
  }

  return (
    <div className={cn('space-y-1.5', className)}>
      {label && <label className="block text-sm font-medium text-ink-700">{label}</label>}
      {/*
        Vòng sáng focus đặt trên **lớp bọc**, không trên ô nhập.

        `globals.css` cố ý xoá mọi dấu hiệu focus của `input` (kể cả `box-shadow`) theo yêu cầu
        thiết kế của biểu mẫu. Nhưng một ô **tìm kiếm** thì khác một ô nhập biểu mẫu: nó là thứ
        người dùng nhảy vào bằng bàn phím giữa lúc đang đọc, và không có dấu hiệu nào thì họ gõ
        vào hư không. Đặt hiệu ứng ở thẻ `div` bao ngoài là cách giữ được cả hai: quy tắc kia
        chỉ nhắm vào `input`, nên nó không đụng tới chỗ này.
      */}
      <div className="relative rounded-xl transition-shadow focus-within:shadow-[0_0_0_3px_rgb(var(--brand)/0.15)]">
        <span className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-ink-400">
          <Icon name="search" size={16} />
        </span>
        <input
          type="search"
          value={text}
          autoFocus={autoFocus}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter tìm ngay, không chờ hết thời gian trễ.
            if (e.key === 'Enter') {
              lastEmitted.current = text.trim();
              onSearchRef.current(text.trim());
            }
            if (e.key === 'Escape') clear();
          }}
          placeholder={placeholder}
          className={cn(
            'h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-9 text-base text-ink-900',
            'placeholder:text-ink-400 transition-colors hover:border-line-strong',
            // Viền đổi màu khi focus. `outline`/`box-shadow` bị `globals.css` chặn trên `input`,
            // còn `border-color` thì không — vòng sáng do lớp bọc bên ngoài lo.
            'focus:border-brand focus:outline-none',
            'sm:text-sm',
            // Ẩn nút xoá mặc định của trình duyệt để dùng nút của mình cho đồng nhất.
            '[&::-webkit-search-cancel-button]:hidden',
          )}
        />
        {text && (
          <button
            type="button"
            onClick={clear}
            aria-label="Xoá tìm kiếm"
            className="absolute inset-y-0 right-2 flex w-7 items-center justify-center rounded text-ink-400 hover:text-ink-700"
          >
            <Icon name="close" size={15} />
          </button>
        )}
      </div>
      {hint && <p className="text-xs text-ink-500">{hint}</p>}
    </div>
  );
}
