'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import {
  Badge,
  Card,
  Disclaimer,
  EmptyState,
  Icon,
  LockedContent,
  Spinner,
} from '@/components/ui';
import { useApiQuery, useToast } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate, fromNow } from '@/lib/datetime';
import { formatNumber, truncate } from '@/lib/format';
import type { Article, Page } from '@/types';

type Heading = { id: string; text: string; level: 2 | 3 };

/** Neo cho mục lục — bỏ dấu tiếng Việt để id còn dùng được trong URL. */
function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Ước lượng thời gian đọc — 200 từ/phút, đủ sát cho một dòng thông tin tham khảo. */
function readingMinutes(html: string): number {
  const text = html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 1;
  return Math.max(1, Math.round(text.split(' ').length / 200));
}

export default function ArticleDetailPage() {
  const params = useParams<{ slug: string }>();
  const toast = useToast();
  const { data, error, isLoading } = useApiQuery<Article>(`${CUSTOMER}/articles/${params.slug}`);

  // Bài cùng danh mục — lấp cột phải và giữ khách hàng ở lại luồng đọc.
  const { data: related } = useApiQuery<Page<Article>>(
    data?.category_id ? `${CUSTOMER}/articles` : null,
    { category_id: data?.category_id, size: 6 },
  );

  const [activeId, setActiveId] = useState('');
  const [progress, setProgress] = useState(0);

  /**
   * Gắn `id` cho h2/h3 ngay trên HTML của bài rồi mới đưa vào DOM: mục lục cần neo, mà CMS
   * không sinh sẵn id. Làm bằng `DOMParser` chứ không bằng regex để không phá cấu trúc thẻ.
   *
   * Không lo lệch hydrate: nội dung do SWR tải phía client, lần dựng đầu trên máy chủ chỉ có
   * spinner nên khối này chưa từng được render hai lần với hai kết quả khác nhau.
   */
  const { html, headings } = useMemo(() => {
    const raw = data?.content ?? '';
    if (!raw || typeof window === 'undefined') return { html: raw, headings: [] as Heading[] };

    const doc = new DOMParser().parseFromString(raw, 'text/html');
    const items: Heading[] = [];
    const used = new Set<string>();

    doc.body.querySelectorAll('h2, h3').forEach((el, index) => {
      const text = el.textContent?.trim() ?? '';
      if (!text) return;
      let id = slugify(text) || `muc-${index + 1}`;
      if (used.has(id)) id = `${id}-${index + 1}`;
      used.add(id);
      el.id = id;
      items.push({ id, text, level: el.tagName === 'H3' ? 3 : 2 });
    });

    // Bảng do CMS sinh ra không có lớp bọc nên một bảng nhiều cột làm trôi ngang cả trang.
    doc.body.querySelectorAll('table').forEach((table) => {
      if (table.parentElement?.classList.contains('table-scroll')) return;
      const wrapper = doc.createElement('div');
      wrapper.className = 'table-scroll';
      table.replaceWith(wrapper);
      wrapper.appendChild(table);
    });

    return { html: doc.body.innerHTML, headings: items };
  }, [data?.content]);

  /**
   * Một trình nghe cuộn duy nhất phục vụ cả hai việc: tô sáng mục đang đọc và vẽ thanh tiến độ.
   * Tách làm hai listener chỉ khiến trình duyệt tính lại bố cục hai lần trong cùng một khung hình.
   */
  useEffect(() => {
    const root = document.documentElement;

    const onScroll = () => {
      const scrollable = root.scrollHeight - root.clientHeight;
      setProgress(scrollable > 0 ? Math.min(100, (root.scrollTop / scrollable) * 100) : 0);

      if (!headings.length) return;
      let current = headings[0].id;
      for (const heading of headings) {
        const el = document.getElementById(heading.id);
        // 120px ≈ chiều cao thanh điều hướng dính cộng một khoảng thở: tiêu đề vừa chạm mép trên
        // là đã được coi là mục đang đọc.
        if (el && el.getBoundingClientRect().top <= 120) current = heading.id;
      }
      setActiveId(current);
    };

    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [headings]);

  if (isLoading) {
    return (
      <div className="py-20">
        <Spinner label="Đang tải bài viết…" />
      </div>
    );
  }

  /**
   * Phải xét `error` trước `data`: khi bài bị gỡ hoặc xoá, kênh real-time (YC16) kích hoạt tải
   * lại và API trả 404, nhưng SWR vẫn **giữ nguyên bản đã tải trước đó** trong cache. Chỉ kiểm
   * tra `!data` thì khách hàng tiếp tục đọc một bài viết không còn tồn tại.
   */
  if (error) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Bài viết không còn khả dụng"
          description="Bài viết này vừa được gỡ hoặc chuyển sang trạng thái chưa xuất bản."
        />
        <div className="text-center">
          <Link href="/articles" className="text-sm text-ink-500 hover:text-ink-700">
            ← Quay lại danh sách bài viết
          </Link>
        </div>
      </div>
    );
  }

  if (!data) return <EmptyState title="Không tìm thấy bài viết" />;

  const tags = (data.tags ?? '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const relatedItems = (related?.items ?? []).filter((item) => item.id !== data.id).slice(0, 4);
  const showToc = !data.locked && headings.length > 1;
  const minutes = readingMinutes(data.content ?? '');

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success('Đã sao chép liên kết bài viết');
    } catch {
      toast.error('Trình duyệt không cho phép sao chép liên kết');
    }
  };

  return (
    <>
      {/* Thanh tiến độ đọc — sát mép trên, chồng lên viền của thanh điều hướng dính. */}
      {!data.locked && (
        <div className="fixed inset-x-0 top-0 z-40 h-0.5" aria-hidden>
          <div
            className="h-full bg-brand transition-[width] duration-150 ease-out"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {/*
        Ba cột trên màn rộng. Trước đây bài viết là một dải `max-w-3xl` đặt giữa khung nội dung
        rộng 100rem, nên hai mép trái phải trống hoác. Giờ phần thừa được giao cho mục lục và cột
        thông tin — vẫn giữ độ dài dòng chữ vừa mắt vì cột giữa bị hai cột kia kẹp lại.
      */}
      <div
        className={cn(
          'grid w-full gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]',
          showToc && 'xl:grid-cols-[14rem_minmax(0,1fr)_19rem]',
        )}
      >
        {/* ---- Cột trái: mục lục ---- */}
        {showToc && (
          <aside className="hidden xl:block">
            <div className="sticky top-20">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Trong bài này
              </p>
              <nav className="border-l border-ink-200">
                {headings.map((heading) => (
                  <a
                    key={heading.id}
                    href={`#${heading.id}`}
                    className={cn(
                      '-ml-px block border-l-2 py-1.5 leading-snug transition-colors',
                      heading.level === 3 ? 'pl-6 text-[13px]' : 'pl-4 text-sm',
                      activeId === heading.id
                        ? 'border-ink-900 font-medium text-ink-900'
                        : 'border-transparent text-ink-500 hover:border-ink-300 hover:text-ink-800',
                    )}
                  >
                    {heading.text}
                  </a>
                ))}
              </nav>

              <div className="mt-5 border-t border-ink-200 pt-4">
                <div className="h-1 overflow-hidden rounded-full bg-ink-200">
                  <div
                    className="h-full rounded-full bg-brand"
                    style={{ width: `${progress}%` }}
                  />
                </div>
                <p className="mt-2 text-xs text-ink-400">Đã đọc {Math.round(progress)}%</p>
              </div>
            </div>
          </aside>
        )}

        {/* ---- Cột giữa: nội dung bài ---- */}
        <article className="min-w-0">
          <nav className="mb-4 flex items-center gap-1.5 text-sm text-ink-500">
            <Link href="/articles" className="transition-colors hover:text-ink-900">
              Bài viết
            </Link>
            {data.category_name && (
              <>
                <Icon name="chevron-right" size={14} className="text-ink-300" />
                <span className="truncate text-ink-700">{data.category_name}</span>
              </>
            )}
          </nav>

          <header>
            {data.category_name && <Badge tone="blue">{data.category_name}</Badge>}

            <h1 className="mt-3 text-2xl font-semibold leading-tight tracking-tight text-ink-900 sm:text-3xl lg:text-[2.125rem] lg:leading-[1.2]">
              {data.title}
            </h1>

            {data.excerpt && (
              <p className="mt-4 text-base leading-relaxed text-ink-600 sm:text-lg">
                {data.excerpt}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-ink-200 py-3 text-sm text-ink-500">
              <span className="inline-flex items-center gap-1.5">
                <Icon name="calendar" size={15} className="text-ink-400" />
                {formatDate(data.published_at)}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="clock" size={15} className="text-ink-400" />
                {minutes} phút đọc
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Icon name="eye" size={15} className="text-ink-400" />
                {formatNumber(data.view_count)} lượt xem
              </span>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="ml-auto inline-flex min-h-touch items-center gap-1.5 rounded-lg px-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900"
              >
                <Icon name="share" size={15} />
                Chia sẻ
              </button>
            </div>
          </header>

          {data.thumbnail && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={data.thumbnail}
              alt=""
              className="mt-6 aspect-[2/1] w-full rounded-2xl border border-ink-200 bg-ink-100 object-cover"
            />
          )}

          {data.locked ? (
            <div className="mt-6">
              <LockedContent description="Bài viết này chỉ dành cho gói dịch vụ cao hơn. Nâng cấp để đọc toàn bộ nội dung." />
            </div>
          ) : (
            <Card padded={false} className="mt-6 px-5 py-6 sm:px-8 sm:py-8 lg:px-10 lg:py-9">
              {/* Nội dung do CMS sinh ra, chỉ nhân viên nội bộ có quyền content.publish mới xuất bản được. */}
              <div
                className="prose-article prose-reading"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </Card>
          )}

          {tags.length > 0 && (
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wider text-ink-400">Thẻ</span>
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-ink-200 bg-surface px-3 py-1 text-xs text-ink-600"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* BR-601 — disclaimer ở chân mọi màn có nội dung khuyến nghị. */}
          <Disclaimer className="mt-5" />

          <Link
            href="/articles"
            className="mt-5 inline-flex items-center gap-1.5 text-sm text-ink-500 transition-colors hover:text-ink-900"
          >
            <Icon name="arrow-left" size={15} />
            Quay lại danh sách bài viết
          </Link>
        </article>

        {/* ---- Cột phải: thông tin bài & bài cùng danh mục ---- */}
        <aside className="min-w-0">
          <div className="space-y-4 lg:sticky lg:top-20">
            <Card className="hidden lg:block">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                Thông tin bài viết
              </p>
              <dl className="space-y-2.5 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-500">Danh mục</dt>
                  <dd className="truncate text-right font-medium text-ink-900">
                    {data.category_name ?? '—'}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-500">Xuất bản</dt>
                  <dd className="text-right font-medium text-ink-900">
                    {formatDate(data.published_at)}
                  </dd>
                </div>
                {data.updated_at && (
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-ink-500">Cập nhật</dt>
                    <dd className="text-right font-medium text-ink-900">
                      {fromNow(data.updated_at)}
                    </dd>
                  </div>
                )}
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-500">Lượt xem</dt>
                  <dd className="text-right font-medium tabular-nums text-ink-900">
                    {formatNumber(data.view_count)}
                  </dd>
                </div>
              </dl>
              <button
                type="button"
                onClick={() => void copyLink()}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700 transition-colors hover:border-ink-300 hover:bg-ink-50"
              >
                <Icon name="copy" size={15} />
                Sao chép liên kết
              </button>
            </Card>

            {relatedItems.length > 0 && (
              <Card>
                <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-400">
                  Bài cùng danh mục
                </p>
                <div className="divide-y divide-ink-100">
                  {relatedItems.map((item) => (
                    <Link
                      key={item.id}
                      href={`/articles/${item.slug}`}
                      className="group block py-3 first:pt-0 last:pb-0"
                    >
                      <p className="flex items-start gap-1.5 text-sm font-medium leading-snug text-ink-900 transition-colors group-hover:text-ink-600">
                        {item.locked && (
                          <Icon name="lock" size={13} className="mt-0.5 shrink-0 text-tone-amber-fg" />
                        )}
                        <span>{truncate(item.title, 90)}</span>
                      </p>
                      <p className="mt-1 text-xs text-ink-500">
                        {fromNow(item.published_at)} · {formatNumber(item.view_count)} lượt xem
                      </p>
                    </Link>
                  ))}
                </div>
                <Link
                  href="/articles"
                  className="mt-3 inline-flex items-center gap-1 text-sm text-ink-500 transition-colors hover:text-ink-900"
                >
                  Xem tất cả bài viết
                  <Icon name="chevron-right" size={14} />
                </Link>
              </Card>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
