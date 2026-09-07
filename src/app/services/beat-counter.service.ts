import { Injectable, computed, signal } from '@angular/core';

export type CounterMode = 'manual' | 'mic';

/**
 * Cuenta tiempos en modo manual o siguiendo el pulso detectado por el micrófono.
 *
 * La detección usa spectral flux + energía de graves para encontrar ataques
 * musicales. Después de reunir suficientes intervalos, estima un BPM estable
 * y mantiene una rejilla temporal con ese BPM. De esta forma no es necesario
 * detectar físicamente un golpe en cada tiempo.
 */
@Injectable({ providedIn: 'root' })
export class BeatCounterService {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private rafId: number | null = null;
  private beatTimerId: number | null = null;

  private previousSpectrum: Float32Array | null = null;
  private onsetHistory: number[] = [];
  private energyHistory: number[] = [];
  private beatIntervals: number[] = [];

  private lastOnsetTime = 0;
  private beatAnchorTime = 0;
  private nextScheduledBeatTime = 0;

  private readonly energyHistorySize = 60;
  private readonly intervalHistorySize = 12;
  private readonly minOnsetGapMs = 220;
  private readonly minUsefulIntervalMs = 250;
  private readonly maxUsefulIntervalMs = 1200;

  readonly beatsPerBar = signal(4);
  readonly currentBeat = signal(1);
  readonly isListening = signal(false);
  readonly micError = signal<string | null>(null);
  readonly bpm = signal<number | null>(null);
  readonly beatIndexes = computed(() =>
    Array.from({ length: this.beatsPerBar() }, (_, i) => i),
  );

  setBeatsPerBar(n: number): void {
    const value = Math.max(1, Math.min(16, Math.round(n)));
    this.beatsPerBar.set(value);
    this.currentBeat.set(1);
  }

  tap(): void {
    this.registerManualBeat(performance.now());
  }

  markAsOne(): void {
    const now = performance.now();
    this.currentBeat.set(1);
    if (this.bpm()) {
      this.beatAnchorTime = now;
      this.nextScheduledBeatTime = now;
    }
  }

  reset(): void {
    this.currentBeat.set(1);
    this.bpm.set(null);
    this.lastOnsetTime = 0;
    this.beatAnchorTime = 0;
    this.nextScheduledBeatTime = 0;
    this.onsetHistory = [];
    this.energyHistory = [];
    this.beatIntervals = [];
    this.previousSpectrum = null;
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

    const now = performance.now();
    const meanEnergy = this.mean(this.energyHistory);
    const energyStd = this.standardDeviation(this.energyHistory, meanEnergy);
    const energyThreshold = meanEnergy + Math.max(energyStd * 1.15, 0.015);

    // Normalizamos ligeramente el peso del grave para que un golpe de bombo
    // tenga más relevancia sin convertir cualquier ruido fuerte en un beat.
    const combinedOnsetStrength = flux * 0.75 + lowBandEnergy * 0.25;
    const isStrongEnough =
      energy > energyThreshold && combinedOnsetStrength > 0.055;
    const enoughTimeSinceOnset = now - this.lastOnsetTime > this.minOnsetGapMs;

    if (isStrongEnough && enoughTimeSinceOnset) {
      this.registerOnset(now);
    }

    this.rafId = requestAnimationFrame(this.watchLoop);
  };

  private registerOnset(now: number): void {
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
    this.onsetHistory.push(now);
    if (this.onsetHistory.length > 20) this.onsetHistory.shift();

    // Antes de tener un BPM fiable, los onsets sirven directamente como
    // tiempos provisionales. Una vez tenemos BPM, la rejilla se encarga del
    // conteo y los onsets solo corrigen ligeramente la fase.
    if (!this.bpm()) {
      this.currentBeat.set((this.currentBeat() % this.beatsPerBar()) + 1);
    } else {
      this.correctPhase(now);
    }
  }

  private updateTempoEstimate(): void {
    if (this.beatIntervals.length < 4) return;

    const sorted = [...this.beatIntervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const candidateBpm = 60000 / median;

    // Los detectores de onset suelen caer a mitad/doble tempo. Probamos
    // múltiplos/divisores sencillos y nos quedamos con un rango razonable.
    const candidates = [candidateBpm / 2, candidateBpm, candidateBpm * 2]
      .filter((value) => value >= 70 && value <= 180);

    if (candidates.length === 0) return;

    // Para baile, el pulso útil suele quedar aproximadamente entre 70 y 180.
    // Preferimos la opción más cercana al intervalo observado sin saltos.
    const current = this.bpm();
    const best = current
      ? candidates.reduce((a, b) =>
          Math.abs(b - current) < Math.abs(a - current) ? b : a,
        )
      : candidates.reduce((a, b) =>
          Math.abs(a - 120) < Math.abs(b - 120) ? a : b,
        );

    const nextBpm = Math.round(best);
    if (!this.bpm() || Math.abs((this.bpm() ?? nextBpm) - nextBpm) <= 4) {
      this.bpm.set(nextBpm);
      this.ensureBeatClock(performance.now());
    }
  }

  private ensureBeatClock(now: number): void {
    const bpm = this.bpm();
    if (!bpm) return;

    const interval = 60000 / bpm;
    if (!this.beatAnchorTime) {
      this.beatAnchorTime = now;
      this.nextScheduledBeatTime = now + interval;
    }

    if (this.beatTimerId === null) {
      this.beatTimerId = window.setInterval(() => this.tickBeatClock(), 25);
    }
  }

  private tickBeatClock(): void {
    const bpm = this.bpm();
    if (!bpm || !this.isListening() || !this.beatAnchorTime) return;

    const interval = 60000 / bpm;
    const now = performance.now();

    while (now >= this.nextScheduledBeatTime) {
      this.currentBeat.set((this.currentBeat() % this.beatsPerBar()) + 1);
      this.nextScheduledBeatTime += interval;
    }
  }

  private correctPhase(now: number): void {
    const bpm = this.bpm();
    if (!bpm) return;

    const interval = 60000 / bpm;
    if (!this.beatAnchorTime) {
      this.beatAnchorTime = now;
      this.nextScheduledBeatTime = now + interval;
      return;
    }

    // Ajuste suave de fase: desplaza la rejilla como mucho un 20% de un beat.
    const elapsed = now - this.beatAnchorTime;
    const nearestBeatIndex = Math.round(elapsed / interval);
    const ideal = this.beatAnchorTime + nearestBeatIndex * interval;
    const phaseError = now - ideal;

    if (Math.abs(phaseError) < interval * 0.2) {
      this.beatAnchorTime += phaseError * 0.12;
      this.nextScheduledBeatTime = this.beatAnchorTime + interval;
    }
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
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  private standardDeviation(values: number[], mean: number): number {
    if (values.length < 2) return 0;
    const variance = this.mean(values.map((value) => (value - mean) ** 2));
    return Math.sqrt(variance);
  }
}
