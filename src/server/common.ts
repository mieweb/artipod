/**
 * Shared shapes for the fetch-style handler factories (sync plan Phase B).
 * A handler takes the standard Request plus the already-split path segments
 * so Next (`params.path`), Hono, or a raw node adapter wire it in ~3 lines.
 */

export type PathHandler = (req: Request, path: string[]) => Promise<Response>;

export type AuthHook = (req: Request) => boolean | Promise<boolean>;

export const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** Bearer-token AuthHook; the token is read per request so env changes apply live. No token configured = open. */
export const bearerAuth =
  (token: () => string | undefined): AuthHook =>
  (req) => {
    const required = token();
    if (!required) return true;
    return (req.headers.get('authorization') ?? '') === `Bearer ${required}`;
  };

export async function authorize(req: Request, auth?: AuthHook): Promise<Response | null> {
  if (auth && !(await auth(req))) return json({ error: 'unauthorized' }, 401);
  return null;
}
