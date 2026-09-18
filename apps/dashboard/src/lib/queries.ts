import { operatorDb } from './admin-db';
import { STATUS_GROUPS, type PostStatus, type StatusGroup } from './format';
import { withTenantTransaction } from './tenant-db';

export type Client = {
  id: string;
  name: string;
  telegram_chat_id: string | null;
  telegram_link_code: string | null;
  fb_page_id: string | null;
  fb_page_name: string | null;
  ig_user_id: string | null;
  ig_username: string | null;
  meta_connected: boolean;
  meta_connected_at: Date | null;
  timezone: string;
  active: boolean;
  created_at: Date;
};

export type BrandProfile = {
  business_description: string;
  voice: string;
  audience: string;
  language: string;
  default_cta: string;
  hashtags: string[];
  banned_words: string[];
  emoji_policy: string;
  sample_posts: string;
};

export type PostSummary = {
  id: string;
  status: PostStatus;
  brief: string;
  source_media_url: string | null;
  platforms: string[];
  publish_at: Date | null;
  published_at: Date | null;
  created_at: Date;
  fb_permalink: string | null;
  ig_permalink: string | null;
  fb_caption: string | null;
  ig_caption: string | null;
  current_version: number;
};

export type PostDetail = PostSummary & {
  approved_at: Date | null;
  updated_at: Date;
  error: string | null;
  attempts: number;
};

export type PostVersion = {
  version: number;
  fb_caption: string;
  ig_caption: string;
  feedback: string | null;
  created_at: Date;
};

export type AuditEntry = { action: string; detail: Record<string, unknown>; created_at: Date };

export const PAGE_SIZE = 24;

// Expects the clients table aliased as "c".
const CLIENT_COLUMNS = `
  c.id, c.name, c.telegram_chat_id::text, c.telegram_link_code, c.fb_page_id, c.fb_page_name, c.ig_user_id, c.ig_username,
  c.meta_connected_at IS NOT NULL AS meta_connected, c.meta_connected_at, c.timezone, c.active, c.created_at`;

export async function getClient(clientId: string): Promise<Client | null> {
  return withTenantTransaction(clientId, async (sql) => {
    const [row] = await sql<Client[]>`SELECT ${sql.unsafe(CLIENT_COLUMNS)} FROM clients c WHERE c.id = ${clientId}::uuid`;
    return row ?? null;
  });
}

export async function getBrandProfile(clientId: string): Promise<BrandProfile> {
  return withTenantTransaction(clientId, async (sql) => {
    const [row] = await sql<BrandProfile[]>`
      SELECT business_description, voice, audience, language, default_cta, hashtags, banned_words, emoji_policy, sample_posts
      FROM brand_profiles WHERE client_id = ${clientId}::uuid`;
    return row ?? {
      business_description: '', voice: 'Friendly, clear and professional', audience: '', language: 'English',
      default_cta: '', hashtags: [], banned_words: [], emoji_policy: 'A few relevant emojis', sample_posts: '',
    };
  });
}

export type PostStats = { awaiting: number; scheduled: number; published_30d: number; attention: number };

export async function getPostStats(clientId: string): Promise<PostStats> {
  return withTenantTransaction(clientId, async (sql) => {
    const [row] = await sql<PostStats[]>`
      SELECT
        count(*) FILTER (WHERE status IN ('generating', 'pending_approval'))::int AS awaiting,
        count(*) FILTER (WHERE status IN ('approved', 'scheduled', 'publishing'))::int AS scheduled,
        count(*) FILTER (WHERE status IN ('published', 'partially_published') AND published_at > now() - interval '30 days')::int AS published_30d,
        count(*) FILTER (WHERE status IN ('failed', 'draft_failed', 'partially_published'))::int AS attention
      FROM posts WHERE client_id = ${clientId}::uuid`;
    return row ?? { awaiting: 0, scheduled: 0, published_30d: 0, attention: 0 };
  });
}

export async function listPosts(clientId: string, group: StatusGroup, page: number) {
  return withTenantTransaction(clientId, async (sql) => {
    const statuses = STATUS_GROUPS[group].statuses;
    const offset = (page - 1) * PAGE_SIZE;
    const rows = await sql<(PostSummary & { total: number })[]>`
      SELECT p.id, p.status, p.brief, p.source_media_url, p.platforms, p.publish_at, p.published_at, p.created_at,
             p.fb_permalink, p.ig_permalink, p.current_version, v.fb_caption, v.ig_caption,
             count(*) OVER ()::int AS total
      FROM posts p
      LEFT JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
      WHERE p.client_id = ${clientId}::uuid
        ${statuses ? sql`AND p.status IN ${sql([...statuses])}` : sql``}
      ORDER BY COALESCE(p.published_at, p.publish_at, p.created_at) DESC
      LIMIT ${PAGE_SIZE} OFFSET ${offset}`;
    return { posts: rows as PostSummary[], total: rows[0]?.total ?? 0 };
  });
}

export async function getPost(clientId: string, postId: string) {
  return withTenantTransaction(clientId, async (sql) => {
    const [post] = await sql<PostDetail[]>`
      SELECT p.id, p.status, p.brief, p.source_media_url, p.platforms, p.publish_at, p.published_at, p.created_at,
             p.approved_at, p.updated_at, p.error, p.attempts,
             p.fb_permalink, p.ig_permalink, p.current_version, v.fb_caption, v.ig_caption
      FROM posts p
      LEFT JOIN post_versions v ON v.post_id = p.id AND v.version = p.current_version
      WHERE p.id = ${postId}::uuid AND p.client_id = ${clientId}::uuid`;
    if (!post) return null;

    const [versions, audit] = await Promise.all([
      sql<PostVersion[]>`
        SELECT version, fb_caption, ig_caption, feedback, created_at
        FROM post_versions WHERE post_id = ${postId}::uuid ORDER BY version DESC`,
      sql<AuditEntry[]>`
        SELECT action, detail, created_at FROM audit_log WHERE post_id = ${postId}::uuid ORDER BY created_at`,
    ]);
    return { post, versions, audit };
  });
}

export type AdminClientRow = Client & { posts_total: number; posts_awaiting: number; posts_published: number; last_post_at: Date | null };

export async function listClientsForAdmin(): Promise<AdminClientRow[]> {
  return operatorDb()<AdminClientRow[]>`SELECT * FROM app_admin_list_clients()`;
}
