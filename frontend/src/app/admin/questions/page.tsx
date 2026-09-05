'use client';

import { useState } from 'react';

import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Modal,
  PageHeader,
  Pagination,
  SearchInput,
  Spinner,
  Tabs,
  Textarea,
} from '@/components/ui';
import { useApiMutation, useApiQuery, usePagination, useStaffSession, useToast } from '@/hooks';
import { ADMIN, api } from '@/lib/api';
import { formatDateTime, fromNow } from '@/lib/datetime';
import type { Message, Page } from '@/types';

const TABS = [
  { key: 'PENDING', label: 'Chờ trả lời' },
  { key: 'overdue', label: 'Quá hạn SLA' },
  { key: 'mine', label: 'Được phân cho tôi' },
  { key: 'ANSWERED', label: 'Đã trả lời' },
];

export default function AdminQuestionsPage() {
  const toast = useToast();
  const { can } = useStaffSession();
  const [tab, setTab] = useState('PENDING');
  const [answering, setAnswering] = useState<any>(null);
  const [search, setSearch] = useState('');
  const { page, size, setPage, setSize, reset } = usePagination(20);

  const params: Record<string, unknown> = { page, size, q: search || undefined };
  if (tab === 'overdue') params.overdue_only = true;
  else if (tab === 'mine') params.mine_only = true;
  else params.status = tab;

  const { data, isLoading, refresh } = useApiQuery<Page<any>>(`${ADMIN}/questions`, params);

  const overdueCount = (data?.items ?? []).filter((q) => q.overdue).length;

  return (
    <div className="flex h-full flex-col space-y-3">
      <PageHeader
        title="Hỏi đáp chiến lược"
        description="Hàng chờ câu hỏi của khách hàng, cam kết trả lời trong 24 giờ làm việc"
        infoTitle="Ràng buộc khi trả lời câu hỏi"
        info={
          <>
            {/* BR-850 / BR-858 — hai ràng buộc quan trọng nhất khi trả lời. */}
            <p>
              Câu hỏi của khách hàng là <strong>riêng tư</strong> — chỉ người hỏi nhìn thấy. Khi
              công khai thành FAQ, hệ thống <strong>ẩn danh người hỏi</strong> và chỉ tài khoản có
              quyền xuất bản nội dung mới được duyệt công khai: một câu trả lời vội, khi công khai,
              trở thành nội dung tư vấn phát ra toàn bộ khách hàng.
            </p>
            {/* BR-857 — hàng chờ tồn đọng làm mất niềm tin nhanh hơn bất cứ lỗi kỹ thuật nào. */}
            <p>
              Cam kết SLA <strong>24 giờ làm việc</strong> được hiển thị công khai với khách hàng.
              Câu quá hạn có thẻ đỏ “Quá hạn SLA” — ưu tiên trả lời trước.
            </p>
          </>
        }
      />

      {/* Cảnh báo quá hạn giữ lại ngoài màn: đây là việc cần làm ngay, không phải kiến thức nền. */}
      {overdueCount > 0 && (
        <Alert tone="danger" title={`${overdueCount} câu hỏi đã quá hạn cam kết 24 giờ`}>
          Ưu tiên trả lời các câu này trước.
        </Alert>
      )}

      <Tabs
        items={TABS}
        active={tab}
        onChange={(key) => {
          setTab(key);
          reset();
        }}
      />

      <SearchInput
        className="shrink-0"
        placeholder="Nội dung câu hỏi, câu trả lời, mã khách hàng…"
        value={search}
        onSearch={(value) => {
          setSearch(value);
          reset();
        }}
      />

      {isLoading ? (
        <div className="py-16">
          <Spinner label="Đang tải…" />
        </div>
      ) : !data?.items.length ? (
        <EmptyState
          title={
            search ? 'Không có câu hỏi nào khớp từ khoá' : 'Không có câu hỏi nào trong mục này'
          }
        />
      ) : (
        <>
          {/* Hàng chờ lấp đầy phần trống còn lại và tự cuộn — tab, ô tìm kiếm và thanh phân
              trang luôn ở trong tầm mắt, không phụ thuộc số đo căn tay. */}
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
            {data.items.map((question) => (
              <Card key={question.id}>
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone="blue">{question.strategy_name}</Badge>
                        {question.signal_id && (
                          <Badge tone="gray">Về lệnh #{question.signal_id}</Badge>
                        )}
                        {question.overdue && <Badge tone="red">Quá hạn SLA</Badge>}
                        {question.is_public && <Badge tone="green">Đã công khai</Badge>}
                      </div>
                      <p className="mt-2 text-sm text-ink-900">{question.question}</p>
                      <p className="mt-1 text-xs text-ink-500">
                        {/* BR-850 — hiển thị mã KH thay vì email, hạn chế phơi bày dữ liệu cá nhân. */}
                        {question.customer_code ?? `KH #${question.user_id}`} ·{' '}
                        {fromNow(question.created_at)}
                        {question.sla_due_at &&
                          question.status === 'PENDING' &&
                          ` · Hạn trả lời ${formatDateTime(question.sla_due_at)}`}
                      </p>
                    </div>

                    {can('qa.answer') && question.status === 'PENDING' && (
                      <Button size="sm" onClick={() => setAnswering(question)}>
                        Trả lời
                      </Button>
                    )}
                  </div>

                  {question.answer && (
                    <div className="rounded-lg bg-ink-100 p-3">
                      <p className="text-xs font-medium text-ink-900">
                        Trả lời · {formatDateTime(question.answered_at)}
                      </p>
                      <p className="mt-1 whitespace-pre-line text-sm text-ink-700">
                        {question.answer}
                      </p>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>

          <Pagination
            page={data.page}
            pages={data.pages}
            total={data.total}
            size={data.size}
            onPageChange={setPage}
            onSizeChange={setSize}
          />
        </>
      )}

      {answering && (
        <AnswerModal
          question={answering}
          canPublish={can('content.publish')}
          onClose={() => setAnswering(null)}
          onAnswered={(message) => {
            toast.success(message);
            setAnswering(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AnswerModal({
  question,
  canPublish,
  onClose,
  onAnswered,
}: {
  question: any;
  canPublish: boolean;
  onClose: () => void;
  onAnswered: (message: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [makePublic, setMakePublic] = useState(false);

  const submit = useApiMutation<Message, { answer: string; make_public: boolean }>((body) =>
    api.post<Message>(`${ADMIN}/questions/${question.id}/answer`, body),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title="Trả lời câu hỏi"
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Huỷ
          </Button>
          <Button
            loading={submit.loading}
            disabled={answer.trim().length < 5}
            onClick={async () => {
              const result = await submit.mutate({
                answer: answer.trim(),
                make_public: makePublic,
              });
              if (result) onAnswered(result.message);
            }}
          >
            Gửi trả lời
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {submit.error && <Alert tone="danger">{submit.error.message}</Alert>}

        <div className="rounded-lg bg-ink-50 p-3">
          <p className="text-xs font-medium text-ink-500">
            Câu hỏi · {question.strategy_name}
          </p>
          <p className="mt-1 text-sm text-ink-800">{question.question}</p>
        </div>

        <Textarea
          label="Nội dung trả lời"
          placeholder="Trả lời câu hỏi của khách hàng…"
          required
          rows={7}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          hint="Giải thích chiến lược hoạt động như thế nào. Tránh đưa ra khuyến nghị mua bán cụ thể cho tình huống riêng của khách hàng."
        />

        {/* BR-851 — ranh giới giữa cung cấp thông tin và tư vấn đầu tư. */}
        <Alert tone="warning" title="Lưu ý về ranh giới nội dung">
          Trả lời nên tập trung giải thích <strong>quy tắc và cách chiến lược vận hành</strong>. Với
          các câu hỏi kiểu “tôi có nên mua mã X không” hay “danh mục tôi đang lỗ, nên cắt chưa”, hãy
          hướng khách hàng liên hệ môi giới phụ trách thay vì trả lời trực tiếp.
        </Alert>

        {canPublish ? (
          <Checkbox
            checked={makePublic}
            onChange={(e) => setMakePublic(e.target.checked)}
            label={
              <>
                Công khai thành câu hỏi thường gặp của chiến lược này{' '}
                <span className="block text-xs text-ink-500">
                  Người hỏi được ẩn danh. Nội dung sẽ hiển thị với mọi khách hàng xem chiến lược.
                </span>
              </>
            }
          />
        ) : (
          <p className="text-xs text-ink-500">
            Bạn không có quyền xuất bản nội dung nên không thể công khai câu trả lời thành FAQ.
          </p>
        )}
      </div>
    </Modal>
  );
}
