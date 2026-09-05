'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Spinner } from '@/components/ui';
import { Icon, type IconName } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/Button';
import { ChangePasswordModal } from '@/components/domain/ChangePasswordModal';
import { NotificationMenu } from '@/components/layout/NotificationMenu';
import { Brand, UserMenu } from '@/components/layout/UserMenu';
import { useNotificationSound, useRealtime, useStaffSession, useToast, useThemeArea } from '@/hooks';
import { ADMIN } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Menu Admin Site.
 *
 * `permissions` chỉ dùng để **ẩn/hiện menu**. BR-533 — chặn thật nằm ở backend trên từng
 * endpoint; nhân viên gõ thẳng URL vẫn bị API từ chối.
 */
const NAV_GROUPS: Array<{
  label: string;
  items: Array<{ href: string; label: string; icon: IconName; permissions?: string[] }>;
}> = [
  {
    label: 'Tổng quan',
    items: [
      { href: '/admin', label: 'Dashboard', icon: 'dashboard', permissions: ['dashboard.view'] },
      {
        href: '/admin/customers/warning',
        label: 'Cảnh báo NAV',
        icon: 'warning',
        permissions: ['customer.view'],
      },
    ],
  },
  {
    label: 'Khách hàng',
    items: [
      { href: '/admin/customers', label: 'Danh sách KH', icon: 'users', permissions: ['customer.view'] },
    ],
  },
  {
    label: 'Nội dung',
    items: [
      {
        href: '/admin/articles',
        label: 'Bài viết',
        icon: 'edit',
        permissions: ['content.view', 'content.create'],
      },
      { href: '/admin/documents', label: 'Tài liệu', icon: 'folder', permissions: ['doc.view'] },
      {
        href: '/admin/strategies',
        label: 'Chiến lược & tín hiệu',
        icon: 'target',
        permissions: ['strategy.view', 'strategy.manage'],
      },
      { href: '/admin/questions', label: 'Hỏi đáp', icon: 'mail', permissions: ['qa.answer'] },
      {
        href: '/admin/news',
        label: 'Tin tức dẫn nguồn',
        icon: 'external',
        permissions: ['content.view', 'content.create'],
      },
      {
        href: '/admin/news/sources',
        label: 'Nguồn tin tự động',
        icon: 'refresh',
        permissions: ['content.view', 'content.create'],
      },
    ],
  },
  {
    label: 'Vận hành',
    items: [
      { href: '/admin/market', label: 'Dữ liệu thị trường', icon: 'chart', permissions: ['sync.view'] },
      { href: '/admin/sync', label: 'Đồng bộ NAV', icon: 'refresh', permissions: ['sync.view'] },
      { href: '/admin/telegram', label: 'Telegram', icon: 'telegram', permissions: ['telegram.view'] },
      {
        href: '/admin/notifications',
        label: 'Gửi thông báo',
        icon: 'bell',
        permissions: ['notification.send'],
      },
    ],
  },
  {
    label: 'Hệ thống',
    items: [
      { href: '/admin/staff', label: 'Nhân viên & quyền', icon: 'key', permissions: ['staff.view'] },
      { href: '/admin/legal', label: 'Văn bản pháp lý', icon: 'scale', permissions: ['legal.manage'] },
      { href: '/admin/audit', label: 'Nhật ký hệ thống', icon: 'archive', permissions: ['audit.view'] },
      { href: '/admin/settings', label: 'Cấu hình hệ thống', icon: 'settings', permissions: ['staff.manage'] },
    ],
  },
];

function covers(pathname: string, href: string): boolean {
  if (href === '/admin') return pathname === '/admin';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Mục menu đang mở — mục khớp **sâu nhất** thắng.
 *
 * Không dùng "mục đầu tiên khớp tiền tố": `/admin/news/sources` khớp cả `/admin/news`, và khi
 * đó màn Nguồn tin sẽ sáng nhầm ở mục Tin tức kèm tiêu đề sai trên header.
 */
function activeHref(pathname: string): string | null {
  let best: string | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (covers(pathname, item.href) && (best === null || item.href.length > best.length)) {
        best = item.href;
      }
    }
  }
  return best;
}

