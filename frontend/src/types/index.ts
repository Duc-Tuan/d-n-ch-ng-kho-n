/** Kiểu dữ liệu dùng chung, ánh xạ 1-1 với schema của backend. */

export type Page<T> = {
  items: T[];
  total: number;
  page: number;
  size: number;
  pages: number;
};

export type Message = { message: string; code?: string | null };

export type Banner = {
  level: 'info' | 'warning' | 'danger';
  code: string;
  message: string;
  days_left?: number | null;
  action?: { label?: string; url?: string } | null;
};

/** Kết quả áp BR-001. */
export type AccessInfo = {
  allowed: boolean;
  reason: string;
  message: string;
  action: { type?: string; url?: string; [k: string]: unknown };
  banner: Banner | null;
};

export type UserProfile = {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  customer_code: string | null;
  customer_type: string;
  securities_account_no: string | null;
  ib_link_status: string;
  ib_link_deadline: string | null;
  subscription_status: string;
  compliance_status: string;
  compliance_exempt: boolean;
  warning_until: string | null;
  email_verified_at: string | null;
  last_login_at: string | null;
  broker_name: string | null;
  broker_code: string | null;
  broker_phone: string | null;
  latest_nav: number | null;
  latest_nav_date: string | null;
  last_trade_date: string | null;
  created_at: string;
};

export type SubscriptionInfo = {
  id: number;
  package_code: string;
  package_name: string;
  package_tier: number;
  starts_at: string;
  expires_at: string;
  days_remaining: number | null;
  frozen_days: number;
  is_frozen: boolean;
  payment_status: string;
};

export type SessionResponse = {
  user: UserProfile;
  subscription: SubscriptionInfo | null;
  access: AccessInfo;
};

export type StaffProfile = {
  id: number;
  username: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  totp_enabled: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  roles: string[];
  permissions: string[];
};

export type Package = {
  id: number;
  code: string;
  name: string;
  duration_months: number;
  duration_days: number;
  price: number;
  is_trial: boolean;
  tier: number;
  description: string | null;
  max_telegram_alerts: number;
  max_ai_questions_per_day: number;
};

export type Category = {
  id: number;
  code: string;
  name: string;
  type: 'ARTICLE' | 'DOCUMENT';
  sort_order: number;
};

export type Article = {
  id: number;
  title: string;
  slug: string;
  excerpt: string | null;
  content?: string | null;
  thumbnail: string | null;
  tags?: string | null;
  category_id: number;
  category_name: string | null;
  status: string;
  published_at: string | null;
  view_count: number;
  min_package_id: number | null;
  /** BR-502 — nội dung vượt gói hiện tại thì bị khoá. */
  locked: boolean;
  author_id?: number;
  updated_at?: string | null;
};

export type DocumentItem = {
  id: number;
  title: string;
  description: string | null;
  category_id: number;
  category_name: string | null;
  original_name: string;
  file_size: number;
  mime_type: string;
  download_count: number;
  min_package_id: number | null;
  locked: boolean;
  created_at: string;
};

export type DownloadTicket = {
  url: string;
  expires_at: string;
  ttl_seconds: number;
  watermarked: boolean;
};

export type StrategyStats = {
  total_trades: number;
  closed_trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  open_trades: number;
  win_rate: number | null;
  avg_r: number | null;
  max_dd: number | null;
  profit_factor: number | null;
  period_from: string | null;
  period_to: string | null;
  signal_type: string;
};

export type StrategyKind = 'RULE' | 'DOCUMENT';

export type Strategy = {
  id: number;
  code: string;
  name: string;
  school: string;
  /** RULE = bộ điều kiện tự dựng · DOCUMENT = tài liệu tải lên cho AI đọc. Hai loại tách hẳn. */
  kind: StrategyKind;
  /** Luôn `D1` — không còn chọn được ở bất kỳ đâu. */
  timeframe: string;
  description: string | null;
  rules_summary?: string | null;
  status: string;
  min_package_id: number | null;
  locked: boolean;
  symbols: string[];
  stats_live: StrategyStats | null;
  stats_backtest: StrategyStats | null;
  analyst_id?: number | null;
  created_at?: string;
};

