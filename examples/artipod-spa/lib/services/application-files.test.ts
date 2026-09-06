import { describe, expect, it } from 'vitest';
import { applicationSource, type ApplicationFiles } from './application-files';

function fixture() {
  const files: ApplicationFiles = {
    read: async path => new TextEncoder().encode(path),
    list: async path => path === '/pod' ? ['artipod.json', 'index.html', 'case', '.artipod', '.git', 'node_modules'] : [],
    stat: async path => ({ size: 32, isDirectory: () => path === '/pod', isSymbolicLink: () => false }),
  };
  return files;
}

describe('application-only filesystem adapter', () => {
  it('maps the selected pod and excludes case data and internal storage', async () => {
    const source = await applicationSource(fixture(), '/pod');
    expect(source.paths).toEqual(['/app/artipod.json', '/app/index.html']);
    expect(new TextDecoder().decode(await source.read('/app/index.html'))).toBe('/pod/index.html');
    await expect(source.read('/case/subject.json')).rejects.toThrow('Unprojected');
  });
  it('rejects symlinks including replacements after enumeration', async () => {
    const files = fixture();
    const source = await applicationSource(files, '/pod');
    files.stat = async () => ({ size: 2, isDirectory: () => false, isSymbolicLink: () => true });
    await expect(source.read('/app/index.html')).rejects.toThrow('symlink');
    await expect(applicationSource(files, '/pod')).rejects.toThrow();
  });
  it('bounds traversal before capture', async () => {
    const files = fixture();
    files.list = async () => Array.from({ length: 300 }, (_, index) => `file${index}`);
    await expect(applicationSource(files, '/pod')).rejects.toThrow('too large');
  });
});