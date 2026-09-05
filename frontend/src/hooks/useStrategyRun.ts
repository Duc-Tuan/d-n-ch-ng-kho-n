'use client';

/**
 * Chạy chiến lược lên một mã và lấy kèm dữ liệu nến để vẽ (YC12).
 *
 * Dùng chung cho cả site khách hàng và site quản trị. Điểm khác nhau duy nhất giữa hai bên là
 * đường dẫn API, nên hook nhận `endpoint` thay vì tự đoán — chỗ gọi biết rõ mình đang ở site nào.
 *
 * Hai lời gọi (chạy chiến lược, tải nến) chạy song song: chúng độc lập với nhau, gọi tuần tự chỉ
 * làm người dùng chờ lâu gấp đôi.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/lib/api';
import type { ApiError } from '@/lib/api';
import type { Candle, OhlcvResponse, StrategyRunResult } from '@/types';

/** Đủ để nhìn thấy bối cảnh quanh các điểm mua bán mà không kéo về hàng nghìn nến. */
const CHART_BARS = 500;

/**
 * @param ohlcvEndpoint Đường dẫn API nến **của site đang gọi** — `/customer/market/ohlcv` hoặc
 *   `/admin/market/ohlcv`. Bắt buộc truyền, không có mặc định: hai site đọc hai cookie khác
 *   nhau, nên đoán sai không phải là hiển thị thiếu mà là 401 làm hỏng cả lần chạy.
 */
export function useStrategyRun(ohlcvEndpoint: string) {
  const [result, setResult] = useState<StrategyRunResult | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Người dùng bấm chạy nhiều mã liên tiếp — chỉ kết quả của lần bấm cuối được nhận.
  const requestId = useRef(0);

  const run = useCallback(
    async (
      endpoint: string,
      symbol: string,
      options?: { body?: unknown; params?: Record<string, unknown> },
    ) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);

      try {
        // Nến chỉ để vẽ nền cho các điểm mua bán. Thiếu nến thì biểu đồ tự báo "chưa có dữ
        // liệu giá"; để nó kéo đổ cả lần chạy là biến một thiếu sót hiển thị thành lỗi chặn.
        const [runResult, ohlcv] = await Promise.all([
          api.post<StrategyRunResult>(endpoint, options?.body, {
            symbol,
            ...options?.params,
          }),
          api
            .get<OhlcvResponse>(ohlcvEndpoint, { symbol, limit: CHART_BARS })
            .catch(() => null),
        ]);

        if (id !== requestId.current) return null;
        setResult(runResult);
        setCandles(ohlcv?.candles ?? []);
        return runResult;
      } catch (err) {
        if (id !== requestId.current) return null;
        const apiError = err as ApiError;
        setError(apiError?.message ?? 'Không chạy được chiến lược');
        setResult(null);
        setCandles([]);
        return null;
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [ohlcvEndpoint],
  );

  const reset = useCallback(() => {
    // Tăng id để kết quả của lần chạy đang bay về không ghi đè lên trạng thái đã xoá.
    requestId.current += 1;
    setResult(null);
    setCandles([]);
    setError(null);
    setLoading(false);
  }, []);

  // Trả luôn endpoint ra ngoài để biểu đồ tải thêm lịch sử đúng site mà không phải khai lại.
  return { result, candles, loading, error, run, reset, ohlcvEndpoint };
}

/** Danh mục chỉ báo/toán tử — tải một lần rồi giữ lại, nội dung gần như không đổi. */
export function useRuleCatalog(endpoint: string) {
  const [catalog, setCatalog] = useState<import('@/types').RuleCatalog | null>(null);

  useEffect(() => {
    let active = true;
    api
      .get<import('@/types').RuleCatalog>(endpoint)
      .then((data) => {
        if (active) setCatalog(data);
      })
      .catch(() => {
        /* Không có danh mục thì màn dựng bộ lọc tự hiển thị trạng thái đang tải. */
      });
    return () => {
      active = false;
    };
  }, [endpoint]);

  return catalog;
}
