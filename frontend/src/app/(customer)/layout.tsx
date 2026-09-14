import { CustomerShell } from '@/components/layout/CustomerShell';
import { SessionProvider, ThemeProvider } from '@/hooks';

/**
 * Vùng Customer Site.
 *
 * BR-000 — dùng `SessionProvider` (cookie `cst_at`), hoàn toàn tách khỏi vùng `/admin`
 * vốn dùng `StaffSessionProvider` (cookie `adm_at`) và secret ký JWT khác.
 *
 * `ThemeProvider` bọc ngoài cùng: nó chỉ đụng tới thẻ `<html>` và `localStorage`, không cần
 * biết người dùng là ai, và đặt ngoài thì bảng màu đã đúng ngay cả ở màn hình chờ tải phiên.
 */
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <SessionProvider>
        <CustomerShell>{children}</CustomerShell>
      </SessionProvider>
    </ThemeProvider>
  );
}
