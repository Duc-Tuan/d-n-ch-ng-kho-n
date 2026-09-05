/**
 * Luật kiểm tra dữ liệu nhập, chạy ở trình duyệt.
 *
 * **Đây là bản sao của luật ở máy chủ, không phải bản thay thế.** Máy chủ vẫn kiểm tra lại toàn
 * bộ (`app/services/auth_service.py`, `app/core/security.py`) — ai gọi thẳng API sẽ bỏ qua hết
 * những gì viết ở đây. Mục đích duy nhất của tệp này là trả lời người dùng ngay lập tức thay vì
 * bắt họ đợi một vòng gọi mạng để biết mình quên điền ô nào.
 *
 * Vì là bản sao nên nó phải **khớp đúng** với bản gốc. Sửa luật ở máy chủ thì sửa cả ở đây; để
 * lệch sẽ sinh ra loại lỗi khó chịu nhất: giao diện báo hợp lệ, máy chủ báo không.
 */

/** Trả về thông báo lỗi, hoặc `undefined` nếu hợp lệ. */
export type Rule = (value: string) => string | undefined;

export function required(label: string): Rule {
  return (value) => (value.trim() ? undefined : `Vui lòng nhập ${label}`);
}

/**
 * Kiểm tra email ở mức "có dạng địa chỉ email".
 *
 * Cố tình lỏng. Chuẩn RFC 5322 cho phép những dạng địa chỉ kỳ lạ hơn nhiều so với trực giác, và
 * biểu thức chính quy chặt tay luôn kết thúc bằng việc từ chối nhầm email thật của khách hàng —
 * lỗi tệ hơn hẳn so với việc để lọt một chuỗi sai xuống máy chủ, nơi nó bị chặn.
 */
export function email(label = 'email'): Rule {
  return (value) => {
    const v = value.trim();
    if (!v) return `Vui lòng nhập ${label}`;
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? undefined : 'Email không đúng định dạng';
  };
}

/** Khớp `PHONE_RE` ở `app/services/auth_service.py` — số di động Việt Nam, 10 chữ số. */
export function vnPhone(): Rule {
  return (value) => {
    const v = value.replace(/[\s.\-()]/g, '');
    if (!v) return 'Vui lòng nhập số điện thoại';
    return /^(0|\+84)(3|5|7|8|9)\d{8}$/.test(v)
      ? undefined
      : 'Số điện thoại không đúng định dạng Việt Nam';
  };
}

/** BR-2.1 — khớp `password_policy_errors` ở `app/core/security.py`. */
export function password(): Rule {
  return (value) => {
    if (!value) return 'Vui lòng nhập mật khẩu';
    if (value.length < 8) return 'Mật khẩu phải có tối thiểu 8 ký tự';
    if (!/[a-zA-Z]/.test(value)) return 'Mật khẩu phải chứa ít nhất một chữ cái';
    if (!/\d/.test(value)) return 'Mật khẩu phải chứa ít nhất một chữ số';
    return undefined;
  };
}

/** Ô "nhập lại" phải trùng ô gốc. */
export function sameAs(other: string, message = 'Mật khẩu nhập lại không khớp'): Rule {
  return (value) => {
    if (!value) return 'Vui lòng nhập lại mật khẩu';
    return value === other ? undefined : message;
  };
}

/** Áp lần lượt nhiều luật lên một giá trị, dừng ở lỗi đầu tiên. */
export function check(value: string, ...rules: Rule[]): string | undefined {
  for (const rule of rules) {
    const error = rule(value);
    if (error) return error;
  }
  return undefined;
}
