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
  onSubmit,
  onCancel,
}: {
  open: boolean;
  initial?: string;
  title: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Mỗi lần mở là một ghi chú khác: nạp lại nội dung và đưa con trỏ vào ô, khỏi phải bấm thêm.
  useEffect(() => {
    if (!open) return;
    setText(initial);
    const id = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(id);
  }, [open, initial]);

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
        hint="Xuống dòng được. Ctrl + Enter để xong."
      />
    </Modal>
  );
}
