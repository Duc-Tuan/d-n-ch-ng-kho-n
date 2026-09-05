'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { Icon } from './Icon';

export type Column<T> = {
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  /** Bề rộng cố định, ví dụ '12rem'. Bỏ trống thì cột co giãn theo nội dung. */
  width?: string;
  align?: 'left' | 'center' | 'right';
  className?: string;
  headerClassName?: string;
  /** Ẩn trên màn hình nhỏ — mục 11.2 khuyến nghị rút gọn số cột trên điện thoại. */
  hideOnMobile?: boolean;
  /**
   * Ghim cột vào mép trái/phải khi cuộn ngang.
   * Đặt `right` cho cột hành động để nút thao tác luôn nhìn thấy dù bảng rộng bao nhiêu.
   */
  sticky?: 'left' | 'right';
};

export type PaginationState = {
  page: number;
  size: number;
  total: number;
};

type TableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  /**
   * Chiều cao tối đa của vùng bảng. Khi đặt, **bảng tự cuộn bên trong** thay vì đẩy cả trang
   * dài ra — tiêu đề bảng và thanh phân trang luôn nhìn thấy.
   *
   * Ưu tiên dùng `fill` thay cho prop này: đặt số đo tay cho từng màn nghĩa là mỗi lần thêm bớt
   * một khối phía trên bảng lại phải chỉnh lại con số, và sai thì không có gì báo.
   */
  maxHeight?: string;
  /**
   * Bảng **lấp đầy chiều cao còn lại** của màn hình.
   *
   * Yêu cầu trang cha là một cột flex có chiều cao xác định (`flex h-full flex-col`). Bảng nhận
   * `flex-1` nên tự co giãn theo phần trống thực tế — thêm hay bớt bộ lọc phía trên không cần
   * sửa gì ở đây.
   */
  fill?: boolean;
  /** Phân trang **phía máy chủ**: trang hiện tại do bên gọi quản lý. */
  pagination?: PaginationState;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  /**
   * Phân trang **phía client** cho bảng nhận thẳng cả mảng dữ liệu.
   *
   * Nhiều API trả về danh sách đầy đủ trong một lần gọi (lịch sử gói, danh sách lệnh của một lần
   * chạy chiến lược). Bắt mỗi màn tự cắt mảng và tự dựng thanh phân trang là ba chỗ lặp lại cùng
   * một đoạn mã, và thực tế là chỗ nào cũng quên. Đặt `clientPageSize` là bảng tự lo.
   *
   * Bị bỏ qua nếu đã truyền `pagination` — một bảng chỉ có một nguồn sự thật về trang hiện tại.
   */
  clientPageSize?: number;
  /** Dạng thẻ trên điện thoại — bảng nhiều cột không dùng được trên màn nhỏ (mục 11.2). */
  mobileCard?: (row: T) => ReactNode;
  /** Bề rộng tối thiểu của bảng trước khi bật cuộn ngang. */
  minWidth?: string;
};

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;
const PAGE_SIZES = [10, 20, 50, 100];

