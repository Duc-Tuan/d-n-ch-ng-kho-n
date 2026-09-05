'use client';

import Link from 'next/link';

import {
  Badge,
  Button,
  Card,
  CardHeader,
  Disclaimer,
  EmptyState,
  StatusBadge,
  Icon,
} from '@/components/ui';
import { useApiQuery, useSession } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { formatDate, fromNow } from '@/lib/datetime';
import { truncate } from '@/lib/format';
import { COMPLIANCE_STATUS, SUBSCRIPTION_STATUS } from '@/lib/status';
import type { Article, Page, Strategy } from '@/types';

export default function HomePage() {
  const { session } = useSession();
  const user = session?.user;
  const subscription = session?.subscription;

  // Trang chủ chỉ điểm 6 bài mới nhất; API đã trả theo published_at giảm dần.
  const { data: articles } = useApiQuery<Page<Article>>(`${CUSTOMER}/articles`, { size: 6 });
  // Trang chủ chỉ khoe vài chiến lược; xin đúng một trang nhỏ thay vì kéo cả danh sách về.
  const { data: strategies } = useApiQuery<Page<Strategy>>(`${CUSTOMER}/strategies`, { size: 12 });

  const activeStrategies = (strategies?.items ?? []).filter((s) => !s.locked).slice(0, 4);

  return (
    <div className="space-y-6 pb-6">
      {/*
        Khối mở đầu.

        Bản trước là một dòng chào cộng ba thẻ chỉ số giống hệt nhau — bố cục của một trang quản
        trị, không phải trang chủ của khách hàng. Ba thẻ ấy cùng kích thước, cùng viền, cùng cỡ
        chữ, nên không thẻ nào là thứ đáng đọc trước; mà thực ra chỉ có một thứ khách cần biết
        ngay khi mở máy: **gói của tôi còn hạn không**.

        Giờ gói là nhân vật chính, đặt trên nền loang màu thương hiệu để tách hẳn khỏi phần nội
        dung phía dưới. Hai trục trạng thái còn lại (BR — trạng thái gói và điều kiện duy trì là
        hai chuyện khác nhau, mục 0.2) tụt xuống dải chân khối: vẫn thấy đủ, nhưng không tranh
        chỗ với con số hạn dùng.
      */}
      <section className="relative overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_140%_at_100%_0%,rgb(var(--brand)/0.14),transparent_62%)]"
        />

        <div className="relative flex flex-col gap-6 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
          <div className="min-w-0">
            <p className="text-label font-medium uppercase text-ink-500">Trang chủ</p>
            <h1 className="mt-2 text-display font-semibold text-ink-900 sm:text-display-lg">
              Chào {user?.full_name?.split(' ').slice(-1)[0] ?? ''}
            </h1>
            <p className="mt-1.5 text-sm text-ink-500">
              Tổng quan tài khoản và nội dung mới nhất
            </p>
          </div>

          {/* Hạn dùng là con số duy nhất được phóng to trên cả trang — có chủ đích. */}
          <div className="shrink-0 sm:text-right">
            <p className="text-label font-medium uppercase text-ink-500">Gói dịch vụ</p>
            <p className="mt-2 text-display-sm font-semibold text-ink-900">
              {subscription?.package_name ?? 'Chưa có gói'}
            </p>
            {subscription ? (
              <p className="mt-1 text-sm text-ink-500">
                Hết hạn {formatDate(subscription.expires_at)}
                {subscription.days_remaining !== null && (
                  <>
                    {' · '}
                    <span className="font-medium tabular-nums text-ink-800">
                      còn {subscription.days_remaining} ngày
                    </span>
                  </>
                )}
              </p>
            ) : (
              <Link href="/pricing" className="mt-2 inline-block">
                <Button size="sm">Chọn gói dịch vụ</Button>
              </Link>
            )}
          </div>
        </div>

        {/* Dải chân: các trạng thái phụ, ngăn bằng đường kẻ chứ không đóng hộp thêm lần nữa. */}
        <dl className="relative flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line px-5 py-3 sm:px-6">
          <div className="flex items-center gap-2">
            <dt className="text-xs text-ink-500">Trạng thái gói</dt>
            <dd>
              <StatusBadge map={SUBSCRIPTION_STATUS} code={user?.subscription_status} />
            </dd>
          </div>

          <div className="flex items-center gap-2">
            <dt className="text-xs text-ink-500">Điều kiện duy trì</dt>
            <dd>
              <StatusBadge map={COMPLIANCE_STATUS} code={user?.compliance_status} />
            </dd>
          </div>

          {subscription?.is_frozen ? (
            <p className="text-xs text-ink-500">Đồng hồ gói đang tạm dừng đếm</p>
          ) : subscription?.frozen_days ? (
            <p className="text-xs text-ink-500">
              Đã bù {subscription.frozen_days} ngày bị đóng băng
            </p>
          ) : null}

          {user?.compliance_status !== 'NOT_REQUIRED' && user?.warning_until && (
            <p className="text-xs text-tone-amber-fg">
              Cần khôi phục trước {formatDate(user.warning_until)}
            </p>
          )}
        </dl>
      </section>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="6 bài viết mới nhất"
              action={
                <Link href="/articles">
                  <Button size="sm" variant="ghost">
                    Xem tất cả
                  </Button>
                </Link>
              }
            />
            {articles?.items.length ? (
              <ul className="-mx-2 space-y-0.5">
                {articles.items.map((article) => (
                  <li key={article.id}>
                    {/*
                      Vùng bấm là cả dòng và có nền riêng khi rê chuột. Bản trước chỉ có đường
                      kẻ ngăn giữa các dòng: đúng về mặt phân tách nhưng không có gì báo cho
                      người dùng biết dòng nào đang trỏ tới, mà đây là danh sách để bấm vào.
                    */}
                    <Link
                      href={`/articles/${article.slug}`}
                      className="group flex min-h-touch items-start gap-3.5 rounded-xl p-2 transition-colors hover:bg-ink-50"
                    >
                      {/* Ảnh đại diện — bài chưa đặt ảnh vẫn giữ đúng khung để danh sách không so le. */}
                      <span className="flex h-[3.75rem] w-[5.5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-ink-100">
                        {article.thumbnail ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={article.thumbnail}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                          />
                        ) : (
                          <Icon name="document" size={18} className="text-ink-400" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium leading-snug text-ink-900">
                          {article.title}
                          {article.locked && (
                            <Icon
                              name="lock"
                              size={13}
                              className="ml-1.5 inline text-tone-amber-fg"
                            />
                          )}
                        </p>
                        {article.excerpt && (
                          <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-ink-600">
                            {truncate(article.excerpt, 120)}
                          </p>
                        )}
                        <p className="mt-1.5 text-xs text-ink-500">
                          <span className="text-ink-400">{article.category_name}</span>
                          {' · '}
                          {fromNow(article.published_at)}
                        </p>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Chưa có bài viết nào" />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Chiến lược đang theo dõi được"
              description="Bấm vào một chiến lược để xem điểm mua/bán trên biểu đồ"
              action={
                <Link href="/strategies">
                  <Button size="sm" variant="ghost">
                    Xem tất cả
                  </Button>
                </Link>
              }
            />
            {activeStrategies.length ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {activeStrategies.map((strategy) => (
                  <Link
                    key={strategy.id}
                    href={`/strategies/${strategy.id}`}
                    className="flex flex-col rounded-xl border border-line bg-ink-50/50 p-3.5 transition-colors hover:border-line-strong hover:bg-ink-50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-snug text-ink-900">
                        {strategy.name}
                      </p>
                      <Badge tone="blue">{strategy.school}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-ink-500">
                      {strategy.timeframe} · {strategy.symbols.length} mã
                    </p>

                    {/* BR-841 — chỉ hiển thị thống kê tín hiệu THỰC ở thẻ tóm tắt.
                        Winrate là con số người ta thực sự so sánh giữa các chiến lược, nên nó
                        được cỡ chữ riêng thay vì nằm lẫn trong một dòng chữ nhỏ. */}
                    {strategy.stats_live && strategy.stats_live.closed_trades > 0 && (
                      <div className="mt-3 flex items-baseline gap-2 border-t border-line pt-2.5">
                        <span className="text-lg font-semibold tabular-nums text-ink-900">
                          {strategy.stats_live.win_rate}%
                        </span>
                        <span className="text-xs text-ink-500">
                          winrate · {strategy.stats_live.closed_trades} lệnh thực
                        </span>
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Chưa có chiến lược nào khả dụng"
                description="Chiến lược cao cấp yêu cầu gói dài hạn hơn."
                action={
                  <Link href="/pricing">
                    <Button size="sm">Xem các gói</Button>
                  </Link>
                }
              />
            )}
          </Card>
        </div>

        <div className="space-y-5">
          {/* F23 — thông tin môi giới phụ trách. */}
          {user?.broker_name && (
            <Card>
              <CardHeader title="Môi giới phụ trách" />
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-ink-500">Họ tên</dt>
                  <dd className="font-medium text-ink-900">{user.broker_name}</dd>
                </div>
                {user.broker_code && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Mã môi giới</dt>
                    <dd className="text-ink-900">{user.broker_code}</dd>
                  </div>
                )}
                {user.broker_phone && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-ink-500">Liên hệ</dt>
                    <dd>
                      <a href={`tel:${user.broker_phone}`} className="text-ink-900">
                        {user.broker_phone}
                      </a>
                    </dd>
                  </div>
                )}
              </dl>
            </Card>
          )}

          <Card>
            <CardHeader title="Lối tắt" />
            <div className="grid grid-cols-2 gap-2">
              {[
                { href: '/news', label: 'Tin tức', icon: 'document' as const },
                { href: '/strategies', label: 'Chiến lược', icon: 'target' as const },
                { href: '/account/notifications', label: 'Nhận tín hiệu', icon: 'bell' as const },
                { href: '/account/compliance', label: 'Điều kiện duy trì', icon: 'shield' as const },
              ].map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="group flex min-h-touch flex-col items-center justify-center gap-2 rounded-xl border border-line bg-ink-50/50 p-3.5 text-center text-xs font-medium text-ink-700 transition-colors hover:border-line-strong hover:bg-ink-50 hover:text-ink-900"
                >
                  <Icon
                    name={item.icon}
                    size={20}
                    className="text-ink-400 transition-colors group-hover:text-brand"
                  />
                  {item.label}
                </Link>
              ))}
            </div>
          </Card>

          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
