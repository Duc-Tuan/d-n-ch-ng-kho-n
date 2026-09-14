'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';

import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  Skeleton,
  ThemeToggle,
} from '@/components/ui';
import { ThemeProvider, useApiQuery } from '@/hooks';
import { PUBLIC } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';
import type { LegalDocument } from '@/types';

/**
 * Văn bản pháp lý công khai — mục 9.1.
 *
 * Không đặt trong route group `(customer)` vì phải xem được **trước khi đăng ký** (bước đăng ký
 * có link mở trong tab mới) và ở footer khi chưa đăng nhập. Hệ quả là màn này không có
 * `CustomerShell`, nên nó phải tự dựng lấy thanh trên, chân trang và `ThemeProvider` — nếu
 * không thì nó là một trang trần, trông như rơi ra từ một website khác.
 *
 * Bản trước tô nền bằng `bg-ink-50` và kẻ viền bằng `border-ink-200`. Ở bản sáng thì trông
 * tạm được, nhưng đó là **sai trục**: thang `ink` là thang độ tương phản của **chữ**, còn nền
 * trang là `canvas` và viền là `line`. Ở bản tối, `ink-50` là một mặt gần đen dùng cho khối
 * nổi, nên cả trang biến thành một mảng xám lửng lơ không thuộc bậc nào.
 */
const LEGAL_DOCS = [
  { slug: 'tos', type: 'TOS', label: 'Điều khoản sử dụng' },
  { slug: 'privacy', type: 'PRIVACY', label: 'Chính sách bảo mật' },
  { slug: 'refund', type: 'REFUND', label: 'Chính sách hoàn tiền' },
  { slug: 'disclaimer', type: 'DISCLAIMER', label: 'Miễn trừ trách nhiệm' },
  { slug: 'cookie', type: 'COOKIE', label: 'Chính sách cookie' },
] as const;

/** Tra ngược từ đoạn đường dẫn sang mã loại của backend. */
const TYPE_BY_SLUG: Record<string, string> = Object.fromEntries(
  LEGAL_DOCS.map((d) => [d.slug, d.type.toUpperCase()]),
);

