import { Component, inject } from '@angular/core';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonSegment,
  IonSegmentButton,
  IonLabel,
  IonIcon,
  IonButton,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { micOutline, flagOutline, refreshOutline, locateOutline } from 'ionicons/icons';
import { BeatCounterService, CounterMode } from '../services/beat-counter.service';

@Component({
  selector: 'app-home',
  templateUrl: 'home.page.html',
  styleUrls: ['home.page.scss'],
  imports: [
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonSegment,
    IonSegmentButton,
    IonLabel,
    IonIcon,
    IonButton,
  ],
})
export class HomePage {
  protected readonly counter = inject(BeatCounterService);
  protected mode: CounterMode = 'manual';

  constructor() {
    addIcons({ micOutline, flagOutline, refreshOutline, locateOutline });
  }

  protected async setMode(mode: CounterMode): Promise<void> {
    if (mode === this.mode) return;
    this.mode = mode;

    if (mode === 'mic') {
      await this.counter.startListening();
    } else {
      this.counter.stopListening();
      this.counter.reset();
    }
  }

  protected onTap(): void {
    if (this.mode === 'manual') this.counter.tap();
  }

  protected setBeatsPerBar(value: number): void {
    this.counter.setBeatsPerBar(value);
  }

  ngOnDestroy(): void {
    this.counter.stopListening();
  }
}