/** Nhãn hiển thị trên header, suy ra từ đường dẫn hiện tại. */
function pageTitle(pathname: string): string {
  const href = activeHref(pathname);
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.href === href) return item.label;
    }
  }
  return 'Quản trị hệ thống';
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Site quản trị giữ nền sáng — xem `app/layout.tsx` và `tailwind.config.ts`.
  useThemeArea('light');
  const current = activeHref(pathname);
  const router = useRouter();
  const { staff, loading, isAuthenticated, can, logout } = useStaffSession();
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * Hộp thoại đổi mật khẩu đặt ở khung chung, mở bằng `onClick` chứ không bằng đường dẫn có
   * `#password`.
   *
   * Cách cũ trỏ tới `/admin/profile#password` rồi để trang hồ sơ đọc hash lúc mount — nhưng khi
   * đang đứng sẵn ở trang hồ sơ thì đổi hash **không** làm component mount lại, nên hộp thoại
   * không bao giờ mở. Trạng thái nằm ngay tại chỗ có nút bấm thì không có khoảng hở đó.
   */
  const [passwordOpen, setPasswordOpen] = useState(false);

  const isLoginPage = pathname === '/admin/login';

  useEffect(() => {
    if (loading || isLoginPage) return;
    if (!isAuthenticated) router.replace('/admin/login');
  }, [loading, isAuthenticated, isLoginPage, router]);

  useEffect(() => setMenuOpen(false), [pathname]);

  /**
   * YC4 — nhắc nhở bằng toast thay vì banner cố định.
   *
   * Banner đứng thường trực chiếm một khoảng chiều cao trên mọi màn, trong khi nội dung chỉ cần
   * đọc một lần. Toast truyền đạt đủ mà không lấy mất diện tích làm việc.
   */
  const toast = useToast();
  const warned = useRef(false);
  useEffect(() => {
    if (!staff || warned.current) return;
    warned.current = true;

    if (staff.must_change_password) {
      toast.warning('Bạn đang dùng mật khẩu do quản trị viên cấp — hãy đổi mật khẩu ngay.');
    }
  }, [staff, toast]);

  /**
   * YC17 — mọi sự kiện real-time từ khách hàng đều bắn toast kèm âm thanh, để người trực trang
   * biết ngay mà không phải nhìn màn hình liên tục.
   */
  const playSound = useNotificationSound();
  useRealtime(
    'admin',
    (event) => {
      if (event.type !== 'notification') return;
      const level = String(event.level ?? 'info');
      const title = String(event.title ?? 'Có sự kiện mới');
      if (level === 'danger' || level === 'warning') {
        toast.warning(title);
        playSound('alert');
      } else {
        toast.info(title);
        playSound('info');
      }
    },
    isAuthenticated && !isLoginPage,
  );

  if (isLoginPage) return <>{children}</>;

  if (loading || !isAuthenticated) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-ink-50">
        <Spinner label="Đang tải…" />
      </div>
    );
  }

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permissions || can(...item.permissions)),
  })).filter((group) => group.items.length > 0);

  return (
    /**
     * Khung cố định đúng chiều cao khung nhìn. Chỉ vùng `main` được cuộn — sidebar và header
     * luôn đứng yên, nên thao tác nhiều bước không bị mất phương hướng.
     */
    <div className="flex h-dvh overflow-hidden bg-ink-50">
      {/* ---------- SIDEBAR TRÁI ---------- */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-sidebar flex-col border-r border-ink-200 bg-surface transition-transform duration-200 lg:static lg:translate-x-0',
          menuOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-ink-100 px-4">
          <Brand label="Quản trị" sublabel="Tư vấn chứng khoán" href="/admin" />
          <IconButton label="Đóng menu" onClick={() => setMenuOpen(false)} size="sm" className="lg:hidden">
            <Icon name="close" size={18} />
          </IconButton>
        </div>

        {/* Menu dài hơn màn hình thì tự cuộn trong sidebar, không đẩy layout. */}
        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-3 py-4">
          {visibleGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-400">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = item.href === current;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-touch items-center gap-2.5 rounded-lg px-3 text-sm transition-colors',
                          active
                            ? 'bg-ink-900 font-medium text-white'
                            : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                        )}
                      >
                        <Icon
                          name={item.icon}
                          size={18}
                          className={active ? 'text-white' : 'text-ink-400'}
                        />
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-ink-100 px-4 py-3">
          <p className="text-[11px] leading-relaxed text-ink-400">
            Phiên bản 1.0 · Múi giờ Asia/Ho_Chi_Minh
          </p>
        </div>
      </aside>

      {menuOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={() => setMenuOpen(false)}
          aria-hidden
        />
      )}

      {/* ---------- CỘT PHẢI: HEADER + MAIN + FOOTER ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-ink-200 bg-surface px-4 lg:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <IconButton label="Mở menu" onClick={() => setMenuOpen(true)} className="lg:hidden">
              <Icon name="menu" size={20} />
            </IconButton>
            <h1 className="truncate text-base font-semibold text-ink-900">{pageTitle(pathname)}</h1>
          </div>

          <div className="flex items-center gap-1">
            <NotificationMenu basePath={ADMIN} listPath="/admin/notifications-inbox" />
            <UserMenu
              name={staff?.full_name ?? staff?.username ?? ''}
              subtitle={staff?.roles.join(', ')}
              items={[
                { label: 'Hồ sơ cá nhân', href: '/admin/profile', icon: 'user' },
                { label: 'Đổi mật khẩu', icon: 'key', onClick: () => setPasswordOpen(true) },
                {
                  label: 'Đăng xuất',
                  icon: 'logout',
                  onClick: logout,
                  separated: true,
                  danger: true,
                },
              ]}
            />
          </div>
        </header>

        {/* Vùng cuộn duy nhất của trang quản trị. */}
        <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/*
            `h-full` để trang con dùng được `flex h-full flex-col` — nhờ đó bảng danh sách lấp
            đầy phần trống còn lại thay vì phải căn `maxHeight` bằng tay cho từng màn.
            Khối này vẫn là block (không phải flex) nên trang nội dung dài hơn màn hình vẫn tràn
            ra và `main` cuộn bình thường, không bị bóp lại.
          */}
          <div className="mx-auto h-full max-w-[110rem] p-4 pb-1 lg:p-6 lg:pb-1">{children}</div>
        </main>

        {passwordOpen && <ChangePasswordModal onClose={() => setPasswordOpen(false)} />}

        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-ink-200 bg-surface px-4 py-2.5 text-xs text-ink-500 lg:px-6">
          <span>Hệ thống tư vấn chứng khoán · Trang quản trị nội bộ</span>
          <span className="hidden sm:inline">
            Mọi thao tác thay đổi dữ liệu đều được ghi vào nhật ký hệ thống
          </span>
        </footer>
      </div>
    </div>
  );
}
