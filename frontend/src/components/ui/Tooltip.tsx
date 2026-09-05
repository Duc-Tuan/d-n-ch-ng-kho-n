'use client';

/**
 * Chú thích hiện khi rê chuột hoặc focus bàn phím.
 *
 * Vẽ bằng portal ra `document.body` với `position: fixed`, **không** đặt tuyệt đối trong phần tử
 * cha. Lý do rất cụ thể: các nút hành động nằm trong bảng có `overflow: auto`; chú thích đặt trong
 * cha sẽ bị vùng cuộn cắt mất, và đó lại chính là chỗ cần nó nhất.
 *
 * Hiện cả khi focus bằng bàn phím chứ không chỉ khi rê chuột — nút chỉ có icon mà không đọc được
 * nhãn thì người dùng bàn phím và trình đọc màn hình không biết nút làm gì.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

type Position = { left: number; top: number };

export function Tooltip({
  label,
  children,
  side = 'top',
}: {
  label: string;
  children: ReactNode;
  side?: 'top' | 'bottom';
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const show = useCallback(() => {
    const el = anchorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition({
      left: rect.left + rect.width / 2,
      top: side === 'top' ? rect.top - 8 : rect.bottom + 8,
    });
  }, [side]);

  const hide = useCallback(() => setPosition(null), []);

  // Cuộn trang thì toạ độ đã tính không còn đúng; ẩn đi thay vì để chú thích trôi lệch khỏi nút.
  useEffect(() => {
    if (!position) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [position, hide]);

  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        onPointerEnter={show}
        onPointerLeave={hide}
        onFocusCapture={show}
        onBlurCapture={hide}
      >
        {children}
      </span>

      {mounted &&
        position &&
        createPortal(
          <span
            role="tooltip"
            style={{
              position: 'fixed',
              left: position.left,
              top: position.top,
              transform: `translate(-50%, ${side === 'top' ? '-100%' : '0'})`,
            }}
            className="pointer-events-none z-[100] whitespace-nowrap rounded-md border border-line bg-inverted px-2 py-1 text-xs font-medium text-inverted-fg shadow-pop"
          >
            {label}
          </span>,
          document.body,
        )}
    </>
  );
}

/**
 * Nút hành động chỉ có icon trong bảng — luôn đi kèm chú thích.
 *
 * Gom thành một component để không nơi nào lỡ đặt icon trần không nhãn: người dùng đoán ý nghĩa
 * của icon là chuyện không nên xảy ra ở màn quản trị, nơi thao tác nhầm rất tốn kém.
 */
export function RowAction({
  label,
  icon,
  onClick,
  href,
  external,
  danger,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const className = [
    'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-900 focus-visible:ring-offset-1',
    disabled
      ? 'cursor-not-allowed text-ink-300'
      : danger
        ? 'text-ink-500 hover:bg-tone-red-bg hover:text-tone-red-fg'
        : 'text-ink-500 hover:bg-ink-100 hover:text-ink-900',
  ].join(' ');

  const content = (
    <Tooltip label={label}>
      {href ? (
        <a
          href={href}
          aria-label={label}
          className={className}
          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          onClick={(e) => e.stopPropagation()}
        >
          {icon}
        </a>
      ) : (
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          className={className}
          onClick={(e) => {
            e.stopPropagation();
            onClick?.();
          }}
        >
          {icon}
        </button>
      )}
    </Tooltip>
  );

  return content;
}
