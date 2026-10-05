import { expect, test, type Page } from '@playwright/test';
import type { KintsugiHook } from '../src/debug/hook';

declare global {
  interface Window {
    __kintsugi?: KintsugiHook;
  }
}

/** Console errors and uncaught exceptions seen by a page. */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
  page.on('pageerror', (error) => problems.push(error.message));
  return problems;
}

/** Opens the study and waits for the hook. `?q=0.6` pins a low render scale so slow GPUs keep up. */
async function open(page: Page): Promise<boolean> {
  await page.goto('/?q=0.6');
  const supported = await page.evaluate(async () => {
    if (!('gpu' in navigator) || !navigator.gpu) return false;
    try { return (await navigator.gpu.requestAdapter()) !== null; } catch { return false; }
  });
  if (!supported) return false;
  await page.waitForFunction(() => window.__kintsugi?.ready === true, null, { timeout: 30_000 });
  return true;
}

const hook = <T>(page: Page, fn: (k: KintsugiHook) => T): Promise<T> =>
  page.evaluate((source) => new Function('k', `return (${source})(k)`)(window.__kintsugi), fn.toString()) as Promise<T>;

test.describe('without WebGPU @fallback', () => {
  test('shows the editorial fallback when navigator.gpu is missing', async ({ page }) => {
    const problems = watchConsole(page);
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true });
    });
    await page.goto('/');
    const fallback = page.locator('.fallback');
    await expect(fallback).toBeVisible();
    await expect(fallback).toContainText('Kintsugi.');
    await expect(fallback).toContainText('This study needs WebGPU, which this browser or device does not currently provide.');
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Unavailable');
    await expect(page.locator('.panel')).toBeHidden();
    await expect(page.locator('canvas.scene')).toBeHidden();
    expect(await page.evaluate(() => window.__kintsugi)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  test('shows the fallback when no adapter can be had', async ({ page }) => {
    const problems = watchConsole(page);
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'gpu', {
        get: () => ({ requestAdapter: async () => null, getPreferredCanvasFormat: () => 'bgra8unorm' }),
        configurable: true,
      });
    });
    await page.goto('/');
    await expect(page.locator('.fallback')).toBeVisible();
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Unavailable');
    expect(problems).toEqual([]);
  });
});

