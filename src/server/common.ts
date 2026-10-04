/**
 * Shared shapes for the fetch-style handler factories (sync plan Phase B).
 * A handler takes the standard Request plus the already-split path segments
 * so Next (`params.path`), Hono, or a raw node adapter wire it in ~3 lines.
 */

export type PathHandler = (req: Request, path: string[]) => Promise<Response>;

/** Who a request is (S5). `access: 'ro'` identities are denied writes. */
export interface Identity {
  name: string;
  access: 'ro' | 'rw';
}

/** `true` = authenticated with full access (legacy boolean hooks stay valid). */
export type AuthResult = boolean | Identity;

export type AuthHook = (req: Request) => AuthResult | Promise<AuthResult>;

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** Bearer-token AuthHook; the token is read per request so env changes apply live. No token configured = open. */
export const bearerAuth =
  (token: () => string | undefined): AuthHook =>
  (req) => {
    const required = token();
    if (!required) return true;
    return (req.headers.get('authorization') ?? '') === `Bearer ${required}`;
  };

function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  if (header.startsWith('Basic ')) {
    // docker login: any username, the token as password
    try {
      const decoded = atob(header.slice('Basic '.length));
      const idx = decoded.indexOf(':');
      return idx >= 0 ? decoded.slice(idx + 1) : decoded;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Static ro/rw token auth (S5, V3): accepts the token as `Bearer <t>` or
 * `Basic base64(<any-user>:<t>)` so `docker login` works. Tokens are read
 * per request; neither configured = open.
 */
export function staticTokenAuth(tokens: { rw?: () => string | undefined; ro?: () => string | undefined }): AuthHook {
  return (req) => {
    const rw = tokens.rw?.();
    const ro = tokens.ro?.();
    if (!rw && !ro) return true;
    const presented = tokenFromRequest(req);
    if (presented !== null && rw && presented === rw) return { name: 'token:rw', access: 'rw' };
    if (presented !== null && ro && presented === ro) return { name: 'token:ro', access: 'ro' };
    return false;
  };
}

const UNAUTHORIZED_HEADERS = { 'www-authenticate': 'Basic realm="artipod"' };

export async function authorize(req: Request, auth?: AuthHook): Promise<Response | null> {
  if (auth && !(await auth(req))) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: UNAUTHORIZED_HEADERS });
  }
  return null;
}

/**
 * Authenticate AND gate on required access: 401 (+ the Basic challenge
 * docker's client needs) for unknown callers, 403 for ro identities on
 * writes. No hook configured = open.
 */
export async function authorizeAccess(
  req: Request,
  auth: AuthHook | undefined,
  need: 'ro' | 'rw',
): Promise<Response | null> {
  if (!auth) return null;
  const result = await auth(req);
  if (result === false) {
    return Response.json({ error: 'unauthorized' }, { status: 401, headers: UNAUTHORIZED_HEADERS });
  }
  if (result !== true && need === 'rw' && result.access === 'ro') {
    return Response.json({ error: 'forbidden: read-only access' }, { status: 403 });
  }
  return null;
}
