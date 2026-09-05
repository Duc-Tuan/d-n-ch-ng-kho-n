'use client';

import { useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Icon } from './Icon';
import { Modal } from './Modal';

export function Card({
  children,
  className,
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-line bg-surface shadow-card',
        padded && 'p-4 sm:p-5',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-4 flex items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h3 className="text-display-sm font-semibold text-ink-900">{title}</h3>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-ink-500">{description}</p>
        )}
      </div>
      {action && <div className="-mt-0.5 shrink-0">{action}</div>}
    </div>
  );
}

/** Thẻ chỉ số cho dashboard (mục 3.1). */
export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  icon?: ReactNode;
  onClick?: () => void;
}) {
  const toneClass = {
    default: 'text-ink-900',
    success: 'text-tone-green-fg',
    warning: 'text-tone-amber-fg',
    danger: 'text-tone-red-fg',
    info: 'text-ink-900',
  }[tone];

  const Wrapper = onClick ? 'button' : 'div';

  return (
    <Wrapper
      onClick={onClick}
      className={cn(
        'group rounded-2xl border border-line bg-surface p-4 text-left shadow-card',
        onClick && 'transition-colors hover:border-line-strong hover:bg-ink-50',
      )}
    >
      {/*
        Nhãn in hoa cỡ nhỏ có giãn chữ, không phải chữ thường 14px. Ở một hàng thẻ chỉ số, nhãn
        và giá trị cùng kiểu chữ thì mắt phải đọc mới biết đâu là cái nào; khác hẳn kiểu thì
        liếc một cái là thấy ngay hàng số.
      */}
      <div className="flex items-start justify-between gap-2">
        <p className="text-label font-medium uppercase text-ink-500">{label}</p>
        {icon && <span className="text-ink-400">{icon}</span>}
      </div>
      <div className={cn('mt-2 text-2xl font-semibold tabular-nums', toneClass)}>{value}</div>
      {sub && <p className="mt-1.5 text-xs leading-relaxed text-ink-500">{sub}</p>}
    </Wrapper>
  );
}

/**
 * Tiêu đề màn hình.
 *
 * `info` là phần **giải thích nghiệp vụ** của màn (quy trình duyệt, ràng buộc BR, lý do có các
 * giới hạn…). Trước đây những nội dung này nằm thường trực trong khối Alert ở đầu trang: đọc một
 * lần là đủ nhưng chiếm chỗ mãi mãi, đẩy bảng dữ liệu xuống dưới nếp gấp màn hình. Giờ gom vào
 * một hộp thoại mở bằng icon ⓘ cạnh tiêu đề — vẫn tra cứu được bất cứ lúc nào mà không lấy mất
 * diện tích làm việc.
 */
/**
 * Nút "i" mở hộp hướng dẫn của màn hình.
 *
 * Tách khỏi `PageHeader` vì có màn không hiện tiêu đề (khung quản trị đã ghi tên màn ở thanh
 * trên), nhưng vẫn cần chỗ đặt phần giải thích — khi đó nút này nằm thẳng trên thanh công cụ.
 */
export function InfoButton({
  info,
  title,
  className,
}: {
  info: ReactNode;
  title?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Hướng dẫn và lưu ý của màn hình này"
        title="Hướng dẫn và lưu ý"
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-ink-400',
          'transition-colors hover:bg-ink-100 hover:text-ink-900',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900',
          className,
        )}
      >
        <Icon name="info" size={18} />
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title ?? 'Hướng dẫn và lưu ý'}
        size="lg"
      >
        <div className="space-y-3 text-sm leading-relaxed text-ink-700">{info}</div>
      </Modal>
    </>
  );
}

export function PageHeader({
  title,
  description,
  action,
  breadcrumb,
  info,
  infoTitle,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  breadcrumb?: ReactNode;
  info?: ReactNode;
  infoTitle?: string;
}) {
  return (
    <div className="mb-1 shrink-0">
      {breadcrumb && <div className="mb-2 text-sm text-ink-500">{breadcrumb}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-display font-semibold text-ink-900 sm:text-display-lg">{title}</h1>
            {info && <InfoButton info={info} title={infoTitle} className="h-7 w-7 rounded-full" />}
          </div>
          {description && <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}