test.describe('the study', () => {
  let problems: string[] = [];

  test.beforeEach(async ({ page }) => {
    problems = watchConsole(page);
    test.skip(!(await open(page)), 'This browser exposes no WebGPU adapter; only the fallback tests can run here.');
  });

  test.afterEach(() => {
    expect(problems, 'console errors').toEqual([]);
  });

  test('loads intact with a clean console', async ({ page }) => {
    const info = await hook(page, (k) => ({ ready: k.ready, version: k.version, seed: k.seed, state: k.state, stats: k.stats, gpu: k.getGpuInfo() as Record<string, unknown> }));
    expect(info.ready).toBe(true);
    expect(info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(info.state.mode).toBe('break');
    expect(info.state.phase).toBe('intact');
    expect(info.state.material).toBe('porcelain');
    expect(info.state).toMatchObject({ brittleness: 58, thickness: 46, impact: 55, viscosity: 52, temperature: 58, cureRate: 46, seamThickness: 48 });
    expect(info.stats.fragments).toBe(1);
    expect(info.stats.crackEdges).toBe(0);
    expect(info.stats.crackLength).toBe(0);
    expect(info.stats.colliderFallbacks).toBe(0);
    expect(info.gpu.api).toBe('WebGPU');
    expect(info.gpu.errors).toEqual([]);

    await expect(page.locator('canvas.scene')).toHaveAttribute('aria-label', 'An interactive ceramic bowl that can fracture and be repaired with gold.');
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Intact');
    await expect(page.getByRole('heading', { name: 'Kintsugi.' }).first()).toBeVisible();
    await expect(page.locator('[data-stat="fragments"]')).toHaveText('1');
    await expect(page.locator('[data-stat="crackLength"]')).toHaveText('0.00 m');
    await page.screenshot({ path: 'test-results/01-intact.png' });
  });

  test('switches ceramic presets without touching the fracture', async ({ page }) => {
    for (const [label, name] of [['Celadon', 'celadon'], ['Raku', 'raku'], ['Terracotta', 'terracotta'], ['Porcelain', 'porcelain']]) {
      const button = page.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      expect(await hook(page, (k) => k.state.material)).toBe(name);
    }
    // Recolouring a broken bowl keeps its cracks exactly as they are.
    await hook(page, (k) => k.fractureAt({ u: 0.17, v: 0.64, energy: 0.72 }));
    const before = await hook(page, (k) => k.getCracks().map((c) => c.length));
    await hook(page, (k) => k.setMaterial('raku'));
    expect(await hook(page, (k) => k.getCracks().map((c) => c.length))).toEqual(before);
    expect(await hook(page, (k) => k.state.material)).toBe('raku');
  });

  test('fractures, then repairs the same cracks with gold', async ({ page }) => {
    await hook(page, (k) => k.fractureAt({ u: 0.17, v: 0.64, energy: 0.72 }));
    const broken = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase, cracks: k.getCracks() }));
    expect(broken.stats.fragments).toBeGreaterThan(1);
    expect(broken.stats.crackLength).toBeGreaterThan(0);
    expect(broken.stats.crackEdges).toBe(broken.cracks.length);
    expect(broken.phase).toBe('fractured');
    for (const crack of broken.cracks) {
      expect(Number.isFinite(crack.length) && crack.length > 0).toBe(true);
      expect(crack.fill).toBe(0);
      expect(crack.cure).toBe(0);
      expect(crack.joined).toBe(false);
      expect(crack.shardB).not.toBeNull();
    }
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Fractured');
    await expect(page.getByRole('button', { name: 'Drop test' })).toBeDisabled();

    // Let the pieces fall, then look at them.
    await hook(page, (k) => k.step(2.5));
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/02-fractured.png' });

    await page.getByRole('button', { name: 'Repair', exact: true }).click();
    expect(await hook(page, (k) => k.state.mode)).toBe('repair');
    await hook(page, (k) => { k.alignAllForTest(); k.step(0.05); });
    expect(await hook(page, (k) => k.getCracks().every((c) => c.aligned))).toBe(true);

    // Gold on half the cracks first: partial repair.
    await hook(page, (k) => { for (const c of k.getCracks()) if (c.id % 2 === 0) k.paintCrack({ edgeId: c.id, amount: 1 }); });
    const painted = await hook(page, (k) => k.stats);
    expect(painted.goldFilled).toBeGreaterThan(20);
    expect(painted.cured).toBeLessThan(5);
    expect(painted.repaired).toBeLessThan(5);
    await hook(page, (k) => k.step(1.5));
    const curing = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase }));
    expect(curing.stats.cured).toBeGreaterThan(painted.cured);
    expect(curing.stats.repaired).toBeGreaterThan(painted.repaired);
    expect(curing.phase).toBe('repairing');
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/03-partial-repair.png' });

    await hook(page, (k) => k.step(8));
    const half = await hook(page, (k) => ({ stats: k.stats, cracks: k.getCracks() }));
    expect(half.cracks.some((c) => c.joined)).toBe(true);
    expect(half.cracks.some((c) => !c.joined)).toBe(true);
    expect(half.stats.fragments).toBeLessThan(broken.stats.fragments);
    expect(half.stats.openCrackLength).toBeLessThan(half.stats.crackLength);

    // Now the rest.
    await hook(page, (k) => { k.paintCrack({ amount: 1 }); k.step(12); });
    const mended = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase, cracks: k.getCracks() }));
    expect(mended.cracks.every((c) => c.joined)).toBe(true);
    expect(mended.stats.fragments).toBe(1);
    expect(mended.stats.repaired).toBeGreaterThan(99.5);
    expect(mended.stats.openCrackLength).toBe(0);
    expect(mended.phase).toBe('repaired');
    // The repaired bowl is the same fracture: same cracks, same lengths.
    expect(mended.cracks.map((c) => c.length)).toEqual(broken.cracks.map((c) => c.length));
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Repaired');
    await expect(page.locator('[data-stat="repaired"]')).toHaveText('100%');
    await expect(page.locator('[data-stat="fragments"]')).toHaveText('1');
    await page.waitForTimeout(250);
    await page.screenshot({ path: 'test-results/04-repaired.png' });
  });

  test('regenerates the same fracture from the same seed, and a different one after reset', async ({ page }) => {
    const breakOnce = () => hook(page, (k) => {
      k.fractureAt({ u: 0.4, v: 0.7, energy: 0.6 });
      return { seed: k.seed, lengths: k.getCracks().map((c) => +c.length.toFixed(9)), fragments: k.stats.fragments };
    });
    const first = await breakOnce();
    await hook(page, (k) => k.reset({ sameSeed: true }));
    expect(await hook(page, (k) => ({ fragments: k.stats.fragments, phase: k.state.phase }))).toEqual({ fragments: 1, phase: 'intact' });
    const again = await breakOnce();
    expect(again).toEqual(first);

    await page.getByRole('button', { name: 'Reset', exact: true }).click();
    const fresh = await hook(page, (k) => ({ seed: k.seed, fragments: k.stats.fragments, phase: k.state.phase, cracks: k.getCracks().length }));
    expect(fresh).toEqual({ seed: first.seed + 1, fragments: 1, phase: 'intact', cracks: 0 });
    const next = await breakOnce();
    expect(next.lengths).not.toEqual(first.lengths);
  });

  test('pause freezes the simulation until resumed', async ({ page }) => {
    await hook(page, (k) => k.fractureAt({ u: 0.17, v: 0.64, energy: 0.9 }));
    await page.waitForTimeout(150);
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Paused');
    expect(await hook(page, (k) => [k.state.paused, k.state.phase])).toEqual([true, 'paused']);
    const frozen = await hook(page, (k) => JSON.stringify(k.getScreenPoints().shards));
    await page.waitForTimeout(500);
    expect(await hook(page, (k) => JSON.stringify(k.getScreenPoints().shards))).toBe(frozen);
    // The automation hook can still advance a paused study.
    await hook(page, (k) => k.step(0.25));
    expect(await hook(page, (k) => JSON.stringify(k.getScreenPoints().shards))).not.toBe(frozen);

    await page.getByRole('button', { name: 'Resume' }).click();
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Fractured');
    const resumed = await hook(page, (k) => JSON.stringify(k.getScreenPoints().shards));
    await page.waitForTimeout(400);
    expect(await hook(page, (k) => JSON.stringify(k.getScreenPoints().shards))).not.toBe(resumed);
  });

  test('orbits, zooms and resets the view', async ({ page }) => {
    const home = await hook(page, (k) => k.getCamera());
    // The wall to the left of the bowl is empty space: dragging there orbits.
    expect(await hook(page, (k) => k.probe(250, 560).shard)).toBeNull();
    await page.mouse.move(250, 560);
    await page.mouse.down();
    await page.mouse.move(370, 520, { steps: 8 });
    await page.mouse.up();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(200);
    const moved = await hook(page, (k) => k.getCamera());
    expect(Math.abs(moved.azimuth - home.azimuth)).toBeGreaterThan(0.2);
    expect(moved.elevation).not.toBeCloseTo(home.elevation, 2);
    expect(moved.distance).toBeGreaterThan(home.distance);

    await page.getByRole('button', { name: 'Reset view' }).click();
    await page.waitForTimeout(1600);
    const back = await hook(page, (k) => k.getCamera());
    expect(back.azimuth).toBeCloseTo(home.azimuth, 1);
    expect(back.elevation).toBeCloseTo(home.elevation, 1);
    expect(back.distance).toBeCloseTo(home.distance, 0);
  });

  test('a real strike breaks the bowl where it lands', async ({ page }) => {
    const strike = page.getByRole('button', { name: 'Strike bowl' });
    await strike.click();
    await expect(strike).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('canvas.scene')).toHaveAttribute('data-cursor', 'strike');
    const bowl = await hook(page, (k) => k.getScreenPoints().shards[0]);
    await page.mouse.click(bowl.x - 60, bowl.y - 10);
    // Nothing breaks on the click itself: the ball still has to get there.
    expect(await hook(page, (k) => k.stats.fragments)).toBe(1);
    await expect(strike).toHaveAttribute('aria-pressed', 'false');
    await page.waitForFunction(() => window.__kintsugi!.stats.fragments > 1, null, { timeout: 15_000 });
    const after = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase }));
    expect(after.phase).toBe('fractured');
    expect(after.stats.crackLength).toBeGreaterThan(0);
  });

  test('the drop test lifts the bowl and lets it break on the table', async ({ page }) => {
    await page.getByRole('button', { name: 'Drop test' }).click();
    await page.waitForFunction(() => window.__kintsugi!.stats.fragments > 1, null, { timeout: 20_000 });
    expect(await hook(page, (k) => k.state.phase)).toBe('fractured');
  });

  test('pieces can be picked up with the pointer, and closed cracks painted with the brush', async ({ page }) => {
    const scene = page.locator('canvas.scene');
    // Lift the intact bowl a little and put it down again: no fracture from a gentle set-down.
    const bowl = await hook(page, (k) => k.getScreenPoints().shards[0]);
    await page.mouse.move(bowl.x, bowl.y);
    await page.waitForTimeout(200);
    await expect(scene).toHaveAttribute('data-cursor', 'grab');
    await page.mouse.down();
    await expect(scene).toHaveAttribute('data-cursor', 'grabbing');
    await page.mouse.move(bowl.x + 4, bowl.y - 26, { steps: 10 });
    await page.waitForTimeout(500);
    const lifted = await hook(page, (k) => k.getScreenPoints().shards[0]);
    expect(lifted.y).toBeLessThan(bowl.y - 6);
    await page.mouse.move(bowl.x, bowl.y, { steps: 20 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    await page.waitForTimeout(700);
    expect(await hook(page, (k) => k.stats.fragments)).toBe(1);

    await hook(page, (k) => { k.fractureAt({ u: 0.17, v: 0.64, energy: 0.72 }); k.step(2.5); });
    await page.keyboard.press('r');
    expect(await hook(page, (k) => k.state.mode)).toBe('repair');
    await expect(page.getByRole('button', { name: 'Gold brush' })).toHaveAttribute('aria-pressed', 'true');

    // The brush is armed, but gold only goes on a break that is closed. Whatever the brush would
    // take anywhere along any crack is one whose two sides are together (a few small fragments
    // may still lie mated where they fell); an open edge is never a target, so a loose piece
    // under the pointer is simply picked up.
    const brushed = await hook(page, (k) => {
      const cracks = k.getCracks();
      const taken = new Set<number>();
      for (const line of k.getScreenPoints().cracks) {
        for (const [x, y] of [[line.x, line.y], ...line.path]) {
          const hit = k.probe(x, y).crack;
          if (hit !== null) taken.add(hit);
        }
      }
      return { open: cracks.filter((c) => !c.aligned).length, taken: [...taken].map((id) => cracks[id].aligned) };
    });
    expect(brushed.open).toBeGreaterThan(10);
    expect(brushed.taken.every(Boolean)).toBe(true);
    const loose = await hook(page, (k) => {
      for (const p of k.getScreenPoints().shards) {
        if (p.id === 0 || p.x < 260 || p.x > 1050 || p.y < 120 || p.y > 960) continue;
        if (k.probe(p.x, p.y).shard === p.id) return p;
      }
      return null;
    });
    expect(loose).not.toBeNull();
    await page.mouse.move(loose!.x, loose!.y);
    await page.waitForTimeout(200);
    await expect(scene).toHaveAttribute('data-cursor', 'grab');
    await page.mouse.move(250, 300);

    // Put the pieces together and the same cracks take the brush.
    await hook(page, (k) => { k.alignAllForTest(); k.step(0.05); });
    const target = await hook(page, (k) => {
      for (const c of k.getScreenPoints().cracks) {
        if (c.x < 260 || c.x > 1050 || c.y < 120 || c.y > 960) continue;
        if (k.probe(c.x, c.y).crack !== null) return c;
      }
      return null;
    });
    expect(target).not.toBeNull();
    await page.mouse.move(target!.x, target!.y);
    await page.waitForTimeout(200);
    await expect(scene).toHaveAttribute('data-cursor', 'brush');
    await page.mouse.down();
    await page.mouse.move(target!.x + 5, target!.y + 3, { steps: 5 });
    await page.waitForTimeout(700);
    await page.mouse.up();
    const painted = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase, filled: k.getCracks().filter((c) => c.fill > 0).length }));
    expect(painted.stats.goldFilled).toBeGreaterThan(0);
    expect(painted.filled).toBeGreaterThan(0);
    expect(painted.phase).toBe('repairing');
    await expect(page.locator('.status-text')).toHaveText('WebGPU · Repairing');
  });

  test.describe('mending by hand', () => {
    const clear = (x: number, y: number) => x > 20 && x < 1090 && y > 20 && y < 980; // on the canvas, off the panel
    const points = (page: Page) => hook(page, (k) => k.getScreenPoints());
    const probe = (page: Page, x: number, y: number) => page.evaluate(([px, py]) => window.__kintsugi!.probe(px, py), [x, y]);
    const withShell = (page: Page, id: number) => page.evaluate(
      (shard) => window.__kintsugi!.getCracks().filter((c) => (c.shardA === 0 && c.shardB === shard) || (c.shardA === shard && c.shardB === 0)),
      id,
    );
    /** Pieces that share a crack with the part still standing on the table. */
    const neighbours = (page: Page) => hook(page, (k) => [...new Set(k.getCracks().filter((c) => c.shardA === 0 || c.shardB === 0).map((c) => (c.shardA === 0 ? c.shardB! : c.shardA)))]);

    /** Where to take hold of a piece, and where on screen it belongs; null if either is out of reach. */
    async function reach(page: Page, id: number): Promise<{ grip: { x: number; y: number }; home: { x: number; y: number } } | null> {
      const now = await points(page);
      const centre = now.shards.find((p) => p.id === id), home = now.homes.find((p) => p.id === id);
      if (!centre || !home || !clear(home.x, home.y)) return null;
      for (const [dx, dy] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [14, 8], [-14, 8], [14, -8], [-14, -8]]) {
        const x = centre.x + dx, y = centre.y + dy;
        // Anywhere on the piece will do: with the pieces apart the brush has nothing to say.
        if (clear(x, y) && (await probe(page, x, y)).shard === id) return { grip: { x, y }, home: { x: home.x + dx, y: home.y + dy } };
      }
      return null;
    }

    /** Picks a piece up, carries it to a point on the screen, waits a moment and lets go. */
    async function carry(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
      await page.mouse.move(from.x, from.y);
      await page.waitForTimeout(150);
      await expect(page.locator('canvas.scene')).toHaveAttribute('data-cursor', 'grab');
      await page.mouse.down();
      await page.mouse.move(from.x, from.y - 50, { steps: 8 });
      await page.mouse.move(to.x, to.y, { steps: 45 });
      await page.waitForTimeout(700);
      await page.mouse.up();
      await page.waitForTimeout(900);
    }

    test.beforeEach(async ({ page }) => {
      // Only the pointer from here on: no alignAllForTest, no paintCrack.
      await hook(page, (k) => k.fractureAt({ u: 0.17, v: 0.64, energy: 0.72 }));
      await page.waitForTimeout(2600);
      await page.getByRole('button', { name: 'Repair', exact: true }).click();
    });

    test('a piece brought near its place is drawn in, takes gold along its crack and bonds', async ({ page }) => {
      test.setTimeout(240_000);
      const before = await hook(page, (k) => k.stats.fragments);
      const scene = page.locator('canvas.scene');
      const candidates = await neighbours(page);
      expect(candidates.length).toBeGreaterThan(0);

      let bonded = -1;
      for (const id of candidates) {
        const at = await reach(page, id);
        if (!at) continue;
        // Carried in one movement and let go a couple of centimetres off the mark: no nudging.
        await carry(page, at.grip, { x: at.home.x + 22, y: at.home.y - 14 });
        const seated = (await withShell(page, id)).filter((c) => c.aligned);
        if (seated.length === 0) continue;
        // It sits where it was in the bowl, to within a couple of millimetres…
        for (const crack of seated) expect(crack.aperture).toBeLessThan(0.03);
        // …but seated is not mended: nothing bonds without gold.
        expect(seated.every((c) => !c.joined)).toBe(true);
        expect(await hook(page, (k) => k.stats.fragments)).toBe(before);

        // One stroke along each seated crack; a second only if the first left it short.
        let traced = 0;
        for (const crack of seated) {
          const line = (await points(page)).cracks.find((c) => c.id === crack.id);
          if (!line) continue;
          const path = line.path.filter(([x, y]) => clear(x, y));
          if (path.length < 2) continue;
          for (let stroke = 0; stroke < 2; stroke++) {
            const route = stroke === 0 ? path : [...path].reverse();
            await page.mouse.move(route[0][0], route[0][1]);
            await page.waitForTimeout(200);
            // A crack hidden behind another piece cannot be reached from here; try another piece.
            if ((await scene.getAttribute('data-cursor')) !== 'brush') break;
            if (stroke === 0) traced++;
            await page.mouse.down();
            for (const [x, y] of route.slice(1)) { await page.mouse.move(x, y, { steps: 6 }); await page.waitForTimeout(40); }
            await page.mouse.up();
            await page.waitForTimeout(150);
            if ((await page.evaluate((edge) => window.__kintsugi!.getCracks()[edge].fill, crack.id)) > 0.74) break;
          }
        }
        if (traced === 0) continue;
        // …and wait for the cure.
        try {
          await page.waitForFunction((shard) => window.__kintsugi!.getCracks().some((c) => c.joined && (c.shardA === shard || c.shardB === shard)), id, { timeout: 20_000 });
          bonded = id;
          break;
        } catch { /* this piece would not take; try the next one */ }
      }

      expect(bonded, 'a hand-placed piece bonded').toBeGreaterThan(0);
      const after = await hook(page, (k) => ({ stats: k.stats, phase: k.state.phase }));
      expect(after.stats.fragments).toBe(before - 1);
      expect(after.stats.goldFilled).toBeGreaterThan(0);
      expect(after.stats.repaired).toBeGreaterThan(0);
      expect(after.stats.openCrackLength).toBeLessThan(after.stats.crackLength);
      expect(after.phase).toBe('repairing');
      await page.waitForTimeout(250);
      await page.screenshot({ path: 'test-results/06-mended-by-hand.png' });
    });

    test('a piece let go well away from its place is left where it falls', async ({ page }) => {
      let tested = false;
      for (const id of await neighbours(page)) {
        const at = await reach(page, id);
        if (!at) continue;
        // A hand's width to one side: outside the reach of the assist.
        const aside = clear(at.home.x - 175, at.home.y) ? { x: at.home.x - 175, y: at.home.y } : { x: at.home.x + 175, y: at.home.y };
        if (!clear(aside.x, aside.y)) continue;
        await carry(page, at.grip, aside);
        const cracks = await withShell(page, id);
        expect(cracks.some((c) => c.aligned)).toBe(false);
        expect(Math.min(...cracks.map((c) => c.aperture))).toBeGreaterThan(0.3);
        tested = true;
        break;
      }
      expect(tested, 'a piece within reach of the pointer').toBe(true);
      expect(await hook(page, (k) => k.getCracks().some((c) => c.joined))).toBe(false);
    });

    test('the first visit says how, beside the bowl, and steps aside once a piece is picked up', async ({ page }) => {
      const coach = page.locator('.coach');
      await expect(coach).toHaveAttribute('data-visible', 'true');
      await expect(coach).toHaveText('Pick up a fragment and bring its matching edges close. Gold appears once the break is aligned.');
      // A line of type by the object: not a dialog, and nothing that takes the pointer.
      await expect(page.locator('dialog, [role="dialog"], [aria-modal="true"]')).toHaveCount(0);
      expect(await coach.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe('none');
      const box = (await coach.boundingBox())!;
      const foot = (await points(page)).shards.find((p) => p.id === 0)!;
      expect(Math.abs(box.x + box.width / 2 - foot.x)).toBeLessThan(160);
      expect(box.y + box.height).toBeLessThan(foot.y);
      expect(foot.y - (box.y + box.height)).toBeLessThan(460);
      expect(box.x + box.width).toBeLessThan(1100);

      // Orbiting does not dismiss it; picking a piece up does.
      await page.mouse.move(250, 560);
      await page.mouse.down();
      await page.mouse.move(280, 550, { steps: 4 });
      await page.mouse.up();
      await expect(coach).toHaveAttribute('data-visible', 'true');
      let lifted = false;
      for (const id of await neighbours(page)) {
        const at = await reach(page, id);
        if (!at) continue;
        await page.mouse.move(at.grip.x, at.grip.y);
        await page.waitForTimeout(150);
        await page.mouse.down();
        await page.mouse.move(at.grip.x, at.grip.y - 30, { steps: 5 });
        await expect(coach).toHaveAttribute('data-visible', 'false');
        await page.mouse.up();
        lifted = true;
        break;
      }
      expect(lifted).toBe(true);

      // Said once: coming back to Repair does not repeat it.
      await page.getByRole('button', { name: 'Break', exact: true }).click();
      await page.getByRole('button', { name: 'Repair', exact: true }).click();
      await expect(coach).toHaveAttribute('data-visible', 'false');
      await expect(page.locator('.hint')).toHaveAttribute('data-visible', 'true');
    });

    test('a piece that leaves the table can be recovered, and nothing else is disturbed', async ({ page }) => {
      const recover = page.getByRole('button', { name: 'Recover pieces' });
      await expect(recover).toBeHidden();
      expect(await hook(page, (k) => k.stats.offStage)).toBe(0);

      // Pick up the loose piece nearest the front, lift it, and scroll it towards the camera
      // until it is out past the table's front edge. Then let go.
      const loose = (await points(page)).shards.filter((p) => p.id !== 0 && clear(p.x, p.y)).sort((a, b) => b.y - a.y);
      let stray = -1;
      for (const piece of loose) {
        if ((await probe(page, piece.x, piece.y)).shard !== piece.id) continue;
        stray = piece.id;
        await page.mouse.move(piece.x, piece.y);
        await page.waitForTimeout(150);
        await page.mouse.down();
        await page.mouse.move(piece.x, piece.y - 90, { steps: 10 });
        for (let i = 0; i < 9; i++) { await page.mouse.wheel(0, 380); await page.waitForTimeout(70); }
        await page.waitForTimeout(350);
        await page.mouse.up();
        break;
      }
      expect(stray).toBeGreaterThan(0);
      await page.waitForFunction(() => window.__kintsugi!.stats.offStage > 0, null, { timeout: 15_000 });
      await expect(recover).toBeVisible();
      await expect(page.locator('.hint')).toContainText('Recover pieces brings it back.');
      // Recovery belongs to mending: it is not offered in Break mode.
      await page.getByRole('button', { name: 'Break', exact: true }).click();
      await expect(recover).toBeHidden();
      await page.getByRole('button', { name: 'Repair', exact: true }).click();
      await expect(recover).toBeVisible();

      await page.waitForTimeout(1800);
      const before = await hook(page, (k) => ({ pieces: k.getPieces(), cracks: k.getCracks(), fragments: k.stats.fragments }));
      expect(before.pieces.find((p) => p.id === stray)!.offStage).toBe(true);
      expect(before.pieces.filter((p) => p.offStage).length).toBe(1);

      await recover.click();
      await page.waitForFunction(() => window.__kintsugi!.stats.offStage === 0, null, { timeout: 10_000 });
      await expect(recover).toBeHidden();
      await page.waitForTimeout(1000);
      const after = await hook(page, (k) => ({ pieces: k.getPieces(), cracks: k.getCracks(), fragments: k.stats.fragments }));

      // The piece is back on the table top, within reach.
      const back = after.pieces.find((p) => p.id === stray)!;
      expect(back.offStage).toBe(false);
      expect(back.position[1]).toBeGreaterThan(-0.05);
      expect(back.position[1]).toBeLessThan(1.2);
      // It is the same piece with the same cracks, and it has not been fitted or joined to anything.
      expect(after.fragments).toBe(before.fragments);
      expect(after.cracks.map((c) => [c.id, c.shardA, c.shardB, c.length])).toEqual(before.cracks.map((c) => [c.id, c.shardA, c.shardB, c.length]));
      expect(after.cracks.every((c) => !c.joined && c.fill === 0)).toBe(true);
      expect(after.cracks.filter((c) => c.shardA === stray || c.shardB === stray).every((c) => !c.aligned)).toBe(true);
      // Nothing that was on the table has been moved.
      for (const piece of after.pieces) {
        if (piece.id === stray) continue;
        const was = before.pieces.find((p) => p.id === piece.id)!;
        expect(Math.hypot(piece.position[0] - was.position[0], piece.position[1] - was.position[1], piece.position[2] - was.position[2])).toBeLessThan(0.03);
      }
      await page.screenshot({ path: 'test-results/07-recovered.png' });
    });
  });

  test('render quality can be raised for stills and handed back to the adaptive default', async ({ page }) => {
    type Info = { quality: string; shadowMapSize: number; canvasSize: number[]; renderSize: number[]; errors: string[] };
    const info = () => hook(page, (k) => k.getGpuInfo() as unknown as Info);
    const auto = await info();
    expect(auto.quality).toBe('auto');
    // The canvas is the viewport in device pixels; the suite pins the scene at 0.6 of that.
    expect(auto.canvasSize).toEqual([1440, 1000]);
    expect(auto.renderSize).toEqual([864, 600]);

    expect(await hook(page, (k) => k.setQuality('ultra'))).toBe('ultra');
    await page.waitForTimeout(500);
    const ultra = await info();
    expect(ultra.quality).toBe('ultra');
    expect(ultra.shadowMapSize).toBeGreaterThan(auto.shadowMapSize);
    // At the fixed levels the scene is rendered at least as large as the canvas.
    expect(ultra.canvasSize).toEqual([1440, 1000]);
    expect(ultra.renderSize[0]).toBeGreaterThanOrEqual(1440);
    expect(ultra.renderSize[1]).toBeGreaterThanOrEqual(1000);
    expect(ultra.errors).toEqual([]);

    // The study works the same at the higher level.
    await hook(page, (k) => k.fractureAt({ u: 0.17, v: 0.64, energy: 0.72 }));
    expect(await hook(page, (k) => k.stats.fragments)).toBeGreaterThan(1);
    expect(await hook(page, (k) => k.stats.renderQuality)).toBe('ultra');

    // Something that is not a level changes nothing; 'auto' gives the resolution back to the governor.
    expect(await hook(page, (k) => k.setQuality('cinematic' as never))).toBe('ultra');
    expect(await hook(page, (k) => k.setQuality('high'))).toBe('high');
    expect(await hook(page, (k) => k.setQuality('auto'))).toBe('auto');
    await page.waitForTimeout(300);
    const back = await info();
    expect(back.quality).toBe('auto');
    expect(back.renderSize).toEqual([864, 600]);
    expect(back.shadowMapSize).toBe(auto.shadowMapSize);
    expect(back.errors).toEqual([]);
  });

  test('sliders and keyboard shortcuts drive the same state as the buttons', async ({ page }) => {
    const slider = page.getByRole('slider', { name: 'Brittleness' });
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(await hook(page, (k) => k.state.brittleness)).toBe(60);
    await page.getByRole('slider', { name: 'Gold viscosity' }).fill('80');
    expect(await hook(page, (k) => k.state.viscosity)).toBe(80);
    await hook(page, (k) => { k.setControl('impact', 250); k.setControl('nonsense', 3); k.setControl('cureRate', Number.NaN); });
    expect(await hook(page, (k) => [k.state.impact, k.state.cureRate])).toEqual([100, 46]);
    await expect(page.getByRole('slider', { name: 'Impact' })).toHaveValue('100');

    await page.locator('canvas.scene').focus();
    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Repair', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.hint')).toContainText('Break the bowl first.');
    await page.keyboard.press('b');
    await expect(page.getByRole('button', { name: 'Break', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('s');
    await expect(page.getByRole('button', { name: 'Strike bowl' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Strike bowl' })).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('g');
    await expect(page.getByRole('button', { name: 'Gold brush' })).toHaveAttribute('aria-pressed', 'true');
    expect(await hook(page, (k) => k.state.mode)).toBe('repair');
    await page.keyboard.press('Space');
    expect(await hook(page, (k) => k.state.paused)).toBe(true);
    await page.keyboard.press('Space');
    expect(await hook(page, (k) => k.state.paused)).toBe(false);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  test('the controls become a bottom sheet on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    const handle = page.getByRole('button', { name: 'Controls' });
    await expect(handle).toBeVisible();
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    const closed = await page.locator('.panel').boundingBox();
    expect(closed!.height).toBeLessThan(80);
    await expect(page.getByRole('button', { name: 'Strike bowl' })).toBeHidden();

    // With the sheet closed the canvas still takes the pointer: strike the bowl.
    await hook(page, (k) => k.setMode('break'));
    const bowl = await hook(page, (k) => k.getScreenPoints().shards[0]);
    expect(bowl.y).toBeLessThan(844 - 56);
    expect(await hook(page, (k) => k.probe(2, 2).shard)).toBeNull();
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [bowl.x, bowl.y])).toBe('scene');

    await handle.click();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await page.waitForTimeout(500);
    const opened = await page.locator('.panel').boundingBox();
    expect(opened!.height).toBeGreaterThan(300);
    expect(opened!.height).toBeLessThanOrEqual(844 * 0.64 + 2);
    await expect(page.locator('.howto')).toBeHidden();

    // The panel is clickable, and arming a tool hands the screen back to the bowl.
    await page.getByRole('button', { name: 'Celadon', exact: true }).click();
    expect(await hook(page, (k) => k.state.material)).toBe('celadon');
    await page.getByRole('button', { name: 'Strike bowl' }).click();
    await expect(handle).toHaveAttribute('aria-expanded', 'false');
    await page.waitForTimeout(500);
    const target = await hook(page, (k) => k.getScreenPoints().shards[0]);
    await page.mouse.click(target.x, target.y);
    await page.waitForFunction(() => window.__kintsugi!.stats.fragments > 1, null, { timeout: 15_000 });
    await page.screenshot({ path: 'test-results/05-phone.png' });
  });
});
