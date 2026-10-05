# Kintsugi

Real-time procedural ceramic fracture and interactive gold repair in WebGPU.

**Material Studies / 02.** A porcelain bowl stands on a table in slatted daylight. Drop it or
strike it with a steel ball and it breaks where it was hit, into real pieces you can pick up.
Switch to Repair, carry the pieces back, trace the cracks with a gold brush, and the bowl is
mended along exactly the lines it broke on.

The fracture pattern is generated from the impact. The shards are closed meshes and rigid bodies.
The gold follows the crack network that the fracture produced; nothing is pre-authored.

**Live demo:** <https://tahabakri.github.io/kintsugi-webgpu/> (needs a browser with WebGPU; built and
deployed from `main` by the Pages workflow in this repository).

## What it does

- Renders a procedural bowl with real wall thickness in a small lit studio, using WebGPU directly.
- Breaks the bowl from actual collision data: a drop onto the table, or a steel ball thrown at the
  point you click.
- Generates the crack pattern at the moment of impact, from where and how hard the bowl was hit.
  A light blow knocks a hole out of a bowl that stays standing; a hard one breaks the wall up all
  the way round and leaves only the foot.
- Turns every fragment into a watertight mesh with exposed broken faces and a Rapier rigid body.
- Lets you move the pieces, fit them back together, and paint gold resin along the generated cracks.
- Simulates the resin along each crack: it flows, cools, cures, and bonds aligned pieces for good.

## Features

- Native WebGPU renderer written in WGSL: contact-hardening sun shadows, height-map ambient
  occlusion, HDR, 4× MSAA, bloom, filmic tone mapping.
- Impact-driven anisotropic power-diagram fracture over the bowl's own surface coordinates.
- Closed, extruded shard meshes whose neighbours share bit-identical borders.
- Deterministic: the same seed, impact point and energy always produce the same pieces.
- Persistent crack graph, with a one-dimensional resin field on every crack.
- Gold brush with capillary flow, temperature, viscosity and curing.
- Alignment detection with hysteresis, a seating assist that draws a held piece the last few
  centimetres into its place, and permanent bonds.
- Pieces that fall off the table can be brought back without disturbing the rest.
- Four procedural glazes: crazed porcelain with under-glaze cobalt brushwork, celadon, raku, terracotta.
- Three render quality levels: adaptive by default, with fixed higher levels for stills.
- Editorial interface in plain DOM and CSS, with a bottom sheet at phone widths.
- A fallback card when WebGPU is unavailable, and reduced-motion support.
- No external 3D models, textures, images or fonts. Everything on screen is generated in code.

## How it works

```text
Impact
  ↓
Material-space power diagram
  ↓
Closed shard meshes
  ↓
Rapier rigid bodies
  ↓
Persistent crack graph
  ↓
Gold 1D flow fields
  ↓
Cure + alignment
  ↓
Fixed repair joints
```

The short version, in the order things happen:

1. **The bowl is a surface with coordinates.** It is a surface of revolution described by
   `(u, v)`: `u` runs around the bowl, `v` runs along the profile from the centre of the underside
   to the rim. Every point of the outer skin has a partner on the inner skin at the same `(u, v)`,
   so "through the wall" is a well-defined direction. The mesh is a 160 × 72 grid over that surface.
2. **An impact becomes a point and an energy.** Rapier reports a contact; the pre-impact velocities
   give the closing speed along the contact normal. That, the effective mass, the kind of contact
   (a steel ball concentrates the blow far more than a flat table) and the Brittleness and
   Thickness controls give an energy between 0 and 1. Below a threshold nothing breaks.
3. **Seeds are scattered over the bowl.** Densely around the impact, in three rings stretched along
   the direction the blow glanced in; sparsely everywhere else: a ring on the foot and a handful up
   the wall.
4. **A power diagram of those seeds is the crack pattern.** It is computed in `(u, v)` with an
   anisotropic distance, and it wraps round the bowl. Cells are then grouped into pieces. The
   cells of the foot always stay together as one body. After a light blow so does the rest of the
   wall, leaving a hole; after a hard one each wall cell comes free as a large piece of its own.
5. **Each cell is cut out of the bowl's grid** and extruded through the wall: outer skin, inner
   skin, and a rough broken face along every crack. Two neighbouring shards use the very same
   vertices along their shared crack, so the pieces fit with no gaps or overlaps.
