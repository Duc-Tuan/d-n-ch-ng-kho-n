'use client';

/**
 * Ô chọn tự dựng — thay cho `<select>` của trình duyệt.
 *
 * Vì sao không dùng thẻ gốc: phần danh sách xổ ra của `<select>` do **hệ điều hành** vẽ, không
 * phải trình duyệt. Nó không nhận CSS, nên trên cùng một màn hình nó lệch hẳn khỏi phần còn lại
 * của giao diện: font khác, bo góc khác, màu chọn khác, và trên Windows thì cao 16px giữa những
 * ô nhập cao 44px. Không có thuộc tính nào sửa được điều đó.
 *
 * Bù lại, thẻ gốc cho sẵn khá nhiều thứ mà bản tự dựng phải làm lại cho đủ — nếu thiếu thì đây
 * là một bước lùi về khả năng dùng được, không phải một bước tiến về thẩm mỹ:
 *
 * * **Bàn phím**: Enter/Space mở, mũi tên di chuyển, Enter chọn, Esc đóng, Home/End nhảy đầu
 *   cuối, và gõ chữ để nhảy tới mục bắt đầu bằng chữ đó.
 * * **Trình đọc màn hình**: vai trò `combobox` + `listbox`, `aria-activedescendant` để người
 *   dùng nghe được mục đang trỏ tới.
 * * **Tiêu điểm**: đóng danh sách thì tiêu điểm quay lại nút, không rơi về đầu trang.
 * * **Vị trí**: gần đáy màn hình thì mở lên trên thay vì bị cắt.
 *
 * Danh sách được vẽ bằng portal ra `document.body` với `position: fixed`, **không** đặt tuyệt đối
 * trong phần tử cha — giống `Tooltip` và vì cùng một lý do, cộng thêm một lý do nữa: phần tử đặt
 * tuyệt đối vẫn tính vào vùng cuộn của tổ tiên, nên trong thân modal (`overflow-y-auto`) chỉ cần
 * mở danh sách là nội dung modal sinh thanh cuộn và nhảy chỗ.
 *
 * API giữ **nguyên** hình dạng của thẻ gốc (`value` + `onChange` với `event.target.value`) để
 * ba mươi bảy chỗ đang dùng không phải sửa dòng nào.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/cn';
import { Field } from './Input';
import { Icon } from './Icon';

export type SelectOption = { value: string | number; label: string; disabled?: boolean };

/** Hình dạng tối thiểu của sự kiện `<select>` — đủ cho `(e) => e.target.value`. */
export type SelectChangeEvent = { target: { value: string; name?: string } };

/** Toạ độ khung nhìn của danh sách. Mở lên trên thì neo `bottom`, mở xuống thì neo `top`. */
type Placement = {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
};

/** Chừa lại quanh mép khung nhìn để danh sách không dính sát cạnh màn hình. */
const VIEWPORT_MARGIN = 8;
/** Khoảng hở giữa ô chọn và danh sách. */
const ANCHOR_GAP = 4;

export type SelectProps = {
  options: SelectOption[];
  value?: string | number | null;
  onChange?: (event: SelectChangeEvent) => void;
  placeholder?: string;
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  /** Số mục hiển thị trước khi danh sách bắt đầu cuộn. */
  maxVisible?: number;
};

