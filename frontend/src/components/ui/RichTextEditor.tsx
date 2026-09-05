'use client';

/**
 * Trình soạn thảo nội dung bài viết (YC13).
 *
 * Dùng TipTap thay vì để biên tập gõ HTML thô. Lý do không chỉ là tiện: HTML gõ tay hay thiếu
 * thẻ đóng, và một thẻ hở sẽ phá vỡ bố cục của *cả trang* khi bài được đăng lên site khách hàng.
 * Trình soạn thảo luôn sinh ra HTML cân bằng.
 *
 * Nội dung sinh ra ở đây vẫn được **máy chủ lọc lại lúc lưu** (`html_sanitizer.py`). Lọc phía
 * trình duyệt chỉ là tiện lợi; ai gọi thẳng API vẫn gửi được HTML tuỳ ý, nên tuyến phòng thủ
 * thật phải nằm ở máy chủ.
 */

import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TextAlign from '@tiptap/extension-text-align';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { cn } from '@/lib/cn';
import { Field } from './Input';
import { Icon } from './Icon';
import { ResizableImage, setSelectedImageWidth } from './ResizableImage';

export type RichTextEditorProps = {
  value: string;
  onChange: (html: string) => void;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  placeholder?: string;
  disabled?: boolean;
  minHeight?: string;
  /** Chèn ảnh: trả về đường dẫn ảnh sau khi tải lên, hoặc null nếu người dùng huỷ. */
  onRequestImage?: () => Promise<{ url: string; alt?: string } | null>;
};

export function RichTextEditor({
  value,
  onChange,
  label,
  hint,
  error,
  required,
  placeholder = 'Bắt đầu soạn nội dung bài viết…',
  disabled,
  minHeight = '24rem',
  onRequestImage,
}: RichTextEditorProps) {
  // Giữ hàm mới nhất trong ref: TipTap chỉ đọc cấu hình lúc khởi tạo, truyền thẳng sẽ đóng băng
  // phiên bản đầu tiên của `onChange` và mọi lần gõ sau đó ghi vào state cũ.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    // Next.js dựng trước trên máy chủ; bật ngay sẽ lệch giữa HTML máy chủ và máy khách.
    immediatelyRender: false,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
      }),
      Placeholder.configure({ placeholder }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
      }),
      ResizableImage.configure({ inline: false, allowBase64: false }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
    ],
    content: value,
    onUpdate: ({ editor: instance }) => {
      const html = instance.getHTML();
      // TipTap trả về "<p></p>" cho tài liệu rỗng; quy về chuỗi rỗng để phần kiểm tra bắt buộc
      // ở màn gọi không hiểu nhầm là đã có nội dung.
      onChangeRef.current(html === '<p></p>' ? '' : html);
    },
    editorProps: {
      attributes: {
        class: cn('prose-article focus:outline-none', 'px-4 py-3'),
        style: `min-height:${minHeight}`,
      },
    },
  });

  // Nạp nội dung từ ngoài vào (mở bài cũ để sửa, khôi phục bản nháp). Chỉ đặt lại khi khác thật
  // sự, nếu không mỗi lần gõ sẽ tự nạp lại và con trỏ nhảy về đầu bài.
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (value !== current && value !== (current === '<p></p>' ? '' : current)) {
      editor.commands.setContent(value || '', false);
    }
  }, [editor, value]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <Field label={label} hint={hint} error={error} required={required}>
      <div
        className={cn(
          'overflow-hidden rounded-lg border bg-surface transition-colors',
          error ? 'border-down' : 'border-ink-300 focus-within:border-ink-900',
          disabled && 'bg-ink-50',
        )}
      >
        {editor && <Toolbar editor={editor} disabled={disabled} onRequestImage={onRequestImage} />}
        <EditorContent editor={editor} />
      </div>
    </Field>
  );
}

/** Cỡ ảnh đặt sẵn, tính theo bề rộng khung soạn thảo. `null` = trả ảnh về kích thước gốc. */
const IMAGE_WIDTHS: { ratio: number | null; label: string; title: string }[] = [
  { ratio: 0.25, label: '25%', title: 'Ảnh rộng 25% khung bài viết' },
  { ratio: 0.5, label: '50%', title: 'Ảnh rộng 50% khung bài viết' },
  { ratio: 0.75, label: '75%', title: 'Ảnh rộng 75% khung bài viết' },
  { ratio: 1, label: '100%', title: 'Ảnh rộng hết khung bài viết' },
  { ratio: null, label: 'Gốc', title: 'Trả ảnh về kích thước gốc' },
];

