'use client';

import Link from 'next/link';

import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  PageHeader,
  Spinner,
  StatCard,
  StatusBadge,
} from '@/components/ui';
import { useApiQuery } from '@/hooks';
import { ADMIN } from '@/lib/api';
import { formatDateTime } from '@/lib/datetime';
import { formatCompactCurrency, formatNumber, formatPercent } from '@/lib/format';
import { SYNC_JOB_STATUS } from '@/lib/status';
import type { DashboardStats } from '@/types';

export default function AdminDashboardPage() {
  const { data, isLoading } = useApiQuery<DashboardStats>(`${ADMIN}/dashboard`, undefined, {
    refreshInterval: 120_000,
  });

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải dashboard…" />
      </div>
    );
  }

  if (!data) return <Alert tone="danger">Không tải được dữ liệu dashboard.</Alert>;

  const { accounts, revenue, compliance, content, last_sync, alerts } = data;
  const latestMonth = revenue.by_month?.[revenue.by_month.length - 1];

  return (
    <div className="space-y-6 pb-4 lg:pb-6">
      <PageHeader title="Dashboard" description="Tổng quan tài khoản, doanh thu và vận hành" />

      {/* Cờ đỏ cần xử lý ngay — BR-700, không để job fail âm thầm. */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, index) => (
            <Alert
              key={index}
              tone={alert.level === 'danger' ? 'danger' : alert.level === 'warning' ? 'warning' : 'info'}
              action={
                alert.action ? (
                  <Link href={alert.action}>
                    <Button size="sm" variant="outline">
                      Xem
                    </Button>
                  </Link>
                ) : undefined
              }
            >
              {alert.message}
            </Alert>
          ))}
        </div>
      )}

      {/* ---------- Nhóm chỉ số tài khoản ---------- */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Chỉ số tài khoản
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Tổng khách hàng" value={formatNumber(accounts.total)} />
          <StatCard label="Đang dùng thử" value={formatNumber(accounts.trial)} tone="info" />
          <StatCard label="Đang hiệu lực" value={formatNumber(accounts.active)} tone="success" />
          <StatCard
            label="Đã hết hạn"
            value={formatNumber(accounts.expired + accounts.trial_expired)}
            tone="danger"
            sub={`${formatNumber(accounts.grace)} đang ân hạn`}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {/* Chỉ số quan trọng nhất của mô hình này (mục 3.1). */}
          <StatCard
            label="Tỷ lệ chuyển đổi Trial → Trả phí"
            value={formatPercent(accounts.trial_conversion_rate)}
            sub={`${formatNumber(accounts.trial_conversion_detail?.converted)} / ${formatNumber(
              accounts.trial_conversion_detail?.trialed,
            )} tài khoản`}
            tone="info"
          />
          <StatCard
            label="KH mới"
            value={formatNumber(accounts.new_today)}
            sub={`7 ngày: ${formatNumber(accounts.new_7d)} · 30 ngày: ${formatNumber(accounts.new_30d)}`}
          />
          <StatCard
            label="Đang cảnh báo NAV"
            value={formatNumber(accounts.warning)}
            tone="warning"
            sub="Cần đội môi giới liên hệ"
          />
          <StatCard
            label="Đang tạm dừng"
            value={formatNumber(accounts.suspended)}
            tone="danger"
            sub={`${formatNumber(accounts.closed)} đã đóng vĩnh viễn`}
          />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* ---------- Sắp hết hạn ---------- */}
        <Card>
          <div className="h-full flex flex-col gap-3 justify-between">
            <div className="">
              <CardHeader
                title="Sắp hết hạn"
                description="Danh sách cho đội chăm sóc gọi gia hạn"
              />
              <ul className="space-y-2">
                {[
                  { days: 7, value: accounts.expiring_7d },
                  { days: 15, value: accounts.expiring_15d },
                  { days: 30, value: accounts.expiring_30d },
                ].map((item) => (
                  <li
                    key={item.days}
                    className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2"
                  >
                    <span className="text-sm text-ink-600">Trong {item.days} ngày</span>
                    <span className="flex items-center gap-2">
                      <span className="font-semibold tabular-nums">{formatNumber(item.value)}</span>
                      <Link
                        href={`/admin/customers?expiring_in_days=${item.days}`}
                        className="text-xs text-ink-900 hover:underline"
                      >
                        Xem
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <Link href="/admin/customers?expiring_in_days=30" className="mt-3 block">
              <Button variant="outline" size="sm" fullWidth>
                Xuất danh sách chăm sóc
              </Button>
            </Link>
          </div>
        </Card>

        {/* ---------- Doanh thu ---------- */}
        <Card>
          <div className="flex flex-col justify-between gap-2 h-full">
            <CardHeader title="Doanh thu" description="Theo tháng, phân rã theo gói" />
            {latestMonth ? (
              <div className="space-y-3 flex flex-col justify-between gap-2 flex-1">
                <div className="">
                  <div>
                    <p className="text-xs text-ink-500">Tháng {latestMonth.month}</p>
                    <p className="text-2xl font-semibold text-ink-900">
                      {formatCompactCurrency(latestMonth.total)}
                    </p>
                  </div>
                  <ul className="space-y-1.5 text-sm">
                    {Object.entries(latestMonth.packages ?? {}).map(([name, info]: [string, any]) => (
                      <li key={name} className="flex justify-between gap-2">
                        <span className="text-ink-600">{name}</span>
                        <span className="tabular-nums text-ink-900">
                          {formatCompactCurrency(info.amount)}{' '}
                          <span className="text-xs text-ink-400">({info.count})</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="border-t border-ink-100 pt-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-ink-600">Tỷ lệ gia hạn</span>
                    <span className="font-medium">{formatPercent(revenue.renewal_rate)}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-ink-400">
                    {formatNumber(revenue.renewed_customers)} / {formatNumber(revenue.paying_customers)}{' '}
                    KH trả phí đã gia hạn ít nhất một lần
                  </p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-ink-500">Chưa có doanh thu ghi nhận.</p>
            )}
          </div>
        </Card>

        {/* ---------- Compliance & job ---------- */}
        <Card>
          <CardHeader title="NAV & đồng bộ dữ liệu" />
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-2">
              <dt className="text-ink-500">Tổng NAV toàn bộ KH</dt>
              <dd className="font-medium tabular-nums">
                {formatCompactCurrency(compliance.total_nav)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-500">NAV trung bình</dt>
              <dd className="font-medium tabular-nums">
                {formatCompactCurrency(compliance.avg_nav)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-ink-500">Số tài khoản có dữ liệu</dt>
              <dd className="tabular-nums">{formatNumber(compliance.accounts_with_nav)}</dd>
            </div>
          </dl>

          <div className="mt-4 rounded-lg border border-ink-200 p-3">
            <p className="mb-2 text-xs font-medium text-ink-500">Job đồng bộ NAV lần cuối</p>
            {last_sync ? (
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-600">{last_sync.run_date}</span>
                  <StatusBadge map={SYNC_JOB_STATUS} code={last_sync.status} />
                </div>
                <p className="text-xs text-ink-500">
                  {formatNumber(last_sync.rows_read)} dòng đọc ·{' '}
                  {formatNumber(last_sync.rows_matched)} khớp ·{' '}
                  {formatNumber(last_sync.rows_unmatched)} chưa khớp
                </p>
                <p className="text-xs text-ink-400">
                  Kết thúc {formatDateTime(last_sync.finished_at)}
                </p>
                {last_sync.error_message && (
                  <p className="text-xs text-red-600">{last_sync.error_message}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-500">Chưa từng chạy.</p>
            )}
            <Link href="/admin/sync" className="mt-2 block">
              <Button variant="ghost" size="sm" fullWidth>
                Xem chi tiết đồng bộ →
              </Button>
            </Link>
          </div>
        </Card>
      </div>

      {/* ---------- Nội dung ---------- */}
      <Card>
        <CardHeader title="Nội dung" />
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg bg-ink-50 p-3">
            <p className="text-xs text-ink-500">Bài viết đã xuất bản</p>
            <p className="mt-1 text-xl font-semibold">{formatNumber(content.articles_published)}</p>
          </div>
          <div className="rounded-lg bg-amber-50 p-3">
            <p className="text-xs text-amber-700">Chờ duyệt</p>
            <p className="mt-1 text-xl font-semibold text-amber-900">
              {formatNumber(content.articles_pending_review)}
            </p>
            {content.articles_pending_review > 0 && (
              <Link
                href="/admin/articles?status=PENDING_REVIEW"
                className="text-xs text-amber-700 hover:underline"
              >
                Duyệt ngay →
              </Link>
            )}
          </div>
          <div className="rounded-lg bg-ink-50 p-3">
            <p className="text-xs text-ink-500">Tài liệu</p>
            <p className="mt-1 text-xl font-semibold">{formatNumber(content.documents)}</p>
          </div>
        </div>

        {content.top_articles?.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-ink-500">Bài viết xem nhiều nhất</p>
            <ul className="space-y-1.5">
              {content.top_articles.map((article: any) => (
                <li key={article.id} className="flex justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate text-ink-700">{article.title}</span>
                  <Badge tone="gray">{formatNumber(article.view_count)} lượt</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>
    </div>
  );
}
