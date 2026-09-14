const main = `import { readCase } from './data.js';
const subject = await readCase();
const { newestFirst } = await import('./order.js');
document.querySelector('h1').textContent = subject.title;
document.querySelector('#priority').textContent = subject.priority;
document.querySelector('#timeline').textContent = newestFirst(subject.timeline).join(' | ');
const binary = await fetch('./probe.wasm').then(response => response.arrayBuffer());
document.querySelector('#binary').textContent = binary.byteLength + ' WASM bytes loaded';
document.documentElement.dataset.ready = 'true';
parent.postMessage({ type: 'm0-ready' }, '*');
`;

const sourceMap = JSON.stringify({ version: 3, file: 'main.js', sources: ['main.ts'], sourcesContent: [main], names: [], mappings: 'AAAA;AACA;AACA;AACA;AACA;AACA;AACA;AACA;AACA' });

export const fixtureFiles: Record<string, string | Uint8Array> = {
  '/app/artipod.json': JSON.stringify({ apiVersion: 'artipod.io/v1', kind: 'SPAPod', metadata: { name: 'm0-case-viewer' }, spec: { entrypoint: 'index.html', capabilities: ['case:read'], dependencies: [] } }),
  '/app/index.html': `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Case Viewer M0</title><link rel="stylesheet" href="./style.css"></head>
<body><main><img src="./pixel.png" width="24" height="24" alt="Projection image probe">
<h1>Loading case</h1><p id="priority"></p><p id="timeline"></p><p id="binary"></p>
</main><script type="module" src="./main.js"></script></body></html>`,
  '/app/main.js': `${main}\n//# sourceMappingURL=data:application/json;base64,${btoa(sourceMap)}\n`,
  '/app/main.js.map': sourceMap,
  '/app/data.js': `export async function readCase() {
  const response = await fetch('../case/subject.json');
  if (!response.ok) throw new Error('Case read failed: ' + response.status);
  return response.json();
}\n`,
  '/app/order.js': 'export const newestFirst = timeline => [...timeline].reverse();\n',
  '/app/style.css': 'body{margin:0;font:16px Georgia,serif;color:#202824;background:#f4f7f5}main{padding:24px;overflow-wrap:anywhere}h1{font-size:24px}#priority{color:#a12b3f;font-weight:bold}img{image-rendering:pixelated}\n',
  '/app/probe.wasm': new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  '/app/pixel.png': new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,2,0,0,0,2,8,6,0,0,0,114,182,13,36,0,0,0,22,73,68,65,84,120,156,99,80,233,203,250,127,103,185,217,127,6,16,1,226,0,0,84,131,9,167,156,48,29,116,0,0,0,0,73,69,78,68,174,66,96,130]),
  '/case/subject.json': JSON.stringify({ title: 'Synthetic support case', priority: 'normal', timeline: ['Opened', 'Customer contacted'] }),
};
