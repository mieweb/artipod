import { label } from './data.js';
const dynamic = await import('./dynamic.js');
const binary = await fetch('./probe.wasm').then(response => response.arrayBuffer());
document.querySelector('#modules').textContent = `${label}, ${dynamic.label}, ${binary.byteLength} WASM bytes loaded`;