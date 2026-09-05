import type { Metadata } from 'next';

import { AdminShell } from '@/components/layout/AdminShell';
import { StaffSessionProvider } from '@/hooks';

export const metadata: Metadata = {
  title: { default: 'Quản trị hệ thống', template: '%s · Quản trị' },
  // Trang quản trị không được lập chỉ mục.
  robots: { index: false, follow: false },
};

/**
 * Vùng Admin Site.
 *
 * BR-000 — dùng `StaffSessionProvider` (cookie `adm_at`, bảng `staff`, secret ký JWT riêng).
 * Tài khoản khách hàng không bao giờ đăng nhập được vào đây và ngược lại.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <StaffSessionProvider>
      <AdminShell>{children}</AdminShell>
    </StaffSessionProvider>
  );
}
