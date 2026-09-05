import { Injectable, signal, computed } from '@angular/core';

export type CounterMode = 'manual' | 'mic';

/**
 * Gestiona la cuenta de tiempos (1, 2, 3, 4...) tanto en modo manual (tap)
 * como escuchando el micrófono.
 *
 * La detección por micrófono usa un detector de "onsets" muy simple basado
 * en energía: mide el volumen de la señal en cada frame y dispara un "golpe"
 * cuando supera claramente la media reciente (umbral adaptativo), con un
 * periodo refractario para no contar dos veces el mismo golpe.
 *
 * Esto funciona razonablemente bien con música con pulso marcado (bajo,
 * bombo, palmas) pero NO hace beat-tracking real: no sabe solo, sin ayuda,
 * cuál de los golpes es "el 1" de compás. Por eso existe `markAsOne()`,
 * para que el bailarín sincronice la fase a mano y luego la app siga
 * contando sola. Si más adelante se quiere afinar la detección, este es el
 * sitio para sustituir `watchLoop` por una librería como Meyda o aubio.js.
 */
@Injectable({ providedIn: 'root' })
export class BeatCounterService {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private micStream: MediaStream | null = null;
  private rafId: number | null = null;

  private energyHistory: number[] = [];
  private readonly historySize = 40; // ~ último segundo de contexto
  private lastBeatTime = 0;
  private readonly refractoryMs = 250; // no permite más de ~240 bpm

  readonly beatsPerBar = signal(4);
  readonly currentBeat = signal(1); // 1-indexado, más natural para bailar
  readonly isListening = signal(false);
  readonly micError = signal<string | null>(null);
  readonly lastBeatIntervalMs = signal<number | null>(null);

  readonly bpm = computed(() => {
    const interval = this.lastBeatIntervalMs();
    return interval ? Math.round(60000 / interval) : null;
  });

  readonly beatIndexes = computed(() =>
    Array.from({ length: this.beatsPerBar() }, (_, i) => i)
  );

  setBeatsPerBar(n: number): void {
    this.beatsPerBar.set(n);
    this.currentBeat.set(1);
  }

  /** Avanza un tiempo manualmente (modo manual, o tap-tempo). */
  tap(): void {
    this.registerBeat(performance.now());
  }

  /** Realinea la fase: el tiempo actual pasa a ser "el 1" sin perder el tempo. */
  markAsOne(): void {
    this.currentBeat.set(1);
  }

  reset(): void {
    this.currentBeat.set(1);
    this.lastBeatIntervalMs.set(null);
    this.lastBeatTime = 0;
    this.energyHistory = [];
  }

  async startListening(): Promise<void> {
    if (this.isListening()) return;
    this.micError.set(null);

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      this.micError.set('No se pudo acceder al micrófono. Revisa los permisos de la app.');
      return;
    }

    this.audioContext = new AudioContext();
    const source = this.audioContext.createMediaStreamSource(this.micStream);
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);

    this.energyHistory = [];
    this.isListening.set(true);
    this.watchLoop();
  }

  stopListening(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;

    this.micStream?.getTracks().forEach((track) => track.stop());
    this.audioContext?.close();

    this.audioContext = null;
    this.analyser = null;
    this.micStream = null;
    this.isListening.set(false);
  }

  /** Bucle de análisis de audio. Arrow function para conservar `this` en requestAnimationFrame. */
  private watchLoop = (): void => {
    if (!this.analyser) return;

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteTimeDomainData(data);

    // Energía RMS de la ventana actual: aproxima la fuerza del "golpe" (bajo, bombo, palmas...).
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const centered = (data[i] - 128) / 128;
      sumSquares += centered * centered;
    }
    const energy = Math.sqrt(sumSquares / data.length);

    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.historySize) this.energyHistory.shift();

    const average = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
    // Umbral adaptativo: un golpe es un pico bien por encima de la energía media reciente.
    const threshold = average * 1.6 + 0.02;
    const now = performance.now();

    if (energy > threshold && now - this.lastBeatTime > this.refractoryMs) {
      this.registerBeat(now);
    }

    this.rafId = requestAnimationFrame(this.watchLoop);
  };

  private registerBeat(now: number): void {
    if (this.lastBeatTime > 0) {
      const interval = now - this.lastBeatTime;
      // Descarta intervalos larguísimos (silencios) para no falsear el bpm estimado.
      if (interval < 2000) this.lastBeatIntervalMs.set(interval);
    }
    this.lastBeatTime = now;

    const next = (this.currentBeat() % this.beatsPerBar()) + 1;
    this.currentBeat.set(next);
  }
}