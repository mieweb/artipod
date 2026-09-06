import { describe, expect, it } from 'vitest';
import { applicationPath, parseExecutableDescriptor } from './executable-descriptor';

const encode = (spec: object = {}, overrides: object = {}) => new TextEncoder().encode(JSON.stringify({
  apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'viewer' }, spec: { entrypoint: 'index.html', ...spec }, ...overrides,
}));

describe('executable pod descriptors', () => {
  it('accepts plain browser apps and logical app entrypoints', () => {
    expect(parseExecutableDescriptor(encode()).entrypoint).toBe('index.html');
    expect(parseExecutableDescriptor(encode({ entrypoint: '/app/ui/index.html' })).entrypoint).toBe('ui/index.html');
  });
  it.each(['../index.html', '/index.html', 'ui//index.html', 'ui/%2e/index.html', 'ui/./index.html', 'ui\\index.html'])('rejects escaped entrypoint %s', entrypoint => {
    expect(() => applicationPath(entrypoint)).toThrow();
  });
  it('rejects non-apps, wrong versions, dependencies and writable mounts', () => {
    expect(() => parseExecutableDescriptor(encode({}, { kind: 'CasePod' }))).toThrow();
    expect(() => parseExecutableDescriptor(encode({}, { apiVersion: 'artipod.io/v2' }))).toThrow();
    expect(() => parseExecutableDescriptor(encode({ dependencies: ['external'] }))).toThrow();
    expect(() => parseExecutableDescriptor(encode({ mounts: [{ path: '/case', profile: 'CasePod', mode: 'rw' }] }))).toThrow();
  });
  it('keeps read-only case requests separate from resolved mounts', () => {
    expect(parseExecutableDescriptor(encode({ mounts: [{ path: '/case', profile: 'CasePod', mode: 'ro' }] })).mounts).toEqual([
      { path: '/case', profile: 'CasePod', mode: 'ro' },
    ]);
  });
});