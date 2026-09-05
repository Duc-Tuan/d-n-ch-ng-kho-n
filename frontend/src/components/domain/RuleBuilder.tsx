'use client';

/**
 * Bộ dựng điều kiện chiến lược (YC10).
 *
 * Dùng chung cho cả site khách hàng và site quản trị — cùng một bộ lọc, cùng một máy chạy, nên
 * không có lý do gì để có hai giao diện khác nhau. Danh mục chỉ báo và toán tử lấy từ API, nên
 * thêm chỉ báo mới ở máy chủ là giao diện tự có, không phải sửa hai nơi.
 *
 * Người dùng không gõ công thức. Mỗi điều kiện là ba ô chọn: *chỉ báo → phép so sánh → chỉ báo
 * hoặc con số*. Cho nhập công thức tự do thì vừa khó kiểm tra, vừa mở đường chạy mã tuỳ ý trên
 * máy chủ.
 */

import { useMemo, type ReactNode } from 'react';

import { Button, Card, Icon, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';
import type {
  IndicatorMeta,
  RuleCatalog,
  RuleCondition,
  RuleGroup,
  RuleOperand,
  StrategyRules,
} from '@/types';

/** Bộ lọc trống khi bắt đầu tạo mới — đủ một điều kiện để người dùng thấy ngay hình dạng. */
export function emptyRules(): StrategyRules {
  return {
    direction: 'BUY',
    entry: {
      logic: 'AND',
      conditions: [
        {
          left: { key: 'close', params: {} },
          operator: 'cross_above',
          right: { key: 'sma', params: { period: 20 } },
        },
      ],
    },
    exit: { logic: 'OR', conditions: [] },
    risk: { stop_loss_pct: 7, take_profit_pct: 15, max_hold_days: 40 },
  };
}

/** Hai phép này chỉ nhìn vào vế trái nên giao diện ẩn hẳn vế phải. */
const UNARY_OPERATORS = new Set(['increasing', 'decreasing']);

function defaultParams(meta: IndicatorMeta | undefined): Record<string, number> {
  const params: Record<string, number> = {};
  for (const p of meta?.params ?? []) params[p.name] = p.default;
  return params;
}

export function RuleBuilder({
  value,
  onChange,
  catalog,
  disabled,
}: {
  value: StrategyRules;
  onChange: (rules: StrategyRules) => void;
  catalog: RuleCatalog;
  disabled?: boolean;
}) {
  const indicatorOptions = useMemo(
    () => catalog.indicators.map((i) => ({ value: i.key, label: i.label })),
    [catalog.indicators],
  );

  const setGroup = (which: 'entry' | 'exit', group: RuleGroup) =>
    onChange({ ...value, [which]: group });

  return (
    <div className="space-y-4">
      <Card>
        <Select
          label="Chiều lệnh"
          value={value.direction}
          disabled={disabled}
          options={catalog.directions.map((d) => ({ value: d.key, label: d.label }))}
          onChange={(e) => onChange({ ...value, direction: e.target.value as 'BUY' | 'SELL' })}
          hint="Mua là kỳ vọng giá lên sau khi vào lệnh; bán là kỳ vọng giá xuống."
        />
      </Card>

      <GroupEditor
        title="Điều kiện vào lệnh"
        description="Phiên nào thoả điều kiện thì phiên kế tiếp mở lệnh ở giá mở cửa."
        group={value.entry}
        onChange={(g) => setGroup('entry', g)}
        catalog={catalog}
        indicatorOptions={indicatorOptions}
        disabled={disabled}
        required
      />

      <GroupEditor
        title="Điều kiện thoát lệnh"
        description="Không bắt buộc. Bỏ trống thì chỉ thoát bằng cắt lỗ, chốt lời hoặc hết hạn giữ."
        group={value.exit}
        onChange={(g) => setGroup('exit', g)}
        catalog={catalog}
        indicatorOptions={indicatorOptions}
        disabled={disabled}
      />

      <RiskEditor
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

function GroupEditor({
  title,
  description,
  group,
  onChange,
  catalog,
  indicatorOptions,
  disabled,
  required,
}: {
  title: string;
  description: string;
  group: RuleGroup;
  onChange: (group: RuleGroup) => void;
  catalog: RuleCatalog;
  indicatorOptions: Array<{ value: string; label: string }>;
  disabled?: boolean;
  required?: boolean;
}) {
  const setCondition = (index: number, condition: RuleCondition) => {
    const conditions = [...group.conditions];
    conditions[index] = condition;
    onChange({ ...group, conditions });
  };

  const addCondition = () =>
    onChange({
      ...group,
      conditions: [
        ...group.conditions,
        {
          left: { key: 'close', params: {} },
          operator: 'gt',
          right: { key: 'sma', params: { period: 20 } },
        },
      ],
    });

  const removeCondition = (index: number) =>
    onChange({ ...group, conditions: group.conditions.filter((_, i) => i !== index) });

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold text-ink-900">
            {title}
            {required && <span className="ml-1 text-down">*</span>}
          </h3>
          <p className="mt-0.5 text-xs text-ink-500">{description}</p>
        </div>

        {group.conditions.length > 1 && (
          <Select
            aria-label="Cách ghép điều kiện"
            value={group.logic}
            disabled={disabled}
            className="w-auto min-w-[13rem]"
            options={catalog.logics.map((l) => ({ value: l.key, label: l.label }))}
            onChange={(e) => onChange({ ...group, logic: e.target.value as 'AND' | 'OR' })}
          />
        )}
      </div>

      {group.conditions.length === 0 ? (
        <p className="rounded-lg border border-dashed border-ink-200 px-3 py-6 text-center text-sm text-ink-500">
          Chưa có điều kiện nào.
        </p>
      ) : (
        <ul className="space-y-2">
          {group.conditions.map((condition, index) => (
            <li key={index}>
              {index > 0 && (
                <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-ink-400">
                  {group.logic === 'AND' ? 'và' : 'hoặc'}
                </p>
              )}
              <ConditionRow
                index={index}
                condition={condition}
                onChange={(c) => setCondition(index, c)}
                onRemove={() => removeCondition(index)}
                catalog={catalog}
                indicatorOptions={indicatorOptions}
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
      )}

      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={disabled}
        leftIcon={<Icon name="plus" size={15} />}
        onClick={addCondition}
      >
        Thêm điều kiện
      </Button>
    </Card>
  );
}

/**
 * Một dòng điều kiện.
 *
 * Bố cục dùng **container query** chứ không phải breakpoint của Tailwind: bộ dựng này nằm trong
 * cột hẹp (~30rem) ở màn Bộ lọc phân tích, trong khi `sm:` đo bề rộng **cửa sổ**. Kết quả cũ là
 * bốn ô bị nhồi vào cột hẹp, chữ trong ô chọn bị cắt và ô cuối tụt hàng. Container query đo đúng
 * khung chứa nên xếp dọc khi hẹp, xếp ngang khi thật sự có chỗ.
 */
function ConditionRow({
  index,
  condition,
  onChange,
  onRemove,
  catalog,
  indicatorOptions,
  disabled,
}: {
  index: number;
  condition: RuleCondition;
  onChange: (condition: RuleCondition) => void;
  onRemove: () => void;
  catalog: RuleCatalog;
  indicatorOptions: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  const isUnary = UNARY_OPERATORS.has(condition.operator);

  return (
    <div className="rule-condition rounded-lg border border-ink-200 bg-ink-50/50 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-400">
          Điều kiện {index + 1}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={`Xoá điều kiện ${index + 1}`}
          title="Xoá điều kiện"
          onClick={onRemove}
        >
          <Icon name="trash" size={15} />
        </Button>
      </div>

      <div className={cn('rule-condition-grid grid gap-2', isUnary && 'rule-condition-unary')}>
        <FieldBlock label="Vế trái">
          <OperandEditor
            operand={condition.left}
            onChange={(left) => onChange({ ...condition, left })}
            catalog={catalog}
            indicatorOptions={indicatorOptions}
            disabled={disabled}
            // Vế trái luôn là chỉ báo — so sánh "30 lớn hơn RSI" là cách viết ngược, gây rối.
            allowConstant={false}
          />
        </FieldBlock>

        <FieldBlock label="So sánh">
          <Select
            aria-label="Phép so sánh"
            value={condition.operator}
            disabled={disabled}
            options={catalog.operators.map((o) => ({ value: o.key, label: o.label }))}
            onChange={(e) => onChange({ ...condition, operator: e.target.value })}
          />
        </FieldBlock>

        {!isUnary && (
          <FieldBlock label="Vế phải">
            <OperandEditor
              operand={condition.right}
              onChange={(right) => onChange({ ...condition, right })}
              catalog={catalog}
              indicatorOptions={indicatorOptions}
              disabled={disabled}
              allowConstant
            />
          </FieldBlock>
        )}
      </div>
    </div>
  );
}

/** Nhãn nhỏ trên mỗi ô — xếp dọc thì không có nhãn là không biết ô nào là vế nào. */
function FieldBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-[11px] font-medium text-ink-500">{label}</p>
      {children}
    </div>
  );
}

function OperandEditor({
  operand,
  onChange,
  catalog,
  indicatorOptions,
  disabled,
  allowConstant,
}: {
  operand: RuleOperand;
  onChange: (operand: RuleOperand) => void;
  catalog: RuleCatalog;
  indicatorOptions: Array<{ value: string; label: string }>;
  disabled?: boolean;
  allowConstant: boolean;
}) {
  const isConstant = !operand.key;
  const meta = catalog.indicators.find((i) => i.key === operand.key);

  const options = allowConstant
    ? [{ value: '__const__', label: 'Một con số cụ thể' }, ...indicatorOptions]
    : indicatorOptions;

  return (
    <div className="space-y-2">
      <Select
        aria-label="Chỉ báo"
        value={isConstant ? '__const__' : operand.key}
        disabled={disabled}
        options={options}
        onChange={(e) => {
          const key = e.target.value;
          if (key === '__const__') {
            onChange({ value: operand.value ?? 0 });
            return;
          }
          const next = catalog.indicators.find((i) => i.key === key);
          onChange({ key, params: defaultParams(next) });
        }}
      />

      {isConstant ? (
        <Input
          type="number"
          step="any"
          aria-label="Giá trị"
          placeholder="Nhập số"
          disabled={disabled}
          value={operand.value ?? ''}
          onChange={(e) => onChange({ value: e.target.value === '' ? null : Number(e.target.value) })}
        />
      ) : (
        meta &&
        meta.params.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {meta.params.map((param) => (
              <Input
                key={param.name}
                type="number"
                min={1}
                max={500}
                aria-label={param.name}
                className="w-24"
                disabled={disabled}
                value={operand.params?.[param.name] ?? param.default}
                onChange={(e) =>
                  onChange({
                    ...operand,
                    params: { ...operand.params, [param.name]: Number(e.target.value) },
                  })
                }
              />
            ))}
          </div>
        )
      )}
    </div>
  );
}

function RiskEditor({
  value,
  onChange,
  disabled,
}: {
  value: StrategyRules;
  onChange: (rules: StrategyRules) => void;
  disabled?: boolean;
}) {
  const setRisk = (patch: Partial<StrategyRules['risk']>) =>
    onChange({ ...value, risk: { ...value.risk, ...patch } });

  // Để trống ô phần trăm nghĩa là không dùng mức đó, khác hẳn với nhập số 0.
  const parse = (raw: string) => (raw === '' ? null : Number(raw));

  return (
    <Card>
      <h3 className="font-semibold text-ink-900">Quản trị rủi ro</h3>
      <p className="mb-3 mt-0.5 text-xs text-ink-500">
        Chiến lược chỉ có điểm vào mà không có đường thoát thì thống kê thắng thua không có ý
        nghĩa, nên luôn có giới hạn số phiên giữ.
      </p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Input
          type="number"
          label="Cắt lỗ (%)"
          placeholder="Ví dụ: 3"
          min={0.1}
          max={100}
          step="any"
          disabled={disabled}
          value={value.risk.stop_loss_pct ?? ''}
          onChange={(e) => setRisk({ stop_loss_pct: parse(e.target.value) })}
          hint="Bỏ trống nếu không đặt"
        />
        <Input
          type="number"
          label="Chốt lời (%)"
          placeholder="Ví dụ: 6"
          min={0.1}
          max={100}
          step="any"
          disabled={disabled}
          value={value.risk.take_profit_pct ?? ''}
          onChange={(e) => setRisk({ take_profit_pct: parse(e.target.value) })}
          hint="Bỏ trống nếu không đặt"
        />
        <Input
          type="number"
          label="Giữ tối đa (phiên)"
          placeholder="Ví dụ: 20"
          min={1}
          max={1000}
          disabled={disabled}
          value={value.risk.max_hold_days ?? 40}
          onChange={(e) => setRisk({ max_hold_days: Number(e.target.value) })}
          hint="Quá hạn thì thoát ở giá đóng cửa"
        />
      </div>
    </Card>
  );
}
