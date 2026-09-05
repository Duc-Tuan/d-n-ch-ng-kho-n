'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, type ReactNode } from 'react';

import { NotificationMenu } from '@/components/layout/NotificationMenu';
import { Brand, UserMenu } from '@/components/layout/UserMenu';
import { AccessBanner, Spinner } from '@/components/ui';
import { Icon, type IconName } from '@/components/ui/Icon';
import { useContentRealtime, useSession, useThemeArea } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';

/** BR-826 — thanh dưới trên điện thoại, tối đa 5 mục. */
const BOTTOM_NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: '/', label: 'Trang chủ', icon: 'home' },
  { href: '/market', label: 'Bảng giá', icon: 'chart' },
  { href: '/strategies', label: 'Chiến lược', icon: 'target' },
  { href: '/news', label: 'Tin tức', icon: 'document' },
  { href: '/account', label: 'Tài khoản', icon: 'user' },
];

const DESKTOP_NAV = [
  { href: '/', label: 'Trang chủ' },
  { href: '/market', label: 'Bảng giá' },
  { href: '/strategies', label: 'Chiến lược' },
  { href: '/news', label: 'Tin tức' },
  { href: '/articles', label: 'Bài viết' },
];

function isActive(pathname: string, href: string) {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/**
 * Khung Customer Site.
 *
 * BR-001 — bị backend chặn thì điều hướng tới đúng màn theo `access.action.type`
 * thay vì hiện thông báo chung chung (BR-112).
 */
export function CustomerShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { session, loading, isAuthenticated, logout } = useSession();

  // YC16 — bài viết bị sửa/gỡ/xoá ở site quản trị thì màn đang mở tự cập nhật, không phải F5.
  // Đặt ở khung chung nên áp dụng cho mọi màn con: danh sách, chi tiết, khối bài mới ở trang chủ.
  useContentRealtime(isAuthenticated);

  // Site khách hàng chạy nền tối. Script trong `app/layout.tsx` đã đặt từ lượt tải đầu; dòng
  // này lo trường hợp người dùng đi từ `/admin` sang bằng điều hướng phía trình duyệt.
  useThemeArea('dark');

  useEffect(() => {
    if (loading) return;

    if (!isAuthenticated) {
      router.replace(`/login?next=${encodeURIComponent(pathname)}`);
      return;
    }

    const access = session?.access;
    if (access && !access.allowed) {
      const target =
        {
          CHOOSE_PACKAGE: '/pricing',
          RENEW: '/pricing',
          VERIFY_EMAIL: '/verify-email',
          RESTORE_COMPLIANCE: '/account/blocked',
          CONTACT_SUPPORT: '/account/blocked',
        }[access.action?.type ?? ''] ?? '/account/blocked';

      if (!pathname.startsWith(target)) router.replace(target);
    }
  }, [loading, isAuthenticated, session, pathname, router]);

  if (loading || !isAuthenticated) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas">
        <Spinner label="Đang tải…" />
      </div>
    );
  }

  const user = session?.user;

  return (
    // Khung cao đúng bằng màn hình: đầu trang, chân trang và thanh điều hướng dưới đứng yên,
    // chỉ vùng nội dung cuộn. Nhờ vậy trang con đặt được thanh công cụ và phân trang cố định
    // bằng `h-full` — cùng cách khung quản trị đang dùng.
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
      {/*
        Thanh trên hơi trong suốt cộng `backdrop-blur`: nội dung cuộn qua bên dưới vẫn thấy mờ
        mờ, nên thanh đọc ra là một lớp nổi chứ không phải một dải đặc cắt ngang màn hình. Ở nền
        tối chi tiết này gánh phần việc mà đổ bóng làm ở nền sáng — bóng trên nền gần đen thì
        không ai nhìn thấy.
      */}
      <header className="z-30 shrink-0 border-b border-line bg-surface/85 backdrop-blur-xl">
        {/* Bề rộng nội dung rộng hơn hẳn để không thừa hai mép trên màn hình lớn. */}
        <div className="mx-auto flex h-[4.25rem] max-w-content items-center justify-between gap-4 px-4 lg:px-8">
          <div className="flex min-w-0 items-center gap-6">
            <Brand label="Tư vấn chứng khoán" href="/" />

            <nav className="hidden items-center gap-1 lg:flex">
              {DESKTOP_NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive(pathname, item.href) ? 'page' : undefined}
                  className={cn(
                    'rounded-lg px-3 py-2 text-sm transition-colors',
                    isActive(pathname, item.href)
                      ? 'bg-brand-soft font-medium text-brand'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <NotificationMenu basePath={CUSTOMER} listPath="/notifications" />
            <UserMenu
              name={user?.full_name ?? ''}
              subtitle={user?.customer_code ?? undefined}
              items={[
                { label: 'Hồ sơ cá nhân', href: '/account', icon: 'user' },
                { label: 'Điều kiện duy trì', href: '/account/compliance', icon: 'shield' },
                { label: 'Cài đặt thông báo', href: '/account/notifications', icon: 'bell' },
                { label: 'Gói dịch vụ', href: '/pricing', icon: 'star' },
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
        </div>

        {/* BR-134 / BR-302 — banner GRACE / WARNING hiển thị trên mọi trang. */}
        <AccessBanner banner={session?.access.banner ?? null} />
      </header>

      {/*
        Vùng cuộn duy nhất của trang. `min-h-0` là bắt buộc: phần tử con của flex mặc định
        `min-height: auto` nên thiếu nó thì `overflow-y-auto` không bao giờ có hiệu lực và cả
        khung bị đẩy dài ra.

        Khoảng hở cho thanh điều hướng dưới đặt là `padding` của chính vùng cuộn chứ không phải
        `margin` của lớp con: `h-full` không trừ margin, trang con sẽ thò xuống dưới thanh đó.
      */}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-bottom-nav lg:pb-0">
        {/*
          Đệm dưới rất mỏng để phân trang nằm sát mép, nhường chỗ cho nội dung.

          Vẫn là `flex flex-col`: trang con dùng `flex-1` (bảng giá) hay `h-full` (các màn danh
          sách) đều lấp đúng chiều cao còn lại, và trang dài hơn thì tràn ra cho vùng cha cuộn.
        */}
        <div className="mx-auto flex h-full w-full max-w-content flex-col px-4 pb-2 pt-6 lg:px-8">
          {children}
        </div>
      </main>

      <footer className="hidden shrink-0 border-t border-line bg-surface lg:block">
        <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-3 px-8 py-4 text-xs text-ink-500">
          <nav className="flex flex-wrap gap-x-5 gap-y-1">
            <Link href="/legal/tos" className="transition-colors hover:text-ink-900">
              Điều khoản sử dụng
            </Link>
            <Link href="/legal/privacy" className="transition-colors hover:text-ink-900">
              Chính sách bảo mật
            </Link>
            <Link href="/legal/refund" className="transition-colors hover:text-ink-900">
              Chính sách hoàn tiền
            </Link>
            <Link href="/legal/disclaimer" className="transition-colors hover:text-ink-900">
              Miễn trừ trách nhiệm
            </Link>
          </nav>
          <p className="max-w-xl">
            Thông tin mang tính tham khảo, không phải khuyến nghị mua bán chứng khoán.
          </p>
        </div>
      </footer>

      {/* BR-826 — điều hướng chính trên điện thoại là thanh dưới, tối đa 5 mục. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 pb-safe backdrop-blur-xl lg:hidden">
        <div className="mx-auto flex max-w-md">
          {BOTTOM_NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative flex min-h-touch flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[11px] transition-colors',
                  active ? 'font-medium text-brand' : 'text-ink-500',
                )}
              >
                {/* Vạch trên đầu mục đang mở: ở cỡ chữ 11px, riêng đậm/nhạt là quá mảnh để
                    nhận ra mình đang ở đâu chỉ bằng một cái liếc. */}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-4 top-0 h-0.5 rounded-full bg-brand"
                  />
                )}
                <Icon name={item.icon} size={20} />
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
