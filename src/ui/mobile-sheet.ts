import type { Framing } from '../gpu/camera';
import type { Interface } from './panel';

const SHEET_QUERY = '(max-width: 900px)';

/**
 * On narrow viewports the control panel becomes a bottom sheet with a 56 px handle.
 * This also works out where the bowl should sit: clear of the masthead, the panel and the sheet.
 */
export class MobileSheet {
  private readonly media = window.matchMedia(SHEET_QUERY);
  private open = false;

  constructor(private readonly ui: Interface, private readonly onChange: () => void) {
    ui.sheetHandle.addEventListener('click', () => this.setOpen(!this.open));
    this.media.addEventListener('change', () => {
      if (!this.media.matches) this.setOpen(false);
      this.onChange();
    });
  }

  get isSheet(): boolean {
    return this.media.matches;
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(open: boolean): void {
    this.open = open && this.media.matches;
    this.ui.panel.dataset.open = String(this.open);
    this.ui.sheetHandle.setAttribute('aria-expanded', String(this.open));
    document.body.classList.toggle('sheet-open', this.open);
    this.onChange();
  }

  /** Screen position and free space for the bowl in the current layout. */
  framing(width: number, height: number): Framing {
    if (!this.isSheet) {
      const panel = this.ui.panel.getBoundingClientRect();
      const freeRight = Math.max(240, panel.left - 16);
      // Slightly right of the middle of the free area, so the masthead keeps its air.
      const centreX = Math.min(freeRight - 250, Math.max(width * 0.49, freeRight * 0.62));
      return {
        centreX: centreX / width,
        centreY: height < 620 ? 0.6 : 0.585,
        halfWidth: Math.min(centreX, freeRight - centreX),
        halfHeight: height * 0.3,
      };
    }
    const portrait = height >= width;
    const sheetTop = this.open ? height - Math.min(height * 0.64, this.ui.panel.getBoundingClientRect().height) : height - 56;
    if (portrait) {
      // The masthead takes the top; the bowl goes into the space between it and the sheet.
      const top = Math.min(height * 0.44, this.ui.masthead.getBoundingClientRect().bottom + 8);
      const bottom = Math.max(top + 120, sheetTop - 28);
      return {
        centreX: 0.5,
        centreY: (top + (bottom - top) * 0.5) / height,
        halfWidth: width * 0.5 - 6,
        halfHeight: (bottom - top) * 0.5,
        // A phone is narrow: let the bowl take more of the width than it does on a desk.
        margin: 0.84,
      };
    }
    // Short landscape: masthead on the left, bowl on the right.
    return {
      centreX: 0.62,
      centreY: Math.min(0.56, (sheetTop * 0.56) / height + 0.02),
      halfWidth: width * 0.34,
      halfHeight: Math.max(60, sheetTop * 0.42),
    };
  }
}
