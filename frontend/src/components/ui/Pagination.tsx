'use client';

import { cn } from '@/lib/cn';
import { formatNumber } from '@/lib/format';
import { Button } from './Button';

const PAGE_SIZES = [10, 20, 30, 50, 100];

export function Pagination({
  page,
  pages,
  total,
  size,
  onPageChange,
  onSizeChange,
  className,
}: {
  page: number;
  pages: number;
  total: number;
  size: number;
  onPageChange: (page: number) => void;
  /** Cho phép đổi số bản ghi mỗi trang. Bỏ trống thì không hiện ô chọn. */
  onSizeChange?: (size: number) => void;
  className?: string;
}) {
  // Không có bản ghi nào thì màn đã hiện trạng thái rỗng riêng, thêm thanh này chỉ gây nhiễu.
  if (total <= 0) return null;

  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const hasPages = pages > 1;

  // Hiển thị tối đa 5 số trang quanh trang hiện tại — đủ dùng, không tràn trên mobile.
  const windowSize = 5;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  const end = Math.min(pages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const numbers = Array.from({ length: end - start + 1 }, (_, i) => start + i);

  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 py-3 sm:flex-row sm:justify-between',
        className,
      )}
    >
      <div className="flex items-center gap-3 text-sm text-ink-500">
        <p>
          Hiển thị {formatNumber(from)}–{formatNumber(to)} trên {formatNumber(total)}
        </p>
        {onSizeChange && (
          <label className="flex items-center gap-1.5 border-l border-ink-200 pl-3 text-xs">
            <span className="text-ink-400">Số dòng</span>
            <select
              value={size}
              onChange={(e) => onSizeChange(Number(e.target.value))}
              className="h-7 rounded-md border border-ink-200 bg-surface px-1.5 text-xs text-ink-800"
            >
              {PAGE_SIZES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {/*
        Chỉ ẩn dãy số trang khi vừa đúng một trang — dòng "Hiển thị x–y trên z" vẫn giữ.
        Ẩn cả thanh như trước khiến màn hình trông như **chưa có phân trang**: người dùng không
        phân biệt được "danh sách chỉ có ngần này" với "phân trang chưa làm".
      */}
      {hasPages && (
      <nav className="flex items-center gap-1" aria-label="Phân trang">
        <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          ‹
        </Button>
        {start > 1 && (
          <>
            <Button size="sm" variant="ghost" onClick={() => onPageChange(1)}>
              1
            </Button>
            {start > 2 && <span className="px-1 text-ink-400">…</span>}
          </>
        )}
        {numbers.map((n) => (
          <Button
            key={n}
            size="sm"
            variant={n === page ? 'primary' : 'ghost'}
            onClick={() => onPageChange(n)}
            aria-current={n === page ? 'page' : undefined}
          >
            {n}
          </Button>
        ))}
        {end < pages && (
          <>
            {end < pages - 1 && <span className="px-1 text-ink-400">…</span>}
            <Button size="sm" variant="ghost" onClick={() => onPageChange(pages)}>
              {pages}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
        >
          ›
        </Button>
      </nav>
      )}
    </div>
  );
}
