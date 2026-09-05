/**
 * API client dùng chung cho toàn bộ FE.
 *
 * Mọi lời gọi API đi qua đây — không dùng `fetch` trực tiếp trong component.
 * Lý do: cần một chỗ duy nhất xử lý lỗi chuẩn hoá {code, message, details},
 * gửi cookie, và bắt trạng thái BR-001 (ACCESS_BLOCKED) để điều hướng đúng màn.
 */

export const API_PREFIX = '/api/v1';

export type ApiErrorBody = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message || 'Đã có lỗi xảy ra');
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code || 'UNKNOWN';
    this.details = body.details ?? {};
  }

  /** BR-001 — bị chặn truy cập, kèm lý do và hành động tiếp theo (BR-112). */
  get isAccessBlocked() {
    return this.code === 'ACCESS_BLOCKED';
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  /** Lỗi gắn với một trường cụ thể — dùng để hiển thị ngay dưới ô nhập. */
  get field(): string | undefined {
    const field = this.details?.field;
    return typeof field === 'string' ? field : undefined;
  }

  /** Hành động tiếp theo do backend gợi ý (gia hạn, xác thực email, liên hệ môi giới…). */
  get action(): { type?: string; url?: string; [k: string]: unknown } {
    return (this.details?.action as Record<string, unknown>) ?? {};
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & {
  body?: unknown;
  /** Tham số query — bỏ qua giá trị undefined/null/'' để URL sạch. */
  params?: Record<string, unknown>;
};

function buildUrl(path: string, params?: Record<string, unknown>): string {
  const url = path.startsWith('http') ? path : `${API_PREFIX}${path}`;
  if (!params) return url;

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      value.forEach((v) => v !== undefined && v !== null && search.append(key, String(v)));
    } else {
      search.append(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, params, headers, ...rest } = options;

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const response = await fetch(buildUrl(path, params), {
    ...rest,
    // Bắt buộc để cookie HttpOnly (cst_at / adm_at) được gửi kèm.
    credentials: 'include',
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (!response.ok) {
      throw new ApiError(response.status, {
        code: 'HTTP_ERROR',
        message: `Lỗi ${response.status}`,
      });
    }
    return (await response.blob()) as T;
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(response.status, data as ApiErrorBody);
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'GET', params }),
  post: <T>(path: string, body?: unknown, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'POST', body, params }),
  put: <T>(path: string, body?: unknown, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'PUT', body, params }),
  // Sửa một phần: chỉ gửi những trường thật sự đổi, máy chủ giữ nguyên phần còn lại.
  patch: <T>(path: string, body?: unknown, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'PATCH', body, params }),
  del: <T>(path: string, params?: Record<string, unknown>) =>
    request<T>(path, { method: 'DELETE', params }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: 'POST', body: form }),
};

/** Fetcher cho SWR. */
export const swrFetcher = <T>(key: string | [string, Record<string, unknown>]) => {
  if (Array.isArray(key)) return api.get<T>(key[0], key[1]);
  return api.get<T>(key);
};

/** Đường dẫn gốc của hai vùng API — tách biệt hoàn toàn (BR-000). */
export const CUSTOMER = '/customer';
export const ADMIN = '/admin';
export const PUBLIC = '/public';