6. **Each shard becomes a rigid body.** Mass, centre of mass and inertia come from the closed mesh;
   collision uses a handful of convex hulls per shard. The pieces get a small parting push and
   Rapier takes over: wall pieces that have lost their neighbours topple off the foot and lie
   where they fall.
7. **The cracks are kept as a graph.** Every crack between two junctions is an edge that knows its
   two shards, its path on the surface, and its length. This graph is the only thing the repair
   works on, which is why the gold can only ever appear on cracks the fracture made.
8. **Gold is a quantity along each edge.** Each crack carries a row of samples holding fill, cure,
   temperature and flow. The brush deposits resin at the sample under the pointer; a small flow
   model spreads it along the crack and through junctions into connected cracks.
9. **Cured gold on a closed crack becomes a bond.** When the two sides of an edge are back in
   their original relative position, and the edge is full and cured enough, the two shards are
   locked together. When every edge is bonded the bowl is one object again, with the same cracks.

### Fracture model

This is an impact-driven **procedural surface fracture approximation, not engineering-grade
fracture mechanics**. There is no stress field and no crack propagation; the pattern is a
geometric construction chosen to look and behave like a brittle break.

- **Energy.** `E = ½ · m_eff · v_n² · concentration · brittleness / thickness`, clamped to 0…1.
  The bowl fractures at `E ≥ 0.2`. The Impact slider sets the striker's launch speed, so it changes
  the energy by changing the collision, not by overriding it.
- **Two regimes.** Below `E = 0.26` the blow crushes a zone a little over 0.4 world units in radius
  (1 unit is 10 cm) and the rest of the bowl holds: a collar of seeds just outside the zone draws
  the ragged outline of the hole. From `E = 0.26` the wall lets go all the way round. The zone
  crushed into small fragments is then tighter (0.62 of the radius the energy would otherwise
  give), and the rest of the wall becomes a handful of large pieces.
- **Seeds.** Around the impact: one at the contact, then about 40% in an inner ring, 40% in a
  middle ring and the rest in an outer ring, with angular and radial jitter; seeds that fall beyond
  the rim are mirrored back in, so a rim hit still produces rim fragments. Over the rest of the
  bowl: eight on the foot, five or six up the wall, two or three by the rim. The seed budget runs
  from 4 to 40 with the energy and the Brittleness and Thickness controls, and the large wall
  pieces come out of it, so a harder blow does not simply add to the count.
- **Power diagram.** A weighted Voronoi diagram with straight bisectors, under a metric that makes
  distance across the blow's tangential direction cost more, so cells elongate along it. `u` is
  periodic: every seed is also present one turn to either side, and cells that cross the grid
  column opposite the impact are cut there. That cut is internal to a piece, never a crack. Cells
  below a minimum area are merged into the neighbour they share the longest border with, and no
  fracture has more than 44 pieces.
- **Watertight meshes.** Grid cells are clipped against the diagram with a tagged
  Sutherland–Hodgman pass. Crossing points are computed in a canonical order so that both shards
  on either side of a crack get bit-identical vertices. The broken face of each crack segment is
  built once, with deterministic roughness that fades to nothing at its ends, and used by both
  neighbours with opposite winding.
- **Determinism.** The random stream is seeded from the reset seed and the quantised impact
  position and energy. The unit tests check that repeated runs produce the same seeds, cells,
  crack graph and shard vertices, and that the cells tile the bowl exactly once.
- **Parting.** Each piece inherits the bowl's motion, then takes a push away from the contact
  that dies off with distance, its share of the striker's momentum, and, when the wall has let
  go, a small outward release with a twist of its own. Nothing is placed: where pieces end up is
  what the simulation does with those starting velocities.
- **Physics.** Rapier (`@dimforge/rapier3d-compat`) **handles all rigid-body simulation**: a fixed
  120 Hz step with an accumulator, compound convex-hull colliders, and the contact events that
  trigger the fracture. One world unit is 10 cm, so gravity is 98.1 units/s².

### Repair model

- **Alignment.** For each crack the two sides store the same polyline in their own shard's frame.
  The RMS distance between matching points, the relative rotation, the tangent error and the
  opposition of the two face normals decide whether an edge is closed. It becomes aligned under
  0.055 units, 9° and 12°, and stays aligned until 0.075 units, 12° and 16°, so the state does not
  flicker.
