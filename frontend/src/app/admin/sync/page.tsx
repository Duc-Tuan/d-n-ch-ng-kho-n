'use client';

import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  PageHeader,
  Pagination,
  Spinner,
  StatusBadge,
  TabPanel,
  Tabs,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/datetime';
import { formatCurrency, formatNumber } from '@/lib/format';
import { SYNC_JOB_STATUS } from '@/lib/status';
import type { Message, Page, SyncJob } from '@/types';

const JOB_LABEL: Record<string, string> = {
  sync_nav: 'Đồng bộ NAV từ Google Sheet',
  check_compliance: 'Kiểm tra điều kiện duy trì',
  check_subscription: 'Cập nhật vòng đời gói',
  notify_expiry: 'Nhắc sắp hết hạn',
  notify_warning: 'Nhắc khách hàng đang cảnh báo',
  close_signals: 'Chốt kết quả tín hiệu',
  cleanup: 'Dọn dẹp dữ liệu tạm',
};

/**
 * Nhãn cho **mọi** job xuất hiện trong nhật ký.
 *
 * Tách khỏi `JOB_LABEL` vì danh sách kia đồng thời sinh ra các nút "Chạy job thủ công" ở tab
 * Trạng thái: `sync_market` và `ai_analysis` đã có màn hình riêng để chạy, thêm nút ở đây là hai
 * đường vào cho cùng một việc.
 */
const JOB_HISTORY_LABEL: Record<string, string> = {
  ...JOB_LABEL,
  sync_market: 'Đồng bộ giá thị trường',
  ai_analysis: 'Phân tích hằng ngày (AI)',
};

const TABS = [
  { key: 'status', label: 'Trạng thái' },
  { key: 'history', label: 'Lịch sử chạy' },
  { key: 'unmatched', label: 'Dòng chưa khớp' },
];

