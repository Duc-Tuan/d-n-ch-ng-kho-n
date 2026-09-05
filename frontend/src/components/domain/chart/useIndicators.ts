'use client';

/**
 * Danh sách chỉ báo người dùng đang bật, kèm tham số riêng của từng cái.
 *
 * Lưu vào `localStorage` chứ không vào máy chủ: đây là tuỳ chọn xem của một người trên một máy,
 * không phải dữ liệu nghiệp vụ. Đổi mã thì **giữ nguyên** danh sách — người theo EMA 20/50 muốn
 * thấy đúng bộ đó trên mọi mã, bắt họ dựng lại sau mỗi lần bấm sang mã khác là vô lý.
 *
 * Đọc `localStorage` sau khi gắn vào DOM chứ không lúc khởi tạo state: lần render đầu chạy cả
 * trên máy chủ (Next.js) và ở đó không có `localStorage`, lệch nội dung giữa hai lần render là
 * lỗi hydrate.
 *
 * Cờ "đã đọc xong" phải là state chứ không phải ref: hai hiệu ứng dưới đây chạy nối nhau trong
 * cùng một lượt, nên một cái ref bật lên ở hiệu ứng đọc sẽ cho hiệu ứng ghi chạy ngay khi danh
 * sách còn rỗng và ghi đè bản đã lưu bằng `[]`. Ở chế độ nghiêm ngặt (dev) React chạy hiệu ứng
 * hai lần, lần đọc thứ hai gặp đúng ô trống vừa bị ghi đè — mất sạch chỉ báo sau mỗi lần F5.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { createInstance, getIndicator } from '@/lib/indicators/registry';
import type { IndicatorInstance, ParamValues, PlotDef } from '@/lib/indicators/types';

const STORAGE_KEY = 'stock.chart.indicators.v1';

/**
 * Mỗi cửa sổ chỉ báo là một biểu đồ riêng xếp dưới biểu đồ giá. Quá ba cái thì phần nến còn
 * lại quá ít để đọc — giới hạn ở đây thay vì để người dùng tự phát hiện ra điều đó.
 */
export const MAX_PANE_INDICATORS = 3;

function load(): IndicatorInstance[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Bỏ qua chỉ báo không còn trong danh mục: bản lưu cũ có thể trỏ tới `defId` đã gỡ, và
    // một mục hỏng không được phép làm hỏng cả danh sách.
    return (parsed as IndicatorInstance[]).filter((item) => item?.defId && getIndicator(item.defId));
  } catch {
    return [];
  }
}

export interface IndicatorStore {
  indicators: IndicatorInstance[];
  /** Chỉ báo vẽ đè lên nến. */
  overlays: IndicatorInstance[];
  /** Chỉ báo có cửa sổ riêng bên dưới. */
  panes: IndicatorInstance[];
  add: (defId: string) => boolean;
  remove: (instanceId: string) => void;
  removeByDef: (defId: string) => void;
  toggleVisible: (instanceId: string) => void;
  setParams: (instanceId: string, params: ParamValues) => void;
  setStyle: (instanceId: string, plotKey: string, style: Partial<PlotDef>) => void;
  clear: () => void;
}

export function useIndicators(): IndicatorStore {
  const [indicators, setIndicators] = useState<IndicatorInstance[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setIndicators(load());
    setHydrated(true);
  }, []);

  useEffect(() => {
    // Chỉ ghi khi state đã mang nội dung đọc từ bản lưu; trước đó nó còn rỗng và ghi ra sẽ
    // xoá mất bản lưu.
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(indicators));
    } catch {
      // Chế độ riêng tư hoặc hết dung lượng — chỉ mất phần ghi nhớ, biểu đồ vẫn chạy.
    }
  }, [hydrated, indicators]);

  const panes = useMemo(
    () => indicators.filter((item) => getIndicator(item.defId)?.placement === 'pane'),
    [indicators],
  );
  const overlays = useMemo(
    () => indicators.filter((item) => getIndicator(item.defId)?.placement === 'overlay'),
    [indicators],
  );

  const add = useCallback(
    (defId: string) => {
      const def = getIndicator(defId);
      if (!def) return false;
      if (def.placement === 'pane' && panes.length >= MAX_PANE_INDICATORS) return false;
      setIndicators((current) => [...current, createInstance(defId)]);
      return true;
    },
    [panes.length],
  );

  const remove = useCallback((instanceId: string) => {
    setIndicators((current) => current.filter((item) => item.instanceId !== instanceId));
  }, []);

  const removeByDef = useCallback((defId: string) => {
    setIndicators((current) => current.filter((item) => item.defId !== defId));
  }, []);

  const toggleVisible = useCallback((instanceId: string) => {
    setIndicators((current) =>
      current.map((item) =>
        item.instanceId === instanceId ? { ...item, visible: !item.visible } : item,
      ),
    );
  }, []);

  const setParams = useCallback((instanceId: string, params: ParamValues) => {
    setIndicators((current) =>
      current.map((item) => (item.instanceId === instanceId ? { ...item, params } : item)),
    );
  }, []);

  const setStyle = useCallback((instanceId: string, plotKey: string, style: Partial<PlotDef>) => {
    setIndicators((current) =>
      current.map((item) =>
        item.instanceId === instanceId
          ? {
              ...item,
              styleOverrides: {
                ...item.styleOverrides,
                [plotKey]: { ...item.styleOverrides[plotKey], ...style },
              },
            }
          : item,
      ),
    );
  }, []);

  const clear = useCallback(() => setIndicators([]), []);

  return { indicators, overlays, panes, add, remove, removeByDef, toggleVisible, setParams, setStyle, clear };
}
