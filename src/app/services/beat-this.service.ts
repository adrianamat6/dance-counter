import * as ort from 'onnxruntime-web';
import { Injectable, signal } from '@angular/core';

type BeatEvent = { timeMs: number; confidence: number; kind: 'beat' | 'downbeat' };

/**
 * Neural beat/downbeat detector using the "Beat This!" small model (FP32 ONNX,
 * checkpoint small1, ~10 MB), MIT-licensed, from CPJKU/beat_this (JKU Linz).
 *
 * The model expects:
 *   - mono audio resampled to 22050 Hz
 *   - 128-band Slaney log-mel spectrogram
 *   - n_fft=1024, hop=441 (50 fps)
 *   - log1p(1000 * magnitude)
 *
 * Model weights are downloaded and checksum-verified by
 * scripts/fetch-beat-model.mjs, since the upstream project does not publish
 * an official browser ONNX artifact. The ONNX export used here comes from
 * danigb/beat-this-rs (MIT), pinned to a specific commit and SHA-256 — see
 * that script for the verified provenance.
 */
@Injectable({ providedIn: 'root' })
export class BeatThisService {
  readonly ready = signal(false);
  readonly processing = signal(false);
  readonly lastError = signal<string | null>(null);
  readonly lastDownbeatConfidence = signal(0);

  private session: ort.InferenceSession | null = null;
  private initPromise: Promise<void> | null = null;

  private readonly sampleRate = 22050;
  private readonly fftSize = 1024;
  private readonly hopSize = 441;
  private readonly melBands = 128;
  private readonly minFrequency = 30;
  private readonly maxFrequency = 11000;
  private readonly fps = 50;

  async init(): Promise<boolean> {
    if (this.session) return true;
    if (this.initPromise) {
      await this.initPromise;
      return Boolean(this.session);
    }

    this.initPromise = this.loadModel();
    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
    return Boolean(this.session);
  }

  async analyze(
    pcm: Float32Array,
    sourceSampleRate: number,
    windowStartTimeMs: number,
  ): Promise<BeatEvent[]> {
    if (pcm.length < sourceSampleRate * 4) return [];
    if (!(await this.init()) || !this.session) return [];

    this.processing.set(true);
    this.lastError.set(null);
    try {
      const mono = sourceSampleRate === this.sampleRate
        ? pcm
        : this.resampleLinear(pcm, sourceSampleRate, this.sampleRate);

      const spectrogram = this.computeLogMel(mono);
      if (spectrogram.length < this.melBands * 8) return [];

      const frames = Math.floor(spectrogram.length / this.melBands);
      const input = new ort.Tensor('float32', spectrogram, [1, frames, this.melBands]);
      const feeds: Record<string, ort.Tensor> = {};
      const inputName = this.session.inputNames[0];
      feeds[inputName] = input;

      const output = await this.session.run(feeds);
      const beatTensor = output.beat ?? output[this.session.outputNames[0]];
      const downbeatTensor = output.downbeat ?? output[this.session.outputNames[1]];
      const beatLogits = this.tensorToFloat32(beatTensor);
      const downbeatLogits = this.tensorToFloat32(downbeatTensor);

      const beats = this.pickPeaks(beatLogits, 0.5, 2);
      const downbeats = this.pickPeaks(downbeatLogits, 0.45, 2);

      const events: BeatEvent[] = [];
      for (const frame of beats) {
        events.push({
          kind: 'beat',
          timeMs: windowStartTimeMs + frame * 1000 / this.fps,
          confidence: frameConfidence(beatLogits, frame),
        });
      }
      for (const frame of downbeats) {
        events.push({
          kind: 'downbeat',
          timeMs: windowStartTimeMs + frame * 1000 / this.fps,
          confidence: frameConfidence(downbeatLogits, frame),
        });
      }

      const maxDownbeat = events
        .filter((event) => event.kind === 'downbeat')
        .reduce((max, event) => Math.max(max, event.confidence), 0);
      this.lastDownbeatConfidence.set(Math.round(maxDownbeat * 100));

      return events.sort((a, b) => a.timeMs - b.timeMs);
    } catch (error) {
      this.lastError.set(error instanceof Error ? error.message : 'Error del modelo Beat This.');
      return [];
    } finally {
      this.processing.set(false);
    }
  }

