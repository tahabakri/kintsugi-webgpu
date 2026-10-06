import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTROLS, FRACTURE } from '../src/config';
import type { Vec3 } from '../src/math/vec';
import { invert3, mulMat3Vec, pointResponse, releaseVelocity, servoImpulse, smoothDamp, type HandSample, type Mat3 } from '../src/physics/hand';
import { CONCENTRATION, contactConcentration, ImpactEpisodes, impactSeverity, type ImpactSample } from '../src/physics/impact-model';
import { PoseHistory, type PosedBody } from '../src/physics/interpolation';

const DT = 1 / 120;

describe('the hand', () => {
  it('draws a target in without overshooting it, and rests there', () => {
    const x: Vec3 = [0, 0, 0], v: Vec3 = [0, 0, 0];
    let furthest = 0;
    for (let i = 0; i < 240; i++) {
      smoothDamp(x, v, [1, -2, 0.5], 2 * Math.PI * 24, DT);
      furthest = Math.max(furthest, x[0]);
    }
    expect(furthest).toBeLessThanOrEqual(1 + 1e-9);
    expect(x[0]).toBeCloseTo(1, 6);
    expect(x[1]).toBeCloseTo(-2, 6);
    expect(Math.hypot(...v)).toBeLessThan(1e-6);
    // Within about 50 ms it has covered nine tenths of the way: responsive, not laggy.
    const y: Vec3 = [0, 0, 0], w: Vec3 = [0, 0, 0];
    for (let i = 0; i < 6; i++) smoothDamp(y, w, [1, 0, 0], 2 * Math.PI * 24, DT);
    expect(y[0]).toBeGreaterThan(0.7);
  });

  /** A hand moving along a path, sampled at the physics rate. */
  const path = (position: (t: number) => Vec3, from: number, to: number): HandSample[] => {
    const out: HandSample[] = [];
    for (let t = from; t <= to + 1e-9; t += DT) out.push({ time: t, position: position(t) });
    return out;
  };

  it('reads a hand that has stopped as not moving, and one that is moving as moving', () => {
    const resting = path(() => [1, 2, 3], 0, 0.3);
    expect(releaseVelocity(resting, 0.3)).toEqual([0, 0, 0].map((x) => expect.closeTo(x, 9)));
    const steady = path((t) => [0.5 * t, -12 * t, 3 * t], 0, 0.3);
    const v = releaseVelocity(steady, 0.3);
    expect(v[0]).toBeCloseTo(0.5, 3);
    expect(v[1]).toBeCloseTo(-12, 3);
    expect(v[2]).toBeCloseTo(3, 3);
    // Moved quickly, then stopped for the last 80 ms: the release is where the hand is now.
    const stopped = path((t) => [0, -20 * Math.min(t, 0.2), 0], 0, 0.28);
    expect(Math.abs(releaseVelocity(stopped, 0.28)[1])).toBeLessThan(4);
  });

  it('follows a hand that is speeding up by what it is doing now, not by its whole gesture', () => {
    // Slow for a long time, then a flick: the fit sees the flick.
    const flick = path((t) => [0, t < 0.25 ? -1 * t : -0.25 - 30 * (t - 0.25) - 200 * (t - 0.25) ** 2, 0], 0, 0.3);
    const v = releaseVelocity(flick, 0.3);
    expect(v[1]).toBeLessThan(-18);
    expect(v[1]).toBeGreaterThan(-60);
  });

  it('ignores a single wild sample', () => {
    const clean = path((t) => [0, -8 * t, 0], 0, 0.3);
    const spiked = clean.map((s, i) => (i === clean.length - 4 ? { ...s, position: [3, 5, -4] as Vec3 } : s));
    const v = releaseVelocity(spiked, 0.3);
    expect(v[1]).toBeCloseTo(-8, 0);
    expect(Math.abs(v[0])).toBeLessThan(1.5);
    expect(releaseVelocity(clean.slice(0, 2), 0.01)).toEqual([0, 0, 0]);
  });

  it('inverts a matrix and gives a point the response of a point on a rigid body', () => {
    const m: Mat3 = [2, 0, 1, 0, 3, 0, 1, 0, 4];
    const inverse = invert3(m)!;
    const back = mulMat3Vec(m, mulMat3Vec(inverse, [1, 2, 3]));
    expect(back[0]).toBeCloseTo(1, 9);
    expect(back[1]).toBeCloseTo(2, 9);
    expect(back[2]).toBeCloseTo(3, 9);
    expect(invert3([1, 2, 3, 2, 4, 6, 1, 1, 1])).toBeNull();

    // With the lever arm zero the point simply has the body's mass; at an arm it moves more per impulse.
    const identity: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const centre = pointResponse(2, identity, [0, 0, 0]);
    expect(centre[0]).toBeCloseTo(0.5, 9);
    const rim = pointResponse(2, identity, [1.5, 0, 0]);
    expect(rim[4]).toBeGreaterThan(centre[4]);
    // Pushing along the lever arm moves it like the plain mass; pushing across it also turns the body.
    expect(rim[0]).toBeCloseTo(0.5, 9);
  });

  it('pulls a point to a target like a damped spring whatever the mass, without overshoot', () => {
    for (const mass of [0.05, 3.3, 40]) {
      let position = 0.8, velocity = 0;
      const response = pointResponse(mass, [1e3, 0, 0, 0, 1e3, 0, 0, 0, 1e3], [0, 0, 0]);
      let past = 0;
      for (let i = 0; i < 240; i++) {
        const impulse = servoImpulse([position, 0, 0], [velocity, 0, 0], response, 2 * Math.PI * 18, 1, DT);
        velocity += impulse[0] / mass;
        position += velocity * DT;
        past = Math.min(past, position);
      }
      expect(Math.abs(position)).toBeLessThan(1e-4);
      expect(past).toBeGreaterThan(-0.01);
    }
  });
});

