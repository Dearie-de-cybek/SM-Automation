import { env } from './env';
import { withTenantTransaction } from './tenant-db';

export class GraphError extends Error {}

export type VerifiedPageInfo = {
  pageId: string;
  pageName: string;
  igUserId: string | null;
  igUsername: string | null;
};

/** Verify a Page access token against Graph API and fetch page metadata and linked Instagram details. */
export async function verifyMetaCredentials(pageId: string, pageToken: string): Promise<VerifiedPageInfo> {
  const { META_GRAPH_VERSION } = env();
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(pageId)}`);
  url.searchParams.set('fields', 'id,name,instagram_business_account{id,username}');
  url.searchParams.set('access_token', pageToken);

  const res = await fetch(url, { cache: 'no-store' });
  const body = (await res.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    instagram_business_account?: { id: string; username?: string };
    error?: { message?: string };
  };

  if (!res.ok || body.error) {
    throw new GraphError(body.error?.message ?? `Meta Graph API returned HTTP ${res.status}`);
  }

  return {
    pageId: body.id ?? pageId,
    pageName: body.name ?? `Page (${pageId})`,
    igUserId: body.instagram_business_account?.id ?? null,
    igUsername: body.instagram_business_account?.username ?? null,
  };
}

/** Encrypts and saves client Meta credentials in Postgres. */
export async function saveClientMetaCredentials(params: {
  clientId: string;
  pageId: string;
  pageName: string;
  pageToken: string;
  igUserId?: string | null;
  igUsername?: string | null;
}): Promise<void> {
  const platforms = params.igUserId ? ['facebook', 'instagram'] : ['facebook'];

  await withTenantTransaction(params.clientId, async (sql) => {
    await sql`
      UPDATE clients SET
        fb_page_id = ${params.pageId},
        fb_page_name = ${params.pageName},
        ig_user_id = ${params.igUserId ?? null},
        ig_username = ${params.igUsername ?? null},
        meta_token_enc = pgp_sym_encrypt(${params.pageToken}, ${env().TOKEN_ENCRYPTION_KEY}::text),
        meta_connected_at = now(),
        default_platforms = ${platforms}::text[]
      WHERE id = ${params.clientId}::uuid`;
  });
}
