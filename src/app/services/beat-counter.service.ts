import { Injectable, computed, inject, signal } from '@angular/core';
import { BeatThisService } from './beat-this.service';

export type CounterMode = 'manual' | 'mic';

type Onset = {
  time: number;
  strength: number;
  lowEnergy: number;
};

/**
 * Detector de pulso + estimación de downbeat ("el 1").
 *
 * Idea:
 *  1. Detectamos ataques musicales con spectral flux + graves.
 *  2. Estimamos un BPM robusto a partir de los intervalos.
 *  3. Probamos las 4 fases posibles del compás.
 *  4. Para cada fase agrupamos los ataques en posiciones 1/2/3/4 y buscamos
 *     la que presenta un patrón repetitivo donde el 1 destaca de forma estable.
 *  5. Una vez encontrado el 1, dejamos que una rejilla temporal siga el tempo.
 *     Los nuevos ataques solo corrigen suavemente la fase para evitar deriva.
 *
 * Está pensado especialmente para baile (4 tiempos), pero sigue funcionando
 * con 3/4 y 8 tiempos usando la misma rejilla temporal.
 */
@Injectable({ providedIn: 'root' })
export class BeatCounterService {
  private readonly beatThis = inject(BeatThisService);
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private scriptProcessor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;
  private audioChunks: Float32Array[] = [];
  private collectedAudioSamples = 0;
  private totalCapturedSamples = 0;
  private audioCaptureStartMs = 0;
  private lastNeuralAnalysisMs = 0;
  private neuralAnalysisBusy = false;
  private neuralDownbeatTimesMs: number[] = [];
  private rafId: number | null = null;
  private beatTimerId: number | null = null;

  private previousSpectrum: Float32Array | null = null;
  private onsetHistory: Onset[] = [];
  private energyHistory: number[] = [];
  private beatIntervals: number[] = [];

  private lastOnsetTime = 0;
  private beatAnchorTime = 0; // instante del beat 1 de la rejilla
  private nextScheduledBeatTime = 0;
  private autoOneLocked = false;

  private readonly energyHistorySize = 60;
  private readonly intervalHistorySize = 18;
  private readonly onsetHistorySize = 48;
  private readonly minOnsetGapMs = 180;
  private readonly minUsefulIntervalMs = 250;
  private readonly maxUsefulIntervalMs = 1200;
  private readonly downbeatWindowBeats = 24; // ~6 compases en 4/4

  readonly beatsPerBar = signal(4);
  readonly currentBeat = signal(1);
  readonly isListening = signal(false);
  readonly micError = signal<string | null>(null);
  readonly bpm = signal<number | null>(null);
  readonly oneConfidence = signal(0); // 0..100
  readonly neuralReady = this.beatThis.ready;
  readonly neuralProcessing = this.beatThis.processing;
  readonly beatIndexes = computed(() =>
    Array.from({ length: this.beatsPerBar() }, (_, i) => i),
  );

  setBeatsPerBar(n: number): void {
    const value = Math.max(1, Math.min(16, Math.round(n)));
    this.beatsPerBar.set(value);
    this.currentBeat.set(1);
    this.autoOneLocked = false;
    this.oneConfidence.set(0);
    if (this.bpm()) {
      this.beatAnchorTime = performance.now();
      this.nextScheduledBeatTime = this.beatAnchorTime + 60000 / this.bpm()!;
    }
  }

  tap(): void {
    this.registerManualBeat(performance.now());
  }

  /** Fuerza el instante actual a ser el 1 y reinicia la fase sin perder BPM. */
  markAsOne(): void {
    const now = performance.now();
    this.currentBeat.set(1);
    this.beatAnchorTime = now;
    this.autoOneLocked = true;
    this.oneConfidence.set(100);
    this.scheduleNextBeat(now);
  }

  /** Busca explícitamente el 1 con el material de audio que ya tenemos. */
  detectOne(): void {
    const detected = this.findBestDownbeat();
    if (!detected) return;

    const { anchorTime, confidence } = detected;
    this.beatAnchorTime = anchorTime;
    this.currentBeat.set(1);
    this.oneConfidence.set(confidence);
    this.autoOneLocked = confidence >= 50;
    this.scheduleNextBeat(anchorTime);
  }

