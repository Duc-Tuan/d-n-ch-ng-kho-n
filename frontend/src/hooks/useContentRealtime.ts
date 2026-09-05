'use client';

/**
 * Đồng bộ nội dung site khách hàng theo thời gian thực (YC16).
 *
 * Khi quản trị sửa, xuất bản, gỡ hoặc xoá một bài viết, máy chủ đẩy một gói tin qua WebSocket.
 * Ở đây chỉ **xoá hiệu lực cache** rồi để SWR tự gọi lại API thường — không lấy nội dung từ gói
 * tin. Đây là điểm quan trọng: nội dung đi đường API nên vẫn qua đủ chốt kiểm tra gói dịch vụ
 * (BR-502) và trạng thái tài khoản; nếu nhận thẳng nội dung từ WebSocket thì kênh real-time trở
 * thành cửa sau cấp phát nội dung vượt quyền.
 */
import { useCallback } from 'react';
import { useSWRConfig } from 'swr';

import { useRealtime, type RealtimeEvent } from './useRealtime';

/** Khoá SWR là `path` hoặc `[path, params]` — lấy ra phần đường dẫn để so khớp. */
function pathOf(key: unknown): string | null {
  const raw = Array.isArray(key) ? key[0] : key;
  return typeof raw === 'string' ? raw : null;
}

export function useContentRealtime(enabled = true) {
  const { mutate } = useSWRConfig();

  const onEvent = useCallback(
    (event: RealtimeEvent) => {
      if (event.type !== 'content' || event.entity !== 'article') return;
      const slug = typeof event.slug === 'string' ? event.slug : null;

      void mutate((key: unknown) => {
        const path = pathOf(key);
        if (!path || !path.includes('/articles')) return false;

        const detailSlug = path.split('/articles/')[1];
        // Khoá danh sách (trang bài viết, khối "mới nhất" ở trang chủ) luôn tải lại.
        if (!detailSlug) return true;
        // Khoá chi tiết chỉ tải lại đúng bài vừa đổi: mỗi lần gọi API chi tiết đều cộng một lượt
        // xem, tải lại tất cả sẽ thổi phồng số liệu của những bài không liên quan.
        return detailSlug === slug;
      });
    },
    [mutate],
  );

  // Chưa đăng nhập thì máy chủ đóng kênh ngay (1008); mở sớm chỉ tạo ra vòng thử lại vô ích.
  useRealtime('customer', onEvent, enabled);
}
