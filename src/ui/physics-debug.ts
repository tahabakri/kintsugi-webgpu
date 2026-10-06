import type { PhysicsInfo } from '../app';

const f = (x: number, digits = 2): string => x.toFixed(digits);
const v3 = (v: readonly number[]): string => `[${v.map((x) => f(x, 1)).join(', ')}]`;

/**
 * A small monospace read-out of the physics, for development. It is created only for `?debug` or
 * `window.__kintsugi.setPhysicsDebug(true)`; a normal visitor never gets one.
 */
export class PhysicsDebug {
  private readonly element: HTMLPreElement;
  private last = 0;

  constructor(root: HTMLElement) {
    this.element = document.createElement('pre');
    this.element.className = 'physics-debug';
    this.element.setAttribute('aria-hidden', 'true');
    root.append(this.element);
  }

  update(info: PhysicsInfo, nowMs: number): void {
    if (nowMs - this.last < 250) return;
    this.last = nowMs;
    const i = info.lastImpact;
    this.element.textContent = [
      'physics',
      i
        ? `impact   ${i.source} @ v=${f(i.v)}  ${i.fractured ? 'FRACTURED' : 'held'}\n` +
          `  normal speed  ${f(i.normalSpeed)}   tangent ${f(i.tangentSpeed)}\n` +
          `  eff. mass     ${f(i.effectiveMass)}   raw energy ${f(i.rawEnergy, 1)}\n` +
          `  severity      ${f(i.normalizedEnergy, 3)} / threshold ${f(i.threshold)}   (x${f(i.concentration, 1)})`
        : 'impact   none yet',
      `body     v ${v3(info.bodyLinear)}  w ${v3(info.bodyAngular)}`,
      `hand     v ${v3(info.grabVelocity)}`,
      `strikers ${info.activeStrikers}   fragments ${info.fragments}`,
      `momentum error ${f(info.momentumError, 3)}   interpolation alpha ${f(info.interpolationAlpha)}`,
    ].join('\n');
  }

  remove(): void {
    this.element.remove();
  }
}
