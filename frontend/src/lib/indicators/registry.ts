/**
 * Danh mục chỉ báo — cổng duy nhất để giao diện tra cứu và tạo chỉ báo.
 *
 * Phần tính toán (`math`, `overlays`, `oscillators`, `statistical`, `smc`) dùng chung với FE
 * hệ thống forex nội bộ: cùng một công thức, cùng tham số mặc định, nên một mã đọc trên hai
 * sản phẩm ra cùng con số. Sửa công thức thì phải sửa cả hai chỗ.
 */
import { OSCILLATOR_INDICATORS } from '@/lib/indicators/oscillators';
import { OVERLAY_INDICATORS } from '@/lib/indicators/overlays';
import { SMC_INDICATORS } from '@/lib/indicators/smc';
import { STATISTICAL_INDICATORS } from '@/lib/indicators/statistical';
import { defaultParams, type IndicatorDef, type IndicatorInstance } from '@/lib/indicators/types';

/** Mã duy nhất cho mỗi lần thêm chỉ báo — một biểu đồ có thể có hai EMA khác chu kỳ. */
function uid(prefix = 'ind'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export const INDICATORS: IndicatorDef[] = [
  ...OVERLAY_INDICATORS,
  ...SMC_INDICATORS,
  ...OSCILLATOR_INDICATORS,
  ...STATISTICAL_INDICATORS,
];

const BY_ID = new Map(INDICATORS.map((def) => [def.id, def]));

export function getIndicator(defId: string): IndicatorDef | undefined {
  return BY_ID.get(defId);
}

export const CATEGORY_LABELS: Record<IndicatorDef['category'], string> = {
  trend: 'Xu hướng',
  momentum: 'Động lượng',
  volatility: 'Biến động',
  volume: 'Khối lượng',
};

/** Tạo instance mới với param mặc định của định nghĩa. */
export function createInstance(defId: string): IndicatorInstance {
  const def = getIndicator(defId);
  if (!def) throw new Error(`Chỉ báo không tồn tại: ${defId}`);
  return {
    instanceId: uid('ind'),
    defId,
    params: defaultParams(def),
    styleOverrides: {},
    visible: true,
  };
}

/** Nhãn legend: "RSI 14", "MACD 12 26 9", "BB 20 2". */
export function instanceLabel(instance: IndicatorInstance): string {
  const def = getIndicator(instance.defId);
  if (!def) return instance.defId;

  // Chỉ báo nhiều tham số (bộ SMC) khai báo `labelParams` để legend khỏi dài dòng.
  const keys = def.labelParams ?? def.params.filter((p) => p.type === 'number').map((p) => p.key);
  const values = keys.map((key) => instance.params[key]).filter((v) => v !== undefined && v !== 0);

  return values.length ? `${def.short} ${values.join(' ')}` : def.short;
}

export function searchIndicators(query: string): IndicatorDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return INDICATORS;
  return INDICATORS.filter(
    (def) => def.name.toLowerCase().includes(q) || def.short.toLowerCase().includes(q),
  );
}
