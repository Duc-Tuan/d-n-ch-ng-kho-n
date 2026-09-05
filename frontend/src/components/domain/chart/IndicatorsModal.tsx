'use client';

/**
 * Danh mục chỉ báo — chọn cái nào hiện trên biểu đồ.
 *
 * Bấm vào một chỉ báo đang bật sẽ **gỡ nó đi** (kể cả khi đã thêm hai lần với hai chu kỳ khác
 * nhau): danh sách này trả lời câu hỏi "có hay không", còn việc chỉnh từng bản thì làm ở nhãn
 * ngay trên biểu đồ, chỗ người dùng nhìn thấy kết quả.
 */
import { useMemo, useState } from 'react';

import { Alert, Badge, Icon, Input, Modal, Tabs } from '@/components/ui';
import { useDebounced } from '@/hooks';
import { cn } from '@/lib/cn';
import { CATEGORY_LABELS, searchIndicators } from '@/lib/indicators/registry';
import type { IndicatorDef, IndicatorInstance } from '@/lib/indicators/types';

import { MAX_PANE_INDICATORS } from './useIndicators';

type Category = IndicatorDef['category'] | 'all' | 'active';

const TABS: { key: Category; label: string }[] = [
  { key: 'all', label: 'Tất cả' },
  { key: 'active', label: 'Đang dùng' },
  { key: 'trend', label: CATEGORY_LABELS.trend },
  { key: 'momentum', label: CATEGORY_LABELS.momentum },
  { key: 'volatility', label: CATEGORY_LABELS.volatility },
  { key: 'volume', label: CATEGORY_LABELS.volume },
];

export function IndicatorsModal({
  open,
  onClose,
  indicators,
  paneCount,
  onAdd,
  onRemoveByDef,
}: {
  open: boolean;
  onClose: () => void;
  indicators: IndicatorInstance[];
  /** Số chỉ báo đang chiếm một cửa sổ riêng — để báo trước khi chạm trần. */
  paneCount: number;
  onAdd: (defId: string) => boolean;
  onRemoveByDef: (defId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<Category>('all');
  const [warning, setWarning] = useState<string | null>(null);
  const search = useDebounced(query, 200);

  const activeIds = useMemo(() => new Set(indicators.map((i) => i.defId)), [indicators]);

  const results = useMemo(() => {
    const found = searchIndicators(search);
    if (category === 'all') return found;
    if (category === 'active') return found.filter((def) => activeIds.has(def.id));
    return found.filter((def) => def.category === category);
  }, [search, category, activeIds]);

  const toggle = (def: IndicatorDef) => {
    setWarning(null);
    if (activeIds.has(def.id)) {
      onRemoveByDef(def.id);
      return;
    }
    if (!onAdd(def.id)) {
      setWarning(
        `Tối đa ${MAX_PANE_INDICATORS} chỉ báo có cửa sổ riêng. Bỏ bớt một cái rồi thêm lại — ` +
          'thêm nữa thì phần nến còn quá ít để đọc.',
      );
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Chỉ báo kỹ thuật"
      description={`${indicators.length} đang dùng · ${paneCount}/${MAX_PANE_INDICATORS} cửa sổ riêng`}
      size="lg"
    >
      <div className="space-y-3">
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Tìm chỉ báo, ví dụ RSI hoặc Bollinger…"
          leftAddon={<Icon name="search" size={16} />}
        />

        <Tabs
          items={TABS.map((tab) => ({
            key: tab.key,
            label: tab.label,
            badge: tab.key === 'active' ? indicators.length : undefined,
          }))}
          active={category}
          onChange={(key) => setCategory(key as Category)}
        />

        {warning && <Alert tone="warning">{warning}</Alert>}

        <div className="max-h-[55vh] overflow-y-auto overscroll-contain rounded-xl border border-ink-100">
          {results.length === 0 ? (
            <p className="p-6 text-center text-sm text-ink-500">
              {category === 'active'
                ? 'Chưa bật chỉ báo nào.'
                : 'Không có chỉ báo nào khớp từ khoá này.'}
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {results.map((def) => {
                const active = activeIds.has(def.id);
                return (
                  <li key={def.id}>
                    <button
                      type="button"
                      onClick={() => toggle(def)}
                      aria-pressed={active}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-ink-50"
                    >
                      <span
                        className={cn(
                          'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                          active
                            ? 'border-primary bg-primary text-primary-fg'
                            : 'border-ink-300 bg-surface',
                        )}
                        aria-hidden
                      >
                        {active && <Icon name="check" size={12} />}
                      </span>

                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink-900">
                          {def.name}
                        </span>
                        <span className="block text-xs text-ink-500">
                          {CATEGORY_LABELS[def.category]} ·{' '}
                          {def.placement === 'overlay' ? 'Vẽ trên biểu đồ giá' : 'Cửa sổ riêng'}
                        </span>
                      </span>

                      <Badge tone="gray">{def.short}</Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