const sample = (over: Partial<ImpactSample> = {}): ImpactSample => ({
  source: 'table', ballIndex: -1, time: 1, point: [0, 0, 0], normal: [0, 1, 0], localPoint: [0, 0, 0], u: 0.3, v: 0.12,
  relativeVelocity: [0, 12, 0], otherVelocity: [0, 0, 0], normalSpeed: 12, tangentSpeed: 0, effectiveMass: 3.3, bodyLinear: [0, -12, 0], bodyAngular: [0, 0, 0], ...over,
});

const severity = (over: Partial<ImpactSample>, controls = DEFAULT_CONTROLS) => impactSeverity(sample(over), controls).normalized;

describe('impact severity', () => {
  it('rises with speed, with the energy as the square of it, and is clamped to 0…1', () => {
    expect(severity({ normalSpeed: 0.5 })).toBeLessThan(1e-3);
    expect(severity({ normalSpeed: 16 })).toBeGreaterThan(severity({ normalSpeed: 12 }));
    const raw = (v: number) => impactSeverity(sample({ normalSpeed: v }), DEFAULT_CONTROLS).rawEnergy;
    expect(raw(20) / raw(10)).toBeCloseTo(4, 9);
    expect(severity({ normalSpeed: 400 })).toBe(FRACTURE.maxEnergy);
    expect(severity({ normalSpeed: Number.NaN })).toBe(0);
  });

  it('orders contacts: the broad foot, then the curve of the wall, then the rim, then a steel ball', () => {
    expect(contactConcentration('table', 0.1)).toBe(CONCENTRATION.broad);
    expect(contactConcentration('stage', 0.5)).toBe(CONCENTRATION.wall);
    expect(contactConcentration('table', 0.95)).toBe(CONCENTRATION.edge);
    expect(contactConcentration('ball', 0.1)).toBe(CONCENTRATION.steel);
    expect(CONCENTRATION.broad).toBeLessThan(CONCENTRATION.wall);
    expect(CONCENTRATION.wall).toBeLessThan(CONCENTRATION.edge);
    expect(CONCENTRATION.edge).toBeLessThan(CONCENTRATION.steel);
    expect(severity({ v: 0.95 })).toBeGreaterThan(severity({ v: 0.12 }));
  });

  it('counts a glancing blow for much less than a square one, and brittleness and wall thickness as expected', () => {
    expect(severity({ normalSpeed: 2, tangentSpeed: 12 })).toBeLessThan(severity({ normalSpeed: 12, tangentSpeed: 2 }) / 4);
    expect(severity({}, { ...DEFAULT_CONTROLS, brittleness: 90 })).toBeGreaterThan(severity({}));
    expect(severity({}, { ...DEFAULT_CONTROLS, thickness: 90 })).toBeLessThan(severity({}));
  });

  it('puts the foot-first drop where the interaction is meant to feel right', () => {
    // v = sqrt(2·g·h) with g = 98.1 units/s² and 1 unit = 10 cm.
    const dropped = (centimetres: number, over: Partial<ImpactSample> = {}) => severity({ normalSpeed: Math.sqrt(2 * 98.1 * (centimetres / 10)), ...over });
    expect(dropped(2)).toBeLessThan(FRACTURE.threshold);
    expect(dropped(5)).toBeLessThan(FRACTURE.threshold);
    expect(dropped(10)).toBeGreaterThan(FRACTURE.threshold);
    expect(dropped(22)).toBeGreaterThan(0.45);
    expect(dropped(60)).toBe(FRACTURE.maxEnergy);
    // On its rim it is far more fragile.
    expect(dropped(4, { v: 0.95 })).toBeGreaterThan(FRACTURE.threshold);
    // The default steel ball (about 25 units per second) breaks it; the gentlest does not.
    const ball = (speed: number) => severity({ source: 'ball', normalSpeed: speed, effectiveMass: 0.072 });
    expect(ball(25)).toBeGreaterThan(0.4);
    expect(ball(11.2)).toBeLessThan(FRACTURE.threshold);
  });
});

