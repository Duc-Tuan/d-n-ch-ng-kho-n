'use client';

/**
 * Bài viết — cột trái đứng yên, lưới bài bên phải cuộn.
 *
 * ---------------------------------------------------------------------------------------------
 * BA THỨ ĐÃ ĐỔI, VÀ LÝ DO
 * ---------------------------------------------------------------------------------------------
 * **1. Ô tìm kiếm và bộ lọc danh mục rời khỏi đỉnh trang.** Trước đây chúng là hai dải ngang
 * chiếm hết bề ngang rồi trôi mất khi cuộn: vướng lúc đọc, mà tới lúc cần lọc lại phải cuộn
 * ngược lên đầu. Giờ cả hai nằm trong cột trái đứng yên — luôn thấy, luôn bấm được, và chỉ rộng
 * bằng một cột thay vì cả màn hình. Một ô nhập rộng 1.400px vốn là một ô nhập sai: nó hứa hẹn
 * một câu truy vấn dài, trong khi thứ người ta gõ vào đây luôn là vài từ khoá.
 *
 * **2. Danh mục chuyển từ tab ngang sang danh sách dọc.** Tab ngang chỉ hợp khi có ba bốn mục
 * cố định; danh mục bài viết do biên tập thêm bớt, nên hàng tab hoặc tràn ra ngoài màn hoặc
 * phải cuộn ngang — kiểu điều hướng mà dùng chuột gần như không ai tìm ra. Danh sách dọc nở
 * xuống dưới thoải mái và đọc được cả tên dài.
 *
 * **3. Cột trái chỉ còn công cụ; toàn bộ bài viết nằm bên phải, lưới bốn bài một dòng.**
 *
 * Bản trước chia bài thành ba bậc — một bài đinh ảnh lớn nằm dưới bộ lọc ở cột trái, một lưới
 * hai cột, rồi một danh sách chữ. Bố cục ấy theo đúng lối toà soạn, nhưng nó trộn hai thứ khác
 * loại vào chung một cột: cột trái vừa là **thanh công cụ** (tìm kiếm, lọc) vừa là **nội dung**
 * (bài đinh). Hệ quả là ranh giới giữa "chỗ để thao tác" và "chỗ để đọc" biến mất, và người
 * dùng phải quét cả hai cột mới biết hết có những bài nào.
 *
 * Giờ mỗi cột đúng một vai: trái là công cụ, phải là nội dung. Đổi lại thì mọi bài cùng cỡ, tức
 * là trang không còn tự nói bài nào đáng đọc trước — bù lại nó **đếm được**: một dòng bốn bài,
 * ba dòng một trang, nhìn là biết còn bao nhiêu. Với một danh mục bài viết mà phần lớn lượt
 * truy cập là để tra cứu chứ không phải để lướt đọc, đó là đánh đổi đúng.
 */

import Link from 'next/link';
import { useState } from 'react';

import {
  Card,
  EmptyState,
  Pagination,
  SearchInput,
  Skeleton,
  Icon,
} from '@/components/ui';
import { useApiQuery, usePagination } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { fromNow } from '@/lib/datetime';
import { formatNumber, truncate } from '@/lib/format';
import { cn } from '@/lib/cn';
import type { Article, Category, Page } from '@/types';

/**
 * Lưới bài: bốn cột trên màn làm việc, hạ dần xuống một cột trên điện thoại.
 *
 * Bốn cột **chỉ bật từ 1360px**, không phải từ `xl` (1280px). Cột phải không rộng bằng cả màn:
 * nó còn phải trừ cột công cụ 22rem và khoảng cách giữa hai cột, nên ở 1280px mỗi thẻ chỉ còn
 * ~190px — hẹp tới mức tiêu đề vỡ năm dòng và tấm ảnh 16/9 co lại còn một vệt. Ngưỡng 1360px là
 * chỗ mỗi thẻ vừa đủ ~210px; từ 1440px trở lên thì thoải mái.
 */
const GRID = 'grid gap-2 sm:grid-cols-2 xl:grid-cols-3 min-[1360px]:grid-cols-4';

/**
 * Chữ lồng của danh mục — dùng khi bài chưa có ảnh đại diện.
 *
 * Ô xám phẳng có một icon ở giữa đọc ra là **ảnh hỏng**. Một mảng chuyển màu mang chữ lồng đọc
 * ra là chỗ trống có chủ đích, và vì mỗi danh mục cho một cặp chữ khác nhau nên lưới không bị
 * phẳng khi nhiều bài cùng thiếu ảnh.
 */
