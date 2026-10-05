import type { Phase } from '../config';
import type { Interface } from './panel';

const PHASE_LABEL: Record<Phase | 'unavailable', string> = {
  intact: 'Intact',
  fractured: 'Fractured',
  repairing: 'Repairing',
  repaired: 'Repaired',
  paused: 'Paused',
  unavailable: 'Unavailable',
};

export interface PanelStats {
  fragments: number;
  /** Length of cracks not yet bonded, in metres. */
  openCrackLength: number;
  goldFilled: number;
  cured: number;
  repaired: number;
}

export function setStatus(ui: Interface, phase: Phase | 'unavailable'): void {
  if (ui.status.dataset.phase === phase) return;
  ui.status.dataset.phase = phase;
  ui.statusText.textContent = `WebGPU · ${PHASE_LABEL[phase]}`;
}

const write = (element: HTMLElement | undefined, text: string): void => {
  if (element && element.textContent !== text) element.textContent = text;
};

export function setStats(ui: Interface, stats: PanelStats): void {
  const percent = (value: number) => `${Math.round(value)}%`;
  write(ui.stats.fragments, String(stats.fragments));
  write(ui.stats.crackLength, `${stats.openCrackLength.toFixed(2)} m`);
  write(ui.stats.goldFilled, percent(stats.goldFilled));
  write(ui.stats.cured, percent(stats.cured));
  write(ui.stats.repaired, percent(stats.repaired));
  write(ui.stats.progress, percent(stats.repaired));
  const width = `${Math.max(0, Math.min(100, stats.repaired)).toFixed(1)}%`;
  if (ui.progressFill.style.width !== width) {
    ui.progressFill.style.width = width;
    ui.progressTrack.setAttribute('aria-valuenow', String(Math.round(stats.repaired)));
  }
}

/** A small, quiet line of guidance that fades by itself. */
export class Hint {
  private timer = 0;

  constructor(private readonly ui: Interface) {}

  show(text: string, milliseconds = 3600): void {
    const element = this.ui.hint;
    element.textContent = text;
    element.dataset.visible = 'true';
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), milliseconds);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.ui.hint.dataset.visible = 'false';
  }
}

/**
 * A line of guidance set beside the object itself. It is placed over a point of the scene every
 * frame while it shows, and goes as soon as the visitor does what it describes.
 */
export class Coach {
  private timer = 0;
  private at = '';

  constructor(private readonly ui: Interface) {}

  get visible(): boolean {
    return this.ui.coach.dataset.visible === 'true';
  }

  show(text: string, milliseconds: number): void {
    const element = this.ui.coach;
    element.textContent = text;
    element.dataset.visible = 'true';
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.hide(), milliseconds);
  }

  hide(): void {
    window.clearTimeout(this.timer);
    this.ui.coach.dataset.visible = 'false';
  }

  /** Centres the line on a canvas position (CSS pixels), with its last line sitting just above it. */
  place(x: number, y: number): void {
    const element = this.ui.coach;
    const half = element.offsetWidth / 2 + 12;
    const width = this.ui.canvas.clientWidth;
    const cx = Math.round(Math.max(half, Math.min(width - half, x)));
    const cy = Math.round(Math.max(element.offsetHeight + 12, y));
    const at = `translate(calc(${cx}px - 50%), calc(${cy}px - 100%))`;
    if (at === this.at) return;
    this.at = at;
    element.style.transform = at;
  }
}

/** Replaces the experience with the fallback overlay; `detail` adds a secondary line. */
export function showFallback(ui: Interface, detail?: string): void {
  document.body.classList.add('is-unavailable');
  ui.fallback.hidden = false;
  setStatus(ui, 'unavailable');
  if (detail) {
    ui.fallbackDetail.textContent = detail;
    ui.fallbackDetail.hidden = false;
  }
}
