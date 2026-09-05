'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';
import { Button, IconButton } from './Button';
import { Icon } from './Icon';
import { Textarea } from './Input';

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
};

const SIZE: Record<NonNullable<ModalProps['size']>, string> = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
};

/**
 * Khoá cuộn nền khi mở lớp phủ.
 *
 * Phải **bù đúng bề rộng thanh cuộn** bằng padding-right. Nếu chỉ đặt `overflow: hidden`,
 * thanh cuộn biến mất làm toàn bộ trang giãn ra vài pixel — header dính (sticky) nhảy sang phải
 * rồi nhảy về khi đóng, tạo cảm giác giao diện bị giật và để lộ vệt nền ở mép.
 */
function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;

    const { body } = document;
    const previousOverflow = body.style.overflow;
    const previousPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) {
      const current = parseFloat(window.getComputedStyle(body).paddingRight) || 0;
      body.style.paddingRight = `${current + scrollbarWidth}px`;
    }

    return () => {
      body.style.overflow = previousOverflow;
      body.style.paddingRight = previousPaddingRight;
    };
  }, [locked]);
}

/**
 * Modal trên desktop, **bottom sheet trên mobile** (BR-846).
 *
 * Render qua portal gắn thẳng vào `document.body`: nếu để trong cây DOM của trang, phần tử
 * `position: fixed` sẽ bị neo theo phần tử cha có `transform`/`filter` thay vì theo khung nhìn,
 * khiến lớp phủ không che hết màn hình và để lộ một vệt nền ở mép trên.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: ModalProps) {
  const [mounted, setMounted] = useState(false);

  useScrollLock(open);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-black/60 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border border-line bg-surface-raised shadow-pop',
          'animate-sheet-up sm:animate-slide-up sm:rounded-xl',
          SIZE[size],
        )}
      >
        {/* Tay cầm kéo — tín hiệu quen thuộc của bottom sheet trên điện thoại. */}
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-ink-300 sm:hidden" />

        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-ink-500">{description}</p>}
          </div>
          <IconButton label="Đóng" onClick={onClose} size="sm" className="-mr-2 -mt-1 shrink-0">
            <Icon name="close" size={18} />
          </IconButton>
        </div>

        {/* Chỉ vùng nội dung được cuộn — tiêu đề và chân luôn nhìn thấy. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">{children}</div>

        {footer && (
          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-line px-5 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Hộp thoại xác nhận. Đặt `requireReason` cho hành động mà mục 3.4/3.6 bắt buộc nhập lý do
 * (gia hạn thủ công, khoá/mở tài khoản, xoá bài viết, đổi phân quyền, miễn áp điều kiện IB).
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Xác nhận',
  cancelLabel = 'Huỷ',
  danger = false,
  loading = false,
  requireReason = false,
  reasonLabel = 'Lý do',
  reasonHint = 'Lý do sẽ được ghi vào nhật ký hệ thống.',
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonHint?: string;
}) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const reasonTooShort = requireReason && reason.trim().length < 3;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={() => onConfirm(reason.trim())}
            loading={loading}
            disabled={reasonTooShort}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="text-sm leading-relaxed text-ink-700">{message}</div>
        {requireReason && (
          <Textarea
            label={reasonLabel}
            hint={reasonHint}
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Nhập lý do thực hiện thao tác này…"
          />
        )}
      </div>
    </Modal>
  );
}
