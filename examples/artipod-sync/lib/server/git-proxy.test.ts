/**
 * Git proxy validation: host allowlist + smart-HTTP-only endpoints + header
 * filtering (credentials forwarded, junk stripped).
 */
import { describe, expect, it } from 'vitest';
import {
  allowedHosts,
  DEFAULT_ALLOWED_HOSTS,
  filterRequestHeaders,
  filterResponseHeaders,
  validateProxyRequest,
} from './git-proxy';

const seg = (s: string) => s.split('/');

describe('validateProxyRequest', () => {
  it('accepts smart-HTTP info/refs GETs for allowlisted hosts', () => {
    const v = validateProxyRequest(
      'GET',
      seg('github.com/user/repo.git/info/refs'),
      new URLSearchParams('service=git-upload-pack'),
    );
    expect(v).toEqual({
      ok: true,
      upstream: 'https://github.com/user/repo.git/info/refs?service=git-upload-pack',
    });
  });

  it('accepts upload-pack/receive-pack POSTs', () => {
    const up = validateProxyRequest('POST', seg('gitlab.com/g/p.git/git-upload-pack'), new URLSearchParams());
    expect(up.ok).toBe(true);
    const rp = validateProxyRequest('POST', seg('github.com/u/r.git/git-receive-pack'), new URLSearchParams());
    expect(rp.ok).toBe(true);
  });

  it('rejects non-allowlisted hosts', () => {
    const v = validateProxyRequest(
      'GET',
      seg('evil.example.com/x/info/refs'),
      new URLSearchParams('service=git-upload-pack'),
    );
    expect(v).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects non-git endpoints and traversal', () => {
    expect(
      validateProxyRequest('GET', seg('github.com/user/repo/raw/main/secrets.txt'), new URLSearchParams()),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      validateProxyRequest('POST', seg('github.com/user/repo.git/anything'), new URLSearchParams()),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      validateProxyRequest(
        'GET',
        ['github.com', '..', 'info/refs'],
        new URLSearchParams('service=git-upload-pack'),
      ),
    ).toMatchObject({ ok: false, status: 400 });
    expect(validateProxyRequest('DELETE', seg('github.com/u/r.git/git-upload-pack'), new URLSearchParams())).toMatchObject(
      { ok: false, status: 405 },
    );
  });

  it('honors the env host override', () => {
    expect(allowedHosts('git.mycorp.example, other.example')).toEqual(['git.mycorp.example', 'other.example']);
    expect(allowedHosts(undefined)).toEqual(DEFAULT_ALLOWED_HOSTS);
    const v = validateProxyRequest(
      'GET',
      seg('git.mycorp.example/r.git/info/refs'),
      new URLSearchParams('service=git-upload-pack'),
      allowedHosts('git.mycorp.example'),
    );
    expect(v.ok).toBe(true);
  });
});

describe('header filtering', () => {
  it('forwards auth + git headers, strips the rest', () => {
    const incoming = new Headers({
      authorization: 'Basic abc',
      'git-protocol': 'version=2',
      'content-type': 'application/x-git-upload-pack-request',
      cookie: 'session=steal-me',
      'x-forwarded-for': '1.2.3.4',
    });
    const out = filterRequestHeaders(incoming);
    expect(out.get('authorization')).toBe('Basic abc');
    expect(out.get('git-protocol')).toBe('version=2');
    expect(out.get('cookie')).toBeNull();
    expect(out.get('x-forwarded-for')).toBeNull();
  });

  it('adds CORS headers to responses', () => {
    const out = filterResponseHeaders(new Headers({ 'content-type': 'application/x-git-upload-pack-result', 'set-cookie': 'no' }));
    expect(out.get('Access-Control-Allow-Origin')).toBe('*');
    expect(out.get('content-type')).toBe('application/x-git-upload-pack-result');
    expect(out.get('set-cookie')).toBeNull();
  });
});
