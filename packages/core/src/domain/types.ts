// Domain vocabulary. Every union here is backed by a const array so the same list
// can drive SQL CHECK constraints, zod enums and UI pickers without drifting.

export const CHANNELS = [
  'facebook',
  'instagram',
  'threads',
  'x',
  'linkedin',
  'tiktok',
  'youtube',
  'pinterest',
  'bluesky',
  'mastodon',
  'telegram',
  'google_business',
] as const;
export type Channel = (typeof CHANNELS)[number];

export const PROVIDER_IDS = ['buffer', 'meta', 'bluesky', 'mastodon', 'youtube', 'telegram'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PLANS = ['starter', 'pro', 'agency'] as const;
export type Plan = (typeof PLANS)[number];

export const CONNECTION_STATUSES = ['active', 'needs_reauth', 'revoked', 'error'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];
/** social_accounts.status uses the same enum as provider_connections.status. */
export type AccountStatus = ConnectionStatus;

export const POST_STATUSES = [
  'generating',
  'draft_failed',
  'pending_approval',
  'approved',
  'scheduled',
  'publishing',
  'published',
  'partially_published',
  'failed',
  'rejected',
  'cancelled',
] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

export const POST_SOURCES = ['telegram', 'web', 'ai', 'api'] as const;
export type PostSource = (typeof POST_SOURCES)[number];

export const POST_TARGET_STATUSES = [
  'draft',
  'scheduled',
  'queued',
  'publishing',
  'published',
  'failed',
  'cancelled',
] as const;
export type PostTargetStatus = (typeof POST_TARGET_STATUSES)[number];

export const COMMENT_STATUSES = [
  'new',
  'triaging',
  'needs_review',
  'suggested',
  'replied',
  'auto_replied',
  'ignored',
  'hidden',
  'error',
] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

export const REPLY_ORIGINS = ['ai_suggested', 'ai_auto', 'human'] as const;
export type ReplyOrigin = (typeof REPLY_ORIGINS)[number];

export const REPLY_STATUSES = ['draft', 'approved', 'sending', 'sent', 'failed', 'discarded'] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

export const KNOWLEDGE_SOURCE_KINDS = ['website', 'document', 'faq', 'catalog', 'text'] as const;
export type KnowledgeSourceKind = (typeof KNOWLEDGE_SOURCE_KINDS)[number];

export const KNOWLEDGE_SOURCE_STATUSES = ['pending', 'ingesting', 'ready', 'failed'] as const;
export type KnowledgeSourceStatus = (typeof KNOWLEDGE_SOURCE_STATUSES)[number];

export const CONTENT_REQUEST_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type ContentRequestStatus = (typeof CONTENT_REQUEST_STATUSES)[number];

export const CHAT_SESSION_MODES = ['awaiting_edit', 'awaiting_schedule', 'awaiting_reply_edit'] as const;
export type ChatSessionMode = (typeof CHAT_SESSION_MODES)[number];

export const RISK_FLAGS = [
  'complaint',
  'refund',
  'billing',
  'legal',
  'medical',
  'threat',
  'harassment',
  'self_harm',
  'personal_data',
  'competitor',
  'pricing_dispute',
  'spam',
  'off_topic',
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

export const REPLY_INTENTS = ['question', 'praise', 'complaint', 'purchase_intent', 'support', 'spam', 'other'] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

/** Classification of a failed external call; drives whether a retry is allowed. */
export const ERROR_KINDS = [
  'auth',
  'permission',
  'rate_limit',
  'invalid',
  'transient',
  'not_found',
  'interrupted',
  'unknown',
] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function isPlan(value: unknown): value is Plan {
  return typeof value === 'string' && (PLANS as readonly string[]).includes(value);
}

export function isRiskFlag(value: unknown): value is RiskFlag {
  return typeof value === 'string' && (RISK_FLAGS as readonly string[]).includes(value);
}

/** One uploaded or remote asset attached to a post (posts.media entries). */
export interface MediaItem {
  url: string;
  key: string | null;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
  altText?: string | null;
}

// ---------------------------------------------------------------------------
// Row types. Field names and nullability mirror db/migrations exactly.
// bigint/bigserial columns arrive as strings from postgres.js.
// ---------------------------------------------------------------------------

export interface ClientRow {
  id: string;
  name: string;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  fb_page_id: string | null;
  fb_page_name: string | null;
  ig_user_id: string | null;
  ig_username: string | null;
  meta_token_enc: Uint8Array | null;
  meta_connected_at: Date | null;
  timezone: string;
  default_platforms: string[];
  plan: Plan;
  plan_overrides: Record<string, unknown>;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface BrandProfileRow {
  client_id: string;
  business_description: string;
  voice: string;
  audience: string;
  language: string;
  default_cta: string;
  hashtags: string[];
  banned_words: string[];
  emoji_policy: string;
  sample_posts: string;
  updated_at: Date;
}

export interface PostRow {
  id: string;
  client_id: string;
  brief: string;
  source: PostSource;
  source_media_url: string | null;
  media: MediaItem[];
  link_url: string | null;
  campaign_id: string | null;
  platforms: string[];
  status: PostStatus;
  current_version: number;
  publish_at: Date | null;
  approved_at: Date | null;
  published_at: Date | null;
  fb_post_id: string | null;
  fb_permalink: string | null;
  ig_container_id: string | null;
  ig_media_id: string | null;
  ig_permalink: string | null;
  error: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

export interface PostVersionRow {
  id: string;
  post_id: string;
  version: number;
  fb_caption: string;
  ig_caption: string;
  captions: Partial<Record<Channel, string>>;
  feedback: string | null;
  model: string | null;
  created_at: Date;
}

export interface PostTargetRow {
  id: string;
  post_id: string;
  client_id: string;
  social_account_id: string;
  channel: Channel;
  caption: string;
  status: PostTargetStatus;
  publish_at: Date | null;
  external_id: string | null;
  permalink: string | null;
  error: string | null;
  error_kind: ErrorKind | null;
  attempts: number;
  next_attempt_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ProviderConnectionRow {
  id: string;
  client_id: string;
  provider: ProviderId;
  label: string | null;
  credentials_enc: Uint8Array | null;
  status: ConnectionStatus;
  last_error: string | null;
  token_expires_at: Date | null;
  meta: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SocialAccountRow {
  id: string;
  client_id: string;
  connection_id: string;
  provider: ProviderId;
  channel: Channel;
  external_id: string;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  credentials_enc: Uint8Array | null;
  status: AccountStatus;
  capabilities: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  comments_cursor: string | null;
  comments_synced_at: Date | null;
  webhook_subscribed: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CampaignRow {
  id: string;
  client_id: string;
  name: string;
  brief: string;
  goal: string;
  channels: Channel[];
  starts_on: string | null;
  ends_on: string | null;
  cadence: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface CommentRow {
  id: string;
  client_id: string;
  social_account_id: string;
  post_target_id: string | null;
  external_id: string;
  post_external_id: string | null;
  parent_external_id: string | null;
  author_external_id: string | null;
  author_name: string | null;
  author_handle: string | null;
  text: string;
  permalink: string | null;
  remote_created_at: Date | null;
  is_own: boolean;
  is_hidden: boolean;
  status: CommentStatus;
  classification: Record<string, unknown> | null;
  triage_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface CommentReplyRow {
  id: string;
  comment_id: string;
  client_id: string;
  text: string;
  origin: ReplyOrigin;
  status: ReplyStatus;
  model: string | null;
  confidence: number | null;
  grounding: unknown[];
  external_id: string | null;
  error: string | null;
  error_kind: ErrorKind | null;
  attempts: number;
  approved_by: string | null;
  approved_at: Date | null;
  sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AutomationPolicyRow {
  client_id: string;
  auto_reply_enabled: boolean;
  channels: Channel[];
  min_confidence: number;
  escalate_flags: RiskFlag[];
  blocked_keywords: string[];
  max_auto_replies_per_hour: number;
  quiet_hours: { start: string; end: string } | null;
  reply_to_praise: boolean;
  require_grounding: boolean;
  signature: string;
  notify_telegram: boolean;
  updated_at: Date;
}

export interface KnowledgeSourceRow {
  id: string;
  client_id: string;
  kind: KnowledgeSourceKind;
  title: string;
  url: string | null;
  raw_text: string | null;
  file_name: string | null;
  status: KnowledgeSourceStatus;
  error: string | null;
  settings: Record<string, unknown>;
  content_hash: string | null;
  pages_count: number;
  chunks_count: number;
  last_ingested_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface KnowledgeChunkRow {
  id: string;
  source_id: string;
  client_id: string;
  content: string;
  url: string | null;
  title: string | null;
  position: number;
  embedding: number[] | null;
  embedding_model: string | null;
  created_at: Date;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_key: string;
  payload: unknown;
  received_at: Date;
  processed_at: Date | null;
  attempts: number;
  error: string | null;
}

export interface UsageCounterRow {
  client_id: string;
  period: string;
  metric: string;
  value: string;
}

export interface SystemCounterRow {
  period: string;
  metric: string;
  value: string;
}

export interface OAuthStateRow {
  state_hash: Uint8Array;
  client_id: string | null;
  provider: string;
  code_verifier: string | null;
  redirect_path: string | null;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export interface ContentRequestRow {
  id: string;
  client_id: string;
  goal: string;
  count: number;
  channels: Channel[];
  status: ContentRequestStatus;
  error: string | null;
  created_post_ids: string[];
  created_at: Date;
  updated_at: Date;
}

export interface ChatSessionRow {
  chat_id: string;
  mode: ChatSessionMode;
  post_id: string | null;
  reply_id: string | null;
  updated_at: Date;
}

export interface AuditLogRow {
  id: string;
  client_id: string | null;
  post_id: string | null;
  actor_chat_id: string | null;
  action: string;
  detail: Record<string, unknown>;
  created_at: Date;
}

export interface LoginTokenRow {
  token_hash: Uint8Array;
  client_id: string | null;
  chat_id: string;
  is_admin: boolean;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}