  reset(): void {
    this.currentBeat.set(1);
    this.bpm.set(null);
    this.oneConfidence.set(0);
    this.lastOnsetTime = 0;
    this.beatAnchorTime = 0;
    this.nextScheduledBeatTime = 0;
    this.onsetHistory = [];
    this.energyHistory = [];
    this.beatIntervals = [];
    this.previousSpectrum = null;
    this.autoOneLocked = false;
    this.neuralDownbeatTimesMs = [];
    this.totalCapturedSamples = 0;
    this.audioCaptureStartMs = 0;
  }

  async startListening(): Promise<void> {
    if (this.isListening()) return;

    this.micError.set(null);

    if (!navigator.mediaDevices?.getUserMedia) {
      this.micError.set('Este dispositivo no permite acceder al micrófono desde la app.');
      return;
    }

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      this.audioContext = new AudioContext({ latencyHint: 'interactive' });
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      const source = this.audioContext.createMediaStreamSource(this.micStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.05;
      source.connect(this.analyser);

      // Capture raw PCM in parallel for Beat This! inference. A zero-gain node
      // avoids sending the microphone back to the phone speaker.
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.scriptProcessor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input);
        this.audioChunks.push(copy);
        if (!this.audioCaptureStartMs) this.audioCaptureStartMs = performance.now();
        this.collectedAudioSamples += copy.length;
        this.totalCapturedSamples += copy.length;
        const maxSamples = Math.ceil((this.audioContext?.sampleRate ?? 48000) * 30);
        while (this.collectedAudioSamples > maxSamples && this.audioChunks.length > 1) {
          const removed = this.audioChunks.shift();
          if (removed) this.collectedAudioSamples -= removed.length;
        }
        this.maybeRunNeuralAnalysis();
      };
      this.silentGain = this.audioContext.createGain();
      this.silentGain.gain.value = 0;
      source.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.silentGain);
      this.silentGain.connect(this.audioContext.destination);

      this.previousSpectrum = new Float32Array(this.analyser.frequencyBinCount);
      this.energyHistory = [];
      this.onsetHistory = [];
      this.beatIntervals = [];
      this.lastOnsetTime = 0;
      this.beatAnchorTime = 0;
      this.nextScheduledBeatTime = 0;
      this.bpm.set(null);
      this.oneConfidence.set(0);
      this.autoOneLocked = false;
      this.audioChunks = [];
      this.collectedAudioSamples = 0;
      this.totalCapturedSamples = 0;
      this.audioCaptureStartMs = 0;
      this.lastNeuralAnalysisMs = 0;
      this.neuralAnalysisBusy = false;
      this.neuralDownbeatTimesMs = [];

      void this.beatThis.init();
      this.isListening.set(true);
      this.watchLoop();
    } catch (error) {
      this.stopListening();
      const name = error instanceof DOMException ? error.name : '';
      this.micError.set(
        name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Permiso de micrófono denegado. Actívalo en los ajustes de Android.'
          : 'No se pudo acceder al micrófono. Comprueba que ninguna otra app lo esté usando.',
      );
    }
  }

  stopListening(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }

    if (this.scriptProcessor) {
      this.scriptProcessor.onaudioprocess = null;
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    this.silentGain?.disconnect();
    this.silentGain = null;
    this.audioChunks = [];
    this.collectedAudioSamples = 0;
    this.totalCapturedSamples = 0;
    this.audioCaptureStartMs = 0;
    this.neuralAnalysisBusy = false;

    if (this.beatTimerId !== null) {
      window.clearInterval(this.beatTimerId);
      this.beatTimerId = null;
    }

    this.micStream?.getTracks().forEach((track) => track.stop());
    void this.audioContext?.close();

    this.micStream = null;
    this.audioContext = null;
    this.analyser = null;
    this.previousSpectrum = null;
    this.isListening.set(false);
  }

  private watchLoop = (): void => {
    if (!this.analyser || !this.audioContext) return;

    const timeData = new Uint8Array(this.analyser.fftSize);
    const spectrum = new Float32Array(this.analyser.frequencyBinCount);

    this.analyser.getByteTimeDomainData(timeData);
    this.analyser.getFloatFrequencyData(spectrum);

    let sumSquares = 0;
    for (const value of timeData) {
      const sample = (value - 128) / 128;
      sumSquares += sample * sample;
    }
    const energy = Math.sqrt(sumSquares / timeData.length);

    let flux = 0;
    let lowBandEnergy = 0;
    const nyquist = this.audioContext.sampleRate / 2;
    const binHz = nyquist / spectrum.length;

    for (let i = 0; i < spectrum.length; i++) {
      const current = Math.max(0, Math.pow(10, spectrum[i] / 20));
      const previous = this.previousSpectrum
        ? Math.max(0, Math.pow(10, this.previousSpectrum[i] / 20))
        : 0;
      flux += Math.max(0, current - previous);

      const frequency = i * binHz;
      if (frequency >= 45 && frequency <= 180) {
        lowBandEnergy += current;
      }
    }

    if (this.previousSpectrum) {
      this.previousSpectrum.set(spectrum);
    }

    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.energyHistorySize) {
      this.energyHistory.shift();
    }

    const meanEnergy = this.mean(this.energyHistory);
    const energyStd = this.standardDeviation(this.energyHistory, meanEnergy);
    const energyThreshold = meanEnergy + Math.max(energyStd * 1.1, 0.012);

    const combinedOnsetStrength = flux * 0.78 + lowBandEnergy * 0.22;
    const isStrongEnough =
      energy > energyThreshold && combinedOnsetStrength > 0.05;
    const now = performance.now();
    const enoughTimeSinceOnset = now - this.lastOnsetTime > this.minOnsetGapMs;

    if (isStrongEnough && enoughTimeSinceOnset) {
      this.registerOnset(now, combinedOnsetStrength, lowBandEnergy);
    }

    this.rafId = requestAnimationFrame(this.watchLoop);
  };

  private registerOnset(now: number, strength: number, lowEnergy: number): void {
    if (this.lastOnsetTime > 0) {
      const interval = now - this.lastOnsetTime;
      if (
        interval >= this.minUsefulIntervalMs &&
        interval <= this.maxUsefulIntervalMs
      ) {
        this.beatIntervals.push(interval);
        if (this.beatIntervals.length > this.intervalHistorySize) {
          this.beatIntervals.shift();
        }
        this.updateTempoEstimate();
      }
    }

    this.lastOnsetTime = now;
    this.onsetHistory.push({ time: now, strength, lowEnergy });
    if (this.onsetHistory.length > this.onsetHistorySize) {
      this.onsetHistory.shift();
    }

    if (!this.bpm()) {
      // Mientras todavía aprendemos el tempo, dejamos feedback inmediato.
      this.currentBeat.set((this.currentBeat() % this.beatsPerBar()) + 1);
      return;
    }

    // Tras estabilizar BPM, buscamos el 1 automáticamente hasta encontrar
    // una fase con suficiente confianza. Funciona para cualquier compás
    // (4, 8, 3...), no solo 4/4.
    if (this.beatsPerBar() >= 2 && !this.autoOneLocked && this.onsetHistory.length >= 12) {
      this.detectOne();
    }

    this.correctPhase(now);
  }

  private updateTempoEstimate(): void {
    if (this.beatIntervals.length < 5) return;

    const candidates: number[] = [];
    for (const interval of this.beatIntervals) {
      const base = 60000 / interval;
      for (const multiplier of [0.5, 1, 2]) {
        const candidate = base * multiplier;
        if (candidate >= 70 && candidate <= 180) {
          candidates.push(candidate);
        }
      }
    }

    // Mediana de las candidatas cercanas entre sí: evita que un único ataque
    // extraño cambie el tempo continuamente.
    candidates.sort((a, b) => a - b);
    const median = candidates[Math.floor(candidates.length / 2)];
    const current = this.bpm();
    const nextBpm = current
      ? this.closestCandidate(candidates, current)
      : this.closestCandidate(candidates, 120);

    const rounded = Math.round(nextBpm);
    if (!current || Math.abs(current - rounded) <= 5) {
      this.bpm.set(rounded);
      this.ensureBeatClock(performance.now());
    } else if (Math.abs(nextBpm - median) < 8) {
      this.bpm.set(rounded);
      this.ensureBeatClock(performance.now());
    }
  }

  private closestCandidate(values: number[], target: number): number {
    return values.reduce((best, value) =>
      Math.abs(value - target) < Math.abs(best - target) ? value : best,
    );
  }

  private ensureBeatClock(now: number): void {
    const bpm = this.bpm();
    if (!bpm) return;

    if (!this.beatAnchorTime) {
      const detected = this.findBestDownbeat();
      if (detected) {
        this.beatAnchorTime = detected.anchorTime;
        this.oneConfidence.set(detected.confidence);
        this.autoOneLocked = detected.confidence >= 50;
      } else {
        this.beatAnchorTime = now;
      }
      this.currentBeat.set(this.getBeatAtTime(now));
      this.scheduleNextBeat(now);
    }

    if (this.beatTimerId === null) {
      this.beatTimerId = window.setInterval(() => this.tickBeatClock(), 25);
    }
  }

  private scheduleNextBeat(now: number): void {
    const bpm = this.bpm();
    if (!bpm || !this.beatAnchorTime) return;
    const interval = 60000 / bpm;
    const elapsedBeats = Math.max(0, Math.floor((now - this.beatAnchorTime) / interval));
    this.nextScheduledBeatTime = this.beatAnchorTime + (elapsedBeats + 1) * interval;
  }

  private tickBeatClock(): void {
    const bpm = this.bpm();
    if (!bpm || !this.isListening() || !this.beatAnchorTime) return;

    const now = performance.now();
    const expectedBeat = this.getBeatAtTime(now);
    if (expectedBeat !== this.currentBeat()) {
      this.currentBeat.set(expectedBeat);
    }

    const interval = 60000 / bpm;
    while (now >= this.nextScheduledBeatTime) {
      this.nextScheduledBeatTime += interval;
    }
  }

  private getBeatAtTime(time: number): number {
    const bpm = this.bpm();
    if (!bpm || !this.beatAnchorTime) return 1;
    const interval = 60000 / bpm;
    const beatIndex = Math.max(0, Math.floor((time - this.beatAnchorTime) / interval));
    return (beatIndex % this.beatsPerBar()) + 1;
  }

  private correctPhase(now: number): void {
    const bpm = this.bpm();
    if (!bpm || !this.beatAnchorTime) return;

    const interval = 60000 / bpm;
    const elapsed = now - this.beatAnchorTime;
    const nearestBeatIndex = Math.round(elapsed / interval);
    const ideal = this.beatAnchorTime + nearestBeatIndex * interval;
    const phaseError = now - ideal;

    // Solo corregimos ligeramente: el tempo ya lo controla la rejilla.
    // Antes, en cuanto localizábamos el 1 (autoOneLocked) dejábamos de
    // corregir del todo, lo que hacía que un pequeño error de BPM se
    // fuera acumulando en canciones largas hasta desincronizar el conteo.
    // Ahora seguimos corrigiendo siempre, pero mucho más suave una vez
    // localizado el 1, para no "cazar" el downbeat de un lado a otro.
    const alpha = this.autoOneLocked ? 0.025 : 0.08;
    if (Math.abs(phaseError) < interval * 0.15) {
      this.beatAnchorTime += phaseError * alpha;
    }
  }

  /**
   * Prueba todas las fases del compás y devuelve la que tenga un patrón más
   * coherente. No exige que haya un onset en todos los beats: usa los ataques
   * disponibles y su fuerza relativa.
   */
  private findBestDownbeat(): { anchorTime: number; confidence: number } | null {
    const bpm = this.bpm();
    const n = this.beatsPerBar();
    // Con menos de 2 tiempos por compás no hay downbeat que distinguir.
    // Con compases muy largos (>8) probamos solo las primeras 8 fases:
    // más allá de eso el acento musical real (graves/armonía) ya no suele
    // marcar la diferencia y solo añadimos ruido a la búsqueda.
    if (!bpm || n < 2 || this.onsetHistory.length < 10) {
      return null;
    }

    const phasesToTest = Math.min(n, 8);
    const interval = 60000 / bpm;
    const onsets = this.onsetHistory.slice(-this.downbeatWindowBeats * 2);
    if (onsets.length < 10) return null;

    const referenceTime = onsets[0].time;
    const candidates = Array.from({ length: phasesToTest }, (_, phase) => referenceTime + phase * interval);
    const scored = candidates.map((anchorTime) => ({
      anchorTime,
      ...this.scorePhase(anchorTime, interval, onsets, n),
    }));

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];

    // Confianza basada tanto en el patrón como en la separación respecto a
    // la segunda fase. Evitamos afirmar que sabemos dónde está el 1 si todas
    // las fases se parecen demasiado.
    const separation = Math.max(0, best.score - second.score);
    const confidence = Math.round(
      Math.max(0, Math.min(100, best.score * 75 + separation * 80)),
    );

    if (confidence < 35) return null;

    // Llevamos el ancla al beat más reciente de la fase elegida.
    const beatsBehind = Math.round((performance.now() - best.anchorTime) / interval);
    const latestAnchor = best.anchorTime + beatsBehind * interval;
    return { anchorTime: latestAnchor, confidence };
  }

  private scorePhase(anchorTime: number, interval: number, onsets: Onset[], n: number): {
    score: number;
    means: number[];
  } {
    const groups: number[][] = Array.from({ length: n }, () => []);
    const tolerance = interval * 0.28;

    for (const onset of onsets) {
      const beatFloat = (onset.time - anchorTime) / interval;
      const nearest = Math.round(beatFloat);
      const error = Math.abs(beatFloat - nearest) * interval;
      if (error > tolerance) continue;

      const position = ((nearest % n) + n) % n;
      // Mezclamos el ataque con graves: para downbeat suele ser útil dar
      // algo más de peso al contenido grave.
      const weightedStrength = onset.strength * 0.75 + onset.lowEnergy * 0.25;
      groups[position].push(weightedStrength);
    }

    const means = groups.map((values) =>
      values.length ? this.mean(values) : 0,
    );

    // Necesitamos señal en al menos ~el 60% de las posiciones para fiarnos
    // del patrón (con n grande exigir "todas menos una" es poco realista).
    const nonZero = means.filter((value) => value > 0);
    if (nonZero.length < Math.max(2, Math.ceil(n * 0.6))) {
      return { score: 0, means };
    }

    const others = means.slice(1);
    const averageOther = this.mean(others);
    const total = this.mean(means);
    const downbeatAccent = total > 0 ? (means[0] - averageOther) / total : 0;

    // Premia que el 1 aparezca de forma consistente: no basta con un único
    // golpe enorme al principio.
    const hitCounts = groups.map((group) => group.length);
    const repetition = Math.min(1, hitCounts[0] / Math.max(1, Math.max(...hitCounts.slice(1))));

    const score = downbeatAccent * 0.72 + repetition * 0.28;
    return { score, means };
  }

  private maybeRunNeuralAnalysis(): void {
    if (!this.isListening() || this.neuralAnalysisBusy || !this.audioContext) return;
    const now = performance.now();
    const sampleRate = this.audioContext.sampleRate;
    const minSamples = Math.floor(sampleRate * 8);
    if (this.collectedAudioSamples < minSamples) return;
    if (now - this.lastNeuralAnalysisMs < 4500) return;

    const windowSeconds = Math.min(14, this.collectedAudioSamples / sampleRate);
    const windowSamples = Math.floor(windowSeconds * sampleRate);
    const pcm = this.takeRecentAudio(windowSamples);
    if (!pcm.length) return;

    const capturedEndMs = this.audioCaptureStartMs + (this.totalCapturedSamples / sampleRate) * 1000;
    const startTimeMs = capturedEndMs - windowSeconds * 1000;
    this.lastNeuralAnalysisMs = now;
    this.neuralAnalysisBusy = true;

    void this.beatThis.analyze(pcm, sampleRate, startTimeMs).then((events) => {
      const downbeats = events
        .filter((event) => event.kind === 'downbeat' && event.confidence >= 0.45)
        .map((event) => event.timeMs)
        .filter((time) => Number.isFinite(time));

      if (downbeats.length) {
        this.neuralDownbeatTimesMs.push(...downbeats);
        this.neuralDownbeatTimesMs = this.uniqueSortedTimes(this.neuralDownbeatTimesMs).slice(-24);
        const latest = downbeats[downbeats.length - 1];
        this.applyNeuralDownbeat(latest);
      }
    }).finally(() => {
      this.neuralAnalysisBusy = false;
    });
  }

  private takeRecentAudio(sampleCount: number): Float32Array {
    const out = new Float32Array(sampleCount);
    let write = sampleCount;
    for (let i = this.audioChunks.length - 1; i >= 0 && write > 0; i--) {
      const chunk = this.audioChunks[i];
      const take = Math.min(chunk.length, write);
      out.set(chunk.subarray(chunk.length - take), write - take);
      write -= take;
    }
    return write === 0 ? out : out.subarray(write);
  }

  private applyNeuralDownbeat(timeMs: number): void {
    const bpm = this.bpm();
    if (!bpm || this.beatsPerBar() < 2) return;

    const interval = 60000 / bpm;
    const recent = this.neuralDownbeatTimesMs.slice(-6);

    // A single neural downbeat is useful, but two or more consistent
    // downbeats are much stronger evidence that we found the bar phase.
    if (recent.length >= 2) {
      const spacings = [];
      for (let i = 1; i < recent.length; i++) {
        spacings.push(recent[i] - recent[i - 1]);
      }
      const nearBar = spacings.filter((spacing) => {
        const bars = spacing / (interval * 4);
        return bars >= 0.75 && bars <= 1.25;
      });

      if (nearBar.length > 0) {
        const confidence = this.beatThis.lastDownbeatConfidence();
        if (confidence >= 45) {
          // The model is explicitly predicting the bar start. Do not force
          // this timestamp through the old onset phase heuristic: a correct
          // neural downbeat can be exactly 1, 2 or 3 beats away from the
          // heuristic's current phase. Instead, replace the phase anchor.
          this.beatAnchorTime = timeMs;
          this.currentBeat.set(this.getBeatAtTime(performance.now()));
          this.oneConfidence.set(Math.max(this.oneConfidence(), confidence));
          this.autoOneLocked = true;
          this.scheduleNextBeat(performance.now());
        }
        return;
      }
    }

    // During startup accept one confident model downbeat as a provisional
    // anchor. A later consistent prediction will confirm/correct it.
    if (!this.beatAnchorTime && this.beatThis.lastDownbeatConfidence() >= 55) {
      this.beatAnchorTime = timeMs;
      this.currentBeat.set(this.getBeatAtTime(performance.now()));
      this.oneConfidence.set(this.beatThis.lastDownbeatConfidence());
      this.autoOneLocked = true;
      this.scheduleNextBeat(performance.now());
    }
  }

  private uniqueSortedTimes(times: number[]): number[] {
    const sorted = [...times].sort((a, b) => a - b);
    const result: number[] = [];
    for (const value of sorted) {
      if (!result.length || Math.abs(value - result[result.length - 1]) > 120) {
        result.push(value);
      }
    }
    return result;
  }

  private registerManualBeat(now: number): void {
    if (this.lastOnsetTime > 0) {
      const interval = now - this.lastOnsetTime;
      if (interval >= 250 && interval <= 1500) {
        this.beatIntervals.push(interval);
        if (this.beatIntervals.length > this.intervalHistorySize) {
          this.beatIntervals.shift();
        }
        this.updateTempoEstimate();
      }
    }

    this.lastOnsetTime = now;
    this.currentBeat.set((this.currentBeat() % this.beatsPerBar()) + 1);
  }

  private mean(values: number[]): number {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private standardDeviation(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const variance = this.mean(values.map((value) => (value - mean) ** 2));
    return Math.sqrt(variance);
  }
}
