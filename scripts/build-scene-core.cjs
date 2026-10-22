const { buildSync } = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'miniprogram/lib/scene-runtime/vendor');
fs.mkdirSync(out, { recursive: true });
const source = require.resolve('@spatial-memory/scene-core');
const bundle = buildSync({ entryPoints: [source], write: false, bundle: true,
  format: 'cjs', platform: 'neutral', mainFields: ['main'], target: 'es2018', minify: true, legalComments: 'eof' }).outputFiles[0].text;
fs.writeFileSync(path.join(out, 'scene-core.js'), bundle);
for (const file of ['THEATRE-CORE-LICENSE.txt', 'THEATRE-DATAVERSE-LICENSE.txt']) fs.rmSync(path.join(out, file), { force: true });
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({ sceneCore: '2.1.0',
  sourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex'),
  bytes: Buffer.byteLength(bundle) }, null, 2) + '\n');
console.log(`Built dependency-free Scene Core (${Buffer.byteLength(bundle)} bytes).`);
