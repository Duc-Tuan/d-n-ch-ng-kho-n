'use client';

/**
 * Nút đổi bảng màu của site khách hàng.
 *
 * Hai hình thức cho hai chỗ đặt, cùng một trạng thái bên dưới:
 *
 *   * `ThemeToggle` — một nút tròn trên thanh trên. Bấm là đảo sáng ↔ tối. Người dùng đổi nền
 *     bằng một cú bấm, không phải mở menu rồi tìm.
 *   * `ThemeSegmented` — ba ô Sáng · Tối · Hệ thống, đặt ở đáy menu tài khoản. Đây là chỗ duy
 *     nhất chọn được `system`, vì một nút đảo hai nấc không diễn đạt nổi ba trạng thái.
 *
 * Cả hai đều chờ `mounted` rồi mới vẽ trạng thái thật. Lượt dựng trên máy chủ không biết người
 * dùng đã chọn gì — lựa chọn nằm ở `localStorage` — nên vẽ ngay sẽ cho ra một hình ở HTML và
 * một hình khác sau khi hydrate: React báo lệch, và mắt thấy icon nhảy một cái. Trong quãng
 * vài mili giây chờ đó, nút hiện mặt trời và ô "Sáng" chưa sáng lên; không ai kịp thấy.
 */
import { useEffect, useState } from 'react';

import { useTheme, type ThemeMode } from '@/hooks/useTheme';
import { cn } from '@/lib/cn';
import { Icon } from './Icon';

const MODES: Array<{ key: ThemeMode; label: string; title: string }> = [
  { key: 'light', label: 'Sáng', title: 'Luôn dùng nền sáng' },
  { key: 'dark', label: 'Tối', title: 'Luôn dùng nền tối' },
  { key: 'system', label: 'Hệ thống', title: 'Đi theo cài đặt của máy' },
];

function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}

export function ThemeToggle({ className }: { className?: string }) {
  const { resolved, toggle } = useTheme();
  const mounted = useMounted();
  const next = resolved === 'dark' ? 'sáng' : 'tối';

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Chuyển sang nền ${next}`}
      title={`Chuyển sang nền ${next}`}
      className={cn(
        'relative flex h-touch w-touch items-center justify-center rounded-xl text-ink-500',
        'transition-colors hover:bg-ink-100 hover:text-ink-900',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900',
        className,
      )}
    >
      {/*
        Hai icon chồng lên nhau và xoay đổi chỗ, không phải một icon bị thay thế.

        Thay thẳng thì icon biến mất rồi hiện lại — đọc ra là một lỗi vẽ. Mặt trời lặn xuống
        còn mặt trăng mọc lên là cùng một cú bấm kể thành một chuyển động, và nó mất đúng
        khoảng thời gian mà nền đang tan màu.
      */}
      <Icon
        name="sun"
        size={19}
        className={cn(
          'absolute transition-all duration-300',
          mounted && resolved === 'dark'
            ? 'rotate-90 scale-50 opacity-0'
            : 'rotate-0 scale-100 opacity-100',
        )}
      />
      <Icon
        name="moon"
        size={19}
        className={cn(
          'absolute transition-all duration-300',
          mounted && resolved === 'dark'
            ? 'rotate-0 scale-100 opacity-100'
            : '-rotate-90 scale-50 opacity-0',
        )}
      />
    </button>
  );
}

export function ThemeSegmented({ className }: { className?: string }) {
  const { mode, setMode } = useTheme();
  const mounted = useMounted();

  return (
    <div
      role="radiogroup"
      aria-label="Bảng màu giao diện"
      className={cn('flex gap-0.5 rounded-xl bg-ink-100 p-0.5', className)}
    >
      {/*
        Chỉ có chữ, không icon.

        Bộ ba này sống trong menu tài khoản rộng 16rem. Thêm icon vào mỗi ô thì "Hệ thống" —
        nhãn dài nhất — vỡ thành hai dòng và ô thứ ba cao hơn hai ô kia. Ở đây icon cũng không
        gánh việc gì: ba nhãn đã rõ nghĩa, còn hình mặt trời/mặt trăng đã nằm sẵn trên nút đảo
        ở thanh trên.
      */}
      {MODES.map((item) => {
        const active = mounted && mode === item.key;
        return (
          <button
            key={item.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => setMode(item.key)}
            title={item.title}
            className={cn(
              'flex flex-1 items-center justify-center whitespace-nowrap rounded-[0.625rem] px-2 py-1.5',
              'text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900',
              active
                ? 'bg-surface text-ink-900 shadow-card'
                : 'text-ink-500 hover:text-ink-800',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
