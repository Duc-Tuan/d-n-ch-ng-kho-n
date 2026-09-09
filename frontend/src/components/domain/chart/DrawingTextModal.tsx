'use client';

/**
 * Ô nhập nội dung cho công cụ văn bản và ghi chú dán trên khung.
 *
 * Thay cho `window.prompt`: hộp của trình duyệt chỉ nhận **một dòng**, không xuống dòng được, và
 * nó mang giao diện hệ điều hành đặt giữa một trang đã có bảng màu riêng. Ghi chú trên biểu đồ hầu
 * như luôn nhiều dòng ("vùng kháng cự 28.5 / chờ phá vỡ / dừng lỗ 26"), nên đây là chỗ đáng thay.
 */
import { useEffect, useRef, useState } from 'react';

import { Button, Modal, Textarea } from '@/components/ui';

export function DrawingTextModal({
  open,
  initial = '',
  title,
  hint = 'Xuống dòng được. Ctrl + Enter để xong.',
  onSubmit,
  onCancel,
}: {
  open: boolean;
  initial?: string;
  title: string;
  /** Dòng nhắc dưới ô nhập. Sửa nhãn mã tự động cần một lời cảnh báo mà ghi chú thường không có. */
  hint?: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Nội dung mở sẵn chỉ được đọc ở **lúc mở**. Nó theo mã đang xem, mà mã có thể đổi ngay sau
  // lưng ô nhập (giá chạy về, người dùng bấm mã khác ở cửa sổ bên) — chép thẳng vào danh sách
  // phụ thuộc thì một cú đổi mã như vậy xoá sạch câu đang gõ dở.
  const initialRef = useRef(initial);
  initialRef.current = initial;

  // Mỗi lần mở là một ghi chú khác: nạp lại nội dung và đưa con trỏ vào ô, khỏi phải bấm thêm.
  // Bôi đen luôn để gõ đè lên phần mở sẵn, khỏi phải xoá tay.
  useEffect(() => {
    if (!open) return;
    setText(initialRef.current);
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const submit = () => {
    const value = text.trim();
    // Ghi chú rỗng là một hình vô hình nằm lại trên biểu đồ, chỉ chặn chuột chứ không hiện gì.
    if (!value) return onCancel();
    onSubmit(value);
  };

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="outline" onClick={onCancel}>
            Huỷ
          </Button>
          <Button onClick={submit} disabled={!text.trim()}>
            Xong
          </Button>
        </>
      }
    >
      <Textarea
        ref={inputRef}
        value={text}
        rows={4}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          // Enter xuống dòng như mọi ô nhiều dòng khác; Ctrl/Cmd+Enter mới là "xong".
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={['Ví dụ: vùng kháng cự 28.5', 'chờ phá vỡ mới vào'].join('\n')}
        hint={hint}
      />
    </Modal>
  );
}
