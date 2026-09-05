'use client';

/**
 * Hook cho **màn danh sách** — gộp phân trang, bộ lọc và props của bảng vào một chỗ.
 *
 * Mọi màn danh sách trong hệ thống đang lặp lại đúng cùng một khối:
 *
 * ```tsx
 * const { page, size, setPage, setSize, reset } = usePagination(20);
 * const { data, isLoading, refresh } = useApiQuery<Page<T>>(path, { page, size, ...filters });
 * <Table
 *   pagination={data ? { page: data.page, size: data.size, total: data.total } : undefined}
 *   onPageChange={setPage}
 *   onPageSizeChange={(next) => { setSize(next); reset(); }}
 * />
 * ```
 *
 * Mười hai màn, mười hai bản sao. Chúng không chỉ dài dòng: mỗi bản sao là một cơ hội quên
 * `reset()` khi đổi bộ lọc — lỗi kinh điển "lọc xong thấy trang trắng" vì người dùng đang ở
 * trang 5 của kết quả cũ mà kết quả mới chỉ có một trang.
 */
import { useCallback, useMemo, useState } from 'react';
import type { SWRConfiguration } from 'swr';

import { useApiQuery } from './useApi';
import type { ApiError } from '@/lib/api';
import type { Page } from '@/types';

type Filters = Record<string, unknown>;

type Options<T> = {
  /** Số bản ghi mỗi trang lúc khởi tạo. */
  initialSize?: number;
  /** Chuyển thẳng cho SWR — ví dụ `refreshInterval` cho màn trực cần tự làm mới. */
  swr?: SWRConfiguration<Page<T>, ApiError>;
};

export function useList<T>(path: string | null, filters: Filters = {}, options: Options<T> = {}) {
  const { initialSize = 20, swr } = options;
  // Giữ state ngay tại đây thay vì gọi `usePagination` từ `./index`: file này được `./index`
  // export lại, nên import ngược sẽ tạo vòng phụ thuộc giữa hai module.
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(initialSize);
  const reset = useCallback(() => setPage(1), []);

  // Chuỗi hoá bộ lọc để `useMemo` không phụ thuộc vào tham chiếu object mới mỗi lần render.
  const filterKey = JSON.stringify(filters);
  const params = useMemo(
    () => ({ page, size, ...(JSON.parse(filterKey) as Filters) }),
    [page, size, filterKey],
  );

  const { data, error, isLoading, refresh: revalidate } = useApiQuery<Page<T>>(path, params, swr);

  // Bọc lại thành hàm không tham số. `mutate` của SWR nhận dữ liệu thay thế ở tham số đầu, nên
  // truyền thẳng nó vào một callback dạng `(result) => void` sẽ khiến kết quả của thao tác ghi
  // bị ghi đè lên bộ nhớ đệm của danh sách — một hình dạng dữ liệu hoàn toàn khác.
  const refresh = useCallback(() => {
    void revalidate();
  }, [revalidate]);

  /** Đổi bộ lọc thì luôn quay về trang 1 — gọi hàm này thay vì `setState` trần. */
  const applyFilter = useCallback(
    (change: () => void) => {
      change();
      reset();
    },
    [reset],
  );

  /** Trải thẳng vào `<Table {...tableProps} />`. */
  const tableProps = {
    rows: data?.items ?? [],
    loading: isLoading,
    pagination: data ? { page: data.page, size: data.size, total: data.total } : undefined,
    onPageChange: setPage,
    onPageSizeChange: (next: number) => {
      setSize(next);
      reset();
    },
  };

  return {
    items: data?.items ?? [],
    total: data?.total ?? 0,
    data,
    error,
    isLoading,
    refresh,
    page,
    size,
    setPage,
    setSize,
    reset,
    applyFilter,
    tableProps,
  };
}