export default function SyncPage() {
  const toast = useToast();
  const { can } = useStaffSession();
  const [tab, setTab] = useState('status');
  const [runJob, setRunJob] = useState<string | null>(null);

  const { data: status, isLoading, refresh } = useApiQuery<any>(`${ADMIN}/sync/status`, undefined, {
    refreshInterval: 60_000,
  });

  const run = useApiMutation<Message, { jobType: string }>(({ jobType }) =>
    api.post<Message>(`${ADMIN}/sync/run/${jobType}`),
  );

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Đồng bộ dữ liệu"
        description="Trạng thái các job tự động và dữ liệu cần xử lý thủ công"
        infoTitle="Nguyên tắc an toàn của job compliance"
        /* BR-301 — quy tắc an toàn tuyệt đối. */
        info={
          <p>
            Khi thiếu dữ liệu NAV hoặc job đồng bộ thất bại, hệ thống{' '}
            <strong>không thay đổi trạng thái tài khoản nào</strong>. Không có dữ liệu không đồng
            nghĩa với vi phạm — một lỗi đọc file mà khoá nhầm khách hàng đã trả tiền là sự cố không
            sửa được bằng lời xin lỗi.
          </p>
        }
      />

      <Tabs items={TABS} active={tab} onChange={setTab} />

      {/* Nội dung tab lấp đầy phần trống còn lại và tự cuộn bên trong. */}
      <TabPanel
        active={tab}
        tabKey="status"
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {isLoading ? (
          <Spinner label="Đang tải…" />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Card>
                <p className="text-xs text-ink-500">Hôm nay</p>
                <p className="mt-1 text-lg font-semibold">{formatDate(status?.today)}</p>
                <Badge tone={status?.is_trading_day ? 'green' : 'gray'} className="mt-1">
                  {status?.is_trading_day ? 'Ngày giao dịch' : 'Ngày nghỉ'}
                </Badge>
              </Card>

              <Card>
                <p className="text-xs text-ink-500">Job compliance hôm nay</p>
                <div className="mt-1.5">
                  <Badge tone={status?.compliance_can_run_today ? 'green' : 'amber'}>
                    {status?.compliance_can_run_today ? 'Đủ điều kiện chạy' : 'Không chạy'}
                  </Badge>
                </div>
                {status?.compliance_blocked_reason && (
                  <p className="mt-1 text-xs text-ink-600">{status.compliance_blocked_reason}</p>
                )}
              </Card>

              <Card>
                <p className="text-xs text-ink-500">Cấu hình Google Sheet</p>
                <div className="mt-1.5">
                  <Badge tone={status?.google_sheet_configured ? 'green' : 'red'}>
                    {status?.google_sheet_configured ? 'Đã cấu hình' : 'Chưa cấu hình'}
                  </Badge>
                </div>
                {!status?.google_sheet_configured && (
                  <p className="mt-1 text-xs text-red-600">
                    Đặt GOOGLE_SHEET_ID và service account trong biến môi trường.
                  </p>
                )}
              </Card>
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <JobCard
                title="Đồng bộ NAV"
                job={status?.last_sync_nav}
                schedule="15:15 ngày giao dịch"
              />
              <JobCard
                title="Kiểm tra điều kiện duy trì"
                job={status?.last_check_compliance}
                schedule="16:30 ngày giao dịch"
              />
            </div>

            {can('sync.run') && (
              <Card>
                <CardHeader
                  title="Chạy job thủ công"
                  description="Dùng khi cần chạy lại sau sự cố. Thao tác được ghi vào nhật ký hệ thống."
                />
                <div className="flex flex-wrap gap-2">
                  {Object.entries(JOB_LABEL).map(([key, label]) => (
                    <Button key={key} size="sm" variant="outline" onClick={() => setRunJob(key)}>
                      {label}
                    </Button>
                  ))}
                </div>
              </Card>
            )}
          </div>
        )}
      </TabPanel>

      <TabPanel active={tab} tabKey="history" className="flex min-h-0 flex-1 flex-col">
        <JobHistory />
      </TabPanel>

      <TabPanel active={tab} tabKey="unmatched" className="flex min-h-0 flex-1 flex-col">
        <UnmatchedRows canResolve={can('sync.run')} />
      </TabPanel>

      <ConfirmDialog
        open={Boolean(runJob)}
        onClose={() => setRunJob(null)}
        title="Chạy job thủ công"
        message={
          <>
            Chạy lại <strong>{JOB_LABEL[runJob ?? ''] ?? runJob}</strong>? Job sẽ chạy nền và kết
            quả xuất hiện ở tab Lịch sử chạy. Các chốt chặn an toàn (BR-301) vẫn được áp dụng.
          </>
        }
        confirmLabel="Chạy ngay"
        loading={run.loading}
        onConfirm={async () => {
          if (!runJob) return;
          const result = await run.mutate({ jobType: runJob });
          if (result) {
            toast.success(result.message);
            setRunJob(null);
            setTimeout(refresh, 2000);
          }
        }}
      />
    </div>
  );
}

