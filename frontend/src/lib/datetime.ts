/**
 * Thời gian — cấu hình dayjs một lần, dùng chung toàn hệ thống.
 *
 * BR-130: backend lưu UTC; FE **luôn** hiển thị theo múi giờ Asia/Ho_Chi_Minh.
 */
import dayjs from 'dayjs';
import 'dayjs/locale/vi';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import relativeTime from 'dayjs/plugin/relativeTime';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(relativeTime);
dayjs.extend(advancedFormat);
dayjs.extend(isSameOrBefore);
dayjs.locale('vi');

export const TZ = 'Asia/Ho_Chi_Minh';

type DateInput = string | number | Date | null | undefined;

/** Chuyển mốc UTC từ API sang giờ Việt Nam. */
export function local(value: DateInput) {
  return dayjs.utc(value ?? undefined).tz(TZ);
}

/** 01/08/2026 */
export function formatDate(value: DateInput, fallback = '—'): string {
  if (!value) return fallback;
  return local(value).format('DD/MM/YYYY');
}

/** 01/08/2026 14:30 */
export function formatDateTime(value: DateInput, fallback = '—'): string {
  if (!value) return fallback;
  return local(value).format('DD/MM/YYYY HH:mm');
}

/** 14:30 */
export function formatTime(value: DateInput, fallback = '—'): string {
  if (!value) return fallback;
  return local(value).format('HH:mm');
}

/** "3 ngày trước" — dùng cho nhật ký, thông báo. */
export function fromNow(value: DateInput, fallback = '—'): string {
  if (!value) return fallback;
  return local(value).fromNow();
}

/** Thời điểm hiện tại theo giờ Việt Nam. */
export function nowLocal() {
  return dayjs().tz(TZ);
}

/** Số ngày còn lại (làm tròn xuống, không âm). Dùng cho đếm ngược hết hạn/cảnh báo. */
export function daysLeft(value: DateInput): number | null {
  if (!value) return null;
  return Math.max(local(value).startOf('day').diff(nowLocal().startOf('day'), 'day'), 0);
}

/** Đã qua mốc thời gian này chưa. */
export function isPast(value: DateInput): boolean {
  if (!value) return false;
  return local(value).isBefore(nowLocal());
}

/** Định dạng cho input type="date" / "datetime-local". */
export function toInputDate(value: DateInput): string {
  if (!value) return '';
  return local(value).format('YYYY-MM-DD');
}

export function toInputDateTime(value: DateInput): string {
  if (!value) return '';
  return local(value).format('YYYY-MM-DDTHH:mm');
}

/** Chuyển giá trị từ input local về ISO UTC để gửi lên API. */
export function fromInputDateTime(value: string): string | null {
  if (!value) return null;
  return dayjs.tz(value, TZ).utc().toISOString();
}

export { dayjs };