function LegalContent() {
  const params = useParams<{ type: string }>();
  const slug = params.type?.toLowerCase() ?? '';
  const docType = TYPE_BY_SLUG[slug] ?? params.type?.toUpperCase();

  const { data, isLoading, error } = useApiQuery<LegalDocument>(
    docType ? `${PUBLIC}/legal/${docType}` : null,
  );

  /**
   * Danh sách văn bản **đã ban hành**, để dựng thanh điều hướng.
   *
   * Lấy từ máy chủ chứ không viết cứng năm đường dẫn: văn bản nào chưa ban hành thì không có
   * gì để mở, và một thanh điều hướng dẫn tới bốn trang "chưa ban hành" còn tệ hơn là không
   * có thanh điều hướng. Gọi lỗi thì rơi về danh sách đầy đủ — mất một lời hứa nhỏ vẫn hơn
   * mất hẳn lối đi giữa các văn bản.
   */
  const { data: published, error: listError } = useApiQuery<LegalDocument[]>(`${PUBLIC}/legal`);

  const availableTypes = new Set((published ?? []).map((d) => d.type.toUpperCase()));
  const navItems = LEGAL_DOCS.filter(
    (d) => listError || !published || availableTypes.has(d.type.toUpperCase()),
  );

  return (
    <div className="flex min-h-dvh flex-col bg-canvas">
      {/* Thanh trên: cùng công thức kính mờ với `CustomerShell` để hai vùng đọc ra là một site. */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-line bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-[4.25rem] max-w-content items-center justify-between gap-4 px-4 lg:px-8">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <span className="brand-mark flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-bold tracking-tight">
              CK
            </span>
            <span className="truncate text-sm font-semibold text-ink-900">
              Tư vấn chứng khoán
            </span>
          </Link>

          <div className="flex shrink-0 items-center gap-1">
            <ThemeToggle />
            {/* Dùng `Button` chứ không tự kẻ lại một cái nút bằng class trên thẻ `Link`: nút
                tự dựng sẽ trôi khỏi hệ thống ngay lần đầu ai đó sửa bo góc hay chiều cao vùng
                chạm ở `Button`, và ở màn này nó đứng cạnh nút đổi nền nên lệch một pixel là
                thấy ngay. `Link` chỉ còn lo việc điều hướng. */}
            <Link href="/">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Icon name="arrow-left" size={16} />}
              >
                Về trang chủ
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-content flex-1 px-4 py-6 lg:px-8">
        {/* ---------- Khối mở đầu ---------- */}
        <section className="relative overflow-hidden rounded-3xl border border-line bg-surface shadow-card">
          <div aria-hidden className="mesh-brand pointer-events-none absolute inset-0" />
          <div className="relative p-5 sm:p-7">
            <p className="text-label font-medium uppercase text-ink-500">Văn bản pháp lý</p>

            {isLoading ? (
              <>
                <Skeleton className="mt-3 h-8 w-2/3" />
                <Skeleton className="mt-3 h-4 w-1/3" />
              </>
            ) : (
              <>
                <h1 className="mt-2.5 text-display font-semibold text-ink-900 sm:text-display-lg">
                  {data?.title ?? 'Văn bản chưa được ban hành'}
                </h1>

                {data && (
                  <div className="mt-3.5 flex flex-wrap items-center gap-2">
                    <Badge tone="blue">Phiên bản {data.version}</Badge>
                    <Badge tone="gray">
                      <Icon name="calendar" size={13} />
                      Hiệu lực từ {formatDate(data.effective_from)}
                    </Badge>
                    {data.is_current && (
                      <Badge tone="green" dot>
                        Đang áp dụng
                      </Badge>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </section>

        {/* ---------- Điều hướng + nội dung + thông tin văn bản ----------
            Cột điều hướng dính ở mép trên khi cuộn: văn bản pháp lý dài hàng nghìn chữ, và
            người đọc thường cần nhảy qua lại giữa Điều khoản và Chính sách bảo mật ở giữa
            chừng — bắt họ cuộn ngược lên đầu mỗi lần là lý do người ta bỏ đọc.

            **Ba cột, không phải hai.** Khung trang giờ rộng bằng trang chủ (`max-w-content`),
            và nếu chỉ có điều hướng cộng nội dung thì cột chữ nở ra hơn 1.100px — mỗi dòng
            gần 130 ký tự, tức là mắt đọc xong một dòng phải dò lại mới tìm được đầu dòng sau.
            Cột thông tin bên phải vừa kéo cột chữ về khoảng đọc được, vừa đưa những thứ người
            ta thật sự tra cứu (phiên bản đang đọc, hiệu lực từ bao giờ, khác gì bản trước) ra
            khỏi dòng chảy văn bản.

            Dưới `xl` chỉ còn hai cột và khối thông tin tụt xuống dưới nội dung — xem
            `lg:col-start-2` ở chính khối đó. */}
        <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,20rem)]">
          <nav
            aria-label="Các văn bản pháp lý"
            className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1 lg:sticky lg:top-[5.25rem] lg:flex-col lg:gap-1 lg:self-start lg:overflow-visible lg:pb-0"
          >
            {navItems.map((item) => {
              const active = item.slug === slug;
              return (
                <Link
                  key={item.slug}
                  href={`/legal/${item.slug}`}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'relative flex min-h-touch shrink-0 items-center whitespace-nowrap rounded-xl px-3.5 text-sm transition-colors',
                    'lg:min-h-0 lg:py-2.5',
                    active
                      ? 'bg-gradient-to-r from-brand-soft to-brand-soft/30 font-medium text-brand'
                      : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                  )}
                >
                  {/* Vạch mép trái chỉ có nghĩa ở dải dọc; ở dải ngang trên điện thoại nó sẽ là
                      một cái gạch lơ lửng cạnh chữ. */}
                  {active && (
                    <span
                      aria-hidden
                      className="absolute left-0 top-1/2 hidden h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand lg:block"
                    />
                  )}
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="min-w-0 space-y-4">
            {isLoading ? (
              <Card>
                <div className="space-y-3">
                  {Array.from({ length: 14 }, (_, i) => (
                    <Skeleton key={i} className={cn('h-4', i % 4 === 3 ? 'w-2/3' : 'w-full')} />
                  ))}
                </div>
              </Card>
            ) : error || !data ? (
              <EmptyState
                title="Văn bản chưa được ban hành"
                description="Vui lòng liên hệ bộ phận hỗ trợ để được cung cấp nội dung."
                icon={<Icon name="scale" size={22} />}
              />
            ) : (
              <Card>
                {/* Nội dung soạn ở Admin Site dưới dạng markdown đơn giản; giữ nguyên xuống
                    dòng. `prose-reading` nâng cỡ chữ và giãn dòng cho văn bản dài — đây là màn
                    duy nhất ngoài chi tiết bài viết mà người ta đọc liên tục vài nghìn chữ, và
                    cỡ chữ giao diện 14px thì đọc tới đoạn thứ ba là mỏi. */}
                <div className="prose-article prose-reading whitespace-pre-wrap">
                  {data.content}
                </div>
              </Card>
            )}
          </div>

          {/* ---------- Cột thông tin văn bản ----------
              `lg:col-start-2` để ở bố cục hai cột nó rơi xuống **dưới nội dung** chứ không
              nhảy vào cột điều hướng; `xl:col-start-3 xl:row-start-1` kéo nó về cột ba, ngang
              hàng với nội dung, khi màn đủ rộng. Một khối DOM duy nhất cho cả hai bố cục —
              dựng hai bản rồi ẩn bớt một bản là cách chắc chắn để hai bản trôi khỏi nhau. */}
          {data && !isLoading && (
            <aside className="space-y-4 lg:col-start-2 xl:col-start-3 xl:row-start-1 xl:self-start xl:sticky xl:top-[5.25rem]">
              <Card>
                <p className="text-label font-medium uppercase text-ink-500">Thông tin văn bản</p>
                <dl className="mt-3 space-y-2.5 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-ink-500">Phiên bản</dt>
                    <dd className="font-medium tabular-nums text-ink-900">{data.version}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-ink-500">Hiệu lực từ</dt>
                    <dd className="font-medium tabular-nums text-ink-900">
                      {formatDate(data.effective_from)}
                    </dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt className="text-ink-500">Trạng thái</dt>
                    <dd>
                      <Badge tone={data.is_current ? 'green' : 'gray'} dot>
                        {data.is_current ? 'Đang áp dụng' : 'Đã thay thế'}
                      </Badge>
                    </dd>
                  </div>
                </dl>
              </Card>

              {/* Có tóm tắt thay đổi thì nói rõ: người quay lại đọc một văn bản đã đọc rồi chỉ
                  cần biết **phần nào khác đi**, không cần đọc lại từ đầu. */}
              {data.summary_of_changes && (
                <Alert tone="info" title="Thay đổi so với phiên bản trước">
                  {data.summary_of_changes}
                </Alert>
              )}

              <p className="flex items-start gap-2 rounded-xl border border-line bg-ink-50/60 px-3.5 py-3 text-xs leading-relaxed text-ink-600">
                <Icon name="info" size={15} className="mt-0.5 shrink-0 text-ink-400" />
                Khi có phiên bản mới với thay đổi trọng yếu, bạn sẽ được thông báo trước tối
                thiểu 15 ngày và được yêu cầu đồng ý lại trước khi tiếp tục sử dụng dịch vụ.
              </p>
            </aside>
          )}
        </div>
      </main>

      {/* Chân trang giống `CustomerShell`: người đang đọc một văn bản thường muốn mở tiếp văn
          bản kế bên, và đây là chỗ họ quen tìm. */}
      <footer className="mt-6 shrink-0 border-t border-line bg-surface">
        <div className="mx-auto flex max-w-content flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-ink-500 lg:px-8">
          <nav className="flex flex-wrap gap-x-5 gap-y-1">
            {LEGAL_DOCS.map((item) => (
              <Link
                key={item.slug}
                href={`/legal/${item.slug}`}
                className="transition-colors hover:text-ink-900"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <p className="max-w-xl">
            Thông tin mang tính tham khảo, không phải khuyến nghị mua bán chứng khoán.
          </p>
        </div>
      </footer>
    </div>
  );
}

export default function LegalPage() {
  /*
    `ThemeProvider` phải bọc ở đây chứ không ở đâu khác: màn này nằm ngoài route group
    `(customer)`, nên nó không đi qua `app/(customer)/layout.tsx`. Thiếu nó thì `ThemeToggle`
    ném lỗi ngay khi dựng ("useTheme phải nằm trong <ThemeProvider>") và cả trang trắng.
  */
  return (
    <ThemeProvider>
      <LegalContent />
    </ThemeProvider>
  );
}
