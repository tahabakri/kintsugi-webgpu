import type { Mode, Tool } from '../config';

/**
 * The two modes and the tool armed within them.
 *   Break:  no tool (grab, drop, orbit) or Strike (click a point on the bowl).
 *   Repair: Gold brush on by default; with it off the pointer only moves shards.
 */
export class Modes {
  mode: Mode = 'break';
  tool: Tool = 'none';

  constructor(private readonly onChange: () => void) {}

  setMode(mode: Mode): void {
    if (this.mode === mode && (mode === 'break' || this.tool === 'brush')) return;
    this.mode = mode;
    this.tool = mode === 'repair' ? 'brush' : 'none';
    this.onChange();
  }

  toggleStrike(): void {
    const arm = this.tool !== 'strike';
    this.mode = 'break';
    this.tool = arm ? 'strike' : 'none';
    this.onChange();
  }

  toggleBrush(): void {
    if (this.mode !== 'repair') {
      this.mode = 'repair';
      this.tool = 'brush';
    } else {
      this.tool = this.tool === 'brush' ? 'none' : 'brush';
    }
    this.onChange();
  }

  /** Puts any armed tool down (Escape, or after a strike has been thrown). */
  disarm(): void {
    if (this.tool === 'none') return;
    this.tool = 'none';
    this.onChange();
  }

  reset(): void {
    this.mode = 'break';
    this.tool = 'none';
    this.onChange();
  }
}
