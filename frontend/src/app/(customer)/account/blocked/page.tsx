'use client';

import Link from 'next/link';

import { Alert, Button, Card, PageHeader, Spinner } from '@/components/ui';
import { useSession } from '@/hooks';
import { formatDate } from '@/lib/datetime';

/**
 * Màn hiển thị khi BR-001 chặn truy cập vì lý do compliance.
 *
 * BR-112 — phải nêu đúng lý do và hành động tiếp theo, không dùng thông báo chung chung.
 * BR-303 — nêu rõ đây là trạng thái **tự khôi phục**, để KH biết vẫn còn đường quay lại.
 * BR-304 — trấn an rằng thời hạn gói đang đóng băng, KH không mất ngày sử dụng nào.
 */
export default function BlockedPage() {
  const { session, logout, loading } = useSession();

  if (loading) return <Spinner label="Đang tải…" />;

  const access = session?.access;
  const user = session?.user;
  const action = access?.action ?? {};
  const selfRecoverable = action.self_recoverable === true;
  const isClosed = access?.reason === 'ACCOUNT_CLOSED';

  return (
    <div className="mx-auto max-w-xl space-y-5">
      <PageHeader title="Tài khoản đang bị hạn chế" />

      <Alert tone="danger" title="Lý do">
        {access?.message ?? 'Tài khoản của bạn hiện không thể sử dụng dịch vụ.'}
      </Alert>

      {selfRecoverable && (
        <Card className="space-y-3">
          <h3 className="text-sm font-semibold text-ink-900">Cách khôi phục</h3>
          <ul className="space-y-2 text-sm text-ink-700">
            <li className="flex gap-2">
              <span className="text-ink-900">1.</span>
              Nạp thêm tiền hoặc phát sinh giao dịch để đáp ứng lại điều kiện duy trì tài khoản.
            </li>
            <li className="flex gap-2">
              <span className="text-ink-900">2.</span>
              Hệ thống kiểm tra lại hằng ngày sau khi thị trường đóng cửa và{' '}
              <strong>tự động mở lại</strong> tài khoản khi điều kiện được đáp ứng — bạn không cần
              làm thủ tục gì thêm.
            </li>
          </ul>

          {/* BR-304 — đây là điều KH lo nhất khi bị khoá; nói rõ ngay để giảm khiếu nại. */}
          <Alert tone="info">
            Trong thời gian tạm dừng, <strong>thời hạn gói của bạn được đóng băng</strong>. Số ngày
            bị khoá sẽ được bù đủ vào ngày hết hạn khi tài khoản khôi phục.
            {session?.subscription && (
              <>
                {' '}
                Ngày hết hạn hiện tại: {formatDate(session.subscription.expires_at)}.
              </>
            )}
          </Alert>

          <Link href="/account/compliance">
            <Button fullWidth variant="outline">
              Xem chi tiết điều kiện duy trì
            </Button>
          </Link>
        </Card>
      )}

      {isClosed && (
        <Card>
          <p className="text-sm text-ink-700">
            Tài khoản đã được quản trị viên đóng. Chỉ quản trị viên mới mở lại được. Vui lòng liên
            hệ bộ phận hỗ trợ để được giải đáp.
          </p>
        </Card>
      )}

      {(user?.broker_name || user?.broker_phone) && (
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-ink-900">Liên hệ hỗ trợ</h3>
          <dl className="space-y-2 text-sm">
            {user.broker_name && (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Môi giới phụ trách</dt>
                <dd className="font-medium text-ink-900">{user.broker_name}</dd>
              </div>
            )}
            {user.broker_phone && (
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">Điện thoại</dt>
                <dd>
                  <a href={`tel:${user.broker_phone}`} className="font-medium text-ink-900">
                    {user.broker_phone}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </Card>
      )}

      <Button variant="ghost" fullWidth onClick={logout}>
        Đăng xuất
      </Button>
    </div>
  );
}