function categoryInitials(name: string | null): string {
  if (!name) return 'BV';
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function Thumb({ article }: { article: Article }) {
  return (
    <span className="relative block aspect-[16/9] w-full overflow-hidden bg-ink-100">
      {article.thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={article.thumbnail}
          alt=""
          loading="lazy"
          className="absolute inset-0 z-10 h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
        />
      ) : null}

      <span className="mesh-brand absolute inset-0 flex items-center justify-center">
        <span className="text-xl font-bold tracking-tight text-ink-300">
          {categoryInitials(article.category_name)}
        </span>
      </span>

      {/* BR-502 — nội dung cao cấp hiện khoá, kèm lối nâng cấp ở màn chi tiết. Dấu khoá đặt đè
          lên ảnh chứ không nằm lẫn trong hàng chữ nhỏ bên dưới: đây là thông tin quyết định
          người dùng có bấm vào hay không, nên nó phải nằm ở chỗ mắt rơi vào trước. */}
      {article.locked && (
        <span className="absolute right-2 top-2 z-20 flex h-7 w-7 items-center justify-center rounded-full bg-canvas/85 text-tone-amber-fg backdrop-blur-sm">
          <Icon name="lock" size={14} />
        </span>
      )}
    </span>
  );
}

function ArticleCard({ article }: { article: Article }) {
  return (
    <Link href={`/articles/${article.slug}`} className="group block h-full">
      <Card padded={false} interactive className="flex h-full flex-col overflow-hidden">
        <Thumb article={article} />

        <div className="flex flex-1 flex-col p-4">
          {/* Nhãn danh mục kiểu "eyebrow" — chữ hoa nhỏ có giãn, đứng trên tiêu đề. */}
          {article.category_name && (
            <p className="text-label font-medium uppercase text-brand">{article.category_name}</p>
          )}

          <h3 className="mt-1.5 line-clamp-3 text-sm font-semibold leading-snug text-ink-900 transition-colors group-hover:text-brand">
            {article.title}
          </h3>

          {article.excerpt && (
            <p className="mt-2 line-clamp-2 flex-1 text-sm leading-relaxed text-ink-600">
              {truncate(article.excerpt, 110)}
            </p>
          )}

          <p className="mt-3.5 flex items-center gap-2 border-t border-line pt-2.5 text-xs text-ink-500">
            <span>{fromNow(article.published_at)}</span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1 tabular-nums">
              <Icon name="eye" size={13} className="text-ink-400" />
              {formatNumber(article.view_count)}
            </span>
          </p>
        </div>
      </Card>
    </Link>
  );
}