export function Select({
  options,
  value,
  onChange,
  placeholder = 'Chọn…',
  label,
  hint,
  error,
  required,
  disabled,
  name,
  id,
  className,
  maxVisible = 8,
}: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const listId = `${selectId}-list`;

  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [mounted, setMounted] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Bộ đệm cho việc gõ chữ để nhảy tới mục — xoá sau một giây không gõ. */
  const typeahead = useRef({ query: '', timer: 0 });

  const current = value === null || value === undefined ? '' : String(value);
  const selectedIndex = useMemo(
    () => options.findIndex((o) => String(o.value) === current),
    [options, current],
  );
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : '';

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setActiveIndex(-1);
    if (refocus) buttonRef.current?.focus();
  }, []);

  /** Đo lại chỗ đặt danh sách theo vị trí hiện tại của nút trong khung nhìn. */
  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;

    const wanted = maxVisible * 40; // 2.5rem mỗi mục
    const spaceBelow = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;
    // Không đủ chỗ bên dưới mà bên trên rộng hơn thì mở lên trên — nếu không, những mục
    // cuối nằm ngoài màn hình và người dùng không biết là có.
    const dropUp = spaceBelow < Math.min(wanted, 260) && spaceAbove > spaceBelow;

    setPlacement({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(80, Math.min(wanted, dropUp ? spaceAbove : spaceBelow)),
      ...(dropUp
        ? { bottom: window.innerHeight - rect.top + ANCHOR_GAP }
        : { top: rect.bottom + ANCHOR_GAP }),
    });
  }, [maxVisible]);

  const openList = useCallback(() => {
    if (disabled) return;
    place();
    setOpen(true);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
  }, [disabled, place, selectedIndex]);

  const pick = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange?.({ target: { value: String(option.value), name } });
      close();
    },
    [options, onChange, name, close],
  );

  /** Mục kế tiếp theo hướng `step`, bỏ qua mục bị vô hiệu hoá. */
  const step = useCallback(
    (from: number, direction: 1 | -1) => {
      const total = options.length;
      if (!total) return -1;
      for (let i = 1; i <= total; i += 1) {
        const next = (from + direction * i + total * i) % total;
        if (!options[next]?.disabled) return next;
      }
      return from;
    },
    [options],
  );

  useEffect(() => setMounted(true), []);

  // Đóng khi bấm ra ngoài. Dùng cả `touchstart` — trên điện thoại không có `mousedown` (BR-821).
  // Danh sách nằm ở portal nên không thuộc `rootRef`, phải kiểm tra riêng.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);  // bấm ra ngoài là đang chuyển đi nơi khác, đừng kéo tiêu điểm về
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [open, close]);

  // Toạ độ `fixed` hết đúng ngay khi có thứ gì đó cuộn hoặc cửa sổ đổi kích thước. Bám theo nút
  // thay vì đóng danh sách: người dùng thường cuộn bằng bánh xe đúng lúc đang chọn.
  useEffect(() => {
    if (!open) return;
    const update = () => place();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, place]);

  // Giữ mục đang trỏ tới trong tầm nhìn khi di chuyển bằng bàn phím.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  function jumpToTyped(char: string) {
    window.clearTimeout(typeahead.current.timer);
    typeahead.current.query += char.toLowerCase();
    typeahead.current.timer = window.setTimeout(() => {
      typeahead.current.query = '';
    }, 1000);

    const query = typeahead.current.query;
    const found = options.findIndex(
      (o) => !o.disabled && o.label.toLowerCase().startsWith(query),
    );
    if (found >= 0) {
      if (open) setActiveIndex(found);
      else pick(found);
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        if (!open) {
          openList();
          return;
        }
        setActiveIndex((i) => step(i < 0 ? selectedIndex : i, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      case 'Home':
      case 'End': {
        if (!open) return;
        event.preventDefault();
        setActiveIndex(event.key === 'Home' ? step(-1, 1) : step(0, -1));
        return;
      }
      case 'Enter':
      case ' ': {
        event.preventDefault();
        if (open) pick(activeIndex);
        else openList();
        return;
      }
      case 'Escape': {
        if (!open) return;
        event.preventDefault();
        // Chặn luôn ở đây: `Modal` nghe Escape ở cấp cửa sổ, không chặn thì một lần bấm vừa
        // đóng danh sách vừa đóng cả hộp thoại và người dùng mất phần đã nhập.
        event.stopPropagation();
        close();
        return;
      }
      case 'Tab': {
        // Tab là rời khỏi trường — đóng danh sách nhưng để tiêu điểm đi tiếp bình thường.
        if (open) close(false);
        return;
      }
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          jumpToTyped(event.key);
        }
    }
  }

  return (
    <Field label={label} hint={hint} error={error} required={required} htmlFor={selectId}>
      <div ref={rootRef} className="relative">
        <button
          ref={buttonRef}
          id={selectId}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          disabled={disabled}
          onClick={() => (open ? close() : openList())}
          onKeyDown={onKeyDown}
          className={cn(
            'flex h-touch w-full items-center justify-between gap-2 rounded-lg border bg-surface',
            'px-3 text-left text-base transition-colors sm:text-sm',
            // Cùng quy ước với `Input`: không có dấu hiệu focus trực quan.
            'focus:outline-none',
            'disabled:cursor-not-allowed disabled:bg-ink-50 disabled:text-ink-500',
            error ? 'border-tone-red-fg' : 'border-line-strong hover:border-ink-400',
            className,
          )}
        >
          <span className={cn('truncate', selectedLabel ? 'text-ink-900' : 'text-ink-400')}>
            {selectedLabel || placeholder}
          </span>
          <Icon
            name="chevron-down"
            size={16}
            className={cn(
              'shrink-0 text-ink-400 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>

        {/* Giá trị vẫn được gửi kèm khi ô nằm trong một <form> gửi theo cách truyền thống. */}
        {name && <input type="hidden" name={name} value={current} />}

        {open &&
          mounted &&
          placement &&
          createPortal(
            <ul
              ref={listRef}
              id={listId}
              role="listbox"
              aria-labelledby={selectId}
              style={{
                position: 'fixed',
                left: placement.left,
                top: placement.top,
                bottom: placement.bottom,
                width: placement.width,
                maxHeight: placement.maxHeight,
              }}
              className={cn(
                // z-[110]: trên cả modal (z-100) vì ô chọn hay nằm trong hộp thoại.
                'z-[110] overflow-y-auto overscroll-contain rounded-lg border border-ink-200',
                'bg-surface-raised py-1 shadow-pop',
              )}
            >
              {options.length === 0 && (
                <li className="px-3 py-2 text-sm text-ink-500">Không có lựa chọn nào</li>
              )}
              {options.map((option, index) => {
                const isSelected = String(option.value) === current;
                return (
                  <li
                    key={option.value}
                    id={`${listId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    // `onMouseDown` chứ không phải `onClick`: `mousedown` chạy trước khi nút mất
                    // tiêu điểm, nên không có khoảnh khắc danh sách đóng ngay dưới con trỏ.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(index);
                    }}
                    onMouseEnter={() => !option.disabled && setActiveIndex(index)}
                    className={cn(
                      'flex min-h-touch cursor-pointer items-center justify-between gap-2 px-3 py-2',
                      'text-base sm:min-h-0 sm:py-1.5 sm:text-sm',
                      option.disabled && 'cursor-not-allowed text-ink-400',
                      !option.disabled && index === activeIndex && 'bg-ink-100',
                      isSelected ? 'font-medium text-ink-900' : 'text-ink-700',
                    )}
                  >
                    <span className="truncate">{option.label}</span>
                    {isSelected && (
                      <Icon name="check" size={15} className="shrink-0 text-ink-900" />
                    )}
                  </li>
                );
              })}
            </ul>,
            document.body,
          )}
      </div>
    </Field>
  );
}
