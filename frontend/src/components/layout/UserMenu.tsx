'use client';

import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';

import { Icon, type IconName } from '@/components/ui/Icon';
import { useClickOutside } from '@/hooks';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export type UserMenuItem = {
  label: string;
  href?: string;
  icon: IconName;
  onClick?: () => void;
  /** Ngăn cách với nhóm phía trên (dùng cho mục Đăng xuất). */
  separated?: boolean;
  danger?: boolean;
};

/**
 * Avatar + menu tài khoản ở góc phải header. Dùng chung cho cả hai site.
 *
 * BR-821 — mở được bằng chạm, không phụ thuộc hover.
 * BR-822 — vùng chạm của avatar và từng mục menu đều ≥ 44px.
 */
export function UserMenu({
  name,
  subtitle,
  items,
  align = 'right',
}: {
  name: string;
  subtitle?: string;
  items: UserMenuItem[];
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Menu tài khoản"
        className={cn(
          'flex min-h-touch items-center gap-2 rounded-lg pl-1 pr-1.5 transition-colors sm:pr-2',
          'hover:bg-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900',
          open && 'bg-ink-100',
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-fg">
          {initials(name)}
        </span>
        <span className="hidden min-w-0 text-left sm:block">
          <span className="block truncate text-sm font-medium leading-tight text-ink-900">
            {name}
          </span>
          {subtitle && (
            <span className="block truncate text-xs leading-tight text-ink-500">{subtitle}</span>
          )}
        </span>
        <Icon
          name="chevron-down"
          size={16}
          className={cn('hidden text-ink-400 transition-transform sm:block', open && 'rotate-180')}
        />
      </button>

      {open && (
        <div
          role="menu"
          className={cn(
            'absolute top-[calc(100%+0.375rem)] z-50 w-56 overflow-hidden rounded-xl border border-line bg-surface-raised py-1 shadow-pop animate-slide-up',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {/* Trên điện thoại header không đủ chỗ hiện tên, nên nhắc lại trong menu. */}
          <div className="border-b border-ink-100 px-3 py-2 sm:hidden">
            <p className="truncate text-sm font-medium text-ink-900">{name}</p>
            {subtitle && <p className="truncate text-xs text-ink-500">{subtitle}</p>}
          </div>

          {items.map((item) => {
            const content = (
              <>
                <Icon name={item.icon} size={17} className={item.danger ? '' : 'text-ink-400'} />
                {item.label}
              </>
            );
            const className = cn(
              'flex min-h-touch w-full items-center gap-2.5 px-3 text-sm transition-colors',
              item.danger
                ? 'text-tone-red-fg hover:bg-tone-red-bg'
                : 'text-ink-700 hover:bg-ink-50',
              item.separated && 'mt-1 border-t border-ink-100 pt-1',
            );

            return item.href ? (
              <Link
                key={item.label}
                href={item.href}
                role="menuitem"
                onClick={close}
                className={className}
              >
                {content}
              </Link>
            ) : (
              <button
                key={item.label}
                role="menuitem"
                onClick={() => {
                  close();
                  item.onClick?.();
                }}
                className={className}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Chuông thông báo kèm số chưa đọc — dùng ở header cả hai site. */
export function NotificationBell({ count, href }: { count: number; href: string }) {
  return (
    <Link
      href={href}
      aria-label={count > 0 ? `Thông báo (${count} chưa đọc)` : 'Thông báo'}
      className="relative flex h-touch w-touch items-center justify-center rounded-lg text-ink-600 transition-colors hover:bg-ink-100"
    >
      <Icon name="bell" size={20} />
      {count > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-danger-fg">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

/** Ô logo dùng chung — chữ lồng trong khối vuông màu mực. */
export function Brand({
  label,
  sublabel,
  href,
  compact = false,
}: {
  label: string;
  sublabel?: ReactNode;
  href: string;
  compact?: boolean;
}) {
  return (
    <Link href={href} className="flex min-w-0 items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold tracking-tight text-primary-fg">
        CK
      </span>
      {!compact && (
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold leading-tight text-ink-900">
            {label}
          </span>
          {sublabel && (
            <span className="block truncate text-xs leading-tight text-ink-500">{sublabel}</span>
          )}
        </span>
      )}
    </Link>
  );
}
