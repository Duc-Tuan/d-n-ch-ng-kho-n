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
 * Truyền `assetTabs` thì có thêm hàng tab **Chứng khoán · Phái sinh** ngay trong danh sách, để
 * duyệt hợp đồng phái sinh mà không phải nhớ mã rồi gõ ra.
 *
 * Khác `SymbolPicker` (chọn nhiều mã cho phạm vi chiến lược). Dùng chung cho cả hai site.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { Field, Icon, SearchInput, Spinner } from '@/components/ui';
import { useApiQuery, useClickOutside } from '@/hooks';
import { CUSTOMER } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { AssetClass, SymbolInfo } from '@/types';

type Choice = {
  symbol: string;
  subtitle: string | null;
  exchange: string | null;
  /** Bản ghi đầy đủ từ máy chủ — để báo cho màn cha biết mã vừa chọn thuộc loại nào. */
  info?: SymbolInfo;
};

const ASSET_TABS: Array<{ key: AssetClass; label: string }> = [
  { key: 'STOCK', label: 'Chứng khoán' },
  { key: 'DERIVATIVE', label: 'Phái sinh' },
];

export function SymbolCombobox({
  value,
  onChange,
  label = 'Mã cổ phiếu',
  hint,
  disabled,
  className,
  options,
  assetTabs = false,
  assetClass,
}: {
  value: string;
  /**
   * Mã vừa chọn, kèm bản ghi đầy đủ khi có (chế độ `options` lọc tại chỗ thì không có).
   *
   * Tham số thứ hai để màn cha đi theo mã vừa chọn — bảng giá cần biết vừa nhảy sang phái sinh
   * để đổi tab của chính nó, nếu không thì thoát khỏi biểu đồ ra là thấy một bảng cổ phiếu
   * đứng cạnh một biểu đồ hợp đồng.
   */
  onChange: (symbol: string, info?: SymbolInfo) => void;
  label?: string;
  hint?: string;
  disabled?: boolean;
  className?: string;
  /** Giới hạn trong danh sách này và lọc tại chỗ thay vì tìm trên toàn danh mục. */
  options?: string[];
  /** Hiện hàng tab Chứng khoán · Phái sinh trong danh sách. Không dùng ở chế độ `options`. */
  assetTabs?: boolean;
  /** Loại tài sản của mã đang chọn — tab mở đúng chỗ người dùng đang đứng. */
  assetClass?: AssetClass;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState<AssetClass>(assetClass ?? 'STOCK');
  const closeRef = useRef(() => setOpen(false));
  closeRef.current = () => setOpen(false);

  const containerRef = useClickOutside<HTMLDivElement>(() => closeRef.current());

  const isLocal = options !== undefined;
  const searching = search.trim().length > 0;
  /** Hàng tab chỉ có nghĩa khi đang duyệt danh mục đầy đủ — xem phần ẩn nó lúc tìm kiếm bên dưới. */
  const showTabs = assetTabs && !isLocal && !searching;

  // Chỉ gọi API khi danh sách đang mở — mỗi màn có ô này không nên tự tải dữ liệu lúc chưa dùng.
  const { data: symbols, isLoading } = useApiQuery<SymbolInfo[]>(
    open && !isLocal ? `${CUSTOMER}/market/symbols` : null,
    { q: search.trim(), limit: 40, asset_class: showTabs ? tab : undefined },
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
      info: item,
    }));
  }, [isLocal, options, search, symbols]);

  // Mở ra thì bắt đầu lại từ danh sách đầy đủ thay vì giữ từ khoá lần trước, và về đúng tab của
  // mã đang xem — mở ô chọn mã của một hợp đồng phái sinh mà thấy danh sách cổ phiếu là nói sai.
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setTab(assetClass ?? 'STOCK');
  }, [open, assetClass]);

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
            <div className="space-y-2 border-b border-ink-100 p-2">
              <SearchInput
                autoFocus
                placeholder={isLocal ? 'Tìm mã…' : 'Tìm mã hoặc tên công ty…'}
                value={search}
                // Lọc tại chỗ thì không có request nào để gộp, chờ 300ms chỉ làm ô gõ có cảm giác chậm.
                delay={isLocal ? 0 : 300}
                onSearch={setSearch}
              />

              {/* Ẩn hàng tab khi đang gõ, đúng như bảng giá làm: ô tìm kiếm cố ý **không** lọc
                  theo tab — người gõ "VN30" khi đang đứng ở tab Chứng khoán vẫn phải thấy hợp
                  đồng phái sinh — nên để một tab sáng lên trong lúc danh sách không hề lọc theo
                  nó là nói sai với người đọc. */}
              {showTabs && (
                <div className="flex gap-1.5" role="group" aria-label="Loại tài sản">
                  {ASSET_TABS.map((item) => {
                    const active = tab === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        aria-pressed={active}
                        onClick={() => setTab(item.key)}
                        className={cn(
                          'flex-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors',
                          active
                            ? 'border-brand bg-brand-soft text-brand'
                            : 'border-line text-ink-500 hover:border-line-strong hover:text-ink-800',
                        )}
                      >
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* `overflow-x-hidden` không thừa: theo CSS, một trục để `auto` thì trục kia đang
                `visible` tự chuyển thành `auto` — tức là chỉ khai báo cuộn dọc thôi cũng đủ để
                có thanh cuộn ngang ngay khi một dòng nào đó rộng hơn menu. Ở đây menu hẹp nhất
                lúc biểu đồ phóng to kín màn hình, và đó chính là lúc nó lộ ra. */}
            <div className="max-h-72 overflow-y-auto overflow-x-hidden overscroll-contain p-1">
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
                      onChange(item.symbol, item.info);
                      setOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left',
                      'transition-colors hover:bg-ink-50',
                      value === item.symbol && 'bg-ink-100',
                    )}
                  >
                    {/* `min-w-0` là thứ cho phép ô này co lại: mặc định một ô flex không bao
                        giờ hẹp hơn nội dung của nó, nên `truncate` bên trong không có tác dụng
                        và cả dòng đẩy rộng ra ngoài menu. Cắt theo bề ngang thật của menu chứ
                        không theo một mốc cố định — menu rộng bao nhiêu là tuỳ chỗ đặt ô chọn
                        mã, hẹp nhất là trên thanh công cụ của biểu đồ phóng to. */}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-ink-900">
                        {item.symbol}
                      </span>
                      {item.subtitle && (
                        <span className="block truncate text-xs text-ink-500">
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
