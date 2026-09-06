const sessions = new Map();
const PREFIX = '/_artipod/run/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const owner = event.source;
  if (!owner?.url) return;
  const url = new URL(owner.url);
  if (url.origin !== self.location.origin || url.pathname !== '/' || !url.searchParams.get('artipod')) return;
  const { type, session, validUntil, entrypoint } = event.data ?? {};
  if (type === 'revoke' && sessions.get(session)?.owner === owner.id) {
    sessions.get(session).port.close();
    sessions.delete(session);
    return;
  }
  if (type !== 'grant' || typeof session !== 'string' || !/^[a-f0-9-]{36}$/.test(session) ||
      !event.ports?.[0] || !Number.isSafeInteger(validUntil) || validUntil <= Date.now() || validUntil > Date.now() + 3600000 ||
      typeof entrypoint !== 'string' || !/^\/app\/[a-zA-Z0-9_/-]+(?:\.[a-zA-Z0-9_-]+)*\.html$/.test(entrypoint) || /\/\.|\/\//.test(entrypoint) || sessions.has(session)) return;
  const port = event.ports[0];
  sessions.set(session, { owner: owner.id, ownerUrl: owner.url, port, validUntil, entrypoint, guests: new Set() });
  port.postMessage({ type: 'ready' });
});

function requestFile(session, path) {
  return new Promise(resolve => {
    const id = crypto.randomUUID();
    const finish = value => {
      clearTimeout(timer);
      session.port.removeEventListener('message', receive);
      resolve(value);
    };
    const receive = event => { if (event.data?.id === id) finish(event.data); };
    const timer = setTimeout(() => finish({ status: 504 }), 5000);
    session.port.addEventListener('message', receive);
    session.port.start();
    session.port.postMessage({ type: 'read', id, path });
  });
}

async function project(event, url) {
  const denied = () => new Response('Execution session unavailable', { status: 403, headers: { 'Cache-Control': 'no-store' } });
  if (event.request.method !== 'GET' || ['worker', 'sharedworker', 'serviceworker'].includes(event.request.destination)) return denied();
  const match = /^\/_artipod\/run\/([a-f0-9-]{36})(\/.*)$/.exec(url.pathname);
  if (!match) return denied();
  const session = sessions.get(match[1]);
  if (!session) return denied();
  const owner = await self.clients.get(session.owner);
  if (session.validUntil <= Date.now() || !owner || owner.url !== session.ownerUrl) {
    session.port.close();
    sessions.delete(match[1]);
    return denied();
  }
  const path = match[2];
  if (path.length > 512 || /%|\\|\/\.|\/\//.test(path) || !/^\/(app|case)\//.test(path)) return denied();
  if (event.request.mode === 'navigate') {
    if (event.request.destination !== 'iframe' || !event.resultingClientId || path !== session.entrypoint ||
        (event.clientId && event.clientId !== session.owner)) return denied();
    session.guests.add(event.resultingClientId);
  } else if (event.clientId !== session.owner && !session.guests.has(event.clientId)) return denied();
  const file = await requestFile(session, path);
  if (sessions.get(match[1]) !== session || session.validUntil <= Date.now()) return denied();
  if (file.status !== 200 || !(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 1024 * 1024) {
    return new Response('Unavailable', { status: file.status === 404 ? 404 : 502, headers: { 'Cache-Control': 'no-store' } });
  }
  const root = `${url.origin}${PREFIX}${match[1]}`;
  return new Response(file.bytes, { headers: {
    'Content-Type': file.mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': [
      "default-src 'none'", `script-src ${root}/app/`, `style-src ${root}/app/`, `img-src ${root}/app/`,
      `font-src ${root}/app/`, `connect-src ${root}/app/ ${root}/case/`, "frame-src 'none'", "frame-ancestors 'self'",
      "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", 'sandbox allow-scripts allow-same-origin',
    ].join('; '),
  } });
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname.startsWith(PREFIX)) event.respondWith(project(event, url));
});