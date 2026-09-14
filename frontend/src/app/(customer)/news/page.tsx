'use client';

/**
 * Tin tức — cột trái đứng yên, dòng tin bên phải cuộn.
 *
 * ---------------------------------------------------------------------------------------------
 * VÌ SAO KHÔNG PHẢI LƯỚI THẺ ĐỀU NHAU, VÀ VÌ SAO Ô TÌM KIẾM KHÔNG NẰM TRÊN CÙNG
 * ---------------------------------------------------------------------------------------------
 * Hai bản trước đều hỏng ở cùng một chỗ: mọi thứ xếp chồng theo chiều dọc, nên thanh tìm kiếm
 * chiếm trọn một dải ngang trên đầu rồi trôi mất khi cuộn, còn tin thì dàn thành lưới bốn cột
 * đều nhau — không tin nào là tin đáng đọc trước.
 *
 * Bố cục hiện tại tách hẳn hai vai:
 *
 *   * **Cột trái đứng yên** (`sticky`) — ô tìm kiếm và tin đinh. Đây là những thứ không đổi
 *     theo vị trí cuộn, nên chúng không có lý do gì phải trôi đi: người đọc lướt tới tin thứ
 *     ba mươi vẫn gõ tìm được ngay mà không phải cuộn ngược lên đầu.
 *   * **Cột phải cuộn** — dòng chảy tin, ảnh nhỏ bên trái, ngăn nhau bằng một đường kẻ.
 *
 * Ô tìm kiếm vì thế hẹp lại còn bằng bề ngang cột trái thay vì kéo hết màn hình. Một ô nhập
 * rộng 1.400px là một ô nhập sai: nó hứa hẹn một câu truy vấn dài, trong khi thứ người ta gõ
 * vào đây luôn là vài từ khoá.
 */

import { useState } from 'react';

import {
  Card,
  EmptyState,
  Icon,
  Pagination,
  SearchInput,
  Skeleton,
} from '@/components/ui';
import { useApiQuery, usePagination } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { fromNow } from '@/lib/datetime';
import type { NewsItem, Page } from '@/types';

/**
 * Chữ cái đầu của nguồn, dùng làm dấu nhận biết khi tin không có ảnh.
 *
 * Tin dẫn nguồn thường xuyên thiếu ảnh — nguồn chặn hotlink, hoặc bài gốc vốn không có. Một ô
 * xám trống nhìn như ảnh hỏng; một ô chữ lồng mang tên nguồn thì vẫn là thông tin, và nó khác
 * nhau giữa các dòng nên danh sách không bị phẳng.
 */