describe('impact episodes', () => {
  it('judges one collision once, on its hardest contact, after a short window', () => {
    const episodes = new ImpactEpisodes();
    episodes.add(sample({ time: 1.000, normalSpeed: 4 }), 0.1);
    episodes.add(sample({ time: 1.008, normalSpeed: 13 }), 0.6);
    episodes.add(sample({ time: 1.017, normalSpeed: 6 }), 0.2);
    expect(episodes.open).toBe(1);
    expect(episodes.take(1.02)).toBeNull();
    const done = episodes.take(1.031)!;
    expect(done.severity).toBe(0.6);
    expect(done.sample.normalSpeed).toBe(13);
    expect(episodes.take(1.5)).toBeNull();
    expect(episodes.open).toBe(0);
  });

  it('keeps collisions with different things, or far apart, separate, and picks the strongest', () => {
    const episodes = new ImpactEpisodes();
    episodes.add(sample({ time: 2, source: 'table' }), 0.3);
    episodes.add(sample({ time: 2.005, source: 'ball', ballIndex: 4, point: [0.5, 1, 0] }), 0.7);
    episodes.add(sample({ time: 2.01, source: 'table', point: [9, 0, 0] }), 0.2);
    expect(episodes.open).toBe(3);
    expect(episodes.take(2.04)!.severity).toBe(0.7);
    // A contact after the window has closed is a new episode, not part of the old one.
    episodes.add(sample({ time: 3 }), 0.1);
    episodes.add(sample({ time: 3.05 }), 0.9);
    expect(episodes.open).toBe(2);
    episodes.clear();
    expect(episodes.take(10)).toBeNull();
  });
});

describe('drawing between steps', () => {
  const body = (handle: number, x: number, angle: number): PosedBody & { x: number; angle: number } => ({
    handle, x, angle,
    translation() { return { x: this.x, y: 1, z: 0 }; },
    rotation() { return { x: 0, y: Math.sin(this.angle / 2), z: 0, w: Math.cos(this.angle / 2) }; },
  });

  it('blends from the pose at the start of the step to the pose now, and never changes the body', () => {
    const history = new PoseHistory();
    const b = body(7, 0, 0);
    history.record([b]);
    b.x = 1; b.angle = 1;
    const half = history.blend(b, 0.5);
    expect(half.position[0]).toBeCloseTo(0.5, 9);
    expect(half.position[1]).toBe(1);
    const turned = 2 * Math.atan2(half.rotation[1], half.rotation[3]);
    expect(turned).toBeCloseTo(0.5, 6);
    expect(history.blend(b, 0).position[0]).toBe(0);
    expect(history.blend(b, 1).position[0]).toBe(1);
    expect(b.x).toBe(1);
  });

  it('draws a body it has not seen before where it is, and forgets bodies that are gone', () => {
    const history = new PoseHistory();
    const a = body(1, 5, 0), c = body(2, 9, 0);
    history.record([a]);
    expect(history.blend(c, 0.3).position[0]).toBe(9);
    history.record([c]);
    a.x = 6;
    expect(history.blend(a, 0.5).position[0]).toBe(6);
  });
});