- **Seating assist.** A pointer steers a piece across the screen but cannot say how far away it
  should be or which way round. In Repair mode a held piece therefore gets three kinds of help,
  all measured by how far from its place the pointer is holding it, across the view. Within 20 cm
  it starts to turn to the orientation it had in the bowl. Within 10 cm it is drawn towards its
  place, gently at first and fully inside 3 cm, and its depth is eased to match. Once it sits
  there it stays until the pointer has pulled more than about 6 cm away, so a wavering hand does
  not shake it loose. It is the same rigid body on the same carrying spring throughout: nothing
  is moved that is not in the hand, and a piece let go further off simply falls.
- **Its place** is the pose it had in the bowl, expressed in the frame of the part left standing,
  so every piece is fitted to the same bowl rather than to a neighbour that may sit a hair off.
  Only pieces that touch something already in place are drawn in; the standing part is whatever
  is bonded to the anchor shard or mated to it and waiting for gold.
- **The cue.** The broken faces that are about to meet warm faintly, only round the place where
  they will touch. A closed crack that has no gold yet shows a fine gold thread.
- **Steadying.** While a piece is in the hand the standing part is held still, as the other hand
  would hold it. Pieces within 0.14 units and about 26° of mating are held by soft springs between
  matching points; the springs let go beyond 0.18 units or 40°. They leave a piece in the hand
  alone until it sits in its place.
- **Painting.** Gold goes on a break once it is closed: the brush takes the nearest visible closed
  crack within 15 pixels (28 once a stroke is under way) and ignores open edges, so a loose piece
  under the pointer is picked up instead. It deposits resin with a soft footprint about 2 cm
  wide and walks fast strokes in 5-pixel steps so they leave no gaps. One pass along a crack
  fills it. Near a junction the footprint carries on into the other closed cracks that meet
  there, and into no others.
- **Recovering pieces.** A piece that falls off the table lands on the floor below it. In Repair
  mode a Recover pieces button appears while anything is off the table or has slid out of reach
  along it. It sets each such piece down, the way up it lay, on open table beside or behind the
  bowl, or failing that in a gap its own collision shape fits without touching anything. Nothing
  else is moved, and nothing is fitted, joined or painted.
- **Settling.** A fresh fracture is allowed 1.5 mm of contact slack so its pieces do not pop apart;
  0.4 s later that is tightened to 0.4 mm. When the pile has come to rest, any two pieces still
  pressed more than 2 mm into each other are moved apart by the excess, once.
- **Flow.** Per step, resin moves from fuller samples to emptier ones in proportion to the
  difference and to its mobility, with a small capillary pull into dry crack. Mobility rises with
  temperature, falls with viscosity, and reaches zero as the resin cures. Transfers are
  antisymmetric and bounded, so volume is conserved and fill stays within 0…1. At a junction resin
  runs on freely between two cracks that are both closed; into a crack that is still open it only
  creeps, and it never moves between cracks that do not meet.
- **Temperature and curing.** Fresh resin leaves the brush at the Gold temperature setting and
  cools towards ambient over a few seconds. `dcure/dt = cureRate · fill · temperatureFactor`; very
  warm resin cures at under half speed until it has cooled. Temperature is a unitless simulation
  factor, not a real one.
- **Bonding.** An edge bonds when it is aligned, its average fill is above 0.72 and the average
  cure of its filled samples is above 0.82. Resin on pieces that are apart cures but never bonds
  them.
- **Repaired percentage.** Length-weighted over all cracks between two shards: a bonded edge
  counts fully; filled and cured resin on an edge that is not yet bonded counts in part.
- **Seam geometry.** Built once per fracture, in each shard's frame: a raised bead on the outer
  and inner skin of every crack, a film on the broken face, and a hairline for closed cracks that
  have no gold. The vertex shader reads the live resin samples from a storage buffer and scales
  each cross-section, so only filled stretches are visible. The bead's width wanders along the
  seam and swells where cracks meet; liquid, it is tall, smooth and a shade redder, and as it
  cures it settles and takes on the grain of burnished gold.

### Rendering

The renderer and the fracture and repair systems are **native project code**; no engine or scene
graph is involved.

