'use client';

/**
 * Ảnh chỉnh được kích thước trong trình soạn thảo bài viết (YC13).
 *
 * Kích thước được lưu vào **thuộc tính `width` của thẻ `<img>`**, không phải `style`. Đây không
 * phải lựa chọn tuỳ tiện: `html_sanitizer.py` ở máy chủ cố tình không cho `style` ở bất cứ thẻ
 * nào (đường vòng kinh điển để nhúng mã), nên nếu ghi kích thước bằng `style` thì mọi thứ biên
 * tập vừa chỉnh sẽ bị xoá sạch ngay lúc lưu. `width` nằm trong danh sách trắng nên sống sót.
 *
 * Chỉ lưu chiều rộng, không lưu chiều cao — trình duyệt tự suy ra chiều cao theo tỉ lệ gốc. Ghi
 * cả hai thì ảnh sẽ méo khi khung hiển thị hẹp hơn (điện thoại) và `max-width:100%` co chiều
 * rộng lại nhưng chiều cao vẫn đứng yên.
 */

import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { useRef, useState } from 'react';

import { cn } from '@/lib/cn';

/** Nhỏ hơn mức này thì ảnh thành vệt mờ, kéo nhầm là mất luôn nội dung. */
const MIN_WIDTH = 64;

/**
 * Bề rộng thật sự dùng được của vùng soạn thảo (đã trừ padding).
 *
 * Dùng làm mốc cho các nút phần trăm và làm trần khi kéo: cho phép rộng hơn khung thì ảnh vẫn bị
 * `max-width:100%` cắt lại, biên tập kéo mà không thấy gì thay đổi.
 */
export function editorContentWidth(editor: Editor): number {
  const dom = editor.view.dom as HTMLElement;
  const style = window.getComputedStyle(dom);
  const inner =
    dom.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
  return Math.max(inner, MIN_WIDTH);
}

/** Đặt chiều rộng cho ảnh đang chọn theo tỉ lệ khung soạn thảo; `null` = trả về kích thước gốc. */
export function setSelectedImageWidth(editor: Editor, ratio: number | null): void {
  const width = ratio === null ? null : Math.round(editorContentWidth(editor) * ratio);
  editor.chain().focus().updateAttributes('image', { width }).run();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function ImageNodeView({ node, updateAttributes, selected, editor }: NodeViewProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  // Trong lúc kéo chỉ vẽ lại tại chỗ; ghi vào tài liệu mỗi lần chuột nhích sẽ nhồi hàng trăm bước
  // vào lịch sử hoàn tác, bấm Ctrl+Z một cái không trả về được trạng thái trước khi kéo.
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const attrWidth = typeof node.attrs.width === 'number' ? node.attrs.width : null;
  const width = dragWidth ?? attrWidth;
  const editable = editor.isEditable;

  const startResize = (event: React.PointerEvent<HTMLSpanElement>, direction: 1 | -1) => {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();

    const img = imgRef.current;
    const handle = event.currentTarget;
    if (!img) return;

    const startX = event.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const maxWidth = editorContentWidth(editor);
    let latest = startWidth;

    const onMove = (e: PointerEvent) => {
      latest = clamp(startWidth + (e.clientX - startX) * direction, MIN_WIDTH, maxWidth);
      setDragWidth(latest);
    };
    const onEnd = () => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onEnd);
      handle.removeEventListener('pointercancel', onEnd);
      setDragWidth(null);
      updateAttributes({ width: Math.round(latest) });
    };

    // Bắt con trỏ vào chính tay cầm: thả ra ngoài khung soạn thảo vẫn nhận được sự kiện kết thúc,
    // nếu không ảnh sẽ kẹt ở trạng thái đang kéo.
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onEnd);
    handle.addEventListener('pointercancel', onEnd);
  };

  const handleClass =
    'absolute h-3.5 w-3.5 rounded-full border-2 border-white bg-ink-900 shadow';

  return (
    <NodeViewWrapper className="rte-image">
      <span className="relative inline-block max-w-full align-top leading-none">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={node.attrs.src}
          alt={node.attrs.alt ?? ''}
          title={node.attrs.title ?? undefined}
          draggable={false}
          style={{ width: width ? `${width}px` : undefined, maxWidth: '100%', height: 'auto' }}
          className={cn('rounded-lg', selected && 'ring-2 ring-ink-900 ring-offset-1')}
        />

        {selected && editable && (
          <>
            <span
              role="presentation"
              onPointerDown={(e) => startResize(e, -1)}
              className={cn(handleClass, 'bottom-1 left-1 cursor-nesw-resize')}
            />
            <span
              role="presentation"
              onPointerDown={(e) => startResize(e, 1)}
              className={cn(handleClass, 'bottom-1 right-1 cursor-nwse-resize')}
            />
            <span className="absolute bottom-1 left-1/2 -translate-x-1/2 rounded bg-ink-900/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
              {width ? `${Math.round(width)} px` : 'Kích thước gốc'}
            </span>
          </>
        )}
      </span>
    </NodeViewWrapper>
  );
}

/**
 * Giữ nguyên tên node `image` để `setImage`, `isActive('image')` và nội dung bài viết cũ vẫn
 * chạy đúng — đây là bản mở rộng, không phải node mới.
 */
export const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute('width');
          const value = raw ? parseInt(raw, 10) : NaN;
          return Number.isFinite(value) ? value : null;
        },
        renderHTML: (attributes) =>
          attributes.width ? { width: String(Math.round(attributes.width as number)) } : {},
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
