import { CONTROL_NAMES, DEFAULT_CONTROLS, MATERIALS, type ControlName, type MaterialName, type Mode } from '../config';
import { PRESETS } from '../gpu/materials';
import { icon } from './icons';
import { drawSwatch } from './swatches';

const SLIDER_LABELS: Record<ControlName, string> = {
  brittleness: 'Brittleness',
  thickness: 'Thickness',
  impact: 'Impact',
  viscosity: 'Gold viscosity',
  temperature: 'Gold temperature',
  cureRate: 'Cure rate',
  seamThickness: 'Seam thickness',
};

export const CANVAS_LABEL = 'An interactive ceramic bowl that can fracture and be repaired with gold.';

const slider = (name: ControlName): string => `
  <label class="slider" for="control-${name}">
    <span class="slider-label">${SLIDER_LABELS[name]}</span>
    <input id="control-${name}" type="range" min="0" max="100" step="1" value="${DEFAULT_CONTROLS[name]}" data-control="${name}" />
    <output class="slider-value" for="control-${name}">${(DEFAULT_CONTROLS[name] / 100).toFixed(2)}</output>
  </label>`;

const stat = (key: string, label: string, value: string): string =>
  `<div><dt>${label}</dt><dd data-stat="${key}">${value}</dd></div>`;

const TEMPLATE = `
  <canvas class="scene" tabindex="0" aria-label="${CANVAS_LABEL}"></canvas>

  <header class="masthead">
    <p class="eyebrow">Material Studies / 02</p>
    <h1 class="title">Kintsugi.</h1>
    <p class="caption">Breakage becomes part of the object.</p>
    <span class="masthead-rule" aria-hidden="true"></span>
    <p class="support">Drop the bowl, study the fracture, then mend the generated cracks with gold.</p>
  </header>

  <div class="status" role="status" aria-live="polite" data-phase="intact">
    <span class="status-dot" aria-hidden="true"></span>
    <span class="status-text">WebGPU · Intact</span>
  </div>

  <aside class="panel" aria-label="Study controls" data-open="false">
    <button type="button" class="sheet-handle" aria-expanded="false" aria-controls="panel-body">
      <span class="sheet-grip" aria-hidden="true"></span>
      <span class="sheet-title">Controls</span>
      ${icon('chevron')}
    </button>
    <div class="panel-body" id="panel-body">
      <section class="group" aria-labelledby="group-mode">
        <h2 class="group-title" id="group-mode">Mode</h2>
        <div class="segmented" role="group" aria-labelledby="group-mode">
          <button type="button" data-mode="break" aria-pressed="true">Break</button>
          <button type="button" data-mode="repair" aria-pressed="false">Repair</button>
        </div>
      </section>

      <section class="group" aria-labelledby="group-impact">
        <h2 class="group-title" id="group-impact">Impact</h2>
        <div class="actions">
          <button type="button" class="button button-dark" data-action="strike" aria-pressed="false">${icon('strike')}<span>Strike bowl</span></button>
          <button type="button" class="button button-dark" data-action="drop">${icon('drop')}<span>Drop test</span></button>
        </div>
        ${slider('brittleness')}${slider('thickness')}${slider('impact')}
      </section>

      <section class="group" aria-labelledby="group-ceramic">
        <h2 class="group-title" id="group-ceramic">Ceramic</h2>
        <div class="swatches" role="group" aria-labelledby="group-ceramic">
          ${MATERIALS.map((name, index) => `
            <button type="button" class="swatch" data-material="${name}" aria-pressed="${index === 0}">
              <canvas class="swatch-chip" width="128" height="96" aria-hidden="true"></canvas>
              <span>${PRESETS[name].label}</span>
            </button>`).join('')}
        </div>
      </section>

      <section class="group group-repair" aria-labelledby="group-repair">
        <h2 class="group-title" id="group-repair">Repair</h2>
        ${slider('viscosity')}${slider('temperature')}${slider('cureRate')}${slider('seamThickness')}
        <button type="button" class="button button-dark button-gold button-wide" data-action="brush" aria-pressed="false">${icon('brush')}<span>Gold brush</span></button>
        <button type="button" class="button button-outline button-wide" data-action="recover" title="Bring back pieces that have left the table" hidden>${icon('recover')}<span>Recover pieces</span></button>
      </section>

      <section class="group" aria-labelledby="group-state">
        <h2 class="group-title" id="group-state">State</h2>
        <dl class="stats">
          ${stat('fragments', 'Fragments', '1')}
          ${stat('crackLength', 'Crack length', '0.00 m')}
          ${stat('goldFilled', 'Gold filled', '0%')}
          ${stat('cured', 'Cured', '0%')}
          ${stat('repaired', 'Repaired', '0%')}
        </dl>
        <div class="progress">
          <div class="progress-track" role="progressbar" aria-label="Repaired" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <span class="progress-fill"></span>
          </div>
          <span class="progress-value" data-stat="progress">0%</span>
        </div>
      </section>

      <div class="footer-actions">
        <button type="button" class="button button-outline" data-action="reset" title="Reset · hold Alt to replay the same seed">${icon('reset')}<span>Reset</span></button>
        <button type="button" class="button button-outline" data-action="pause" aria-pressed="false">${icon('pause')}<span>Pause</span></button>
        <button type="button" class="button button-outline" data-action="reset-view">${icon('view')}<span>Reset view</span></button>
      </div>
    </div>
  </aside>

  <footer class="howto">
    <p class="eyebrow eyebrow-ruled">How to use</p>
    <p class="howto-line">Break it. Bring it back together. Trace the cracks in gold.</p>
    <ol class="howto-steps">
      <li>Choose settings</li>
      <li>Break the bowl</li>
      <li>Study the fracture</li>
      <li>Mend with gold</li>
    </ol>
    <p class="howto-detail">Drag the bowl or fragments to move them · drag empty space or right-drag to orbit · scroll or pinch to zoom · use Strike bowl to target an impact · in Repair, bring a fragment back and trace the closed crack in gold</p>
  </footer>

  <div class="hint" role="status" aria-live="polite" data-visible="false"></div>
  <p class="coach" role="status" aria-live="polite" data-visible="false"></p>

  <section class="fallback" hidden>
    <div class="fallback-card">
      <p class="eyebrow">Material Studies / 02</p>
      <h1 class="title">Kintsugi.</h1>
      <p class="fallback-text">This study needs WebGPU, which this browser or device does not currently provide. Try a recent Chrome or Edge browser with hardware acceleration enabled.</p>
      <p class="fallback-detail" hidden></p>
    </div>
  </section>
`;

