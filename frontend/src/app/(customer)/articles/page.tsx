'use client';

import Link from 'next/link';
import { useState } from 'react';

import {
  Card,
  EmptyState,
  Input,
  Pagination,
  Spinner,
  Tabs,
  Icon,
} from '@/components/ui';
import { useApiQuery, useDebounced, usePagination } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { fromNow } from '@/lib/datetime';
import { formatNumber, truncate } from '@/lib/format';
import type { Article, Category, Page } from '@/types';

export default function ArticlesPage() {
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search);
  const { page, size, setPage, reset } = usePagination(12);

  const { data: categories } = useApiQuery<Category[]>(`${CUSTOMER}/categories`, {
    type: 'ARTICLE',
  });

  const { data, isLoading } = useApiQuery<Page<Article>>(`${CUSTOMER}/articles`, {
    page,
    size,
    category_id: categoryId || undefined,
    q: debouncedSearch || undefined,
  });

  const tabs = [
    { key: '', label: 'Tất cả' },
    ...(categories ?? []).map((c) => ({ key: String(c.id), label: c.name })),
  ];

  return (
    <div className="flex h-full flex-col space-y-3">
      {/*
        Cùng bố cục với site quản trị: thanh công cụ và phân trang đứng yên, chỉ danh sách cuộn.
      */}
      <div className="shrink-0 space-y-3">
        <div className="space-y-3">
          <Input
            placeholder="Tìm theo tiêu đề bài viết…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              reset();
            }}
            leftAddon={<Icon name="search" size={16} />}
          />
          <Tabs
            items={tabs}
            active={categoryId}
            onChange={(key) => {
              setCategoryId(key);
              reset();
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải bài viết…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="Không có bài viết nào"
            description={search ? 'Thử từ khoá khác hoặc bỏ bộ lọc danh mục.' : undefined}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.items.map((article) => (
              <Link key={article.id} href={`/articles/${article.slug}`}>
                <Card className="h-full transition-colors hover:border-ink-300">
                  <div className="flex h-full flex-col">
                    <div className="mb-2 flex items-center gap-2 text-xs">
                      <span className="rounded bg-ink-100 px-2 py-0.5 font-medium text-ink-900">
                        {article.category_name}
                      </span>
                      {/* BR-502 — nội dung cao cấp hiện khoá, kèm lối nâng cấp. */}
                      {article.locked && <Icon name="lock" size={14} className="text-tone-amber-fg" />}
                    </div>
                    <h3 className="text-sm font-semibold leading-snug text-ink-900">
                      {article.title}
                    </h3>
                    {article.excerpt && (
                      <p className="mt-1.5 flex-1 text-sm text-ink-600">
                        {truncate(article.excerpt, 110)}
                      </p>
                    )}
                    <p className="mt-3 text-xs text-ink-500">
                      {fromNow(article.published_at)} · {formatNumber(article.view_count)} lượt xem
                    </p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>

      {data && data.items.length > 0 && (
        <div className="shrink-0">
          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
          />
        </div>
      )}
    </div>
  );
}