- **Light.** One sun, coming through a slatted blind: bars of light and shade that open out like
  a fan across the wall and the table. Its shadow map is filtered with a blocker search, so a
  shadow is crisp where an object touches the table and soft where it has travelled.
- **Occlusion.** A top-down height map of whatever is on the table is rendered each frame. From
  it one pass works out how much sky every point of the table has hidden from it, treating each
  texel as a small patch with a form factor; the ceramic samples the same map for the shading
  between shards and inside the bowl.
- **Ceramic.** A clear glaze over a body that scatters light a little. The glaze mirrors a
  procedural studio: the lit table and wall, and a window with glazing bars. Crazing is a 3D
  cellular pattern, so it has no seam or stretch, and it fades out with distance. The cobalt
  decoration is painted by the fragment shader as brushwork: a wandering branch, twigs, blossoms
  with irregular petals, buds, and banding lines that waver, each laid over the last.
- **Studio.** A plaster wall and a mineral-finished table block. Their relief is a height
  function evaluated together with its analytic slope, so raking light picks out the texture
  without any normal map.
- **Gold, steel, debris.** Gold seams are driven by storage buffers as described above. The
  striker is brushed steel. A break leaves chips and powder on the table as instanced particles.
- **Post.** Bloom with a high threshold, so only gold and strong highlights glow; an exponential
  film-like shoulder, a gentle S-curve and grade, vignette and dither.
- **Resolution.** The scene has its own resolution, separate from the canvas. Rendered smaller,
  it is brought up with a Catmull-Rom filter; rendered larger, it is filtered down.
- If `rgba16float` or 4× MSAA cannot be used, the renderer falls back to `rgba8unorm` or one
  sample and records that in `window.__kintsugi.getGpuInfo()`.

**Quality levels**

| Level | Scene resolution | Shadow map | Use |
| --- | --- | --- | --- |
| `auto` (default) | 60–100% of the canvas, adapting to hold the frame rate; canvas capped at 2.6 MP | 2048² | Interactive use |
| `high` | The canvas, at device pixel ratio up to 2; capped at 6 MP | 4096² | A fast GPU |
| `ultra` | The canvas, supersampled up to 1.5× within a 9 MP budget; more filter taps everywhere | 4096² | Stills. Not expected to hold 60 frames a second |

Set it with `?quality=high` or `?quality=ultra` in the URL, or from the console with
`window.__kintsugi.setQuality('ultra')`. Opening the page with `?debug` adds a selector to the
panel. `getGpuInfo()` reports the level, the canvas size and the size the scene is rendered at.

## Tech stack

| | |
| --- | --- |
| Build | Vite 7, TypeScript 5.9 (strict) |
| Graphics | WebGPU and WGSL, written directly against the browser API |
| Physics | `@dimforge/rapier3d-compat` 0.19 |
| Interface | Plain DOM and CSS |
| Tests | Vitest 5 (unit), Playwright 1.63 (browser) |

There is no Three.js, Babylon, React or UI framework, and there are no runtime assets.

## Controls

| Input | Break mode | Repair mode |
| --- | --- | --- |
| Drag a piece | Pick it up, throw it or let it fall | Pick it up and bring it near its place |
| Drag along a closed crack | | Paint gold (Gold brush on) |
| Drag empty space, or right-drag | Orbit | Orbit |
| Wheel or pinch | Zoom | Zoom |
| Wheel while holding a piece | Push it away or pull it closer | Same |
| Shift-drag while holding a piece | Turn it | Turn it |
| Two fingers | Orbit and zoom | Orbit and zoom |

| Key | Action |
| --- | --- |
| `B` / `R` | Break mode / Repair mode |
| `S` | Arm or disarm Strike bowl |
| `G` | Gold brush on or off |
| `Space` | Pause or resume |
| `0` | Reset view |
| `Esc` | Put the tool down, let go, close the sheet |

**Strike bowl** arms a crosshair; click a point on the bowl and a steel ball is thrown at it.
**Drop test** lifts the bowl and lets go. **Reset** starts a new bowl with the next seed;
Alt-click Reset to get the same seed again. Brittleness and Impact apply to the next break;
Thickness reshapes the bowl and applies while it is whole. Adding `?q=0.8` to the URL pins the
scene's resolution scale (0.4 to 1) instead of letting it adapt.