function Toolbar({
  editor,
  disabled,
  onRequestImage,
}: {
  editor: Editor;
  disabled?: boolean;
  onRequestImage?: RichTextEditorProps['onRequestImage'];
}) {
  // Buộc vẽ lại khi con trỏ đổi vị trí, để nút đang bật/tắt phản ánh đúng đoạn đang đứng.
  const [, forceRender] = useState(0);
  useEffect(() => {
    const rerender = () => forceRender((n) => n + 1);
    editor.on('selectionUpdate', rerender);
    editor.on('transaction', rerender);
    return () => {
      editor.off('selectionUpdate', rerender);
      editor.off('transaction', rerender);
    };
  }, [editor]);

  const addLink = () => {
    const previous = editor.getAttributes('link').href as string | undefined;
    const input = window.prompt('Địa chỉ liên kết', previous ?? 'https://');
    if (input === null) return;

    if (!input.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // Người dùng hay gõ thiếu giao thức; thiếu thì trình duyệt hiểu thành đường dẫn nội bộ.
    const href = /^https?:\/\//i.test(input) || input.startsWith('mailto:') ? input : `https://${input}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
  };

  const addImage = async () => {
    if (!onRequestImage) return;
    const image = await onRequestImage();
    if (image) editor.chain().focus().setImage({ src: image.url, alt: image.alt ?? '' }).run();
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-ink-200 bg-ink-50 px-2 py-1.5">
      <Group>
        <ToolButton
          label="Đậm"
          active={editor.isActive('bold')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <span className="font-bold">B</span>
        </ToolButton>
        <ToolButton
          label="Nghiêng"
          active={editor.isActive('italic')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <span className="italic">I</span>
        </ToolButton>
        <ToolButton
          label="Gạch ngang"
          active={editor.isActive('strike')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <span className="line-through">S</span>
        </ToolButton>
        <ToolButton
          label="Mã lệnh"
          active={editor.isActive('code')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <span className="font-mono text-xs">{'</>'}</span>
        </ToolButton>
      </Group>

      <Divider />

      <Group>
        {([2, 3, 4] as const).map((level) => (
          <ToolButton
            key={level}
            label={`Tiêu đề cấp ${level - 1}`}
            active={editor.isActive('heading', { level })}
            disabled={disabled}
            onClick={() => editor.chain().focus().toggleHeading({ level }).run()}
          >
            <span className="text-xs font-semibold">H{level - 1}</span>
          </ToolButton>
        ))}
        <ToolButton
          label="Đoạn văn thường"
          active={editor.isActive('paragraph')}
          disabled={disabled}
          onClick={() => editor.chain().focus().setParagraph().run()}
        >
          <span className="text-xs">¶</span>
        </ToolButton>
      </Group>

      <Divider />

      <Group>
        <ToolButton
          label="Danh sách gạch đầu dòng"
          active={editor.isActive('bulletList')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <span className="text-xs">• —</span>
        </ToolButton>
        <ToolButton
          label="Danh sách đánh số"
          active={editor.isActive('orderedList')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <span className="text-xs">1. —</span>
        </ToolButton>
        <ToolButton
          label="Trích dẫn"
          active={editor.isActive('blockquote')}
          disabled={disabled}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <span className="text-sm">❝</span>
        </ToolButton>
        <ToolButton
          label="Đường kẻ ngang"
          disabled={disabled}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <span className="text-xs">—</span>
        </ToolButton>
      </Group>

      <Divider />

      <Group>
        <ToolButton
          label="Liên kết"
          active={editor.isActive('link')}
          disabled={disabled}
          onClick={addLink}
        >
          <Icon name="external" size={15} />
        </ToolButton>
        {onRequestImage && (
          <ToolButton label="Chèn ảnh" disabled={disabled} onClick={() => void addImage()}>
            <Icon name="upload" size={15} />
          </ToolButton>
        )}
        <ToolButton
          label="Chèn bảng 3×3"
          disabled={disabled}
          onClick={() =>
            editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
          }
        >
          <Icon name="dashboard" size={15} />
        </ToolButton>
        {editor.isActive('table') && (
          <ToolButton
            label="Xoá bảng"
            disabled={disabled}
            onClick={() => editor.chain().focus().deleteTable().run()}
          >
            <Icon name="trash" size={15} />
          </ToolButton>
        )}
      </Group>

      {/* Chỉ hiện khi đang chọn một ảnh — nhóm nút này vô nghĩa ở mọi vị trí khác. */}
      {editor.isActive('image') && (
        <>
          <Divider />
          <Group>
            {IMAGE_WIDTHS.map(({ ratio, label, title }) => (
              <ToolButton
                key={label}
                label={title}
                disabled={disabled}
                onClick={() => setSelectedImageWidth(editor, ratio)}
              >
                <span className="text-xs">{label}</span>
              </ToolButton>
            ))}
          </Group>
        </>
      )}

      <Divider />

      <Group>
        <ToolButton
          label="Hoàn tác"
          disabled={disabled || !editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
        >
          <Icon name="arrow-left" size={15} />
        </ToolButton>
        <ToolButton
          label="Làm lại"
          disabled={disabled || !editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
        >
          <Icon name="refresh" size={15} />
        </ToolButton>
        <ToolButton
          label="Xoá định dạng"
          disabled={disabled}
          onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}
        >
          <Icon name="close" size={15} />
        </ToolButton>
      </Group>
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-0.5">{children}</div>;
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-ink-300" />;
}

function ToolButton({
  children,
  label,
  active,
  disabled,
  onClick,
}: {
  children: ReactNode;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 min-w-8 items-center justify-center rounded px-1.5 transition-colors',
        active ? 'bg-ink-900 text-white' : 'text-ink-600 hover:bg-ink-200',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent',
      )}
    >
      {children}
    </button>
  );
}