export default function ArticlesPage() {
  const [categoryId, setCategoryId] = useState('');
  /* `SearchInput` tự hoãn 300ms rồi mới gọi lại, nên `search` ở đây **đã là** giá trị ổn định
     — không cần bọc thêm `useDebounced` như trước. Bọc hai lần thì mỗi lần gõ phải chờ 650ms. */
  const [search, setSearch] = useState('');
  // 12 = ba dòng đầy, mỗi dòng bốn bài. Số chia hết cho 4 để dòng cuối không bị hụt.
  const { page, size, setPage, reset } = usePagination(12);

  const { data: categories } = useApiQuery<Category[]>(`${CUSTOMER}/categories`, {
    type: 'ARTICLE',
  });

  const { data, isLoading } = useApiQuery<Page<Article>>(`${CUSTOMER}/articles`, {
    page,
    size,
    category_id: categoryId || undefined,
    q: search || undefined,
  });

  const items = data?.items ?? [];

  const filters = [
    { key: '', label: 'Tất cả' },
    ...(categories ?? []).map((c) => ({ key: String(c.id), label: c.name })),
  ];

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
        nên cột trái cao hơn ngăn chứa nó và `sticky` ghim ở `top-0`, phần đáy không kéo tới được.

        Cách này không có con số nào để sai: chiều cao do bố cục flex quyết định.

        Dưới `lg` thì ngược lại — chính phần tử này cuộn, còn hai ô con trôi tự nhiên. Màn hình
        điện thoại quá hẹp để chia hai ngăn, và hai thanh cuộn lồng nhau trên cảm ứng là thứ
        không ai điều khiển nổi.
      */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain lg:overflow-hidden">
        <div className="grid gap-2 lg:h-full lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
          {/* ---------- Cột trái: thanh công cụ, đứng yên ---------- */}
          {/* `min-h-0` là bắt buộc: ô lưới mặc định có `min-height: auto`, nghĩa là nó nở ra
              theo nội dung và `overflow-y-auto` không bao giờ có hiệu lực. Thiếu đúng một class
              này thì cột trái lại dài ra và đẩy cả bố cục về như cũ.

              `pr-1` chừa chỗ cho thanh cuộn của chính nó, để nội dung không bị nó đè lên. */}
          <aside className="space-y-5 lg:min-h-0 lg:overflow-y-auto lg:pr-1 lg:pb-4">
            <SearchInput
              placeholder="Tìm theo tiêu đề bài viết…"
              value={search}
              onSearch={(next) => {
                setSearch(next);
                reset();
              }}
            />

            {/*
              Dải danh mục.

              Bỏ hẳn cái hộp có viền bọc quanh danh sách. Một khung chữ nhật viền xám chứa mấy
              dòng chữ xám là hình dạng của một biểu mẫu quản trị, không phải của một thanh điều
              hướng — và nó lặp lại đúng thứ đường kẻ mà cả trang đang cố bỏ bớt. Ở đây chỉ còn
              một nhãn nhỏ kèm đường kẻ mảnh, rồi tới các mục.

              Mục đang chọn nhận **ba** dấu hiệu cùng lúc: nền loang nhạt màu thương hiệu, chữ
              đổi màu, và một vạch dọc ở mép trái. Chỉ đổi nền thôi thì ở bản tối gần như không
              thấy gì — các bậc xám ở đó sát nhau; còn vạch dọc thì đọc được ở cả hai bảng màu
              vì nó là **hình dạng**, không phải sắc độ.
            */}
            <div>
              <div className="mb-2.5 flex items-center gap-3 px-1">
                <p className="text-label font-medium uppercase text-ink-500">Danh mục</p>
                <span aria-hidden className="rule-fade flex-1" />
              </div>

              <div
                role="tablist"
                aria-label="Lọc theo danh mục"
                // Không dùng thủ thuật lề âm (`-mx-1` + `px-1`) để dải chạy sát mép: nó làm hộp
                // rộng hơn cột chứa 8px, và vì không có ai cắt bớt nên ở màn hẹp cả trang thừa
                // ra 4px và mọc một thanh cuộn ngang — đã đo: 522px nội dung trong 518px khung.
                className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0"
              >
                {filters.map((item) => {
                  const active = categoryId === item.key;
                  return (
                    <button
                      key={item.key || 'all'}
                      role="tab"
                      aria-selected={active}
                      onClick={() => {
                        setCategoryId(item.key);
                        reset();
                      }}
                      className={cn(
                        'relative flex min-h-touch shrink-0 items-center gap-2.5 whitespace-nowrap rounded-xl px-3.5 text-sm transition-colors',
                        'lg:min-h-0 lg:py-2.5',
                        active
                          ? 'bg-gradient-to-r from-brand-soft to-brand-soft/30 font-medium text-brand'
                          : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
                      )}
                    >
                      {/* Vạch mép trái chỉ có nghĩa ở dải dọc; ở dải ngang trên điện thoại nó
                          sẽ là một cái gạch lơ lửng cạnh chữ. */}
                      {active && (
                        <span
                          aria-hidden
                          className="absolute left-0 top-1/2 hidden h-5 w-[3px] -translate-y-1/2 rounded-full bg-brand lg:block"
                        />
                      )}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* ---------- Cột phải: toàn bộ bài viết, ngăn cuộn ---------- */}
          <div className="min-w-0 lg:min-h-0 lg:overflow-y-auto lg:pb-4">
            {isLoading ? (
              // Khung giữ chỗ đúng hình dáng và đúng số lượng thẻ thật: dữ liệu về thì điền vào
              // chỗ trống, không đẩy cả lưới nhảy một cái như khi thay một vòng quay ở giữa màn.
              <div className={GRID}>
                {Array.from({ length: size }, (_, i) => (
                  <Card key={i} padded={false} className="overflow-hidden">
                    <Skeleton className="aspect-[16/9] w-full rounded-none" />
                    <div className="space-y-2.5 p-4">
                      <Skeleton className="h-3 w-20" />
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : !items.length ? (
              <EmptyState
                title="Không có bài viết nào"
                description={
                  search || categoryId ? 'Thử từ khoá khác hoặc bỏ bộ lọc danh mục.' : undefined
                }
                icon={<Icon name="document" size={22} />}
              />
            ) : (
              <div className={GRID}>
                {items.map((article) => (
                  <ArticleCard key={article.id} article={article} />
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
