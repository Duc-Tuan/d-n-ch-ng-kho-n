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
import type { IconName } from '@/components/ui/Icon';
import { useApiQuery, useSession } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { formatDate, fromNow } from '@/lib/datetime';
import { truncate } from '@/lib/format';
import { COMPLIANCE_STATUS, SUBSCRIPTION_STATUS } from '@/lib/status';
import type { Article, Page, Strategy, SubscriptionInfo } from '@/types';

const SHORTCUTS: Array<{ href: string; label: string; hint: string; icon: IconName }> = [
  { href: '/market', label: 'Bảng giá', hint: 'Giá và biểu đồ', icon: 'chart' },
  { href: '/strategies', label: 'Chiến lược', hint: 'Điểm mua bán', icon: 'target' },
  { href: '/account/notifications', label: 'Nhận tín hiệu', hint: 'Qua Telegram', icon: 'bell' },
  { href: '/account/compliance', label: 'Điều kiện', hint: 'Duy trì tài khoản', icon: 'shield' },
];

/**
 * Phần gói đã dùng, tính theo ngày — `0` ở ngày đầu, `1` khi hết hạn.
 *
 * Trả `null` khi thiếu mốc hoặc mốc vô lý (hết hạn trước ngày bắt đầu — dữ liệu cũ, gói được
 * chỉnh tay ở site quản trị): khi đó thanh tiến trình không được vẽ. Một thanh vẽ sai còn tệ
 * hơn không có thanh nào, vì người dùng tin vào hình trước khi đọc số.
 */
function usedRatio(subscription: SubscriptionInfo): number | null {
  const start = new Date(subscription.starts_at).getTime();
  const end = new Date(subscription.expires_at).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const elapsed = (Date.now() - start) / (end - start);
  return Math.min(Math.max(elapsed, 0), 1);
}

