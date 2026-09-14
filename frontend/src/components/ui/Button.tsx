'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Icon } from './Icon';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'link';
type Size = 'sm' | 'md' | 'lg';

/**
 * Nút chính dùng `primary` — mực đen ở site quản trị, xanh thương hiệu ở site khách hàng.
 * Màu sắc còn lại để dành cho thông tin trạng thái.
 *
 * Không viết `text-white` ở đây: nền nút là biến, và ở bảng màu nào thì chữ cũng phải đi theo
 * đúng cái nền đó. `text-white` trên `bg-ink-900` là lỗi kinh điển khi thêm bảng màu tối —
 * ở đó `ink-900` gần trắng và chữ biến mất.
 */
const VARIANTS: Record<Variant, string> = {
  /*
    Vệt sáng mảnh ở mép trên (`inset 0 1px 0`) là thứ tách một nút đặc khỏi một hình chữ nhật
    tô màu: nó mô phỏng ánh sáng hắt lên cạnh trên, đúng như mọi nút vật lý. Viết thành
    `shadow-[...]` chứ không phải `shadow-sm` vì Tailwind không có sẵn bóng hai lớp kiểu này.
  */
  primary:
    'bg-primary text-primary-fg shadow-[inset_0_1px_0_0_rgb(255_255_255/0.15),0_1px_2px_0_rgb(0_0_0/0.12)] hover:bg-primary-hover active:bg-primary-active disabled:bg-ink-300 disabled:text-ink-500 disabled:shadow-none',
  secondary: 'bg-ink-100 text-ink-900 hover:bg-ink-200 active:bg-ink-300',
  outline:
    'border border-line bg-surface text-ink-800 hover:border-line-strong hover:bg-ink-50 active:bg-ink-100',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900 active:bg-ink-200',
  danger:
    'bg-danger text-danger-fg shadow-[inset_0_1px_0_0_rgb(255_255_255/0.15),0_1px_2px_0_rgb(0_0_0/0.12)] hover:bg-danger-hover active:bg-danger-active disabled:bg-ink-300 disabled:text-ink-500 disabled:shadow-none',
  link: 'text-ink-900 underline-offset-4 hover:underline',
};

// BR-822 — vùng chạm tối thiểu 44×44px; cỡ 'sm' chỉ dùng trong bảng dày đặc.
const SIZES: Record<Size, string> = {
  sm: 'h-9 rounded-lg px-3 text-sm gap-1.5',
  md: 'h-touch rounded-xl px-4 text-sm gap-2',
  lg: 'h-12 rounded-xl px-6 text-base gap-2',
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    className,
    children,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-colors',
        // Nút lún xuống một chút khi nhấn. Phản hồi chạm quan trọng nhất trên điện thoại, nơi
        // không có con trỏ nào để nói "bạn đang bấm đúng chỗ".
        'active:scale-[0.98] motion-reduce:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        className,
      )}
      {...props}
    >
      {loading ? <Icon name="spinner" size={16} /> : leftIcon}
      {children}
      {!loading && rightIcon}
    </button>
  );
});

/** Nút chỉ có icon — luôn phải có `label` để đọc màn hình hiểu được. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonProps, 'leftIcon' | 'rightIcon' | 'children'> & { label: string; children: ReactNode }
>(function IconButton({ label, className, size = 'md', variant = 'ghost', children, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-xl transition-colors',
        'active:scale-[0.98] motion-reduce:active:scale-100',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-2',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100',
        VARIANTS[variant],
        size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-12 w-12' : 'h-touch w-touch',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
});
