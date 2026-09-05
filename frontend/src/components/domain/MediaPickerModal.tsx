'use client';

/**
 * Chọn ảnh cho bài viết (YC14): tải ảnh mới hoặc dùng lại ảnh đã có trong thư viện.
 *
 * Có thư viện ảnh chứ không chỉ ô tải lên, vì cùng một biểu đồ hay logo thường được dùng lại ở
 * nhiều bài. Bắt tải lại mỗi lần vừa tốn dung lượng vừa khiến cùng một ảnh có nhiều đường dẫn
 * khác nhau, sau này muốn thay thì phải sửa từng bài.
 */

import { useRef, useState } from 'react';

import {
  Alert,
  Button,
  Icon,
  Input,
  Modal,
  Spinner,
  Tabs,
} from '@/components/ui';
import { useApiQuery, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/datetime';

export type PickedImage = { url: string; alt?: string };

type MediaItem = {
  id: number;
  url: string;
  alt_text: string | null;
  original_name: string;
  file_size: number;
  created_at: string;
};

const MAX_MB = 5;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function MediaPickerModal({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (image: PickedImage) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState('upload');

  return (
    <Modal open={open} onClose={onClose} title="Chèn ảnh" size="lg">
      <div className="space-y-4">
        <Tabs
          items={[
            { key: 'upload', label: 'Tải ảnh mới' },
            { key: 'library', label: 'Thư viện ảnh' },
          ]}
          active={tab}
          onChange={setTab}
        />

        {tab === 'upload' ? (
          <UploadPanel
            onDone={(image) => {
              onPick(image);
              onClose();
            }}
            onError={toast.error}
          />
        ) : (
          <LibraryPanel
            open={open && tab === 'library'}
            onPick={(image) => {
              onPick(image);
              onClose();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

function UploadPanel({
  onDone,
  onError,
}: {
  onDone: (image: PickedImage) => void;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [alt, setAlt] = useState('');
  const [uploading, setUploading] = useState(false);

  const choose = (picked: File | null) => {
    if (!picked) return;
    // Chặn ngay ở trình duyệt để người dùng không phải chờ tải xong mới biết ảnh quá nặng.
    if (picked.size > MAX_MB * 1024 * 1024) {
      onError(`Ảnh nặng ${formatSize(picked.size)}, vượt quá ${MAX_MB}MB. Nén lại trước khi tải.`);
      return;
    }
    setFile(picked);
    setPreview(URL.createObjectURL(picked));
    if (!alt) setAlt(picked.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' '));
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (alt.trim()) form.append('alt_text', alt.trim());

      const result = await api.upload<{ url: string; alt_text: string | null }>(
        `${ADMIN}/media`,
        form,
      );
      onDone({ url: result.url, alt: result.alt_text ?? alt.trim() });
    } catch (err) {
      onError((err as Error).message ?? 'Không tải được ảnh lên');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg"
        className="hidden"
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />

      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed',
          'border-ink-300 px-4 py-10 transition-colors hover:border-ink-500 hover:bg-ink-50',
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Xem trước" className="max-h-56 rounded-lg object-contain" />
        ) : (
          <>
            <Icon name="upload" size={28} className="text-ink-400" />
            <span className="text-sm font-medium text-ink-700">Bấm để chọn ảnh</span>
          </>
        )}
        <span className="text-xs text-ink-500">
          {file ? `${file.name} · ${formatSize(file.size)}` : `PNG hoặc JPG, tối đa ${MAX_MB}MB`}
        </span>
      </button>

      <Input
        label="Mô tả ảnh"
        value={alt}
        onChange={(e) => setAlt(e.target.value)}
        placeholder="Ví dụ: Biểu đồ ngày HPG với vùng tích luỹ tháng 6"
        hint="Hiển thị thay ảnh khi ảnh không tải được, và giúp người dùng trình đọc màn hình hiểu nội dung."
      />

      <Button
        className="w-full"
        loading={uploading}
        disabled={!file}
        onClick={() => void upload()}
      >
        Tải lên và chèn vào bài
      </Button>
    </div>
  );
}

function LibraryPanel({ open, onPick }: { open: boolean; onPick: (image: PickedImage) => void }) {
  const { data, isLoading } = useApiQuery<{ items: MediaItem[]; total: number }>(
    open ? `${ADMIN}/media` : null,
    { size: 60 },
  );

  if (isLoading) {
    return (
      <div className="py-16">
        <Spinner label="Đang tải thư viện ảnh…" />
      </div>
    );
  }

  if (!data?.items.length) {
    return (
      <Alert tone="info">
        Thư viện chưa có ảnh nào. Sang thẻ <strong>Tải ảnh mới</strong> để thêm ảnh đầu tiên.
      </Alert>
    );
  }

  return (
    <div className="grid max-h-[26rem] grid-cols-2 gap-3 overflow-y-auto overscroll-contain p-0.5 sm:grid-cols-3">
      {data.items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onPick({ url: item.url, alt: item.alt_text ?? '' })}
          className="group overflow-hidden rounded-lg border border-ink-200 text-left transition-colors hover:border-ink-900"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.url}
            alt={item.alt_text ?? item.original_name}
            className="h-28 w-full bg-ink-50 object-contain"
            loading="lazy"
          />
          <div className="border-t border-ink-100 px-2 py-1.5">
            <p className="truncate text-xs font-medium text-ink-800">
              {item.alt_text || item.original_name}
            </p>
            <p className="text-[11px] text-ink-400">
              {formatSize(item.file_size)} · {formatDate(item.created_at)}
            </p>
          </div>
        </button>
      ))}
    </div>
  );
}
