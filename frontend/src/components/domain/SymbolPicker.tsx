'use client';

/**
 * Chọn mã cổ phiếu từ toàn bộ danh mục niêm yết (hơn 1.500 mã).
 *
 * Không dùng thẻ `<select>` vì danh sách quá dài để cuộn tay, cũng không dùng ô nhập text vì
 * người dùng phải nhớ chính xác mã và dễ gõ sai. Thay bằng ô tìm kiếm có gợi ý, mã đã chọn
 * hiển thị dạng thẻ bấm để gỡ.
 *
 * Các nút chọn hàng loạt lấy dữ liệu từ `/market/symbols/codes` chứ không từ `/market/symbols`:
 * endpoint tra cứu có trần 500 dòng, mà UPCOM một mình đã gần chín trăm mã — dùng nhầm endpoint
 * thì người dùng bấm "toàn bộ sàn" và lặng lẽ nhận thiếu, không có gì báo.
 */
import { useRef, useState } from 'react';

import { Alert, Button, Field, Icon, SearchInput, Spinner } from '@/components/ui';
import { useApiQuery, useToast } from '@/hooks';
import { CUSTOMER, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { SymbolInfo } from '@/types';

const EXCHANGES = ['HOSE', 'HNX', 'UPCOM'] as const;

/** Mã hợp lệ theo quy ước sàn Việt Nam: chữ và số, 3–20 ký tự. */
const SYMBOL_PATTERN = /^[A-Z0-9]{3,20}$/;

/** Chặn người dùng thả nhầm file vài trăm MB vào ô chọn mã. */
const MAX_UPLOAD_BYTES = 1024 * 1024;

/** Kết quả đọc file, hiển thị lại cho người dùng thay vì im lặng bỏ qua phần không nhận ra. */
type UploadReport = {
  fileName: string;
  added: number;
  already: number;
  unknown: string[];
};

export function SymbolPicker({
  value,
  onChange,
  label = 'Mã cổ phiếu áp dụng',
  error,
  max = 50,
  extraActions,
  showExchangeBulk = false,
  showSelectAll = false,
  showUpload = false,
}: {
  value: string[];
  onChange: (symbols: string[]) => void;
  label?: string;
  error?: string;
  max?: number;
  /** Nút bổ sung đặt cạnh thanh công cụ (ví dụ Khôi phục, Bỏ chọn tất cả). */
  extraActions?: React.ReactNode;
  /** Cho phép thêm nhanh toàn bộ mã của một sàn. */
  showExchangeBulk?: boolean;
  /** Cho phép chọn toàn bộ danh mục đang theo dõi của hệ thống. */
  showSelectAll?: boolean;
  /** Cho phép nạp danh sách mã từ file .txt/.csv. */
  showUpload?: boolean;
}) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [bulkLoading, setBulkLoading] = useState<string | null>(null);
  const [report, setReport] = useState<UploadReport | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const { data: results, isLoading } = useApiQuery<SymbolInfo[]>(
    query.length >= 1 ? `${CUSTOMER}/market/symbols` : null,
    { q: query, limit: 30 },
  );

  function toggle(symbol: string) {
    if (value.includes(symbol)) {
      onChange(value.filter((s) => s !== symbol));
    } else if (value.length < max) {
      onChange([...value, symbol]);
    } else {
      toast.warning(`Tối đa ${max} mã cho một chiến lược`);
    }
  }

  /** Gộp thêm một mẻ mã vào danh sách đang chọn. Trả về số mã thực sự được thêm. */
  function merge(codes: string[], sourceLabel: string): number {
    const merged = Array.from(new Set([...value, ...codes]));
    const capped = merged.slice(0, max);
    if (merged.length > max) {
      toast.warning(
        `${sourceLabel} vượt giới hạn ${max} mã. Đã thêm tới mức tối đa, phần còn lại bị bỏ qua.`,
      );
    }
    onChange(capped);
    return capped.length - value.length;
  }

  async function fetchCodes(exchange?: string): Promise<string[]> {
    return api.get<string[]>(
      `${CUSTOMER}/market/symbols/codes`,
      exchange ? { exchange } : undefined,
    );
  }

  /** Thêm toàn bộ mã của một sàn — tiện khi chiến lược áp cho cả sàn thay vì vài mã lẻ. */
  async function addExchange(exchange: string) {
    setBulkLoading(exchange);
    try {
      const added = merge(await fetchCodes(exchange), `Sàn ${exchange}`);
      toast.success(added > 0 ? `Đã thêm ${added} mã sàn ${exchange}` : `Sàn ${exchange} đã có đủ`);
    } catch {
      toast.error(`Không tải được danh sách mã sàn ${exchange}`);
    } finally {
      setBulkLoading(null);
    }
  }

  /** Chọn toàn bộ danh mục đang theo dõi của hệ thống. */
  async function addAll() {
    setBulkLoading('__ALL__');
    try {
      const codes = await fetchCodes();
      const added = merge(codes, 'Toàn bộ danh mục');
      toast.success(
        added > 0
          ? `Đã thêm ${added} mã, tổng cộng ${Math.min(codes.length, max)} mã`
          : 'Đã chọn sẵn toàn bộ danh mục',
      );
    } catch {
      toast.error('Không tải được danh mục mã của hệ thống');
    } finally {
      setBulkLoading(null);
    }
  }

  /**
   * Nạp danh sách mã từ file.
   *
   * Đối chiếu với danh mục của hệ thống rồi **báo lại phần không nhận ra** thay vì lặng lẽ bỏ.
   * File danh sách mã hầu như luôn được chép tay từ Excel, nên sai vài dòng là chuyện bình
   * thường — nhưng người dán file vào cần biết mình vừa mất những mã nào.
   */
  async function handleFile(file: File) {
    setReport(null);

    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('File quá lớn (giới hạn 1MB). Danh sách mã chỉ cần file văn bản thuần.');
      return;
    }

    setBulkLoading('__FILE__');
    try {
      const text = await file.text();
      // Tách trên mọi ký tự không phải chữ/số: nhận được cả CSV, TSV, mỗi dòng một mã,
      // hay danh sách phân tách bằng dấu phẩy — không bắt người dùng chuẩn hoá trước.
      const tokens = Array.from(
        new Set(
          text
            .toUpperCase()
            .split(/[^A-Z0-9]+/)
            .filter((t) => SYMBOL_PATTERN.test(t)),
        ),
      );

      if (!tokens.length) {
        toast.error('Không tìm thấy mã nào trong file');
        return;
      }

      const known = new Set(await fetchCodes());
      const valid = tokens.filter((t) => known.has(t));
      const unknown = tokens.filter((t) => !known.has(t));
      const already = valid.filter((t) => value.includes(t)).length;

      const added = valid.length ? merge(valid, `File ${file.name}`) : 0;
      setReport({ fileName: file.name, added, already, unknown });

      if (!valid.length) {
        toast.error('Không mã nào trong file khớp danh mục của hệ thống');
      } else {
        toast.success(`Đã thêm ${added} mã từ ${file.name}`);
      }
    } catch {
      toast.error('Không đọc được file');
    } finally {
      setBulkLoading(null);
    }
  }

  const showToolbar = showExchangeBulk || showSelectAll || showUpload || extraActions;

  return (
    <Field label={label} error={error} required hint={`Đã chọn ${value.length}/${max} mã`}>
      <div className="space-y-2.5">
        <div className="relative">
          <SearchInput
            value={query}
            onSearch={setQuery}
            placeholder="Gõ mã hoặc tên công ty, ví dụ HPG hoặc Hòa Phát…"
          />

          {query && (
            <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto overscroll-contain rounded-lg border border-ink-200 bg-surface shadow-pop">
              {isLoading ? (
                <div className="p-4">
                  <Spinner />
                </div>
              ) : !results?.length ? (
                <p className="p-4 text-center text-sm text-ink-500">Không tìm thấy mã nào</p>
              ) : (
                <>
                  <div className="flex items-center justify-between border-b border-ink-100 px-3 py-1.5">
                    <span className="text-xs text-ink-500">{results.length} kết quả</span>
                    <button
                      type="button"
                      onClick={() => merge(results.map((r) => r.symbol), 'Kết quả tìm kiếm')}
                      className="text-xs font-medium text-ink-900 hover:underline"
                    >
                      Chọn tất cả kết quả
                    </button>
                  </div>
                  <ul>
                    {results.map((item) => {
                      const selected = value.includes(item.symbol);
                      return (
                        <li key={item.symbol}>
                          <button
                            type="button"
                            onClick={() => toggle(item.symbol)}
                            className={cn(
                              'flex min-h-touch w-full items-center justify-between gap-3 px-3 text-left transition-colors',
                              selected ? 'bg-ink-100' : 'hover:bg-ink-50',
                            )}
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-semibold text-ink-900">
                                {item.symbol}
                                <span className="ml-2 text-xs font-normal text-ink-400">
                                  {item.exchange}
                                </span>
                              </span>
                              <span className="block truncate text-xs text-ink-500">
                                {item.company_name}
                              </span>
                            </span>
                            {selected && <Icon name="check" size={16} className="text-ink-900" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {/* Thanh công cụ chọn hàng loạt. */}
        {showToolbar && (
          <div className="flex flex-wrap items-center gap-1.5">
            {showSelectAll && (
              <Button
                size="sm"
                variant="outline"
                loading={bulkLoading === '__ALL__'}
                onClick={addAll}
              >
                + Toàn bộ danh mục
              </Button>
            )}
            {showExchangeBulk &&
              EXCHANGES.map((exchange) => (
                <Button
                  key={exchange}
                  size="sm"
                  variant="outline"
                  loading={bulkLoading === exchange}
                  onClick={() => addExchange(exchange)}
                >
                  + Toàn bộ {exchange}
                </Button>
              ))}
            {showUpload && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  loading={bulkLoading === '__FILE__'}
                  leftIcon={<Icon name="upload" size={15} />}
                  onClick={() => fileInput.current?.click()}
                >
                  Tải từ file
                </Button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".txt,.csv,.tsv,text/plain,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    // Xoá giá trị để chọn lại đúng file vừa rồi vẫn kích hoạt onChange.
                    e.target.value = '';
                    if (file) void handleFile(file);
                  }}
                />
              </>
            )}
            {extraActions}
          </div>
        )}

        {report && (
          <Alert
            tone={report.unknown.length ? 'warning' : 'success'}
            title={`Đã đọc ${report.fileName}`}
            action={
              <Button size="sm" variant="ghost" onClick={() => setReport(null)}>
                Đóng
              </Button>
            }
          >
            <p>
              Thêm mới <strong>{report.added}</strong> mã
              {report.already > 0 && ` · ${report.already} mã đã có sẵn trong danh sách`}
            </p>
            {report.unknown.length > 0 && (
              <p className="mt-1">
                <strong>{report.unknown.length} mã không có trong danh mục hệ thống</strong> nên bị
                bỏ qua: {report.unknown.slice(0, 15).join(', ')}
                {report.unknown.length > 15 && `, …và ${report.unknown.length - 15} mã khác`}. Thêm
                chúng ở <em>Dữ liệu thị trường → Danh mục mã</em> rồi tải lại file.
              </p>
            )}
          </Alert>
        )}

        {value.length > 0 ? (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-200 bg-ink-50/60 p-2">
            <div className="flex flex-wrap gap-1.5">
              {value.map((symbol) => (
                <button
                  key={symbol}
                  type="button"
                  onClick={() => toggle(symbol)}
                  title={`Bỏ chọn ${symbol}`}
                  className="inline-flex items-center gap-1 rounded-full bg-primary py-1 pl-2.5 pr-1.5 text-xs font-medium text-primary-fg transition-opacity hover:opacity-80"
                >
                  {symbol}
                  <Icon name="close" size={13} />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-ink-300 px-3 py-4 text-center text-sm text-ink-500">
            Chưa chọn mã nào
          </p>
        )}

        {value.length >= max && (
          <p className="text-xs text-tone-amber-fg">Đã đạt giới hạn {max} mã.</p>
        )}
      </div>
    </Field>
  );
}
