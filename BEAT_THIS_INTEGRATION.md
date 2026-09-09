# Beat This! integration

Dance Counter now uses a hybrid detector:

- the existing spectral-flux detector gives immediate real-time beat feedback;
- Beat This! small model (FP32 ONNX, ~10 MB) periodically analyzes the recent
  microphone PCM and predicts beats/downbeats;
- neural downbeats are used to correct the bar phase (`1`) without requiring
  the heuristic detector to guess the phase.

The model expects mono 22.05 kHz audio and a 128-band Slaney log-mel
spectrogram with `n_fft=1024`, `hop=441` (50 fps), `30–11000 Hz`, and
`log1p(1000 * magnitude)` preprocessing.

## Model provenance

- **Original research model**: [CPJKU/beat_this](https://github.com/CPJKU/beat_this)
  (Institute of Computational Perception, JKU Linz). MIT license. The
  official repo publishes PyTorch checkpoints only (`small0`, `small1`,
  `final0`, ...), no ONNX export.
- **ONNX export used here**: [danigb/beat-this-rs](https://github.com/danigb/beat-this-rs),
  which converts the official checkpoints with `scripts/ckpt2onnx.py` and
  commits the small model (`models/beat_this_small.onnx`, checkpoint
  `small1`) directly to git. MIT license, both copyright notices retained.
- `scripts/fetch-beat-model.mjs` pins a specific commit hash (not `main`)
  and verifies the downloaded file's SHA-256 against a value computed
  locally before trusting it. The build fails loudly on a mismatch instead
  of silently using an unexpected file.
- The file is **not** INT8-quantized — it's the small FP32 checkpoint. Don't
  reintroduce an "int8" filename/label without actually verifying that.
- The ONNX artifact is intentionally not committed to this repo's Git
  history (see `.gitignore`); it's fetched and verified at build time.

## Build

Run:

```bash
npm install
npm run build -- --configuration production
```

The prebuild step downloads and checksum-verifies the model, then copies the
ONNX Runtime WASM files into `src/assets/onnxruntime/`.

## Updating the model

If you ever need to point at a different model file or a newer commit of
`beat-this-rs`:

1. Download the new file yourself and compute its SHA-256 locally — never
   trust a hash someone else hands you without being able to reproduce it.
2. Update `COMMIT` and `EXPECTED_SHA256` in `scripts/fetch-beat-model.mjs`
   together, so the pin always matches a specific, known-good file.
3. Re-run the build and confirm it downloads and verifies cleanly.

## Important

A normal browser build still works without the neural model: the existing
detector remains available as a fallback. The GitHub Actions workflow uses
`npm install` and `npm run build`, so the generated model/runtime assets are
present before Angular builds the web app.