  private async loadModel(): Promise<void> {
    this.lastError.set(null);
    try {
      // We use the WASM CPU backend so the same build works across Android
      // WebView devices. Angular copies these files from src/assets/onnxruntime.
      ort.env.wasm.wasmPaths = 'assets/onnxruntime/';
      ort.env.wasm.numThreads = 2;
      ort.env.wasm.simd = true;
      this.session = await ort.InferenceSession.create('assets/beat_this_small.onnx', {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
      this.ready.set(true);
    } catch (error) {
      this.ready.set(false);
      this.lastError.set(
        error instanceof Error
          ? `No se pudo cargar el detector IA: ${error.message}`
          : 'No se pudo cargar el detector IA.',
      );
    }
  }

  private tensorToFloat32(tensor: ort.Tensor | undefined): Float32Array {
    if (!tensor) return new Float32Array();
    const data = tensor.data;
    if (data instanceof Float32Array) return data;
    if (data instanceof Float64Array) return Float32Array.from(data);
    if (ArrayBuffer.isView(data)) return Float32Array.from(data as unknown as ArrayLike<number>);
    return new Float32Array();
  }

  private pickPeaks(logits: Float32Array, threshold: number, radius: number): number[] {
    const peaks: number[] = [];
    for (let i = radius; i < logits.length - radius; i++) {
      const probability = sigmoid(logits[i]);
      if (probability < threshold) continue;
      let isMax = true;
      for (let j = i - radius; j <= i + radius; j++) {
        if (j !== i && logits[j] > logits[i]) {
          isMax = false;
          break;
        }
      }
      if (isMax) peaks.push(i);
    }
    return peaks;
  }

  private resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
    const outputLength = Math.max(1, Math.floor(input.length * toRate / fromRate));
    const output = new Float32Array(outputLength);
    const ratio = fromRate / toRate;
    for (let i = 0; i < outputLength; i++) {
      const position = i * ratio;
      const left = Math.floor(position);
      const frac = position - left;
      const a = input[Math.min(left, input.length - 1)] ?? 0;
      const b = input[Math.min(left + 1, input.length - 1)] ?? a;
      output[i] = a + (b - a) * frac;
    }
    return output;
  }

  private computeLogMel(audio: Float32Array): Float32Array {
    const frameCount = Math.floor((audio.length - this.fftSize) / this.hopSize) + 1;
    if (frameCount <= 0) return new Float32Array();

    const filterBank = this.createMelFilterBank();
    const window = this.hannWindow(this.fftSize);
    const result = new Float32Array(frameCount * this.melBands);
    const real = new Float64Array(this.fftSize);
    const imag = new Float64Array(this.fftSize);
    const magnitude = new Float64Array(this.fftSize / 2 + 1);

    for (let frame = 0; frame < frameCount; frame++) {
      const offset = frame * this.hopSize;
      real.fill(0);
      imag.fill(0);
      for (let i = 0; i < this.fftSize; i++) {
        real[i] = (audio[offset + i] ?? 0) * window[i];
      }
      this.fftInPlace(real, imag);

      for (let k = 0; k <= this.fftSize / 2; k++) {
        // The C++ reference uses magnitude before the mel aggregation.
        magnitude[k] = Math.hypot(real[k], imag[k]) / this.fftSize;
      }

      const rowOffset = frame * this.melBands;
      for (let m = 0; m < this.melBands; m++) {
        const filter = filterBank[m];
        let energy = 0;
        for (let k = 0; k < filter.length; k++) {
          energy += magnitude[k] * filter[k];
        }
        result[rowOffset + m] = Math.log1p(1000 * Math.max(0, energy));
      }
    }

    return result;
  }

  private createMelFilterBank(): Float32Array[] {
    const bins = this.fftSize / 2 + 1;
    const lowMel = this.hzToMel(this.minFrequency);
    const highMel = this.hzToMel(this.maxFrequency);
    const points = new Float64Array(this.melBands + 2);
    for (let i = 0; i < points.length; i++) {
      points[i] = this.melToHz(lowMel + (highMel - lowMel) * i / (this.melBands + 1));
    }

    const bank: Float32Array[] = [];
    for (let m = 0; m < this.melBands; m++) {
      const left = Math.floor((this.fftSize + 1) * points[m] / this.sampleRate);
      const center = Math.floor((this.fftSize + 1) * points[m + 1] / this.sampleRate);
      const right = Math.floor((this.fftSize + 1) * points[m + 2] / this.sampleRate);
      const filter = new Float32Array(bins);
      const lower = points[m];
      const upper = points[m + 2];
      const areaNorm = 2 / Math.max(1e-9, upper - lower);

      for (let k = Math.max(0, left); k < Math.min(center + 1, bins); k++) {
        const value = center === left ? 0 : (k - left) / (center - left);
        filter[k] = Math.max(filter[k], value * areaNorm);
      }
      for (let k = Math.max(0, center); k < Math.min(right + 1, bins); k++) {
        const value = right === center ? 0 : (right - k) / (right - center);
        filter[k] = Math.max(filter[k], value * areaNorm);
      }
      bank.push(filter);
    }
    return bank;
  }

  private hzToMel(hz: number): number {
    // Slaney mel scale used by the reference Beat This front end.
    const fSp = 200 / 3;
    const minLogHz = 1000;
    const minLogMel = (minLogHz - 0) / fSp;
    const logstep = Math.log(6.4) / 27;
    if (hz < minLogHz) return hz / fSp;
    return minLogMel + Math.log(hz / minLogHz) / logstep;
  }

  private melToHz(mel: number): number {
    const fSp = 200 / 3;
    const minLogHz = 1000;
    const minLogMel = minLogHz / fSp;
    const logstep = Math.log(6.4) / 27;
    if (mel < minLogMel) return mel * fSp;
    return minLogHz * Math.exp(logstep * (mel - minLogMel));
  }

  private hannWindow(size: number): Float64Array {
    const window = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    }
    return window;
  }

  private fftInPlace(real: Float64Array, imag: Float64Array): void {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    for (let length = 2; length <= n; length <<= 1) {
      const angle = -2 * Math.PI / length;
      const wLenReal = Math.cos(angle);
      const wLenImag = Math.sin(angle);
      for (let start = 0; start < n; start += length) {
        let wReal = 1;
        let wImag = 0;
        const half = length >> 1;
        for (let j = 0; j < half; j++) {
          const uReal = real[start + j];
          const uImag = imag[start + j];
          const vIndex = start + j + half;
          const vReal = real[vIndex] * wReal - imag[vIndex] * wImag;
          const vImag = real[vIndex] * wImag + imag[vIndex] * wReal;
          real[start + j] = uReal + vReal;
          imag[start + j] = uImag + vImag;
          real[vIndex] = uReal - vReal;
          imag[vIndex] = uImag - vImag;
          const nextWReal = wReal * wLenReal - wImag * wLenImag;
          wImag = wReal * wLenImag + wImag * wLenReal;
          wReal = nextWReal;
        }
      }
    }
  }
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function frameConfidence(logits: Float32Array, frame: number): number {
  return sigmoid(logits[frame] ?? -20);
}
