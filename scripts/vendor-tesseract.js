#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Vendor Tesseract.js runtime assets so production never hits a CDN.
// Downloads worker script, core wasm, and eng.traineddata into assets/tesseract/.
// Run after npm install or inside the Dockerfile before the server starts.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const https = require('https');

const ASSET_DIR = path.resolve(__dirname, '../src/assets/tesseract');
const TESSERACT_VERSION = '5.1.1';
const TESSERACT_CORE_VERSION = '5.1.1';

// Only the language data needs to be vendored. The worker and core WASM are
// provided by the tesseract.js npm package and are Node-compatible. Downloading
// the browser builds (worker.min.js / tesseract-core.wasm.js) from the CDN and
// passing them as workerPath/corePath causes a crash in Node.js worker_threads
// because the browser bundle calls globalThis.addEventListener which doesn't
// exist in Node's global scope.
const FILES = [
  {
    url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng@1.0.0/4.0.0_best_int/eng.traineddata.gz',
    dest: 'eng.traineddata.gz',
  },
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https
      .get(url, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          return download(response.headers.location, dest).then(resolve, reject);
        }
        if (response.statusCode !== 200) {
          return reject(new Error(`Failed to download ${url}: ${response.statusCode}`));
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      })
      .on('error', (err) => {
        fs.unlink(dest, () => {});
        reject(err);
      });
  });
}

async function main() {
  if (!fs.existsSync(ASSET_DIR)) {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
  }

  for (const { url, dest } of FILES) {
    const destPath = path.join(ASSET_DIR, dest);
    if (fs.existsSync(destPath)) {
      console.log(`[vendor-tesseract] ${dest} already exists, skipping`);
      continue;
    }
    console.log(`[vendor-tesseract] Downloading ${dest}...`);
    await download(url, destPath);
    console.log(`[vendor-tesseract] Downloaded ${dest}`);
  }

  console.log('[vendor-tesseract] All assets ready');
}

main().catch((err) => {
  console.error('[vendor-tesseract] Failed:', err.message);
  process.exit(1);
});
