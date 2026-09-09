import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Readable } from 'node:stream';

// Provenance (verified 2026-09-09):
// - Upstream model: CPJKU/beat_this (JKU Linz), MIT license, checkpoint "small1".
//   https://github.com/CPJKU/beat_this
// - ONNX export: danigb/beat-this-rs, which converts CPJKU's PyTorch checkpoints via
//   scripts/ckpt2onnx.py and commits the resulting small model directly to git
//   (not a mutable branch HEAD asset). MIT license, both notices retained.
//   https://github.com/danigb/beat-this-rs
// Pinned to a specific commit (not "main") so the file cannot change under us.
// SHA-256 was computed locally against the downloaded bytes, not copied from a
// third party, and is checked below before the file is trusted.
const COMMIT = 'e82b5de28962663be047adca84781edae566504f';
const url = process.env.BEAT_THIS_MODEL_URL ||
  `https://raw.githubusercontent.com/danigb/beat-this-rs/${COMMIT}/models/beat_this_small.onnx`;
const EXPECTED_SHA256 = 'a5f8d39d989f31859454ba27afe61c5317ca95e4d9373e6853e5361b8937172f';
const out = 'src/assets/beat_this_small.onnx';

await mkdir('src/assets', { recursive: true });

if (existsSync(out)) {
  const info = await stat(out);
  if (info.size > 100_000) {
    console.log(`Beat This model already present (${(info.size / 1024 / 1024).toFixed(1)} MB), skipping download.`);
    console.log('Delete the file if you need to re-verify or re-fetch it.');
    process.exit(0);
  }
}

console.log(`Downloading Beat This small model from ${url}`);
const response = await fetch(url, { redirect: 'follow' });
if (!response.ok || !response.body) {
  throw new Error(`Could not download Beat This model: HTTP ${response.status}`);
}

const chunks = [];
for await (const chunk of Readable.fromWeb(response.body)) chunks.push(chunk);
const data = Buffer.concat(chunks);
if (data.length < 100_000) throw new Error('Downloaded model is unexpectedly small.');

const sha = createHash('sha256').update(data).digest('hex');
if (sha !== EXPECTED_SHA256) {
  throw new Error(
    `Beat This model checksum mismatch!\n` +
    `  expected: ${EXPECTED_SHA256}\n` +
    `  got:      ${sha}\n` +
    `The file at ${url} no longer matches the version this project was built against. ` +
    `Refusing to use it. If this is an intentional model update, verify the new file's ` +
    `provenance yourself and update EXPECTED_SHA256 (and COMMIT) in this script.`,
  );
}

await writeFile(out, data);
console.log(`Beat This model saved to ${out} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`SHA-256 verified: ${sha}`);