export type PanelAction = 'strike' | 'drop' | 'brush' | 'recover' | 'reset' | 'pause' | 'reset-view';

export interface PanelHandlers {
  mode(mode: Mode): void;
  material(name: MaterialName): void;
  control(name: ControlName, value: number): void;
  action(action: PanelAction, event: MouseEvent): void;
}

/** Everything the app needs to reach in the page. */
export interface Interface {
  root: HTMLElement;
  canvas: HTMLCanvasElement;
  panel: HTMLElement;
  panelBody: HTMLElement;
  sheetHandle: HTMLButtonElement;
  status: HTMLElement;
  statusText: HTMLElement;
  hint: HTMLElement;
  /** A line of guidance set beside the object rather than in the margin. */
  coach: HTMLElement;
  howto: HTMLElement;
  masthead: HTMLElement;
  fallback: HTMLElement;
  fallbackDetail: HTMLElement;
  modeButtons: HTMLButtonElement[];
  materialButtons: HTMLButtonElement[];
  actionButtons: Record<PanelAction, HTMLButtonElement>;
  sliders: Record<ControlName, HTMLInputElement>;
  stats: Record<string, HTMLElement>;
  progressTrack: HTMLElement;
  progressFill: HTMLElement;
  /** Render-quality selector; only present in debug mode. */
  quality: HTMLSelectElement | null;
}

