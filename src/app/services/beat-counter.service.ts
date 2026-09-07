import { Injectable, computed, signal } from '@angular/core';

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
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
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
    // una fase con suficiente confianza.
    if (this.beatsPerBar() === 4 && !this.autoOneLocked && this.onsetHistory.length >= 12) {
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
    if (!bpm || !this.beatAnchorTime || this.autoOneLocked) return;

    const interval = 60000 / bpm;
    const elapsed = now - this.beatAnchorTime;
    const nearestBeatIndex = Math.round(elapsed / interval);
    const ideal = this.beatAnchorTime + nearestBeatIndex * interval;
    const phaseError = now - ideal;

    // Solo corregimos ligeramente: el tempo ya lo controla la rejilla.
    if (Math.abs(phaseError) < interval * 0.15) {
      this.beatAnchorTime += phaseError * 0.08;
    }
  }

  /**
   * Prueba todas las fases del compás y devuelve la que tenga un patrón más
   * coherente. No exige que haya un onset en todos los beats: usa los ataques
   * disponibles y su fuerza relativa.
   */
  private findBestDownbeat(): { anchorTime: number; confidence: number } | null {
    const bpm = this.bpm();
    if (!bpm || this.beatsPerBar() !== 4 || this.onsetHistory.length < 10) {
      return null;
    }

    const interval = 60000 / bpm;
    const onsets = this.onsetHistory.slice(-this.downbeatWindowBeats * 2);
    if (onsets.length < 10) return null;

    const referenceTime = onsets[0].time;
    const candidates = [0, 1, 2, 3].map((phase) => referenceTime + phase * interval);
    const scored = candidates.map((anchorTime) => ({
      anchorTime,
      ...this.scorePhase(anchorTime, interval, onsets),
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

  private scorePhase(anchorTime: number, interval: number, onsets: Onset[]): {
    score: number;
    means: number[];
  } {
    const groups: number[][] = [[], [], [], []];
    const tolerance = interval * 0.28;

    for (const onset of onsets) {
      const beatFloat = (onset.time - anchorTime) / interval;
      const nearest = Math.round(beatFloat);
      const error = Math.abs(beatFloat - nearest) * interval;
      if (error > tolerance) continue;

      const position = ((nearest % 4) + 4) % 4;
      // Mezclamos el ataque con graves: para downbeat suele ser útil dar
      // algo más de peso al contenido grave.
      const weightedStrength = onset.strength * 0.75 + onset.lowEnergy * 0.25;
      groups[position].push(weightedStrength);
    }

    const means = groups.map((values) =>
      values.length ? this.mean(values) : 0,
    );

    const nonZero = means.filter((value) => value > 0);
    if (nonZero.length < 3) {
      return { score: 0, means };
    }

    const averageOther = (means[1] + means[2] + means[3]) / 3;
    const total = this.mean(means);
    const downbeatAccent = total > 0 ? (means[0] - averageOther) / total : 0;

    // Premia que el 1 aparezca de forma consistente: no basta con un único
    // golpe enorme al principio.
    const hitCounts = groups.map((group) => group.length);
    const repetition = Math.min(1, hitCounts[0] / Math.max(1, Math.max(...hitCounts.slice(1))));

    const score = downbeatAccent * 0.72 + repetition * 0.28;
    return { score, means };
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
