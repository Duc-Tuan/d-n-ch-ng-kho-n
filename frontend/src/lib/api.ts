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

/**
 * Làm mới access token khi nó hết hạn giữa chừng — lưới an toàn cho `useTokenRefresh`.
 *
 * Cookie phiên là HttpOnly nên JavaScript **không đọc được hạn của nó**. Bộ đếm giờ ở
 * `useTokenRefresh` làm mới trước khi hết hạn, nhưng nó không bao giờ đủ: trình duyệt bóp
 * `setInterval` ở tab nền, máy ngủ thì đồng hồ đứng luôn, và người dùng mở lại tab sau hai
 * tiếng là access token đã chết. Chốt phản ứng ở đây bắt đúng khoảnh khắc đó — một lần 401,
 * làm mới, gọi lại — nên phiên không bao giờ đứt chỉ vì bộ đếm lỡ nhịp.
 *
 * Gộp mọi lượt làm mới đang bay vào **một** lượt gọi: một màn hình mở mười truy vấn song song
 * thì cả mười cùng nhận 401, và mười lượt `/auth/refresh` cùng lúc là mười lần xoay vòng phiên
 * trên máy chủ.
 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * Đã thử làm mới và thất bại → ngừng thử cho tới lần đăng nhập kế tiếp.
 *
 * Không có cờ này thì mỗi lượt gọi API của **khách chưa đăng nhập** đều kéo thêm một lượt
 * `/auth/refresh` chắc chắn hỏng: 401 khi chưa đăng nhập là trạng thái bình thường, không phải
 * sự cố cần chữa.
 */
let refreshBlocked = false;

/** Gọi sau khi đăng nhập thành công — phiên mới thì lưới an toàn được bật lại. */
export function resetAuthRefresh(): void {
  refreshBlocked = false;
}

/** Đường `/auth/refresh` tương ứng với vùng của `path`, hoặc null nếu không nên tự làm mới. */
function refreshEndpointFor(path: string): string | null {
  const area = path.startsWith(ADMIN) ? ADMIN : path.startsWith(CUSTOMER) ? CUSTOMER : null;
  if (!area) return null; // vùng public không có phiên để làm mới

  const rest = path.slice(area.length);
  // Chính các endpoint xác thực thì không tự làm mới: 401 ở `/login` là sai mật khẩu, ở
  // `/refresh` là phiên đã chết — gọi lại chỉ nhân đôi số lượt.
  //
  // Ngoại lệ là `/auth/me`: đó là lượt gọi đầu tiên khi mở lại tab và cũng là chỗ quyết định
  // "còn đăng nhập hay không". Bỏ nó ra ngoài thì người dùng quay lại sau 40 phút bị đá về màn
  // đăng nhập dù refresh token vẫn còn hạn — đúng cái đang cần sửa.
  if (rest.startsWith('/auth/') && rest !== '/auth/me') return null;

  return `${area}/auth/refresh`;
}

async function tryRefresh(endpoint: string): Promise<boolean> {
  if (refreshBlocked) return false;

  const inflight =
    refreshInFlight ??
    (refreshInFlight = fetch(buildUrl(endpoint), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
      .then((response) => {
        // Refresh token cũng hết hạn hoặc phiên bị thu hồi: phiên đã kết thúc thật.
        if (!response.ok) refreshBlocked = true;
        return response.ok;
      })
      .catch(() => false)
      .finally(() => {
        refreshInFlight = null;
      }));

  return inflight;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, params, headers, ...rest } = options;

  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const send = () =>
    fetch(buildUrl(path, params), {
      ...rest,
      // Bắt buộc để cookie HttpOnly (cst_at / adm_at) được gửi kèm.
      credentials: 'include',
      headers: {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : isFormData ? (body as FormData) : JSON.stringify(body),
    });

  let response = await send();

  // Gọi lại đúng **một** lần sau khi làm mới. `FormData` đã bị đọc hết ở lượt đầu thì không gửi
  // lại được, nên lượt tải file hỏng vẫn báo 401 như cũ — người dùng chọn lại file, còn hơn gửi
  // đi một body rỗng và tưởng đã tải lên xong.
  if (response.status === 401 && !isFormData) {
    const endpoint = refreshEndpointFor(path);
    if (endpoint && (await tryRefresh(endpoint))) {
      response = await send();
    }
  }

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
