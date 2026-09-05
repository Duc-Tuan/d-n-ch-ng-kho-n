'use client';

/**
 * Cấu hình một chỉ báo: thông số tính toán và kiểu hiển thị.
 *
 * Form **sinh tự động** từ `def.params`. Thêm một chỉ báo mới vào danh mục là có ngay màn cài
 * đặt của nó, không phải viết thêm giao diện — đó cũng là lý do `ParamDef` mô tả cả kiểu dữ
 * liệu lẫn miền giá trị chứ không chỉ tên tham số.
 */
import { useEffect, useRef, useState } from 'react';

import { Button, Checkbox, Input, Modal, Select, Tabs } from '@/components/ui';
import { PRICE_SOURCES } from '@/lib/indicators/math';
import { getIndicator } from '@/lib/indicators/registry';
import { defaultParams, type IndicatorInstance, type ParamValues, type PlotDef } from '@/lib/indicators/types';

const LINE_WIDTHS = [
  { value: '1', label: 'Mảnh' },
  { value: '2', label: 'Vừa' },
  { value: '3', label: 'Dày' },
];

export function IndicatorSettingsModal({
  instance,
  onClose,
  onApplyParams,
  onPatchStyle,
}: {
  instance: IndicatorInstance | null;
  onClose: () => void;
  onApplyParams: (instanceId: string, params: ParamValues) => void;
  /** Kiểu hiển thị áp dụng **ngay**: người dùng cần thấy màu mới trên biểu đồ để chọn được. */
  onPatchStyle: (instanceId: string, plotKey: string, style: Partial<PlotDef>) => void;
}) {
  const def = instance ? getIndicator(instance.defId) : undefined;

  const [tab, setTab] = useState('inputs');
  /** Thông số sửa trên bản nháp, chỉ ghi khi bấm "Áp dụng" — mỗi lần gõ một chữ số mà tính lại
   *  cả chuỗi chỉ báo thì biểu đồ giật, và những số dở dang ("1" khi đang gõ "14") là vô nghĩa. */
  const [draft, setDraft] = useState<ParamValues>({});

  const instanceRef = useRef(instance);
  instanceRef.current = instance;
  const instanceId = instance?.instanceId ?? null;

  // Chỉ nạp lại bản nháp khi **mở một chỉ báo khác**. Bám theo cả `instance` thì mỗi lần đổi màu
  // (ghi thẳng vào state cha) sẽ đá người dùng về tab Thông số ngay giữa lúc họ đang chỉnh.
  useEffect(() => {
    const current = instanceRef.current;
    if (current) setDraft(current.params);
    setTab('inputs');
  }, [instanceId]);

  if (!instance || !def) return null;

  const styleOf = (plot: PlotDef): PlotDef => ({ ...plot, ...instance.styleOverrides[plot.key] });

  return (
    <Modal
      open
      onClose={onClose}
      title={def.name}
      description={def.placement === 'overlay' ? 'Vẽ trên biểu đồ giá' : 'Cửa sổ riêng bên dưới'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={() => setDraft(defaultParams(def))}>
            Mặc định
          </Button>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            onClick={() => {
              onApplyParams(instance.instanceId, draft);
              onClose();
            }}
          >
            Áp dụng
          </Button>
        </>
      }
    >
      <Tabs
        items={[
          { key: 'inputs', label: 'Thông số' },
          { key: 'style', label: 'Kiểu hiển thị' },
        ]}
        active={tab}
        onChange={setTab}
        className="mb-4"
      />

      {tab === 'inputs' ? (
        <div className="space-y-3">
          {def.params.length === 0 && (
            <p className="text-sm text-ink-500">Chỉ báo này không có thông số để chỉnh.</p>
          )}

          {def.params.map((param) => (
            <div key={param.key} className="flex items-center justify-between gap-4">
              <span className="text-sm text-ink-700">{param.label}</span>

              <div className="w-44 shrink-0">
                {param.type === 'number' && (
                  <Input
                    type="number"
                    value={String(draft[param.key] ?? param.default)}
                    min={param.min}
                    max={param.max}
                    step={param.step ?? 1}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [param.key]: Number(event.target.value) }))
                    }
                  />
                )}

                {param.type === 'boolean' && (
                  <Checkbox
                    label="Bật"
                    checked={Boolean(draft[param.key] ?? param.default)}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [param.key]: event.target.checked }))
                    }
                  />
                )}

                {param.type === 'source' && (
                  <Select
                    options={PRICE_SOURCES}
                    value={String(draft[param.key] ?? param.default)}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [param.key]: event.target.value }))
                    }
                  />
                )}

                {param.type === 'select' && (
                  <Select
                    options={param.options}
                    value={String(draft[param.key] ?? param.default)}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, [param.key]: event.target.value }))
                    }
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {/* Chỉ báo vẽ hoàn toàn bằng hộp/đường (bộ SMC, Khối lượng theo giá) không có đường
              nào để đổi màu — nói thẳng ra thay vì hiện một tab trống. */}
          {def.plots.length === 0 && (
            <p className="text-sm text-ink-500">
              Chỉ báo này tự vẽ hình khối trên biểu đồ, không có đường nào để tuỳ chỉnh.
            </p>
          )}

          {def.plots.map((plot) => {
            const style = styleOf(plot);
            return (
              <div
                key={plot.key}
                className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-100 pb-3 last:border-0"
              >
                <Checkbox
                  label={plot.label}
                  checked={!style.hidden}
                  onChange={(event) =>
                    onPatchStyle(instance.instanceId, plot.key, { hidden: !event.target.checked })
                  }
                />

                <div className="flex items-center gap-2">
                  {style.type !== 'histogram' && (
                    <Select
                      className="w-28"
                      options={LINE_WIDTHS}
                      value={String(style.lineWidth ?? 1)}
                      onChange={(event) =>
                        onPatchStyle(instance.instanceId, plot.key, {
                          lineWidth: Number(event.target.value) as 1 | 2 | 3 | 4,
                        })
                      }
                    />
                  )}
                  <input
                    type="color"
                    aria-label={`Màu của ${plot.label}`}
                    value={style.color}
                    onChange={(event) =>
                      onPatchStyle(instance.instanceId, plot.key, { color: event.target.value })
                    }
                    className="h-9 w-10 cursor-pointer rounded border border-ink-300 bg-surface p-1"
                  />
                </div>
              </div>
            );
          })}

          {def.levels && def.levels.length > 0 && (
            <p className="text-xs text-ink-500">
              Các mức {def.levels.map((level) => level.value).join(', ')} được vẽ cố định trong cửa
              sổ chỉ báo.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