export type Signal = {
  id: number;
  strategy_id: number;
  symbol: string;
  timeframe: string;
  signal_type: 'LIVE' | 'BACKTEST';
  direction: 'BUY' | 'SELL';
  entry_time: string;
  entry_price: number;
  sl: number | null;
  tp: number | null;
  exit_time: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  result: string;
  r_multiple: number | null;
  reason_text: string | null;
  cancel_reason: string | null;
};

export type MarkerResponse = {
  total: number;
  returned: number;
  /** BR-845 — vượt giới hạn marker, FE phải cảnh báo và gợi ý thu hẹp khoảng thời gian. */
  truncated: boolean;
  max_markers: number;
  signals: Signal[];
  legend: Record<string, string>;
  disclaimer: string;
};

export type NotificationItem = {
  id: number;
  code: string;
  channel: string;
  subject: string | null;
  body: string | null;
  status: string;
  read_at: string | null;
  created_at: string;
};

export type NotificationPreference = {
  code: string;
  channel: string;
  enabled: boolean;
  /** BR-815 — nhóm bắt buộc, không cho tắt. */
  locked: boolean;
  label: string | null;
};

export type TelegramStatus = {
  status: string;
  chat_id: number | null;
  telegram_username: string | null;
  verified_at: string | null;
  last_error: string | null;
  usage: { used: number; quota: number; unlimited: boolean };
};

export type StrategyAlert = {
  id: number;
  strategy_id: number;
  strategy_name: string | null;
  symbol: string;
  alert_types: { types?: string[] } | null;
  is_active: boolean;
  inactive_reason: string | null;
  created_at: string;
};

export type NavPoint = {
  trade_date: string;
  nav: number;
  last_trade_date: string | null;
};

export type CustomerListItem = {
  id: number;
  email: string;
  full_name: string;
  phone: string | null;
  customer_code: string | null;
  customer_type: string;
  securities_account_no: string | null;
  package_name: string | null;
  expires_at: string | null;
  latest_nav: number | null;
  latest_nav_date: string | null;
  last_trade_date: string | null;
  subscription_status: string;
  compliance_status: string;
  compliance_exempt: boolean;
  warning_until: string | null;
  last_login_at: string | null;
  created_at: string;
  days_until_suspend?: number | null;
  broker_name?: string | null;
  broker_phone?: string | null;
};

export type DashboardStats = {
  accounts: Record<string, any>;
  revenue: Record<string, any>;
  compliance: Record<string, any>;
  content: Record<string, any>;
  last_sync: SyncJob | null;
  alerts: Array<{ level: string; message: string; action?: string }>;
};

export type SyncJob = {
  id: number;
  job_type: string;
  run_date: string;
  status: string;
  rows_read: number;
  rows_matched: number;
  rows_unmatched: number;
  rows_written: number;
  error_message: string | null;
  summary: Record<string, any> | null;
  started_at: string;
  finished_at: string | null;
  triggered_by: string;
};

export type AuditLog = {
  id: number;
  actor_id: number | null;
  actor_name: string | null;
  actor_type: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  old_value: Record<string, any> | null;
  new_value: Record<string, any> | null;
  reason: string | null;
  ip: string | null;
  created_at: string;
};

export type StaffListItem = {
  id: number;
  username: string;
  email: string;
  full_name: string;
  phone: string | null;
  status: string;
  totp_enabled: boolean;
  last_login_at: string | null;
  roles: string[];
  created_at: string;
};

export type Role = {
  id: number;
  code: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
};

export type Permission = { code: string; name: string; module: string };

export type LegalDocument = {
  id: number;
  type: string;
  version: string;
  title: string;
  content: string | null;
  effective_from: string;
  is_current: boolean;
  requires_reconsent: boolean;
  summary_of_changes: string | null;
};

export type ComplianceDetail = {
  applicable: boolean;
  reason_not_applicable: string | null;
  compliance_status: string;
  warning_until: string | null;
  suspended_reason: string | null;
  rules: {
    nav_min: number;
    nav_window_sessions: number;
    no_trade_days: number;
    warning_days: number;
    description: string;
  };
  current: {
    nav_avg: number | null;
    sessions_counted: number;
    latest_nav: number | null;
    latest_nav_date: string | null;
    last_trade_date: string | null;
    has_data: boolean;
  };
  events: Array<{
    id: number;
    event: string;
    from_status: string | null;
    to_status: string | null;
    reason: string | null;
    nav_avg_20: number | null;
    days_since_last_trade: number | null;
    triggered_by: string;
    created_at: string;
  }>;
};