/**
 * Adds a small render-quality selector under the panel's footer. It is a development aid, shown
 * only when the page is opened with `?debug`.
 */
export function addQualitySelector(ui: Interface, levels: readonly string[], current: string, onChange: (level: string) => void): void {
  const row = document.createElement('label');
  row.className = 'quality';
  const caption = document.createElement('span');
  caption.textContent = 'Render quality';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Render quality');
  for (const level of levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level.charAt(0).toUpperCase() + level.slice(1);
    select.append(option);
  }
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  row.append(caption, select);
  ui.panelBody.append(row);
  ui.quality = select;
}

/** Builds the page inside `root` with plain DOM and returns handles to it. */
export function mountInterface(root: HTMLElement): Interface {
  root.innerHTML = TEMPLATE;
  const one = <T extends Element>(selector: string): T => {
    const element = root.querySelector<T>(selector);
    if (!element) throw new Error(`Interface element missing: ${selector}`);
    return element;
  };
  const all = <T extends Element>(selector: string): T[] => [...root.querySelectorAll<T>(selector)];

  for (const button of all<HTMLButtonElement>('[data-material]')) {
    drawSwatch(button.querySelector('canvas')!, button.dataset.material as MaterialName);
  }

  const actionButtons = {} as Record<PanelAction, HTMLButtonElement>;
  for (const button of all<HTMLButtonElement>('[data-action]')) actionButtons[button.dataset.action as PanelAction] = button;
  const sliders = {} as Record<ControlName, HTMLInputElement>;
  for (const name of CONTROL_NAMES) sliders[name] = one<HTMLInputElement>(`[data-control="${name}"]`);
  const stats: Record<string, HTMLElement> = {};
  for (const element of all<HTMLElement>('[data-stat]')) stats[element.dataset.stat!] = element;

  const ui: Interface = {
    root,
    canvas: one('.scene'),
    panel: one('.panel'),
    panelBody: one('.panel-body'),
    sheetHandle: one('.sheet-handle'),
    status: one('.status'),
    statusText: one('.status-text'),
    hint: one('.hint'),
    coach: one('.coach'),
    howto: one('.howto'),
    masthead: one('.masthead'),
    fallback: one('.fallback'),
    fallbackDetail: one('.fallback-detail'),
    modeButtons: all('[data-mode]'),
    materialButtons: all('[data-material]'),
    actionButtons,
    sliders,
    stats,
    progressTrack: one('.progress-track'),
    progressFill: one('.progress-fill'),
    quality: null,
  };
  for (const name of CONTROL_NAMES) setSlider(ui, name, DEFAULT_CONTROLS[name]);
  return ui;
}

export function bindPanel(ui: Interface, handlers: PanelHandlers): void {
  for (const button of ui.modeButtons) button.addEventListener('click', () => handlers.mode(button.dataset.mode as Mode));
  for (const button of ui.materialButtons) button.addEventListener('click', () => handlers.material(button.dataset.material as MaterialName));
  for (const name of CONTROL_NAMES) {
    ui.sliders[name].addEventListener('input', () => handlers.control(name, Number(ui.sliders[name].value)));
  }
  for (const [action, button] of Object.entries(ui.actionButtons) as Array<[PanelAction, HTMLButtonElement]>) {
    button.addEventListener('click', (event) => handlers.action(action, event));
  }
}

/** Reflects a control value in its slider, the filled part of its track and its read-out. */
export function setSlider(ui: Interface, name: ControlName, value: number): void {
  const input = ui.sliders[name];
  input.value = String(value);
  input.style.setProperty('--fill', `${value}%`);
  const output = input.nextElementSibling;
  if (output) output.textContent = (value / 100).toFixed(2);
}

/** Swaps the pause button between "Pause" and "Resume". */
export function setPauseButton(ui: Interface, paused: boolean): void {
  const button = ui.actionButtons.pause;
  button.setAttribute('aria-pressed', String(paused));
  button.innerHTML = `${icon(paused ? 'play' : 'pause')}<span>${paused ? 'Resume' : 'Pause'}</span>`;
}
