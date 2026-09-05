'use client';

/**
 * Quản lý lỗi kiểm tra **phía giao diện** cho một biểu mẫu.
 *
 * Phân vai rõ ràng giữa hai loại lỗi, vì chúng cần hai cách hiển thị khác nhau:
 *
 * * **Lỗi giao diện bắt được** (bỏ trống ô, sai định dạng, mật khẩu nhập lại không khớp) —
 *   hiện **ngay dưới đúng ô sai**. Người dùng đang nhìn vào ô đó, và họ cần biết phải sửa ô nào.
 *   Hook này giữ những lỗi ấy.
 * * **Lỗi do máy chủ trả về** (sai mật khẩu, email đã tồn tại, tài khoản bị khoá) — hiện bằng
 *   **toast**, do `useAction` lo. Những lỗi này thường không gắn với một ô cụ thể, và người dùng
 *   vừa bấm nút xong nên mắt đang ở nút, không ở đầu biểu mẫu.
 */
import { useCallback, useState } from 'react';

export function useFormErrors<K extends string>() {
  const [errors, setErrors] = useState<Partial<Record<K, string>>>({});

  /**
   * Chạy kiểm tra cho cả biểu mẫu. Trả về `true` nếu **không** có lỗi nào.
   *
   * Nhận vào bản đồ trường → thông báo lỗi (`undefined` là hợp lệ), thường dựng bằng các luật
   * ở `lib/validation`. Trả về boolean để nơi gọi viết được `if (!validate({...})) return;` —
   * chốt chặn duy nhất giữa biểu mẫu và lời gọi API.
   */
  const validate = useCallback((result: Partial<Record<K, string | undefined>>): boolean => {
    const found: Partial<Record<K, string>> = {};
    for (const key of Object.keys(result) as K[]) {
      const message = result[key];
      if (message) found[key] = message;
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }, []);

  /**
   * Xoá lỗi của một ô — gọi khi người dùng bắt đầu sửa ô đó.
   *
   * Giữ lỗi lại trong lúc người ta đang gõ để sửa chính lỗi ấy là một kiểu trách móc vô ích:
   * họ biết mình sai rồi, đang khắc phục, mà dòng chữ đỏ vẫn nằm đó.
   */
  const clear = useCallback((field: K) => {
    setErrors((current) => {
      if (!current[field]) return current;  // không tạo state mới ⇒ không render thừa
      const next = { ...current };
      delete next[field];
      return next;
    });
  }, []);

  const reset = useCallback(() => setErrors({}), []);

  return { errors, validate, clear, reset };
}