function sourceInitials(name: string | null): string {
  if (!name) return 'TIN';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

/** Ảnh của tin, hoặc ô chữ lồng thay thế. Dùng chung cho tin đinh và dòng tin. */
function NewsThumb({
  item,
  className,
  initialsClass = 'text-lg',
}: {
  item: NewsItem;
  className: string;
  initialsClass?: string;
}) {
  return (
    <span className={`relative block shrink-0 overflow-hidden bg-ink-100 ${className}`}>
      {item.image_url ? (
        // Ảnh nằm trên máy chủ của trang nguồn — hệ thống chỉ giữ đường dẫn. Link hỏng thì **ẩn
        // đúng thẻ ảnh** chứ không để lại khung vỡ; ô chữ lồng bên dưới lộ ra và tin vẫn đọc được.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.image_url}
          alt=""
          loading="lazy"
          className="absolute inset-0 z-10 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : null}

      <span className="mesh-brand absolute inset-0 flex items-center justify-center">
        <span className={`font-bold tracking-tight text-ink-300 ${initialsClass}`}>
          {sourceInitials(item.source_name)}
        </span>
      </span>
    </span>
  );
}

/** Nguồn · thời gian · lối ra ngoài — dòng chân dùng chung. */
function NewsMeta({ item }: { item: NewsItem }) {
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-500">
      {item.source_name && <span className="font-medium text-ink-700">{item.source_name}</span>}
      {item.source_name && <span aria-hidden>·</span>}
      <span>{item.published_at ? fromNow(item.published_at) : 'Chưa rõ ngày đăng'}</span>
      {/* Nói thẳng là sẽ rời khỏi site, ngay trên dòng tin. */}
      <Icon
        name="external"
        size={12}
        className="text-ink-400 transition-colors group-hover:text-brand"
      />
    </p>
  );
}

export default function NewsPage() {
  /* `SearchInput` tự hoãn 300ms rồi mới gọi lại, nên `search` ở đây **đã là** giá trị ổn định
     — không cần bọc thêm `useDebounced` như trước. Bọc hai lần thì mỗi lần gõ phải chờ 650ms. */
  const [search, setSearch] = useState('');
  const { page, size, setPage, reset } = usePagination(21);

  const { data, isLoading } = useApiQuery<Page<NewsItem>>(`${CUSTOMER}/news`, {
    page,
    size,
    q: search || undefined,
  });

  /**
   * Đếm lượt bấm nhưng **không chờ nó**: người đọc không phải trả giá bằng một vòng mạng cho số
   * liệu thống kê của chúng ta, và lỗi đếm không được phép chặn việc mở bài.
   */
  const track = (id: number) => {
    void api.post(`${CUSTOMER}/news/${id}/click`).catch(() => undefined);
  };

  const items = data?.items ?? [];

  /*
    Tin đinh chỉ xuất hiện ở **trang một và khi không tìm kiếm**.

    "Tin đinh" nghĩa là "mới nhất, đọc cái này trước". Sang trang hai thì tin đứng đầu chỉ là tin
    thứ hai mươi hai theo thứ tự thời gian, phóng to nó lên là nói với người đọc một điều không
    đúng. Đang tìm kiếm cũng vậy — thứ tự khi đó là theo độ khớp, không phải theo độ mới.
  */
  const showLead = page === 1 && !search && items.length > 3;
  const lead = showLead ? items[0] : null;
  const rest = showLead ? items.slice(1) : items;

  return (
    <div className="flex h-full flex-col">
      {/*
        ==========================================================================================
        HAI NGĂN CUỘN ĐỘC LẬP
        ==========================================================================================
        Từ `lg` trở lên, **phần tử này không cuộn** (`lg:overflow-hidden`); hai ô lưới con mỗi ô
        tự cuộn lấy. Nhờ vậy cột trái đứng yên tuyệt đối: nó không "dính" nhờ mẹo nào cả, nó đơn
        giản là nằm trong một ngăn khác với ngăn đang cuộn.

        Bản trước làm bằng `position: sticky` cộng `max-h-[calc(100dvh - 6.5rem)]`, và nó sai
        theo một kiểu rất dễ tin là đúng: con số `6.5rem` là ước lượng phần chiều cao bị thanh
        trên và các lề ăn mất, nhưng nó **không biết tới thanh phân trang** ở chân trang. Đo
        thật trên cửa sổ cao 620px: vùng cuộn chỉ còn 426px trong khi công thức cho ra 516px,
        nên cột trái cao hơn ngăn chứa nó, `sticky` ghim ở `top-0` và phần đáy — đúng chỗ đặt
        tin đinh — không bao giờ kéo tới được.

        Cách này không có con số nào để sai: chiều cao do bố cục flex quyết định.

        Dưới `lg` thì ngược lại — chính phần tử này cuộn, còn hai ô con trôi tự nhiên. Màn hình
        điện thoại quá hẹp để chia hai ngăn, và hai thanh cuộn lồng nhau trên cảm ứng là thứ
        không ai điều khiển nổi.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:overflow-hidden">
        <div className="grid gap-6 lg:h-full lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)] lg:gap-8 xl:grid-cols-[minmax(0,24rem)_minmax(0,1fr)]">
          {/* ---------- Cột trái: ngăn đứng yên ---------- */}
          {/* `min-h-0` là bắt buộc: ô lưới mặc định có `min-height: auto`, nghĩa là nó nở ra
              theo nội dung và `overflow-y-auto` không bao giờ có hiệu lực. Thiếu đúng một class
              này thì cột trái lại dài ra và đẩy cả bố cục về như cũ.

              `pr-1` chừa chỗ cho thanh cuộn của chính nó, để nội dung không bị nó đè lên. */}
          <aside className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1 lg:pb-4">
            <SearchInput
              placeholder="Tìm theo tiêu đề…"
              value={search}
              onSearch={(next) => {
                setSearch(next);
                reset();
              }}
            />

            {isLoading ? (
              <Card padded={false} className="overflow-hidden">
                <Skeleton className="aspect-[16/9] w-full rounded-none" />
                <div className="space-y-3 p-5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-6 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </Card>
            ) : lead ? (
              <a
                href={lead.url}
                target="_blank"
                // `noopener` là bắt buộc, không phải trang trí: thiếu nó thì trang đích giữ được
                // tham chiếu `window.opener` và chuyển hướng ngược được tab của khách hàng.
                rel="noopener noreferrer"
                onClick={() => track(lead.id)}
                className="group block"
              >
                <Card padded={false} interactive className="overflow-hidden">
                  <NewsThumb item={lead} className="aspect-[16/9] w-full" initialsClass="text-3xl" />

                  <div className="p-4 sm:p-5">
                    <p className="text-label font-medium uppercase text-brand">Tin mới nhất</p>

                    <h2 className="mt-2 text-lg font-semibold leading-snug text-ink-900 transition-colors group-hover:text-brand">
                      {lead.title}
                    </h2>

                    {lead.summary && (
                      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-ink-600">
                        {lead.summary}
                      </p>
                    )}

                    <div className="mt-3.5 border-t border-line pt-2.5">
                      <NewsMeta item={lead} />
                    </div>
                  </div>
                </Card>
              </a>
            ) : null}
          </aside>

          {/* ---------- Cột phải: dòng chảy tin, ngăn cuộn ---------- */}
          <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pb-4">
            {isLoading ? (
              <div className="divide-y divide-line">
                {Array.from({ length: 8 }, (_, i) => (
                  <div key={i} className="flex gap-3.5 py-3.5 first:pt-0">
                    <Skeleton className="aspect-[4/3] w-24 shrink-0 sm:w-28" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : !items.length ? (
              <EmptyState
                title="Chưa có tin nào"
                description={search ? 'Thử từ khoá khác.' : undefined}
                icon={<Icon name="document" size={22} />}
              />
            ) : (
              <div className="divide-y divide-line">
                {rest.map((item) => (
                  <a
                    key={item.id}
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => track(item.id)}
                    className="group flex gap-3.5 py-3.5 transition-colors first:pt-0 hover:bg-ink-50/60"
                  >
                    {/* Ảnh nhỏ, tỉ lệ cố định, bo nhẹ. Ở một dòng chảy tin, ảnh là thứ giúp phân
                        biệt các dòng với nhau chứ không phải thứ để ngắm — 6rem là vừa đủ. */}
                    <NewsThumb item={item} className="aspect-[4/3] w-24 rounded-lg sm:w-28" />

                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-sm font-semibold leading-snug text-ink-900 transition-colors group-hover:text-brand">
                        {item.title}
                      </h3>

                      {item.summary && (
                        <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-600 sm:text-sm">
                          {item.summary}
                        </p>
                      )}

                      <div className="mt-1.5">
                        <NewsMeta item={item} />
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {data && items.length > 0 && (
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
