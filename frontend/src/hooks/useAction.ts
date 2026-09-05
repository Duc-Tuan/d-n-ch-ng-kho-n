'use client';

/**
 * Hook cho **thao tác ghi có phản hồi** — gọi API, hiện toast, làm mới danh sách.
 *
 * Khối này xuất hiện khoảng ba mươi lần trong `app/`:
 *
 * ```tsx
 * const result = await someMutation.mutate(input);
 * if (result) {
 *   toast.success(result.message);
 *   refresh();
 * }
 * ```
 *
 * Bản thân nó không dài, nhưng vì mỗi nơi tự viết nên cách xử lý **thất bại** lại khác nhau:
 * chỗ hiện toast lỗi, chỗ im lặng, chỗ hiện lỗi ở một ô nào đó rồi thôi. Người dùng bấm một nút
 * và không thấy gì xảy ra là hỏng niềm tin nhanh hơn cả một thông báo lỗi thẳng thắn.
 * Gom vào đây để **mặc định là báo lỗi**, và nơi nào muốn khác thì nói rõ ra.
 */
import { useCallback, useState } from 'react';

import { ApiError } from '@/lib/api';
import { useToast } from './useToast';

type Options<TResult> = {
  /** Thông điệp khi thành công. Bỏ trống thì lấy `message` từ phản hồi của máy chủ. */
  success?: string | ((result: TResult) => string);
  /** Chạy sau khi thành công — thường là `refresh` của danh sách hoặc đóng hộp thoại. */
  onSuccess?: (result: TResult) => void;
  /** Đặt `false` khi component tự hiển thị lỗi ngay dưới ô nhập. */
  toastError?: boolean;
};

type WithMessage = { message?: string };

export function useAction<TResult, TInput = void>(
  fn: (input: TInput) => Promise<TResult>,
  options: Options<TResult> = {},
) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const { success, onSuccess, toastError = true } = options;

  const run = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setLoading(true);
      setError(null);
      try {
        const result = await fn(input);

        const message =
          typeof success === 'function'
            ? success(result)
            : success ?? (result as WithMessage | null)?.message;
        if (message) toast.success(message);

        onSuccess?.(result);
        return result;
      } catch (err) {
        const apiError =
          err instanceof ApiError
            ? err
            : new ApiError(0, { code: 'NETWORK_ERROR', message: 'Không kết nối được máy chủ' });
        setError(apiError);
        if (toastError) toast.error(apiError.message);
        return null;
      } finally {
        setLoading(false);
      }
    },
    [fn, success, onSuccess, toastError, toast],
  );

  return { run, loading, error, reset: () => setError(null) };
}

/**
 * Thao tác cần xác nhận trước khi chạy — nút Xoá, nút Ban hành, nút Đóng tài khoản.
 *
 * Quản lý luôn "đối tượng đang chờ xác nhận", thứ mà mỗi màn đang tự khai bằng một
 * `useState<T | null>(null)` riêng rồi tự nhớ đặt lại về `null` ở đủ ba nhánh (xong, huỷ, lỗi).
 * Quên một nhánh thì hộp thoại kẹt lại trên màn hình.
 */
export function useConfirmAction<T, TResult = unknown>(
  fn: (target: T, reason?: string) => Promise<TResult>,
  options: Options<TResult> = {},
) {
  const [target, setTarget] = useState<T | null>(null);

  const action = useAction<TResult, { target: T; reason?: string }>(
    ({ target: t, reason }) => fn(t, reason),
    {
      ...options,
      onSuccess: (result) => {
        setTarget(null);
        options.onSuccess?.(result);
      },
    },
  );

  const confirm = useCallback(
    async (reason?: string) => {
      if (target === null) return null;
      return action.run({ target, reason });
    },
    [action, target],
  );

  return {
    /** Đối tượng đang chờ xác nhận — dùng để dựng câu hỏi trong hộp thoại. */
    target,
    /** Mở hộp thoại cho một đối tượng. */
    ask: setTarget,
    /** Đóng hộp thoại mà không làm gì. */
    cancel: useCallback(() => setTarget(null), []),
    confirm,
    loading: action.loading,
    /** Trải thẳng vào `<ConfirmDialog {...dialogProps} />`. */
    dialogProps: {
      open: target !== null,
      onClose: () => setTarget(null),
      loading: action.loading,
      onConfirm: confirm,
    },
  };
}