Mending by hand: pick up a piece that touches the part still standing, carry it towards where it
came from until its broken edge warms and it settles, and let go. Then draw the brush along the
closed crack; it bonds a few seconds later, when the gold has cured. Work outwards from the
standing part. Pieces of the far wall are easier to reach looking down into the bowl.
**Recover pieces** appears in Repair mode when a piece has left the table.

## Local development

Requires Node 22.12 or newer.

```bash
npm install
npm run dev
```

Then open `http://localhost:5173` in a browser with WebGPU.

## Build

```bash
npm run build
npm run preview
```

`npm run build` type-checks and writes a static site to `dist/`. Asset paths are relative, so the
build works from any subpath.

## Testing

```bash
npm run typecheck
npm test
npm run test:e2e
```

- **Unit tests (Vitest, 39 tests).** Fracture: determinism, variation with seed and impact,
  fragment counts rising with energy, finite cells that tile the bowl exactly once, a hole after
  a light blow and only the foot left after a hard one, a crack graph that matches the shards,
  every shard a closed solid with positive volume and the pieces adding up to the bowl. Repair:
  resin stays within bounds and conserves volume, viscosity and temperature change the flow,
  curing, alignment with hysteresis, no bond between pieces that are apart or lack cured gold,
  a full repair ending as one piece, which pieces count as in place, a held piece guided to its
  own place rather than to a loose neighbour, and a brush stroke that carries on round a junction
  into closed cracks only. Recovery: what counts as off the table, and open places that never
  overlap.
- **Browser tests (Playwright, 18 tests).** Two check the fallback and run anywhere. Sixteen need
  a real WebGPU adapter and are skipped when there is none: load and console, presets, fracture
  and full repair through the automation hook, determinism and reset, pause, orbit and zoom, a
  real strike, a real drop, picking up pieces and painting closed cracks with the pointer, the
  render quality levels, sliders and keyboard, and the phone sheet. Four of them mend by hand,
  with the pointer and nothing else: a piece let go about 2 cm off its place is drawn in, takes
  gold and bonds; one let go a hand's width away is left where it falls; the first visit to
  Repair shows its one line of guidance and drops it when a piece is picked up; and a piece
  pulled off the table is recovered without anything else moving. Locally they use the
  installed Chrome.
- **CI** runs type-check, unit tests and the build, plus the two fallback browser tests. Hosted
  runners have no GPU, so the WebGPU browser tests are not run there.

On the development machine (Windows 11, Chrome 154, Intel integrated GPU) all 39 unit tests and
all 18 browser tests pass.

Mending was also timed once, on the production build, in a session driven by mouse moves, presses
and the wheel alone: Strike bowl, a click on the bowl, a wait for the 14 pieces to lie still,
Repair, then one piece after another. Every piece seated on the first attempt after being let go
about 28 pixels off its place, within a few hundredths of a second of the pointer stopping. A
piece took 4 to 7 seconds to pick up, carry and seat, of which about 2 seconds was the scripted
pointer crossing the screen. Five pieces were seated, gilded and bonded 63 to 73 seconds after
entering Repair, and all 13 loose pieces of a bowl in just under three minutes, with one look
from above to reach the far wall. These are a script's timings on one laptop; no person was timed.

`window.__kintsugi` exposes a small automation surface used by the browser tests: `ready`,
`version`, `seed`, `state`, `stats`, `reset()`, `fractureAt()`, `setMode()`, `setMaterial()`,
`setControl()`, `setQuality()`, `paintCrack()`, `alignAllForTest()`, `step()`, `getCracks()`,
`getPieces()`, `getOverlaps()`, `getGpuInfo()`, `getScreenPoints()`, `getCamera()` and `probe()`.
Every method calls the same code the interface does, except `alignAllForTest()`, which puts every
piece back in its place and has no counterpart in the interface.

## Browser requirements

A browser that exposes WebGPU (`navigator.gpu`) and can provide an adapter. Developed and verified
in Chrome 154 on Windows 11. Other WebGPU browsers should work but have not been tested. Without
WebGPU the page shows a short explanation instead of the study; there is no WebGL fallback.

## Performance notes

Measured on one machine only: a laptop with an Intel 11th-generation integrated GPU, Windows 11,
Chrome 154, production build. Timings on this machine varied noticeably between runs, so these
are ranges.