function JobCard({
  title,
  job,
  schedule,
}: {
  title: string;
  job: SyncJob | null;
  schedule: string;
}) {
  return (
    <Card>
      <CardHeader
        title={title}
        description={`Lịch chạy: ${schedule}`}
        action={job ? <StatusBadge map={SYNC_JOB_STATUS} code={job.status} /> : undefined}
      />
      {job ? (
        <div className="space-y-2 text-sm">
          <dl className="grid grid-cols-2 gap-2">
            <div>
              <dt className="text-xs text-ink-500">Ngày chạy</dt>
              <dd className="font-medium">{job.run_date}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Kết thúc</dt>
              <dd className="font-medium">{formatDateTime(job.finished_at)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Dòng đọc / khớp</dt>
              <dd className="font-medium tabular-nums">
                {formatNumber(job.rows_read)} / {formatNumber(job.rows_matched)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">Chưa khớp</dt>
              <dd className="font-medium tabular-nums text-amber-600">
                {formatNumber(job.rows_unmatched)}
              </dd>
            </div>
          </dl>

          {job.error_message && (
            <Alert tone={job.status === 'FAILED' ? 'danger' : 'warning'}>{job.error_message}</Alert>
          )}

          {job.summary && Object.keys(job.summary).length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer text-ink-500">Chi tiết kết quả</summary>
              <pre className="mt-2 overflow-x-auto rounded bg-ink-50 p-2 text-ink-600">
                {JSON.stringify(job.summary, null, 2)}
              </pre>
            </details>
          )}
        </div>
      ) : (
        <p className="text-sm text-ink-500">Chưa từng chạy.</p>
      )}
    </Card>
  );
}

function JobHistory() {
  const { page, size, setPage } = usePagination(25);
  const { data, isLoading } = useApiQuery<Page<SyncJob>>(`${ADMIN}/sync/jobs`, { page, size });

  if (isLoading) return <Spinner label="Đang tải…" />;
  if (!data?.items.length) return <EmptyState title="Chưa có job nào chạy" />;

  return (
    <div className="space-y-3">
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-ink-200 bg-ink-50">
              <tr>
                {[
                  'Job',
                  'Ngày',
                  'Trạng thái',
                  'Đọc',
                  'Khớp',
                  'Chưa khớp',
                  'Kết quả',
                  'Bắt đầu',
                  'Nguồn',
                ].map(
                  (h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left font-medium text-ink-600">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {data.items.map((job) => (
                <tr key={job.id}>
                  <td className="px-3 py-2.5 font-medium">
                    {JOB_HISTORY_LABEL[job.job_type] ?? job.job_type}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">{job.run_date}</td>
                  <td className="px-3 py-2.5">
                    <StatusBadge map={SYNC_JOB_STATUS} code={job.status} />
                  </td>
                  <td className="px-3 py-2.5 tabular-nums">{formatNumber(job.rows_read)}</td>
                  <td className="px-3 py-2.5 tabular-nums">{formatNumber(job.rows_matched)}</td>
                  <td className="px-3 py-2.5 tabular-nums text-amber-600">
                    {formatNumber(job.rows_unmatched)}
                  </td>
                  {/* Lý do bỏ qua / lỗi: trước đây chỉ nằm trong CSDL, nên một job SKIPPED
                      trông y hệt một job không bao giờ chạy. */}
                  <td
                    className="max-w-[18rem] truncate px-3 py-2.5 text-xs text-ink-600"
                    title={job.error_message ?? undefined}
                  >
                    {job.error_message ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-xs text-ink-500">
                    {formatDateTime(job.started_at)}
                  </td>
                  <td className="px-3 py-2.5 text-xs text-ink-500">{job.triggered_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination
        page={data.page}
        pages={data.pages}
        total={data.total}
        size={data.size}
        onPageChange={setPage}
      />
    </div>
  );
}

function UnmatchedRows({ canResolve }: { canResolve: boolean }) {
  const toast = useToast();
  const { page, size, setPage } = usePagination(25);
  const { data, isLoading, refresh } = useApiQuery<Page<any>>(`${ADMIN}/sync/unmatched`, {
    page,
    size,
  });

  const resolve = useApiMutation<Message, number>((id) =>
    api.post<Message>(`${ADMIN}/sync/unmatched/${id}/resolve`),
  );

  if (isLoading) return <Spinner label="Đang tải…" />;

  return (
    <div className="space-y-3">
      {/* BR-403.5 — không bỏ qua âm thầm; đây là hàng chờ để admin xử lý. */}
      <Alert tone="warning">
        Đây là các dòng trong Google Sheet không khớp với tài khoản nào trong hệ thống. Nguyên nhân
        thường gặp: khách hàng dùng email khác khi mở tài khoản chứng khoán, hoặc gõ sai email trong
        sheet nguồn.
      </Alert>

      {!data?.items.length ? (
        <EmptyState title="Không có dòng nào chưa khớp" />
      ) : (
        <>
          <Card padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-ink-200 bg-ink-50">
                  <tr>
                    {['Email trong sheet', 'Số TK', 'NAV', 'Dòng', 'Ghi nhận', ''].map((h) => (
                      <th key={h} className="whitespace-nowrap px-3 py-2.5 text-left font-medium text-ink-600">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {data.items.map((row) => (
                    <tr key={row.id}>
                      <td className="px-3 py-2.5 font-medium">{row.email_in_sheet ?? '—'}</td>
                      <td className="px-3 py-2.5">{row.account_no ?? '—'}</td>
                      <td className="px-3 py-2.5 tabular-nums">{formatCurrency(row.nav)}</td>
                      <td className="px-3 py-2.5 text-ink-500">{row.row_number ?? '—'}</td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs text-ink-500">
                        {formatDateTime(row.created_at)}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {canResolve && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              const result = await resolve.mutate(row.id);
                              if (result) {
                                toast.success(result.message);
                                refresh();
                              }
                            }}
                          >
                            Đánh dấu đã xử lý
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
          />
        </>
      )}
    </div>
  );
}