// ---------- Dữ liệu thị trường (Phần 12) ----------
export type SymbolInfo = {
  id: number;
  symbol: string;
  exchange: string;
  company_name: string | null;
  last_ohlcv_date: string | null;
};

export type Candle = {
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type OhlcvResponse = {
  symbol: string;
  resolution: string;
  candles: Candle[];
  /** BR-836 — ghi nguồn dữ liệu dưới bảng giá và biểu đồ. */
  attribution: string;
};

export type PriceBoardItem = {
  symbol: string;
  exchange: string;
  company_name: string | null;
  trade_date: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  reference: number | null;
  change: number | null;
  change_pct: number | null;
  has_data: boolean;
};

export type PriceBoardResponse = {
  items: PriceBoardItem[];
  exchange: string;
  attribution: string;
  realtime: boolean;
  note: string;
};

// ======================================================================
// Máy chạy chiến lược (YC10–YC12)
// ======================================================================

/** Một vế của điều kiện: chỉ báo (có `key`) hoặc hằng số (có `value`). */
export type RuleOperand = {
  key?: string;
  params?: Record<string, number>;
  value?: number | null;
};

export type RuleCondition = {
  left: RuleOperand;
  operator: string;
  right: RuleOperand;
};

export type RuleGroup = {
  logic: 'AND' | 'OR';
  conditions: RuleCondition[];
};

export type RuleRisk = {
  stop_loss_pct?: number | null;
  take_profit_pct?: number | null;
  max_hold_days?: number;
};

export type StrategyRules = {
  direction: 'BUY' | 'SELL';
  entry: RuleGroup;
  exit: RuleGroup;
  risk: RuleRisk;
};

export type IndicatorMeta = {
  key: string;
  label: string;
  params: Array<{ name: string; default: number }>;
};

export type RuleCatalog = {
  indicators: IndicatorMeta[];
  operators: Array<{ key: string; label: string }>;
  logics: Array<{ key: string; label: string }>;
  directions: Array<{ key: string; label: string }>;
  min_bars: number;
};

/** Điểm mua/bán vẽ lên biểu đồ. `note` là null khi người xem không được biết quy tắc (BR-848). */
export type RunMarker = {
  trade_date: string;
  kind: 'ENTRY' | 'EXIT';
  direction: 'BUY' | 'SELL';
  price: number;
  label: string;
  note: string | null;
};

export type RunTrade = {
  direction: 'BUY' | 'SELL';
  entry_date: string;
  entry_price: number;
  exit_date: string | null;
  exit_price: number | null;
  exit_reason: string | null;
  exit_reason_label: string | null;
  profit_pct: number | null;
  r_multiple: number | null;
  bars_held: number;
  is_open: boolean;
};

export type RunStats = {
  total_trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_profit_pct: number | null;
  best_pct: number | null;
  worst_pct: number | null;
  profit_factor: number | null;
  max_drawdown_pct: number | null;
  total_return_pct: number | null;
  avg_bars_held: number | null;
  open_trades: number;
};

export type StrategyRunResult = {
  symbol: string;
  from_date: string;
  to_date: string;
  bars: number;
  direction: 'BUY' | 'SELL';
  markers: RunMarker[];
  trades: RunTrade[];
  stats: RunStats;
  warnings: string[];
  signal_type: 'BACKTEST';
  disclaimer: string;
  /** Null khi người xem không có quyền xem quy tắc — chiến lược của hệ thống (BR-848). */
  summary: string | null;
  overlays: Array<{ label: string; points: Array<{ trade_date: string; value: number }> }>;
  strategy?: { id: number; code: string; name: string; school: string; is_system: boolean };
};

// ======================================================================
// PHÂN TÍCH THEO YÊu CẦU — khách bấm nút, kết quả dùng chung theo ngày
// ======================================================================
export type AnalysisStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';

/** Một kịch bản vào lệnh. Một bản có thể có nhiều kịch bản, **cả mua lẫn bán**. */
export type AnalysisSetup = {
  id: number;
  direction: 'BUY' | 'SELL';
  entry_price: number;
  sl: number | null;
  tp: number | null;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  note: string | null;
};

/** Bài viết doanh nghiệp gắn kèm kết quả phân tích — nối với mã bằng ô Thẻ của bài viết. */
export type RelatedArticle = {
  id: number;
  title: string;
  slug: string;
  excerpt: string | null;
  published_at: string | null;
  /** Bài thuộc gói cao hơn gói hiện tại: vẫn hiện tên, mở ra mới bị chặn (BR-502). */
  locked: boolean;
};

export type Analysis = {
  id: number;
  analysis_date: string;
  /** `null` = phân tích theo biểu đồ ở màn bảng giá, không gắn chiến lược nào. */
  strategy_id: number | null;
  strategy_name: string | null;
  symbol: string;
  source: 'ENGINE' | 'AI';
  status: AnalysisStatus;

  title: string | null;
  /** HTML đã lọc ở máy chủ lúc lưu — render bằng `dangerouslySetInnerHTML` được. */
  summary: string | null;
  /**
   * Lý do phân tích — **văn bản thuần, không phải HTML**. Khác `summary`, chuỗi này không
   * đi qua `html_sanitizer` ở máy chủ, nên tuyệt đối không `dangerouslySetInnerHTML`.
   */
  rationale: string | null;

  setups: AnalysisSetup[];
  /** Bài viết có thẻ trùng mã. Rỗng là bình thường — phần lớn mã chưa có bài nào. */
  related_articles: RelatedArticle[];
  /** Tên các chỉ báo mà bản phân tích theo biểu đồ đã dựa vào. Rỗng với bản theo chiến lược. */
  used_indicators?: string[];
  /** Lời dặn khách gửi kèm lúc bấm Phân tích. Rỗng nghĩa là không dặn gì. */
  note?: string;

  started_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
  error_message: string | null;
  view_count: number;
  created_at: string;
  disclaimer?: string;
};

/**
 * Một ngày đã có bản phân tích cho cặp (chiến lược, mã) — mục trong ô chọn ngày.
 *
 * Chỉ đủ để vẽ danh sách chọn; nội dung của ngày được chọn lấy bằng một lượt gọi riêng.
 */
export type AnalysisDay = {
  id: number;
  /** `YYYY-MM-DD` theo giờ Việt Nam — chính là tham số `date` gửi lên khi xem lại. */
  analysis_date: string;
  source: 'ENGINE' | 'AI';
  title: string | null;
  setup_count: number;
};

/** Hạn mức chạy AI trong ngày của một tài khoản. */
export type AnalysisQuota = { used: number; limit: number; remaining: number };

export type AnalysisRequestResult = {
  analysis: Analysis;
  /** `true` = lượt bấm này khởi động một mẻ mới (có trừ hạn mức). */
  started: boolean;
  quota: AnalysisQuota;
};

// ======================================================================
// TIN TỨC DẪN NGUỒN
// ======================================================================
export type NewsItem = {
  id: number;
  title: string;
  summary: string | null;
  /** Đường dẫn bài gốc — bấm vào tin là sang thẳng trang của họ. */
  url: string;
  /** Ảnh đại diện lấy từ thẻ og:image. Ảnh vẫn nằm bên trang nguồn, hệ thống chỉ giữ đường dẫn. */
  image_url: string | null;
  source_name: string | null;
  published_at: string | null;
  is_active: boolean;
  sort_order: number;
  click_count: number;
  created_at: string;
  /** Có giá trị nghĩa là tin do job kéo về; null là nhân viên nhập tay. */
  source_id: number | null;
};

/** Một trang chuyên mục (hoặc feed) mà job `sync_news` dò bài mới mỗi ngày. */
export type NewsSource = {
  id: number;
  name: string;
  url: string;
  is_active: boolean;
  max_items: number;
  /**
   * PENDING | RUNNING | SUCCESS | PARTIAL | FAILED — null là chưa chạy lần nào.
   * Hai giá trị đầu nghĩa là lượt chạy còn dở; giao diện dựa vào đó để vẽ tiến trình.
   */
  last_status: string | null;
  last_error: string | null;
  /** Mốc bắt đầu lượt gần nhất. Các nguồn cùng một lượt có cùng mốc này. */
  last_started_at: string | null;
  /** Mốc kết thúc lượt gần nhất. */
  last_fetched_at: string | null;
  /** Số tin thêm được riêng ở lượt gần nhất; `item_count` là tổng cộng dồn. */
  last_added: number;
  item_count: number;
  created_at: string;
};

