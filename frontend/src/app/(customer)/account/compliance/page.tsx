'use client';

import Link from 'next/link';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  EmptyState,
  PageHeader,
  Spinner,
  StatCard,
  StatusBadge,
} from '@/components/ui';
import { useApiQuery } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { COMPLIANCE_STATUS } from '@/lib/status';
import type { ComplianceDetail } from '@/types';

/**
 * Màn "điều kiện duy trì tài khoản".
 *
 * Mục 9.2.2 yêu cầu điều kiện phải được ghi **cụ thể bằng số**. Màn này là nơi KH đối chiếu
 * số liệu của chính mình với ngưỡng, và cũng là bằng chứng minh bạch khi có khiếu nại.
 *
 * Số liệu NAV đã được gỡ khỏi site khách hàng theo yêu cầu, nên màn chỉ còn trình bày trạng
 * thái, điều kiện giao dịch C1 và nhật ký. Điều kiện C2 (ngưỡng NAV) vẫn chạy ở backend và
 * `rules.description` do server trả về — nếu văn bản đó nhắc tới NAV thì sửa ở phần cấu hình
 * quy định, không phải ở đây.
 */
export default function CompliancePage() {
  const { data, isLoading } = useApiQuery<ComplianceDetail>(`${CUSTOMER}/account/compliance`);

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải…" />
      </div>
    );
  }

  if (!data) return <EmptyState title="Không tải được dữ liệu" />;

  if (!data.applicable) {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <PageHeader title="Điều kiện duy trì tài khoản" />
        <Alert tone="success" title="Không áp dụng với tài khoản của bạn">
          {data.reason_not_applicable}
        </Alert>
        <Card>
          <p className="text-sm leading-relaxed text-ink-600">{data.rules.description}</p>
        </Card>
      </div>
    );
  }

  const { current, rules } = data;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Điều kiện duy trì tài khoản"
        description="Đối chiếu số liệu tài khoản của bạn với ngưỡng quy định"
      />

      {/* BR-301 — thiếu dữ liệu KHÔNG phải là vi phạm; nói rõ để KH không hoảng. */}
      {!current.has_data && (
        <Alert tone="info" title="Chưa có dữ liệu để đánh giá">
          Hệ thống chưa nhận được dữ liệu của tài khoản chứng khoán bạn. Trong trường hợp này, tài
          khoản{' '}
          <strong>không bị thay đổi trạng thái</strong>. Nếu bạn vừa liên kết tài khoản chứng khoán,
          dữ liệu sẽ có sau phiên giao dịch tiếp theo.
        </Alert>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <StatCard
          label="Trạng thái hiện tại"
          value={<StatusBadge map={COMPLIANCE_STATUS} code={data.compliance_status} />}
          sub={
            data.warning_until
              ? `Cần khôi phục trước ${formatDate(data.warning_until)}`
              : undefined
          }
          tone={data.compliance_status === 'OK' ? 'success' : 'warning'}
        />
        <StatCard
          label="Giao dịch gần nhất"
          value={current.last_trade_date ? formatDate(current.last_trade_date) : '—'}
          sub={`Yêu cầu: có giao dịch trong ${rules.no_trade_days} ngày`}
        />
      </div>

      <Card>
        <CardHeader title="Quy định áp dụng" />
        <p className="text-sm leading-relaxed text-ink-700">{rules.description}</p>

        <div className="mt-4 grid gap-3">
          <div className="rounded-lg border border-ink-200 p-3">
            <div className="mb-1 flex items-center gap-2">
              <Badge tone="blue">Điều kiện C1</Badge>
              <span className="text-sm font-medium text-ink-900">Hoạt động giao dịch</span>
            </div>
            <p className="text-sm text-ink-600">
              Tài khoản phải phát sinh giao dịch trong vòng{' '}
              <strong>{rules.no_trade_days} ngày</strong> gần nhất.
            </p>
          </div>
        </div>

        {/* BR-302 / BR-304 — hai điều KH cần biết nhất. */}
        <Alert tone="info" className="mt-4">
          Nếu chưa đạt điều kiện, hệ thống <strong>cảnh báo trước {rules.warning_days} ngày</strong>{' '}
          trước khi tạm dừng tài khoản. Trong thời gian tạm dừng, thời hạn gói được đóng băng và
          được bù đủ số ngày khi tài khoản khôi phục — bạn không mất ngày sử dụng nào.
        </Alert>
      </Card>

      <Card>
        <CardHeader
          title="Nhật ký thay đổi trạng thái"
          description="Toàn bộ lần hệ thống thay đổi trạng thái tài khoản của bạn, kèm số liệu tại thời điểm đó."
        />
        {data.events.length ? (
          <ul className="divide-y divide-ink-100">
            {data.events.map((event) => (
              <li key={event.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    tone={
                      event.event === 'RESTORE'
                        ? 'green'
                        : event.event === 'SUSPEND'
                          ? 'red'
                          : 'amber'
                    }
                  >
                    {
                      {
                        WARNING: 'Cảnh báo',
                        SUSPEND: 'Tạm dừng',
                        RESTORE: 'Khôi phục',
                        EXEMPT: 'Miễn áp dụng',
                        CLOSE: 'Đóng tài khoản',
                        REOPEN: 'Mở lại',
                      }[event.event] ?? event.event
                    }
                  </Badge>
                  <span className="text-xs text-ink-500">
                    {formatDateTime(event.created_at)}
                  </span>
                </div>
                {event.reason && <p className="mt-1 text-sm text-ink-700">{event.reason}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">
            Chưa có thay đổi trạng thái nào
          </p>
        )}
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Link href="/account" className="flex-1">
          <Button variant="outline" fullWidth>
            ← Về trang tài khoản
          </Button>
        </Link>
        <Link href="/legal/tos" className="flex-1">
          <Button variant="ghost" fullWidth>
            Xem Điều khoản sử dụng
          </Button>
        </Link>
      </div>
    </div>
  );
}
