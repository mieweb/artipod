'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  const destination = path.join(__dirname, '..', 'vendor');
  await fs.mkdir(destination, { recursive: true });
  await fs.copyFile(path.join(__dirname, '..', '..', 'src', 'checkpoints.js'), path.join(destination, 'checkpoints.mjs'));
})().catch(error => { console.error(error); process.exitCode = 1; });