export function Table<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyMessage = 'Không tìm thấy bản ghi nào',
  onRowClick,
  maxHeight,
  fill = false,
  pagination,
  onPageChange,
  onPageSizeChange,
  clientPageSize,
  mobileCard,
  minWidth = '52rem',
}: TableProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [shadowRight, setShadowRight] = useState(false);
  const [shadowLeft, setShadowLeft] = useState(false);

  // ---- Phân trang phía client ----
  const clientMode = !pagination && Boolean(clientPageSize);
  const [clientPage, setClientPage] = useState(1);
  const [clientSize, setClientSize] = useState(clientPageSize ?? PAGE_SIZES[0]);

  const clientPages = Math.max(Math.ceil(rows.length / clientSize), 1);
  // Kẹp lại ngay trong lượt vẽ này thay vì đặt trong effect: dữ liệu bị lọc còn ít trang hơn thì
  // trang hiện tại phải lùi về ngay, không để loé lên một bảng trống rồi mới sửa.
  const safeClientPage = Math.min(clientPage, clientPages);
  // Ghi lại luôn vào state, nếu không: lọc còn 1 trang rồi bỏ lọc sẽ nhảy về đúng trang cũ đang
  // treo trong state. Nhánh này tự tắt sau một lượt nên không tạo vòng lặp vẽ.
  if (clientMode && clientPage !== safeClientPage) {
    setClientPage(safeClientPage);
  }

  const visibleRows = clientMode
    ? rows.slice((safeClientPage - 1) * clientSize, safeClientPage * clientSize)
    : rows;

  const effectivePagination: PaginationState | undefined = clientMode
    ? { page: safeClientPage, size: clientSize, total: rows.length }
    : pagination;
  const handlePageChange = clientMode ? setClientPage : onPageChange;
  const handlePageSizeChange = clientMode
    ? (next: number) => {
      setClientSize(next);
      setClientPage(1);
    }
    : onPageSizeChange;

  /**
   * Đổ bóng ở mép cột ghim chỉ khi thực sự còn nội dung bị che.
   * Không có tín hiệu này, người dùng không biết bảng còn cuộn ngang được nữa.
   */
  const checkShadow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;

    // Không cuộn ngang được thì không có gì bị che — bỏ bóng ở cả hai mép.
    const scrollable = el.scrollWidth - el.clientWidth;
    if (scrollable <= 1) {
      setShadowRight(false);
      setShadowLeft(false);
      return;
    }

    // Dung sai 1px: bề rộng cuộn là số thực, ở mức thu phóng lẻ `scrollLeft` không bao giờ chạm
    // đúng giá trị cuối, và khi đó bóng sẽ kẹt lại dù đã cuộn hết.
    setShadowRight(Math.ceil(el.scrollLeft) < scrollable - 1);
    setShadowLeft(el.scrollLeft > 1);
  }, []);

  useEffect(() => {
    checkShadow();
    const el = scrollRef.current;
    if (!el) return;

    window.addEventListener('resize', checkShadow);
    // Theo dõi cả khung cuộn lẫn bảng bên trong: đổi số dòng mỗi trang làm bảng rộng/hẹp đi mà
    // kích thước khung không đổi, chỉ quan sát khung thì bóng không được tính lại.
    const observer = new ResizeObserver(checkShadow);
    observer.observe(el);
    if (tableRef.current) observer.observe(tableRef.current);

    return () => {
      window.removeEventListener('resize', checkShadow);
      observer.disconnect();
    };
  }, [checkShadow, visibleRows, loading, columns.length]);

  /**
   * Cột ghim + đổ bóng báo hiệu còn nội dung bị che.
   *
   * Bóng chỉ xuất hiện khi **thật sự còn phần bảng chưa nhìn thấy** ở phía đó, và tắt ngay khi
   * cuộn tới mép. Không có tín hiệu này thì cột ghim trông y hệt cột cuối cùng của bảng, người
   * dùng không biết bên phải còn dữ liệu nữa hay không.
   */
  const stickyClass = (column: Column<T>, isHeader: boolean) => {
    if (!column.sticky) return '';
    const base = isHeader ? 'bg-ink-50' : 'bg-surface group-hover:bg-ink-50';
    const common = 'z-20 transition-shadow duration-200';

    return column.sticky === 'right'
      ? cn(
        'md:sticky md:right-0',
        common,
        base,
        shadowRight && 'shadow-[-10px_0_14px_-8px_rgba(24,24,27,0.4)]',
      )
      : cn(
        'md:sticky md:left-0',
        common,
        base,
        shadowLeft && 'shadow-[10px_0_14px_-8px_rgba(24,24,27,0.4)]',
      );
  };

  const totalPages = effectivePagination
    ? Math.max(Math.ceil(effectivePagination.total / effectivePagination.size), 1)
    : 0;
  const from = effectivePagination
    ? (effectivePagination.page - 1) * effectivePagination.size + 1
    : 0;
  const to = effectivePagination
    ? Math.min(effectivePagination.page * effectivePagination.size, effectivePagination.total)
    : 0;

  /**
   * Thanh phân trang dùng cho **cả hai** dạng hiển thị.
   *
   * Trước đây thanh này chỉ nằm trong khối bảng, mà khối bảng lại `hidden` trên điện thoại khi có
   * `mobileCard` — nghĩa là trên điện thoại người dùng chỉ thấy trang đầu và không có cách nào
   * sang trang tiếp theo.
   */
  const paginationBar = effectivePagination ? (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-ink-100 bg-ink-50/60 px-4 py-2.5 text-xs">
      <div className="flex items-center gap-3 text-ink-600">
        <span className="hidden sm:inline">
          Hiển thị <strong className="text-ink-900">{formatNumber(from)}</strong>–
          <strong className="text-ink-900">{formatNumber(to)}</strong> trên{' '}
          <strong className="text-ink-900">{formatNumber(effectivePagination.total)}</strong> bản ghi
        </span>
        <span className="sm:hidden">
          {formatNumber(from)}–{formatNumber(to)} / {formatNumber(effectivePagination.total)}
        </span>

        {handlePageSizeChange && (
          <label className="flex items-center gap-1.5 border-l border-ink-200 pl-3">
            <span className="text-ink-400">Số dòng</span>
            <select
              value={effectivePagination.size}
              onChange={(e) => handlePageSizeChange(Number(e.target.value))}
              className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-xs text-ink-800"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {handlePageChange && totalPages > 1 && (
        <PageNav
          page={effectivePagination.page}
          totalPages={totalPages}
          onChange={handlePageChange}
        />
      )}
    </div>
  ) : null;

  return (
    <>
      {/* Dạng thẻ trên điện thoại. */}
      {mobileCard && (
        <div
          className={cn(
            'space-y-3 md:hidden',
            fill && 'min-h-0 flex-1 overflow-y-auto overscroll-contain',
          )}
        >
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-ink-100" />
            ))
          ) : !visibleRows.length ? (
            <EmptyRow message={emptyMessage} />
          ) : (
            visibleRows.map((row) => (
              <div
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(
                  'rounded-xl border border-ink-200 bg-surface p-4 shadow-card',
                  onRowClick && 'cursor-pointer active:bg-ink-50',
                )}
              >
                {mobileCard(row)}
              </div>
            ))
          )}

          {!loading && paginationBar && (
            <div className="overflow-hidden rounded-xl border border-ink-200 bg-surface">
              {paginationBar}
            </div>
          )}
        </div>
      )}

      <div
        className={cn(
          'flex w-full flex-col overflow-hidden rounded-xl border border-ink-200 bg-surface shadow-card flex-1 justify-between',
          mobileCard && 'hidden md:flex',
        )}
      >
        <div
          ref={scrollRef}
          onScroll={checkShadow}
          className="overflow-auto overscroll-contain"
          style={maxHeight ? { maxHeight, minHeight: maxHeight } : undefined}
        >
          {/*
            `border-separate` chứ không phải `border-collapse`: khi viền bị gộp, Chrome **không vẽ
            box-shadow trên ô bảng**. Đó chính là lý do bóng ở cột ghim trước đây không bao giờ
            hiện dù trạng thái tính đúng. Đổi lại phải tự kẻ viền trên từng ô thay vì trên hàng —
            viền đặt trên `<tr>` cũng không được vẽ ở chế độ này.
          */}
          <table
            ref={tableRef}
            className="w-full border-separate border-spacing-0 text-sm"
            style={{ minWidth }}
          >
            {/* Tiêu đề dính — cuộn dài vẫn biết mình đang xem cột nào. */}
            <thead className="sticky top-0 z-30 bg-ink-50">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    style={
                      column.width
                        ? { width: column.width, minWidth: column.width, maxWidth: column.width }
                        : undefined
                    }
                    className={cn(
                      'whitespace-nowrap border-b border-ink-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-ink-500',
                      ALIGN[column.align ?? 'left'],
                      column.hideOnMobile && 'hidden lg:table-cell',
                      stickyClass(column, true),
                      column.headerClassName,
                    )}
                  >
                    {column.header}
                  </th>
                ))}
              </tr>
            </thead>

            {/* Hàng cuối bỏ viền dưới — ngay bên dưới đã là viền trên của thanh phân trang. */}
            <tbody className="[&>tr:last-child>td]:border-b-0">
              {loading ? (
                Array.from({ length: 5 }).map((_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`}>
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={cn(
                          'border-b border-ink-100 px-4 py-3.5',
                          column.hideOnMobile && 'hidden lg:table-cell',
                          // Dùng chung một hàm với hàng dữ liệu: lúc đang tải mà cột ghim
                          // trông khác đi thì bảng nhảy hình khi dữ liệu về.
                          stickyClass(column, false),
                        )}
                      >
                        <div
                          className={cn(
                            'h-4 animate-pulse rounded-full bg-ink-200',
                            column.align === 'right'
                              ? 'ml-auto w-1/2'
                              : column.align === 'center'
                                ? 'mx-auto w-2/3'
                                : 'w-3/4',
                          )}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              ) : !visibleRows.length ? (
                <tr>
                  <td colSpan={columns.length} className="border-b border-ink-100 px-4 py-14">
                    <EmptyRow message={emptyMessage} />
                  </td>
                </tr>
              ) : (
                visibleRows.map((row, index) => (
                  <tr
                    key={rowKey(row)}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={cn(
                      'group transition-colors',
                      onRowClick ? 'cursor-pointer hover:bg-ink-50' : 'hover:bg-ink-50/60',
                    )}
                  >
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        style={
                          column.width
                            ? { width: column.width, minWidth: column.width, maxWidth: column.width }
                            : undefined
                        }
                        className={cn(
                          'border-b border-ink-100 px-4 py-3 text-ink-700',
                          ALIGN[column.align ?? 'left'],
                          column.hideOnMobile && 'hidden lg:table-cell',
                          stickyClass(column, false),
                          column.className,
                        )}
                      >
                        {column.render(row, index)}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Thanh phân trang gắn đáy bảng, không trôi theo nội dung. */}
        {paginationBar}
      </div>
    </>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
      <Icon name="archive" size={34} className="text-ink-300" />
      <span className="text-sm text-ink-500">{message}</span>
    </div>
  );
}

function PageNav({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  // Chỉ hiện trang đầu, trang cuối và các trang kề — đủ dùng mà không tràn trên điện thoại.
  const pages: (number | 'gap')[] = [];
  for (let i = 1; i <= totalPages; i += 1) {
    if (totalPages <= 5 || i === 1 || i === totalPages || Math.abs(page - i) <= 1) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== 'gap') {
      pages.push('gap');
    }
  }

  const navButton =
    'flex h-7 w-7 items-center justify-center rounded-md border border-ink-200 bg-surface text-ink-600 transition-colors hover:bg-ink-100 disabled:pointer-events-none disabled:opacity-40';

  return (
    <nav className="flex items-center gap-1" aria-label="Phân trang">
      <button
        type="button"
        aria-label="Trang trước"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        className={navButton}
      >
        <Icon name="chevron-left" size={14} />
      </button>

      {pages.map((item, index) =>
        item === 'gap' ? (
          <span key={`gap-${index}`} className="px-0.5 text-ink-400">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            aria-current={item === page ? 'page' : undefined}
            onClick={() => onChange(item)}
            className={cn(
              'flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 text-[11px] font-semibold transition-colors',
              item === page
                ? 'bg-primary text-primary-fg'
                : 'border border-ink-200 bg-surface text-ink-600 hover:bg-ink-100',
            )}
          >
            {item}
          </button>
        ),
      )}

      <button
        type="button"
        aria-label="Trang sau"
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
        className={navButton}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </nav>
  );
}
