'use client';

/**
 * Gia hạn phiên đăng nhập **trước** khi access token hết hạn.
 *
 * Access token sống 30 phút (`settings.access_token_minutes`), refresh token sống nhiều ngày.
 * Trước khi có hook này, người dùng ngồi đọc một màn hình quá 30 phút rồi bấm bất cứ đâu là
 * nhận lỗi và bị đá về màn đăng nhập — dù phiên của họ vẫn còn hạn hàng ngày.
 *
 * **Vì sao là bộ đếm giờ chứ không phải đọc hạn của token.** Cookie phiên là HttpOnly, cố ý:
 * JavaScript không đọc được nó thì mã độc chèn vào trang cũng không. Cái giá là phía trình
 * duyệt không có cách nào biết token còn bao lâu, nên chỉ còn cách làm mới theo chu kỳ ngắn hơn
 * hạn token.
 *
 * **Vì sao vẫn cần chốt 401 ở `lib/api.ts`.** Bộ đếm giờ không đáng tin một mình: trình duyệt
 * bóp `setInterval` ở tab nền xuống còn một lần mỗi phút hoặc hơn, và máy ngủ thì nó đứng hẳn.
 * Hai lớp bù nhau — lớp này giữ cho phiên không bao giờ chạm hạn trong lúc đang dùng, lớp kia
 * cứu những lần lớp này lỡ nhịp.
 */
import { useEffect, useRef } from 'react';

import { ADMIN, CUSTOMER, api } from '@/lib/api';

/**
 * Chu kỳ làm mới. Đặt 20 phút cho token 30 phút: sớm hơn hạn 10 phút, đủ chỗ cho một lần lỡ
 * nhịp và cho máy có đồng hồ lệch.
 *
 * Con số 30 phút nằm ở backend (`settings.access_token_minutes`) và không có đường nào để phía
 * trình duyệt đọc được, nên đây là bản sao thủ công. Hạ hạn token xuống dưới 20 phút mà quên
 * sửa chỗ này thì phiên vẫn không đứt — chốt 401 ở `lib/api.ts` đỡ lấy — nhưng mỗi lần đỡ là
 * một lượt gọi hỏng rồi gọi lại, nên hai con số vẫn nên đi cùng nhau.
 */
const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

/**
 * Quay lại tab sau khoảng này thì làm mới ngay, không đợi hết chu kỳ. Đặt 5 phút vì đây là
 * trường hợp máy vừa ngủ dậy: bộ đếm giờ đã đứng, và thứ duy nhất biết được là khoảng cách
 * giữa hai mốc thời gian thật.
 */
const REFRESH_ON_RETURN_AFTER_MS = 5 * 60 * 1000;

export function useTokenRefresh(area: 'customer' | 'admin', enabled: boolean): void {
  const lastRefreshRef = useRef(Date.now());

  useEffect(() => {
    if (!enabled) return;

    const endpoint = `${area === 'admin' ? ADMIN : CUSTOMER}/auth/refresh`;
    lastRefreshRef.current = Date.now();

    const refresh = async () => {
      try {
        await api.post(endpoint);
        lastRefreshRef.current = Date.now();
      } catch {
        // Phiên đã kết thúc thật (refresh token hết hạn, hoặc bị thu hồi từ máy khác). Không
        // đăng xuất ở đây: lượt gọi API kế tiếp nhận 401 và `SessionProvider` xử lý một chỗ.
      }
    };

    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRefreshRef.current >= REFRESH_ON_RETURN_AFTER_MS) void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [area, enabled]);
}