| Level and viewport | Scene rendered at | Frame time at rest |
| --- | --- | --- |
| `auto`, 1440 × 1000 | 864 × 600 (it settles at its lowest scale, 60%) | 17–24 ms |
| Scene pinned at full size (`?q=1`), 1440 × 1000 | 1440 × 1000 | 24–35 ms |
| `high`, 1440 × 1000 | 1440 × 1000 | about 47 ms |
| `ultra`, 1440 × 1000 | 2160 × 1500 | about 85 ms |
| `ultra`, 3840 × 2160 | 3840 × 2160 | 57–85 ms |

- With about 27 pieces in motion a frame at the adaptive level took 20–34 ms.
- Generating a fracture took 40–165 ms: a single hitch at the moment of impact.
- One fixed physics and repair step cost under 1 ms with everything at rest and 5–7.5 ms while all
  the pieces were moving.
- The canvas stays at device resolution at every level; only the scene is scaled. On this GPU the
  adaptive level therefore shows a 60% scene filtered up, which is softer than the fixed levels.
- The JavaScript bundle is 2.4 MB (0.9 MB gzipped). Almost all of it is Rapier's WebAssembly,
  which the `-compat` package embeds.

Nothing was measured on discrete GPUs, phones, Safari or Firefox.

## Limitations

- The fracture is a surface pattern extruded through the wall. Cracks run straight through the
  thickness, and there is no stress analysis or crack dynamics.
- A bowl breaks once. Shards do not break again. After a hard blow the foot is always what is
  left standing, whatever was hit, unless the blow landed on the foot itself.
- A bond is a rigid weld: the two shards are merged into one compound rigid body in their original
  relative pose. It behaves like a fixed joint that cannot stretch, and it is permanent, however
  hard the repaired bowl is hit. The meshes are not merged; the seam stays.
- Fitting a piece is assisted. Within 10 cm of its place a held piece is drawn in and turned the
  right way round, and soft springs then hold it there against gravity before any gold is
  applied. That is a convenience for a mouse or a finger, not physics, as is holding the standing
  part still while a piece is fitted. Nothing is moved that is not in the hand.
- Only a piece that touches something already in place is drawn in. The others have to wait
  their turn; the page says so the first time one is picked up.
- The brush works on closed cracks only. Gold cannot be put on the edge of a loose piece first.
- Colliders are convex approximations of curved shell pieces, pulled back about a millimetre from
  each crack. Fragments have no collider in the small disc at the very centre of the base.
  Settled pieces rest up to about a millimetre into one another, which can show in close-up.
- A held piece is solid. One that belongs on the far wall has to be brought in over the near
  wall, or placed first.
- Recover pieces sets a piece down where there is room; on a table strewn with fragments that
  can be at the front.
- Resin lives on the crack as a one-dimensional field. It does not drip, run over the glaze or
  respond to gravity, and cured gold cannot be removed.
- The chips and powder a break leaves are particles for the eye only. They are not rigid bodies
  and nothing collides with them.
- The crazing in the glaze is a painted detail of the glaze and is unrelated to the fracture.
- The light is a directional sun with an analytic pattern, an analytic studio for reflections and
  height-map occlusion. There is no global illumination and nothing is ray traced.
- On an integrated GPU the adaptive level renders the scene below the canvas resolution and
  filters it up. The fixed levels look better and run slower.
- The camera orbits in front of the wall only. The back of the bowl is reached by looking down
  into it, not by walking round it.
- Phone layouts were checked at 390 × 844 and 844 × 390 in desktop Chrome, not on a physical phone.
- Tuned and measured on a single integrated-GPU laptop.

## Project layout

```text
src/
  ceramic/      bowl profile and the (u, v) surface
  fracture/     impact, seeds, power diagram, clipping, shard meshes, colliders, crack graph
  physics/      Rapier world, shard bodies, grab, striker
  repair/       resin flow, curing, alignment, bonding, seam geometry
  gpu/          WebGPU context, pipelines, render targets, renderer, camera
  shaders/      WGSL
  interaction/  pointer, picking, orbit, modes
  effects/      dust, chips and powder, camera impulse
  ui/           panel, status, bottom sheet, swatches, icons
  debug/        window.__kintsugi
tests/          unit tests and the Playwright suite
```

## License

MIT © 2026 Taha Bakri. See [LICENSE](LICENSE).
