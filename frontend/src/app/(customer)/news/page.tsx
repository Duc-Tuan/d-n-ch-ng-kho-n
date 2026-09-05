'use client';

/**
 * Tin tức — danh sách dẫn nguồn.
 *
 * Không có màn chi tiết: bấm vào một tin là mở trang gốc ở tab mới. Nói rõ điều đó ngay trên thẻ
 * (tên nguồn + biểu tượng liên kết ngoài) thay vì để người đọc bấm rồi mới ngạc nhiên vì bị đưa
 * sang một tên miền khác.
 */

import { useState } from 'react';

import {
  Badge,
  Card,
  EmptyState,
  Icon,
  Input,
  Pagination,
  Spinner,
} from '@/components/ui';
import { useApiQuery, useDebounced, usePagination } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { fromNow } from '@/lib/datetime';
import type { NewsItem, Page } from '@/types';

export default function NewsPage() {
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search);
  const { page, size, setPage, reset } = usePagination(20);

  const { data, isLoading } = useApiQuery<Page<NewsItem>>(`${CUSTOMER}/news`, {
    page,
    size,
    q: debounced || undefined,
  });

  /**
   * Đếm lượt bấm nhưng **không chờ nó**: người đọc không phải trả giá bằng một vòng mạng cho số
   * liệu thống kê của chúng ta, và lỗi đếm không được phép chặn việc mở bài.
   */
  const track = (id: number) => {
    void api.post(`${CUSTOMER}/news/${id}/click`).catch(() => undefined);
  };

  return (
    <div className="flex h-full flex-col">
      {/*
        Cùng bố cục với site quản trị: thanh công cụ và phân trang đứng yên, chỉ danh sách cuộn.
      */}
      <div className="shrink-0 space-y-4 mb-2">
        <Input
          placeholder="Tìm theo tiêu đề…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            reset();
          }}
          leftAddon={<Icon name="search" size={16} />}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {isLoading ? (
          <div className="py-16">
            <Spinner label="Đang tải tin tức…" />
          </div>
        ) : !data?.items.length ? (
          <EmptyState
            title="Chưa có tin nào"
            description={search ? 'Thử từ khoá khác.' : undefined}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {data.items.map((item) => (
              <a
                key={item.id}
                href={item.url}
                target="_blank"
                // `noopener` là bắt buộc, không phải trang trí: thiếu nó thì trang đích giữ được
                // tham chiếu `window.opener` và chuyển hướng ngược được tab của khách hàng.
                rel="noopener noreferrer"
                onClick={() => track(item.id)}
                className="group block h-full"
              >
                {/*
                  Ảnh tràn hết bề ngang thẻ, không còn chừa lề như trước. Ảnh có lề bốn phía
                  đọc ra là "một ô ảnh nằm trong hộp"; ảnh tràn mép đọc ra là "thẻ tin này có
                  ảnh" — cùng một tấm ảnh, khác hẳn cảm giác hoàn thiện. Vì vậy thẻ bỏ đệm mặc
                  định và tự đệm phần chữ.
                */}
                <Card
                  padded={false}
                  className="flex h-full flex-col overflow-hidden transition-colors hover:border-line-strong"
                >
                  {item.image_url && (
                    // Ảnh nằm trên máy chủ của trang nguồn — hệ thống chỉ giữ đường dẫn. Link
                    // hỏng thì ẩn ô ảnh chứ không để lại khung vỡ; thẻ tin vẫn đọc được.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.image_url}
                      alt=""
                      loading="lazy"
                      className="aspect-[16/9] w-full bg-ink-100 object-cover transition-transform duration-300 group-hover:scale-[1.03]"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none';
                      }}
                    />
                  )}

                  <div className="flex flex-1 flex-col p-4">
                    <div className="mb-2.5 flex items-center justify-between gap-2">
                      {item.source_name ? (
                        <Badge tone="gray">{item.source_name}</Badge>
                      ) : (
                        <span />
                      )}
                      <Icon
                        name="external"
                        size={14}
                        className="shrink-0 text-ink-400 transition-colors group-hover:text-brand"
                      />
                    </div>

                    <h3 className="text-sm font-semibold leading-snug text-ink-900 transition-colors group-hover:text-brand">
                      {item.title}
                    </h3>

                    {item.summary && (
                      <p className="mt-2 flex-1 text-sm leading-relaxed text-ink-600">
                        {item.summary}
                      </p>
                    )}

                    <p className="mt-3.5 border-t border-line pt-2.5 text-xs text-ink-500">
                      {item.published_at ? fromNow(item.published_at) : 'Chưa rõ ngày đăng'}
                    </p>
                  </div>
                </Card>
              </a>
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