export default function HomePage() {
  const { session } = useSession();
  const user = session?.user;
  const subscription = session?.subscription;

  /* Trang chủ chỉ điểm 8 bài mới nhất; API đã trả theo published_at giảm dần.

     Tám chứ không phải sáu: từ khi khối này chia hai cột, cột danh sách bên phải thấp hơn hẳn
     cột bài đinh bên trái, nên hai bài thêm vào lấp đúng chỗ trống sẵn có chứ không kéo khối
     dài thêm. */
  const { data: articles } = useApiQuery<Page<Article>>(`${CUSTOMER}/articles`, { size: 6 });
  // Trang chủ chỉ khoe vài chiến lược; xin đúng một trang nhỏ thay vì kéo cả danh sách về.
  const { data: strategies } = useApiQuery<Page<Strategy>>(`${CUSTOMER}/strategies`, { size: 12 });

  const activeStrategies = (strategies?.items ?? []).filter((s) => !s.locked).slice(0, 4);

  /*
    Bài đầu tiên tách ra làm "bài đinh", năm bài còn lại xếp thành danh sách gọn bên dưới.

    Tám thẻ giống hệt nhau không có bài nào là bài đáng đọc trước — mắt phải quét cả tám rồi
    tự chọn, và phần lớn người dùng bỏ qua cả khối. Một bài lớn có ảnh cộng bảy dòng nhỏ là
    bố cục của mọi trang báo, vì nó trả lời sẵn câu "đọc cái nào trước".
  */
  const [lead, ...rest] = articles?.items ?? [];

  const used = subscription ? usedRatio(subscription) : null;

  return (
    <div className="space-y-6 pb-6">
      {/*
        Khối mở đầu.

        Gói dịch vụ là nhân vật chính: đó là thứ duy nhất khách cần biết ngay khi mở máy — còn
        hạn không, còn bao nhiêu ngày. Nó nằm trong một tấm riêng bên phải, có nền và viền của
        chính nó, nên đọc ra là **một vật** chứ không phải một đoạn chữ xếp cạnh lời chào.

        Nền là ba vệt loang màu thương hiệu (`mesh-brand`) trên mặt `surface`. Không phải để
        cho vui: khối này không có dữ liệu nào đáng vẽ thành biểu đồ, mà một mảng phẳng cỡ này
        đặt ngay đầu trang thì trang mở ra như một biểu mẫu nội bộ.
      */}
      <section className="relative overflow-hidden rounded-3xl border border-line bg-surface shadow-card">
        <div aria-hidden className="mesh-brand pointer-events-none absolute inset-0" />

        <div className="relative flex flex-col gap-6 p-5 sm:p-7 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
          <div className="min-w-0">
            <p className="text-label font-medium uppercase text-ink-500">
              {formatDate(new Date().toISOString())}
            </p>
            <h1 className="mt-2.5 text-display font-semibold text-ink-900 sm:text-display-lg">
              Chào{' '}
              {/* Đúng một cụm được đổ màu trên cả trang. Nhiều hơn thì nó thôi là điểm nhấn. */}
              <span className="text-gradient-brand">
                {user?.full_name?.split(' ').slice(-1)[0] ?? 'bạn'}
              </span>
            </h1>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">
              Tổng quan tài khoản, chiến lược đang theo dõi được và nội dung mới nhất.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Link href="/market">
                <Button size="sm" leftIcon={<Icon name="chart" size={16} />}>
                  Mở bảng giá
                </Button>
              </Link>
              <Link href="/strategies">
                <Button size="sm" variant="outline" leftIcon={<Icon name="target" size={16} />}>
                  Xem chiến lược
                </Button>
              </Link>
            </div>
          </div>

          {/* Tấm gói dịch vụ. `bg-surface/70` + `backdrop-blur`: nó nằm **trên** nền loang nên
              phải để lộ chút màu phía dưới, nếu không nó cắt một lỗ hình chữ nhật giữa khối. */}
          <div className="w-full shrink-0 rounded-2xl border border-line bg-surface/70 p-4 backdrop-blur-sm sm:p-5 lg:w-[22rem]">
            <div className="flex items-start justify-between gap-3">
              <p className="text-label font-medium uppercase text-ink-500">Gói dịch vụ</p>
              <StatusBadge map={SUBSCRIPTION_STATUS} code={user?.subscription_status} />
            </div>

            <p className="mt-2.5 text-display-sm font-semibold text-ink-900">
              {subscription?.package_name ?? 'Chưa có gói'}
            </p>

            {subscription ? (
              <>
                {/* Số ngày còn lại là con số lớn duy nhất trên cả trang — có chủ đích. */}
                {subscription.days_remaining !== null && (
                  <p className="mt-3 flex items-baseline gap-1.5">
                    <span className="text-3xl font-semibold tabular-nums leading-none text-ink-900">
                      {subscription.days_remaining}
                    </span>
                    <span className="text-sm text-ink-500">ngày còn lại</span>
                  </p>
                )}

                {/* Thanh tiến trình đọc được ở khoé mắt, con số thì phải dừng lại đọc. Hai thứ
                    nói cùng một điều, và người dùng chỉ cần một trong hai tuỳ lúc. */}
                {used !== null && (
                  <div
                    className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink-200"
                    role="img"
                    aria-label={`Đã dùng ${Math.round(used * 100)}% thời hạn gói`}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-brand to-brand-2 transition-[width] duration-500"
                      style={{ width: `${Math.max(used * 100, 2)}%` }}
                    />
                  </div>
                )}

                <p className="mt-2.5 text-xs text-ink-500">
                  Hết hạn {formatDate(subscription.expires_at)}
                  {subscription.is_frozen && ' · đồng hồ đang tạm dừng đếm'}
                  {!subscription.is_frozen && subscription.frozen_days
                    ? ` · đã bù ${subscription.frozen_days} ngày`
                    : ''}
                </p>
              </>
            ) : (
              <>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">
                  Chọn một gói để mở khoá chiến lược, tín hiệu và toàn bộ nội dung.
                </p>
                <Link href="/pricing" className="mt-4 block">
                  <Button fullWidth>Chọn gói dịch vụ</Button>
                </Link>
              </>
            )}
          </div>
        </div>

        {/* Dải chân: các trạng thái phụ, ngăn bằng đường kẻ chứ không đóng hộp thêm lần nữa. */}
        <dl className="relative flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line px-5 py-3 sm:px-7">
          <div className="flex items-center gap-2">
            <dt className="text-xs text-ink-500">Điều kiện duy trì</dt>
            <dd>
              <StatusBadge map={COMPLIANCE_STATUS} code={user?.compliance_status} />
            </dd>
          </div>

          {user?.compliance_status !== 'NOT_REQUIRED' && user?.warning_until && (
            <p className="text-xs text-tone-amber-fg">
              Cần khôi phục trước {formatDate(user.warning_until)}
            </p>
          )}

          {user?.customer_code && (
            <p className="text-xs text-ink-500">
              Mã khách hàng <span className="tabular-nums text-ink-700">{user.customer_code}</span>
            </p>
          )}
        </dl>
      </section>

      {/* Lối tắt nằm ngay dưới khối mở đầu, thành một hàng ngang trên mọi cỡ màn. Trước đây nó
          nằm cuối cột phải — tức là dưới nếp gấp trên điện thoại, đúng chỗ không ai cuộn tới. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SHORTCUTS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="card-interactive surface-lift group flex min-h-touch items-center gap-3 rounded-2xl border border-line bg-surface p-3.5 shadow-card"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand transition-transform duration-200 group-hover:scale-105">
              <Icon name={item.icon} size={19} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-ink-900">{item.label}</span>
              <span className="block truncate text-xs text-ink-500">{item.hint}</span>
            </span>
          </Link>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader
              title="Bài viết mới nhất"
              action={
                <Link href="/articles">
                  <Button size="sm" variant="ghost" rightIcon={<Icon name="chevron-right" size={15} />}>
                    Xem tất cả
                  </Button>
                </Link>
              }
            />

            {lead ? (
              /*
                Bài đinh bên trái, các bài còn lại bên phải — thay cho kiểu xếp chồng trước đây.

                Xếp chồng thì bài đinh chiếm trọn bề ngang của khối, và với một tấm ảnh 16/7 ở
                cỡ đó nó ăn gần hết chiều cao khối; năm bài còn lại bị đẩy xuống dưới nếp gấp và
                gần như không ai thấy. Chia đôi thì cùng một diện tích chứa được **cả sáu bài**,
                mà bài đinh vẫn giữ nguyên vai trò của nó nhờ cỡ ảnh và cỡ chữ lớn hơn hẳn.

                `items-start` để hai cột không bị kéo cao bằng nhau: cột nào hết nội dung thì
                dừng ở đó, không nở ra một mảng trống cho bằng cột kia.
              */
              <div className="grid gap-4 md:grid-cols-2 md:items-start md:gap-5">
                {/* ---------- Bài đinh ---------- */}
                <Link
                  href={`/articles/${lead.slug}`}
                  className="group block overflow-hidden rounded-2xl border border-line bg-ink-50/40 transition-colors hover:border-line-strong"
                >
                  {/*
                    Bài chưa đặt ảnh thì **không** dựng khung ảnh.

                    Ở các thẻ trong lưới, khung rỗng là cần thiết để hàng không so le. Ở đây thì
                    ngược lại: khối ảnh chiếm gần nửa chiều cao của thẻ, và để trống nó cho ra
                    một ô xám to bằng bàn tay với đúng một icon ở giữa — trông như ảnh hỏng chứ
                    không như bài chưa có ảnh. Bài đinh không có ảnh vẫn là một bài đinh: nó giữ
                    nguyên cỡ chữ và phần mô tả dài hơn các dòng bên cạnh.

                    Tỉ lệ 16/9 chứ không còn 16/7: cột đã hẹp đi một nửa, mà khung càng dẹt thì
                    ở bề ngang nhỏ ảnh càng bị cắt mất nội dung ở trên và dưới.
                  */}
                  {lead.thumbnail && (
                    <span className="flex aspect-[16/9] w-full items-center justify-center overflow-hidden bg-ink-100">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={lead.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                      />
                    </span>
                  )}
                  <span className="block p-4">
                    <span className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                      {lead.category_name && <Badge tone="blue">{lead.category_name}</Badge>}
                      <span>{fromNow(lead.published_at)}</span>
                      {lead.locked && (
                        <Icon name="lock" size={13} className="text-tone-amber-fg" />
                      )}
                    </span>
                    <span className="mt-2 block text-base font-semibold leading-snug text-ink-900 transition-colors group-hover:text-brand">
                      {lead.title}
                    </span>
                    {lead.excerpt && (
                      <span className="mt-1.5 block line-clamp-2 text-sm leading-relaxed text-ink-600">
                        {truncate(lead.excerpt, 180)}
                      </span>
                    )}
                  </span>
                </Link>

                {/* ---------- Các bài còn lại ---------- */}
                {rest.length > 0 && (
                  /* Không dùng lề âm để nền hover chạy sát mép thẻ: ở đây danh sách là **một ô
                     lưới**, nên phần thò ra sẽ lấn vào khoảng cách giữa hai cột và, trên màn
                     hẹp, đẩy cả trang tràn ngang. */
                  <ul className="space-y-0.5">
                    {rest.map((article) => (
                      <li key={article.id}>
                        {/*
                          Vùng bấm là cả dòng và có nền riêng khi rê chuột. Đường kẻ ngăn giữa
                          các dòng là đúng về mặt phân tách nhưng không báo cho người dùng biết
                          dòng nào đang trỏ tới, mà đây là danh sách để bấm vào.
                        */}
                        <Link
                          href={`/articles/${article.slug}`}
                          className="group flex min-h-touch items-start gap-3.5 rounded-xl p-2 transition-colors hover:bg-ink-50"
                        >
                          {/* Ảnh đại diện — bài chưa đặt ảnh vẫn giữ đúng khung để danh sách
                              không so le. */}
                          <span className="flex h-[3.5rem] w-[5rem] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-ink-100">
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
                            <p className="text-sm font-medium leading-snug text-ink-900 transition-colors group-hover:text-brand">
                              {article.title}
                              {article.locked && (
                                <Icon
                                  name="lock"
                                  size={13}
                                  className="ml-1.5 inline text-tone-amber-fg"
                                />
                              )}
                            </p>
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
                )}
              </div>
            ) : (
              <EmptyState title="Chưa có bài viết nào" icon={<Icon name="document" size={22} />} />
            )}
          </Card>

          <Card>
            <CardHeader
              title="Chiến lược đang theo dõi được"
              description="Bấm vào một chiến lược để xem điểm mua/bán trên biểu đồ"
              action={
                <Link href="/strategies">
                  <Button size="sm" variant="ghost" rightIcon={<Icon name="chevron-right" size={15} />}>
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
                    className="card-interactive flex flex-col rounded-2xl border border-line bg-ink-50/50 p-4"
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
                        được cỡ chữ riêng **và** một thanh ngang: hai chiến lược 58% và 71% đọc
                        bằng số thì phải so sánh, đọc bằng thanh thì thấy ngay. */}
                    {strategy.stats_live && strategy.stats_live.closed_trades > 0 && (
                      <div className="mt-auto border-t border-line pt-3">
                        <div className="flex items-baseline gap-2">
                          <span className="text-lg font-semibold tabular-nums text-ink-900">
                            {strategy.stats_live.win_rate}%
                          </span>
                          <span className="text-xs text-ink-500">
                            winrate · {strategy.stats_live.closed_trades} lệnh thực
                          </span>
                        </div>
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink-200">
                          <div
                            className="h-full rounded-full bg-up"
                            style={{ width: `${Math.min(strategy.stats_live.win_rate ?? 0, 100)}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </Link>
                ))}
              </div>
            ) : (
              <EmptyState
                title="Chưa có chiến lược nào khả dụng"
                description="Chiến lược cao cấp yêu cầu gói dài hạn hơn."
                icon={<Icon name="target" size={22} />}
                action={
                  <Link href="/pricing">
                    <Button size="sm">Xem các gói</Button>
                  </Link>
                }
              />
            )}
          </Card>
        </div>

        <div className="space-y-5 pb-6">
          {/* F23 — thông tin môi giới phụ trách. */}
          {user?.broker_name && (
            <Card>
              <CardHeader title="Môi giới phụ trách" />
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  <Icon name="user" size={20} />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink-900">{user.broker_name}</p>
                  {user.broker_code && (
                    <p className="truncate text-xs text-ink-500">Mã {user.broker_code}</p>
                  )}
                </div>
              </div>
              {user.broker_phone && (
                <a
                  href={`tel:${user.broker_phone}`}
                  className="mt-3 flex min-h-touch items-center justify-center gap-2 rounded-xl border border-line bg-ink-50/60 text-sm font-medium text-ink-900 transition-colors hover:border-line-strong hover:bg-ink-50"
                >
                  <Icon name="phone" size={16} className="text-ink-400" />
                  {user.broker_phone}
                </a>
              )}
            </Card>
          )}

          <Card>
            <CardHeader
              title="Chưa biết bắt đầu từ đâu?"
              description="Ba bước để có tín hiệu đầu tiên gửi về Telegram."
            />
            <ol className="space-y-3.5">
              {[
                { label: 'Chọn một chiến lược', href: '/strategies' },
                { label: 'Áp lên mã bạn quan tâm', href: '/market' },
                { label: 'Bật nhận tín hiệu', href: '/account/notifications' },
              ].map((step, index) => (
                <li key={step.href}>
                  <Link
                    href={step.href}
                    className="group flex items-center gap-3 text-sm text-ink-700 transition-colors hover:text-ink-900"
                  >
                    {/* Số bước trong vòng tròn: một danh sách đánh số bằng `1.` `2.` `3.` đọc
                        ra là liệt kê, còn số trong vòng tròn đọc ra là **trình tự**. */}
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-line bg-ink-50 text-xs font-semibold tabular-nums text-ink-600 transition-colors group-hover:border-brand group-hover:bg-brand-soft group-hover:text-brand">
                      {index + 1}
                    </span>
                    <span className="min-w-0 flex-1">{step.label}</span>
                    <Icon
                      name="chevron-right"
                      size={15}
                      className="shrink-0 text-ink-300 transition-transform group-hover:translate-x-0.5 group-hover:text-brand"
                    />
                  </Link>
                </li>
              ))}
            </ol>
          </Card>

          <Disclaimer />
        </div>
      </div>
    </div>
  );
}
