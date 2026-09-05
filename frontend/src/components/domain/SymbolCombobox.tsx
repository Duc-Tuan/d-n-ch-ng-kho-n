'use client';

/**
 * Chọn **một** mã cổ phiếu, có ô tìm kiếm ngay trong danh sách.
 *
 * Hai chế độ:
 * - Mặc định: tìm trong toàn bộ danh mục niêm yết qua API — YC12 yêu cầu chạy được lên *mã bất
 *   kỳ*, nên không giới hạn trong phạm vi mã của chiến lược.
 * - Truyền `options`: chỉ chọn trong danh sách cho sẵn (ví dụ phạm vi mã của một chiến lược) và
 *   lọc ngay tại chỗ, không gọi API.
 *
 * Khác `SymbolPicker` (chọn nhiều mã cho phạm vi chiến lược). Dùng chung cho cả hai site.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Field, Icon, SearchInput, Spinner } from '@/components/ui';
import { useApiQuery, useClickOutside } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { SymbolInfo } from '@/types';

type Choice = { symbol: string; subtitle: string | null; exchange: string | null };

export function SymbolCombobox({
  value,
  onChange,
  label = 'Mã cổ phiếu',
  hint,
  disabled,
  className,
  options,
}: {
  value: string;
  onChange: (symbol: string) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
  /** Giới hạn trong danh sách này và lọc tại chỗ thay vì tìm trên toàn danh mục. */
  options?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const closeRef = useRef(() => setOpen(false));
  closeRef.current = () => setOpen(false);

  const containerRef = useClickOutside<HTMLDivElement>(() => closeRef.current());

  const isLocal = options !== undefined;

  // Chỉ gọi API khi danh sách đang mở — mỗi màn có ô này không nên tự tải dữ liệu lúc chưa dùng.
  const { data: symbols, isLoading } = useApiQuery<SymbolInfo[]>(
    open && !isLocal ? `${CUSTOMER}/market/symbols` : null,
    { q: search.trim(), limit: 40 },
  );

  const choices: Choice[] = useMemo(() => {
    if (isLocal) {
      const keyword = search.trim().toUpperCase();
      return (options ?? [])
        .filter((s) => s.toUpperCase().includes(keyword))
        .map((s) => ({ symbol: s, subtitle: null, exchange: null }));
    }
    return (symbols ?? []).map((item) => ({
      symbol: item.symbol,
      subtitle: item.company_name ?? item.exchange,
      exchange: item.exchange,
    }));
  }, [isLocal, options, search, symbols]);

  // Mở ra thì bắt đầu lại từ danh sách đầy đủ thay vì giữ từ khoá lần trước.
  useEffect(() => {
    if (open) setSearch('');
  }, [open]);

  return (
    <Field label={label} hint={hint}>
      <div ref={containerRef} className={cn('relative', className)}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'flex h-touch w-full items-center justify-between gap-2 rounded-lg border border-ink-300',
            'bg-surface px-3 text-left text-sm transition-colors',
            'hover:border-ink-400 focus:outline-none',
            disabled && 'cursor-not-allowed bg-ink-50 text-ink-400',
          )}
        >
          <span className={cn('font-medium', value ? 'text-ink-900' : 'text-ink-400')}>
            {value || 'Chọn mã…'}
          </span>
          <Icon name="chevron-down" size={16} className="shrink-0 text-ink-400" />
        </button>

        {open && (
          <div className="absolute left-0 right-0 top-full z-30 mt-1 min-w-[14rem] rounded-lg border border-line bg-surface-raised shadow-pop">
            <div className="border-b border-ink-100 p-2">
              <SearchInput
                autoFocus
                placeholder={isLocal ? 'Tìm mã…' : 'Tìm mã hoặc tên công ty…'}
                value={search}
                // Lọc tại chỗ thì không có request nào để gộp, chờ 300ms chỉ làm ô gõ có cảm giác chậm.
                delay={isLocal ? 0 : 300}
                onSearch={setSearch}
              />
            </div>

            <div className="max-h-72 overflow-y-auto overscroll-contain p-1">
              {isLoading ? (
                <div className="py-6">
                  <Spinner label="Đang tìm…" />
                </div>
              ) : !choices.length ? (
                <p className="px-3 py-6 text-center text-sm text-ink-500">
                  Không tìm thấy mã nào khớp.
                </p>
              ) : (
                choices.map((item) => (
                  <button
                    key={item.symbol}
                    type="button"
                    onClick={() => {
                      onChange(item.symbol);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left',
                      'transition-colors hover:bg-ink-50',
                      value === item.symbol && 'bg-ink-100',
                    )}
                  >
                    <span>
                      <span className="block text-sm font-semibold text-ink-900">{item.symbol}</span>
                      {item.subtitle && (
                        <span className="block max-w-[16rem] truncate text-xs text-ink-500">
                          {item.subtitle}
                        </span>
                      )}
                    </span>
                    {item.exchange && (
                      <span className="shrink-0 text-xs text-ink-400">{item.exchange}</span>
                    )}
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </Field>
  );
}
