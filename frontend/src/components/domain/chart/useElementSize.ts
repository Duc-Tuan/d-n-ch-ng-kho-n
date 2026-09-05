'use client';

/**
 * Kích thước thật của một phần tử, theo dõi bằng `ResizeObserver`.
 *
 * Biểu đồ cần con số này chứ không chỉ cần sự kiện `resize` của cửa sổ: khung biểu đồ còn co
 * giãn khi cột bảng giá bên trái đổi bề rộng, khi mở/đóng một cửa sổ chỉ báo, hay khi thanh
 * cuộn xuất hiện — những lúc đó cửa sổ trình duyệt không đổi kích thước chút nào.
 */
import { useEffect, useState, type RefObject } from 'react';

export function useElementSize<T extends HTMLElement>(ref: RefObject<T | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
