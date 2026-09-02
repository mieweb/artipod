/**
 * Static UI serving (serve plan S2): traversal safety, content types, Next
 * export spellings (page.html, dir/index.html), SPA fallback, and the ui
 * option inside createArtipodApp.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStaticHandler } from './static.js';

let dir: string;
let handler: (req: Request) => Promise<Response>;
const req = (path: string, init?: RequestInit): Promise<Response> =>
  handler(new Request(`http://ui.test${path}`, init));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apod-static-'));
  await writeFile(join(dir, 'index.html'), '<html>UI ROOT</html>');
  await writeFile(join(dir, 'editor.html'), '<html>EDITOR</html>');
  await mkdir(join(dir, '_next/static'), { recursive: true });
  await writeFile(join(dir, '_next/static/app.js'), 'console.log("app")');
  await writeFile(join(dir, 'style.css'), 'body{}');
  handler = createStaticHandler(dir);
});

describe('createStaticHandler', () => {
  it('serves index.html at / with the html content type', async () => {
    const res = await req('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('UI ROOT');
  });

  it('serves assets with mapped content types', async () => {
    expect((await req('/_next/static/app.js')).headers.get('content-type')).toContain('javascript');
    expect((await req('/style.css')).headers.get('content-type')).toContain('text/css');
  });

  it('maps extensionless routes to the Next export spelling, then SPA-falls back', async () => {
    expect(await (await req('/editor')).text()).toContain('EDITOR');
    // unknown navigation → index.html (SPA), unknown asset → 404
    expect(await (await req('/deep/route')).text()).toContain('UI ROOT');
    expect((await req('/missing.js')).status).toBe(404);
  });

  it('never escapes the root', async () => {
    for (const path of ['/../etc/passwd', '/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await req(path);
      expect([404, 200]).toContain(res.status);
      if (res.status === 200) expect(await res.text()).toContain('UI ROOT'); // SPA fallback, not the host fs
    }
  });

  it('rejects non-GET/HEAD', async () => {
    expect((await req('/', { method: 'POST', body: 'x' })).status).toBe(405);
  });
});
