// Reproducible, synthetic development media. Requires ffmpeg; no external assets.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createFixtureGLB } = require('../miniprogram/labs/xr-three/runtime');
const target = path.resolve(__dirname, '../miniprogram/labs/xr-three/fixtures');
fs.mkdirSync(target, { recursive: true });
const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=22050:duration=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-profile:v', 'baseline', '-c:a', 'aac', '-b:a', '32k', '-movflags', '+faststart', path.join(target, 'performance.mp4')]);
ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=16000:duration=8', '-c:a', 'pcm_s16le', path.join(target, 'performance.wav')]);
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x120:rate=1', '-frames:v', '1', path.join(target, 'performance.png')]);
fs.writeFileSync(path.join(target, 'performance.glb'), Buffer.from(createFixtureGLB()));
console.log('Prepared synthetic image, video with soundtrack, audio and animated GLB fixtures.');
