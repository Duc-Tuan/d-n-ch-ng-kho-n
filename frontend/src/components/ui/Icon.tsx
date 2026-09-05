'use client';

/**
 * Bộ icon SVG dùng chung.
 *
 * Thay cho emoji: emoji render khác nhau trên từng hệ điều hành (Windows vẽ kiểu 3D nhiều màu,
 * macOS/Android lại khác), không đổi màu theo ngữ cảnh được, và không căn hàng ổn định với chữ.
 * SVG nét mảnh kế thừa `currentColor` nên luôn khớp với hệ màu của giao diện.
 *
 * Nét vẽ theo phong cách outline 1.5px, khung 24×24 — đồng nhất toàn hệ thống.
 */
import type { SVGProps } from 'react';

import { cn } from '@/lib/cn';

export type IconName =
  | 'home'
  | 'chart'
  | 'target'
  | 'folder'
  | 'user'
  | 'users'
  | 'bell'
  | 'document'
  | 'edit'
  | 'key'
  | 'archive'
  | 'refresh'
  | 'send'
  | 'scale'
  | 'warning'
  | 'info'
  | 'check'
  | 'close'
  | 'search'
  | 'plus'
  | 'minus'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'arrow-up'
  | 'arrow-down'
  | 'arrow-left'
  | 'lock'
  | 'unlock'
  | 'logout'
  | 'menu'
  | 'settings'
  | 'eye'
  | 'eye-off'
  | 'download'
  | 'upload'
  | 'trash'
  | 'clock'
  | 'calendar'
  | 'shield'
  | 'telegram'
  | 'mail'
  | 'phone'
  | 'share'
  | 'copy'
  | 'star'
  | 'filter'
  | 'external'
  | 'maximize'
  | 'minimize'
  | 'dashboard'
  | 'trending-up'
  | 'trending-down'
  | 'sparkles'
  | 'spinner';

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  /** Kích thước theo px, mặc định 20. */
  size?: number;
};

/** Đường vẽ của từng icon. Tách riêng để thân component gọn và dễ bổ sung. */
const PATHS: Record<IconName, React.ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5.5 9v10.5A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V9" />,
  chart: <path d="M3 3v18h18M7 15l3.5-4 3 2.5L20 7" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.75" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.25" />
      <path d="M2.5 19.5a6.5 6.5 0 0 1 13 0M16 5.5a3.25 3.25 0 0 1 0 6M18 19.5a6.4 6.4 0 0 0-2-4.7" />
    </>
  ),
  bell: <path d="M18 8.5a6 6 0 1 0-12 0c0 5-2 6.5-2 6.5h16s-2-1.5-2-6.5M10.5 19a1.8 1.8 0 0 0 3 0" />,
  document: <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4" />,
  edit: <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 6.5l3 3" />,
  key: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3M21 12v2.5" />
    </>
  ),
  archive: <path d="M3 7h18v3H3zM5 10v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9M10 14h4" />,
  refresh: <path d="M20 11a8 8 0 0 0-13.7-5.3L4 8M4 4v4h4M4 13a8 8 0 0 0 13.7 5.3L20 16M20 20v-4h-4" />,
  send: <path d="M21 3 3 10.5l7 3 3 7z" />,
  scale: <path d="M12 3v18M7 7h10M5 7l-2.5 6h5zM19 7l-2.5 6h5zM8 20h8" />,
  warning: <path d="M12 4 2.5 20h19zM12 10v4.5M12 17.5v.5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8v.5" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  'chevron-down': <path d="m6 9 6 6 6-6" />,
  'chevron-left': <path d="m15 6-6 6 6 6" />,
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  'arrow-up': <path d="M12 20V4M6 10l6-6 6 6" />,
  'arrow-down': <path d="M12 4v16M6 14l6 6 6-6" />,
  'arrow-left': <path d="M20 12H4M10 6l-6 6 6 6" />,
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  unlock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 7.5-2" />
    </>
  ),
  logout: <path d="M15 17v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v2M11 12h10M18 9l3 3-3 3" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1v.2a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  eye: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3 3.7M6.3 6.3A17 17 0 0 0 2 12s3.5 6 10 6a9.8 9.8 0 0 0 4-.8M3 3l18 18M9.9 9.9a3 3 0 0 0 4.2 4.2" />,
  download: <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4 20h16" />,
  upload: <path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M4 20h16" />,
  trash: <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M10 11v6M14 11v6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  shield: <path d="M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6zM9 12l2 2 4-4" />,
  telegram: <path d="M21.5 4 2.8 11.2c-.9.3-.9 1.5.1 1.7l4.6 1.2 1.8 5.4c.3.8 1.3.9 1.8.3l2.5-2.7 4.7 3.5c.7.5 1.7.1 1.9-.7l2.9-14c.2-.9-.7-1.6-1.6-1.2M7.5 14.1l10-6.4-7.9 7.6-.2 3.3z" />,
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 6.5 8.5 6 8.5-6" />
    </>
  ),
  phone: <path d="M6.5 3h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5L16 12l4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 3.5 5.2 2 2 0 0 1 5.5 3z" />,
  share: (
    <>
      <circle cx="18" cy="6" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="m8.2 10.8 7.6-3.6M8.2 13.2l7.6 3.6" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  star: <path d="m12 3.5 2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8-5.4 2.8 1-6L3.3 9.9l6-.9z" />,
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8z" />,
  external: <path d="M14 4h6v6M20 4l-8 8M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />,
  maximize: <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3" />,
  minimize: <path d="M3 8h3a2 2 0 0 0 2-2V3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M21 16h-3a2 2 0 0 0-2 2v3" />,
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  'trending-up': <path d="m3 17 6-6 4 4 8-8M15 7h6v6" />,
  'trending-down': <path d="m3 7 6 6 4-4 8 8M15 17h6v-6" />,
  sparkles: (
    <>
      <path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z" />
      <path d="M18 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
};

export function Icon({ name, size = 20, className, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={cn('shrink-0', name === 'spinner' && 'animate-spin', className)}
      {...props}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Icon mũi tên tăng/giảm theo quy ước thị trường Việt Nam: tăng xanh lá, giảm đỏ. */
export function PriceArrow({ change, size = 14 }: { change: number | null | undefined; size?: number }) {
  if (change === null || change === undefined || change === 0) return null;
  return (
    <Icon
      name={change > 0 ? 'arrow-up' : 'arrow-down'}
      size={size}
      className={change > 0 ? 'text-up' : 'text-down'}
    />
  );
}
