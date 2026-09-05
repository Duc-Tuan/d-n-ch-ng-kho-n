'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Icon, type IconName } from './Icon';
import type { Banner } from '@/types';
import { Button } from './Button';

export function Spinner({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center gap-2', className)}>
      <span
        className="h-6 w-6 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900"
        aria-hidden
      />
      {label && <span className="text-sm text-ink-500">{label}</span>}
    </div>
  );
}

type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const ALERT_CLASS: Record<AlertTone, string> = {
  info: 'border-tone-blue-line bg-tone-blue-bg text-tone-blue-fg',
  success: 'border-tone-green-line bg-tone-green-bg text-tone-green-fg',
  warning: 'border-tone-amber-line bg-tone-amber-bg text-tone-amber-fg',
  danger: 'border-tone-red-line bg-tone-red-bg text-tone-red-fg',
};

const ALERT_ICON: Record<AlertTone, IconName> = {
  info: 'info',
  success: 'check',
  warning: 'warning',
  danger: 'warning',
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('rounded-lg border px-4 py-3', ALERT_CLASS[tone], className)}
      role={tone === 'danger' ? 'alert' : 'status'}
    >
      <div className="flex items-start gap-3">
        <Icon name={ALERT_ICON[tone]} size={18} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1 space-y-1">
          {title && <p className="text-sm font-semibold">{title}</p>}
          {children && <div className="text-sm leading-relaxed">{children}</div>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

/**
 * Banner trạng thái tài khoản trên toàn site.
 *
 * BR-134 — GRACE hiện banner đỏ kèm nút gia hạn.
 * BR-302 — WARNING hiện đếm ngược số ngày còn lại trước khi tạm dừng.
 * BR-112 — thông điệp và hành động do backend quyết định, FE chỉ hiển thị.
 */
export function AccessBanner({ banner }: { banner: Banner | null }) {
  if (!banner) return null;

  const tone: AlertTone =
    banner.level === 'danger' ? 'danger' : banner.level === 'warning' ? 'warning' : 'info';

  return (
    <Alert
      tone={tone}
      className="rounded-none border-x-0 border-t-0"
      action={
        banner.action?.url ? (
          <Link href={banner.action.url}>
            <Button size="sm" variant={tone === 'danger' ? 'danger' : 'primary'}>
              {banner.action.label ?? 'Xem chi tiết'}
            </Button>
          </Link>
        ) : undefined
      }
    >
      {banner.message}
    </Alert>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-ink-50/60 px-6 py-14 text-center">
      {/* Icon đặt trong một vòng tròn có nền: một icon trần giữa khoảng trắng trông như thiếu
          ảnh chứ không như một trạng thái được thiết kế. */}
      {icon && (
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-ink-100 text-ink-400">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-ink-800">{title}</p>
      {description && (
        <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-500">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/**
 * Khối hiển thị khi nội dung bị khoá theo gói (BR-502, BR-847).
 * Luôn kèm lối thoát rõ ràng — đây là đòn bẩy bán gói, không phải cánh cửa đóng sập.
 */
export function LockedContent({
  title = 'Nội dung thuộc gói cao hơn',
  description = 'Nâng cấp gói dịch vụ để xem đầy đủ nội dung này.',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-tone-amber-line bg-tone-amber-bg/70 px-6 py-10 text-center">
      <Icon name="lock" size={32} className="mx-auto mb-3 text-tone-amber-fg" />
      <p className="text-sm font-semibold text-tone-amber-fg">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-tone-amber-fg/80">{description}</p>
      <Link href="/pricing" className="mt-4 inline-block">
        <Button size="sm">Xem các gói dịch vụ</Button>
      </Link>
    </div>
  );
}

/**
 * BR-601 / BR-844 — disclaimer cố định, hiển thị ở vị trí khách hàng thực sự nhìn thấy,
 * không giấu trong tooltip.
 */
export function Disclaimer({
  className,
  children,
}: {
  className?: string;
  /**
   * Nội dung thay thế cho những màn cần cảnh báo riêng (ví dụ kết quả mô phỏng chiến lược).
   * Bỏ trống thì dùng câu chuẩn — giữ nguyên khuôn hình thức để người đọc nhận ra ngay đây là
   * cảnh báo miễn trừ, dù nội dung khác nhau.
   */
  children?: ReactNode;
}) {
  return (
    <p
      className={cn(
        'rounded-lg border border-line bg-ink-50 px-3 py-2 text-xs leading-relaxed text-ink-600',
        className,
      )}
    >
      <Icon name="warning" size={15} className="mr-1.5 inline-block align-[-2px]" />
      {children ?? (
        <>
          Thông tin mang tính tham khảo, không phải khuyến nghị mua bán chứng khoán. Hiệu suất trong
          quá khứ không đảm bảo kết quả trong tương lai. Bạn tự chịu trách nhiệm với mọi quyết định
          đầu tư của mình.
        </>
      )}
    </p>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-ink-200', className)} />;
}
