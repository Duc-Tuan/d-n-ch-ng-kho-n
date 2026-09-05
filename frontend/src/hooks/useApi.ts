'use client';

/**
 * Hook gọi API dùng chung.
 *
 * `useApiQuery` — đọc dữ liệu (bọc SWR, tự xử lý ACCESS_BLOCKED).
 * `useApiMutation` — ghi dữ liệu, trả về trạng thái loading/error để component không tự quản lý.
 */
import { useCallback, useState } from 'react';
import useSWR, { type SWRConfiguration } from 'swr';

import { ApiError, api } from '@/lib/api';

export function useApiQuery<T>(
  path: string | null,
  params?: Record<string, unknown>,
  config?: SWRConfiguration<T, ApiError>,
) {
  const key = path === null ? null : params ? ([path, params] as const) : path;

  const { data, error, isLoading, isValidating, mutate } = useSWR<T, ApiError>(
    key,
    () => api.get<T>(path as string, params),
    {
      revalidateOnFocus: false,
      shouldRetryOnError: (err) => !(err instanceof ApiError && err.status < 500),
      ...config,
    },
  );

  return { data, error, isLoading, isValidating, refresh: mutate };
}

type MutationState = { loading: boolean; error: ApiError | null };

export function useApiMutation<TResult, TInput = unknown>(
  fn: (input: TInput) => Promise<TResult>,
) {
  const [state, setState] = useState<MutationState>({ loading: false, error: null });

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setState({ loading: true, error: null });
      try {
        const result = await fn(input);
        setState({ loading: false, error: null });
        return result;
      } catch (err) {
        const apiError =
          err instanceof ApiError
            ? err
            : new ApiError(0, { code: 'NETWORK_ERROR', message: 'Không kết nối được máy chủ' });
        setState({ loading: false, error: apiError });
        return null;
      }
    },
    [fn],
  );

  const reset = useCallback(() => setState({ loading: false, error: null }), []);

  return { mutate, reset, ...state };
}

/** Lấy thông báo lỗi cho một trường cụ thể — dùng để hiện dưới ô nhập. */
export function fieldError(error: ApiError | null, field: string): string | undefined {
  if (!error) return undefined;
  return error.field === field ? error.message : undefined;
}
