import { mkdir, copyFile } from 'node:fs/promises';

const files = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];
await mkdir('src/assets/onnxruntime', { recursive: true });
for (const file of files) {
  await copyFile(`node_modules/onnxruntime-web/dist/${file}`, `src/assets/onnxruntime/${file}`);
}
console.log('ONNX Runtime WASM assets copied.');
