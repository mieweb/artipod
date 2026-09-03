/**
 * The one API route (dry plan E2): every /api/* request not matched by a
 * static segment (pods/publish, fake-llm) lands here and is served by the
 * composed `createArtipodApp` — the same object `artipod serve` runs, so
 * behavior cannot drift. Node runtime: the git proxy and exec host need it.
 */
import { getArtipodApp } from '@/lib/artipod-app';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const h = async (req: Request): Promise<Response> => (await getArtipodApp())(req);

export { h as GET, h as HEAD, h as POST, h as PUT, h as DELETE, h as OPTIONS };
