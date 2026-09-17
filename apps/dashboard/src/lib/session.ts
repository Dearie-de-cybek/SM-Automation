import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { env } from './env';

const SESSION_COOKIE = 'sm_session';
// Admins can view the dashboard as any client.
const ACTING_COOKIE = 'sm_acting_client';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Session = { chatId: string; clientId: string | null; isAdmin: boolean };
export type Viewer = Session & { actingClientId: string | null };

const secretKey = () => new TextEncoder().encode(env().SESSION_SECRET);
const cookieOptions = () => ({
  httpOnly: true,
  secure: env().APP_URL.startsWith('https://'),
  sameSite: 'lax' as const,
  path: '/',
});

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export async function createSession(session: Session): Promise<void> {
  const jwt = await new SignJWT({ cid: session.clientId, adm: session.isAdmin })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(session.chatId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secretKey());
  const store = await cookies();
  store.set(SESSION_COOKIE, jwt, { ...cookieOptions(), maxAge: MAX_AGE_SECONDS });
  store.delete(ACTING_COOKIE);
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(ACTING_COOKIE);
}

export async function getViewer(): Promise<Viewer | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secretKey(), { algorithms: ['HS256'] });
    const session: Session = {
      chatId: String(payload.sub),
      clientId: isUuid(payload.cid) ? payload.cid : null,
      isAdmin: payload.adm === true,
    };
    const acting = store.get(ACTING_COOKIE)?.value;
    return { ...session, actingClientId: session.isAdmin && isUuid(acting) ? acting : session.clientId };
  } catch {
    return null;
  }
}

export async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect('/login');
  return viewer;
}

/** The client whose data the page shows. Admins without a selected client go to /admin. */
export async function requireClientViewer(): Promise<Viewer & { actingClientId: string }> {
  const viewer = await requireViewer();
  if (!viewer.actingClientId) redirect(viewer.isAdmin ? '/admin' : '/login');
  return { ...viewer, actingClientId: viewer.actingClientId };
}

export async function requireAdmin(): Promise<Viewer> {
  const viewer = await requireViewer();
  if (!viewer.isAdmin) redirect('/');
  return viewer;
}

export async function setActingClient(clientId: string | null): Promise<void> {
  const store = await cookies();
  if (clientId) store.set(ACTING_COOKIE, clientId, { ...cookieOptions(), maxAge: MAX_AGE_SECONDS });
  else store.delete(ACTING_COOKIE);
}
