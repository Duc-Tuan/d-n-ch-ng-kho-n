'use client';

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
} from '@/components/ui';
import { useApiMutation, useApiQuery, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatNumber, formatPercent } from '@/lib/format';
import { SKIP_REASON_LABEL } from '@/lib/status';
import type { Message } from '@/types';

const DELIVERY_LABEL: Record<string, string> = {
  QUEUED: 'Đang chờ gửi',
  SENT: 'Đã gửi',
  FAILED: 'Thất bại',
  SKIPPED: 'Bỏ qua',
};

export default function AdminTelegramPage() {
  const toast = useToast();
  const { data, isLoading, refresh } = useApiQuery<any>(`${ADMIN}/telegram/overview`, undefined, {
    refreshInterval: 60_000,
  });

  const testSend = useApiMutation<Message, number>((userId) =>
    api.post<Message>(`${ADMIN}/telegram/test/${userId}`),
  );

  if (isLoading) return <Spinner label="Đang tải…" />;
  if (!data) return <EmptyState title="Không tải được dữ liệu" />;

  const sentToday = data.deliveries_today?.SENT ?? 0;
  const failedToday = data.deliveries_today?.FAILED ?? 0;
  const queuedToday = data.deliveries_today?.QUEUED ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Thông báo Telegram"
        description="Tình trạng kết nối, tỷ lệ gửi thành công và dữ liệu quan tâm của khách hàng"
        infoTitle="Nguyên tắc gửi tín hiệu"
        info={
          <p>
            Trước mỗi lần gửi, hệ thống kiểm tra lại trạng thái gói, trạng thái điều kiện duy trì
            và quyền xem chiến lược theo gói. Việc kiểm tra tại thời điểm gửi (chứ không phải lúc
            đăng ký) là chốt chặn ngăn khách hàng hết hạn vẫn tiếp tục nhận tín hiệu trả phí.
          </p>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Khách hàng đã kết nối"
          value={formatNumber(data.connected)}
          sub={`${formatPercent(data.connection_rate)} trên ${formatNumber(data.total_users)} KH`}
          tone="info"
        />
        <StatCard label="Tin gửi thành công hôm nay" value={formatNumber(sentToday)} tone="success" />
        <StatCard label="Đang chờ trong hàng đợi" value={formatNumber(queuedToday)} />
        <StatCard
          label="Gửi thất bại"
          value={formatNumber(failedToday)}
          tone={failedToday > 0 ? 'danger' : 'default'}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* BR-883 — bản ghi SKIPPED kèm lý do là dữ liệu để trả lời khiếu nại. */}
        <Card>
          <CardHeader
            title="Lý do bỏ qua gửi tín hiệu"
            description="Khi khách hàng hỏi “sao tôi không nhận được tín hiệu”, tra ở đây."
          />
          {Object.keys(data.skip_reasons ?? {}).length ? (
            <ul className="space-y-2">
              {Object.entries(data.skip_reasons).map(([reason, count]) => (
                <li
                  key={reason}
                  className="flex items-center justify-between gap-3 rounded-lg bg-ink-50 px-3 py-2"
                >
                  <span className="text-sm text-ink-700">
                    {SKIP_REASON_LABEL[reason] ?? reason}
                  </span>
                  <span className="font-medium tabular-nums">{formatNumber(count as number)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-6 text-center text-sm text-ink-500">Chưa có bản ghi bỏ qua nào</p>
          )}
        </Card>

        {/* Dữ liệu rất giá trị — cho biết KH thực sự quan tâm cái gì. */}
        <Card>
          <CardHeader
            title="Cặp được đăng ký nhiều nhất"
            description="Dữ liệu này cho biết khách hàng thực sự quan tâm chiến lược và mã nào."
          />
          {data.top_pairs?.length ? (
            <ol className="space-y-1.5">
              {data.top_pairs.map((pair: any, index: number) => (
                <li
                  key={`${pair.strategy}-${pair.symbol}`}
                  className="flex items-center justify-between gap-3 text-sm"
                >
                  <span className="min-w-0 truncate">
                    <span className="mr-2 text-ink-400">{index + 1}.</span>
                    <span className="font-medium text-ink-900">{pair.symbol}</span>
                    <span className="ml-2 text-ink-500">{pair.strategy}</span>
                  </span>
                  <Badge tone="blue">{formatNumber(pair.subscribers)} KH</Badge>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-6 text-center text-sm text-ink-500">Chưa có đăng ký nào</p>
          )}
        </Card>
      </div>

      {/* BR-865 — danh sách KH đã chặn bot để đội chăm sóc liên hệ. */}
      <Card>
        <CardHeader
          title="Khách hàng đã chặn bot"
          description="Hệ thống đã ngừng gửi cho các tài khoản này. Liên hệ để hướng dẫn bỏ chặn và kết nối lại."
        />
        {data.blocked_users?.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-ink-200 bg-ink-50">
                <tr>
                  {['Khách hàng', 'Email', 'SĐT', 'Lỗi gần nhất', ''].map((h) => (
                    <th key={h} className="px-3 py-2.5 text-left font-medium text-ink-600">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {data.blocked_users.map((user: any) => (
                  <tr key={user.user_id}>
                    <td className="px-3 py-2.5 font-medium">{user.full_name}</td>
                    <td className="px-3 py-2.5 text-ink-600">{user.email}</td>
                    <td className="px-3 py-2.5">
                      {user.phone ? (
                        <a href={`tel:${user.phone}`} className="text-ink-900">
                          {user.phone}
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-ink-500">{user.last_error ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={testSend.loading}
                        onClick={async () => {
                          const result = await testSend.mutate(user.user_id);
                          if (result) {
                            toast.success(result.message);
                            refresh();
                          } else {
                            toast.error(testSend.error?.message ?? 'Gửi thất bại');
                          }
                        }}
                      >
                        Gửi thử
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">
            Không có khách hàng nào chặn bot
          </p>
        )}
      </Card>

    </div>
  );
}
