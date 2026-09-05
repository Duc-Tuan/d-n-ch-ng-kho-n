import { CustomerShell } from '@/components/layout/CustomerShell';
import { SessionProvider } from '@/hooks';

/**
 * Vùng Customer Site.
 *
 * BR-000 — dùng `SessionProvider` (cookie `cst_at`), hoàn toàn tách khỏi vùng `/admin`
 * vốn dùng `StaffSessionProvider` (cookie `adm_at`) và secret ký JWT khác.
 */
export default function CustomerLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <CustomerShell>{children}</CustomerShell>
    </SessionProvider>
  );
}
