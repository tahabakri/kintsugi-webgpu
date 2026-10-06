# Technical notes

The long version of the [README](../README.md): how the fracture, the repair and the renderer work, what was measured, and where the model stops.

## How it works

```text
Rapier collision
  ↓
impact: point, direction, energy
  ↓
procedural crack network, grown from the impact in the bowl's own surface coordinates
  ↓
the surface cut along those cracks → convex cells → pieces
  ↓
closed shard meshes whose broken edges are exactly those cracks
  ↓
Rapier rigid bodies that carry on with the bowl's own motion
  ↓
the same crack graph, kept
  ↓
gold 1D flow fields along it → cure + alignment → fixed repair joints
```

The short version, in the order things happen:

1. **The bowl is a surface with coordinates.** It is a surface of revolution described by
   `(u, v)`: `u` runs around the bowl, `v` runs along the profile from the centre of the underside
   to the rim. Every point of the outer skin has a partner on the inner skin at the same `(u, v)`,
   so "through the wall" is a well-defined direction. The mesh is a 160 × 72 grid over that surface.
2. **Every contact of the bowl is one measured impact.** A drop, a throw, a steel ball, the table or
   the stage: Rapier reports the contact, and the speed along it, the speed across it, the
   effective mass and where on the bowl it was are taken from the velocities before the solver
   answered. Contacts of one collision are gathered for 30 ms and the hardest one is judged, once.
3. **The impact becomes a severity between 0 and 1,** from the energy of the blow along the
   contact, how concentrated the contact was (a flat foot on a table less than the thin rim, far
   less than a steel ball), the Brittleness and Thickness controls, and a little of the sliding
   speed. Below 0.2 nothing breaks, though the bowl still moves and may shed a crumb.
4. **Cracks are grown from the impact.** Several leave it, with a direction that persists, drifts
   with the stress of the wall, wanders and sometimes kinks; they lose energy as they go, branch,
   and stop where they run out of energy, meet another crack, or reach the rim. A ring crack cuts
   out the cone round the blow, arcs run across the radial cracks, and a hard blow sends cracks
   the height of the wall round the bowl and opens the foot ring.
5. **The bowl's surface is cut along them.** A sweep over the unwrapped surface turns the cracks
   into convex cells; cells that touch without a crack between them are one piece; slivers and
   pieces that would touch themselves at a point are merged away. The foot, or whatever is left
   on the base, is the piece that stays standing.
6. **Each piece is cut out of the bowl's grid** and extruded through the wall: outer skin, inner
   skin, and a rough broken face along every crack. Two neighbouring shards use the very same
   vertices along their shared crack, so the pieces fit with no gaps or overlaps.
7. **Each shard becomes a rigid body** that continues with the motion the bowl had a moment before
   the impact, plus a small separation that adds no momentum to the whole. Rapier does the rest:
   pieces that have lost their neighbours topple, slide and lie where they fall.
8. **The cracks are kept as a graph.** Every crack between two junctions is an edge that knows its
   two shards, its path on the surface, and its length. This graph is the only thing the repair
   works on, which is why the gold can only ever appear on cracks the fracture made.
9. **Gold is a quantity along each edge.** Each crack carries a row of samples holding fill, cure,
   temperature and flow. The brush deposits resin at the sample under the pointer; a small flow
   model spreads it along the crack and through junctions into connected cracks.
10. **Cured gold on a closed crack becomes a bond.** When the two sides of an edge are back in
    their original relative position, and the edge is full and cured enough, the two shards are
    locked together. When every edge is bonded the bowl is one object again, with the same cracks.

### Handling and impact

- **The hand.** Holding a piece is a servo, not a teleport. The pointer sets a target; each fixed
  step that target is smoothed by a critically damped spring (24 Hz), and an impulse is applied at
  the point that was clicked so that it follows the hand like an 18 Hz critically damped spring,
  whatever the piece weighs. The impulse is limited to 14 times the piece's weight, the hand
  carries its weight, and a soft torsion spring (14 rad/s) keeps it from swinging wildly. A grip on
  the rim therefore hangs, tilts and swings differently from one near the middle.
- **Letting go.** The velocity of the hand at release is fitted to the last 130 ms of its path
  (weighted least squares, recent samples counting most, a stray sample rejected): a hand that
  has stopped gives nothing, a flick gives its speed. The piece keeps the velocity it has; if its
  held point was slower than the hand along the hand's direction, it is given the shortfall, at
  most a quarter of the hand's speed. Nothing slows it, and the speed is capped at 48 units/s
  (4.8 m/s at 10 cm per unit), well above anything a mouse produced in testing.
- **Severity.** `½ · m_eff · (v_n² + 0.1 · v_t²) · concentration · brittleness / thickness`,
  scaled by `1.1e-3` and clamped to 0…1. Concentration is 1 for the foot, 1.5 for the curve of the
  wall, 2.2 for the rim and 28 for the steel ball. On the default settings that puts the
  foot-first threshold at a fall of about 6 cm onto the table, the rim's at about 3 cm, and the
  bowl shattered from about 30 cm. These are interaction targets, not material data.
- **After the break.** Each shard starts with the linear and angular velocity the bowl had just
  before the contact, at its own position, so the table or the ball then does to each piece what it
  would have done. A steel ball that broke the bowl is given back 55% of the speed it arrived with
  and goes on into the pieces. On top of that comes a separation push that is strongest beside the
  blow, leans the way the blow went, is lighter for heavy pieces, and has its mean taken out so
  that it adds no momentum. The total momentum of the pieces is compared with the bowl's before
  the blow and reported as `momentumError` (about 0.001 in the runs measured).
- **Settling.** A piece that is only creeping or rocking loses a few per cent of its motion each
  step, so that one rocking on its curved back comes to rest in about a second rather than for
  ever. Fast tumbling is not touched.
- **Drawing.** Physics runs at a fixed 120 Hz. Every body is drawn between its last two states
  (positions lerped, rotations slerped, by the fraction of a step left in the accumulator), so a
  slow frame rate does not show the steps. The orbit camera closes on its target at about 40 ms,
  so uneven pointer events do not make it move in steps.

### Fracture model

This is an impact-driven **procedural crack-network approximation inspired by brittle ceramic
fracture**. It is not finite-element analysis, not fracture mechanics, and not a simulation of
stress in the material: nothing in it solves for stress, and the cracks are a construction chosen
to look and behave like a brittle break. What it does share with a real break is the order of
things: a collision decides the energy and direction, a crack network grows from the point of
impact, the network divides the surface into pieces, and the pieces fall as rigid bodies.

- **The network.** It lives in the bowl's `(u, v)` coordinates over one turn centred on the
  impact, in steps of 1.1 cm along the surface. A crack's direction persists, is drawn a little
  towards the way the stress runs (up and down the wall, round the foot), leans away from the
  impact, wanders with a smooth random walk, and kinks now and then. It starts with
  `E · 4.6` units of travel (less on the foot, longer along the way the blow slid) and spends one
  per unit travelled, one and a half on the foot ring. A crack ends when it is out of energy,
  runs into another crack (which is split there, so every meeting is a vertex), reaches the rim, or
  would enter the disc at the centre of the underside, which is a single point in space and where
  no crack may go.
- **How many.** `round(1.2 + 7.5 · E)` primary cracks leave the impact, two to nine, at irregular
  angles (the blow's sliding direction sets where they start; a glancing blow makes the cracks
  that run with it longer). Up to about `7 · E` of them put out side cracks and `3.5 · E` arcs
  run across them, never right at the impact. Round the impact a ring crack cuts out the cone:
  closed for a light blow, broken into arcs for a hard one, with a second partial ring from
  `E = 0.42`.
- **The wall.** From a moderate blow up, cracks the height of the wall run round the bowl from the
  impact, close together beside it and further apart away from it, and the foot ring opens beside
  the impact; from `E = 0.8` it opens the whole way round, so the wall comes away from the foot.
  A blow on the foot sends only part of its energy up the wall. A blow on the very centre of the
  underside has nowhere to put cracks and uses the older power-diagram pattern instead.
- **Direction.** A glancing blow shifts the ring, lengthens the cracks that run with it and
  shortens the others, so the same blow from the other side makes a different pattern, not a
  mirror of it.
- **Pieces.** A vertical sweep over the unwrapped surface stops at every vertex; between two stops
  no crack starts or ends, so the strips between consecutive cracks are convex. Strips side by
  side are the same piece; the surface is joined across the seam where the turn closes. Cells in a
  piece are merged wherever that stays convex, and vertices that the sweep only put on a straight
  crack are removed again. Pieces below a minimum area are merged into the neighbour they share
  most boundary with (the crack between them is then not a break), no fracture has more than 44
  pieces, and a piece that would touch itself at a vertex has its smallest neighbour merged in.
  Cracks that stop inside a piece separate nothing and are dropped. The survivor is the largest
  piece that includes the base.
- **Piece sizes** follow from the energy: small pieces beside the impact where the ring and the
  radial cracks cross, large curved pieces further out where the cracks are far apart. For a
  strong blow the measured mean piece area near the impact is a fifth to a quarter of that far
  from it.
- **Watertight meshes.** Grid cells are clipped against the cells with a tagged
  Sutherland–Hodgman pass. Crossing points are computed in a canonical order so that both shards
  on either side of a crack get bit-identical vertices. The broken face of each crack segment is
  built once, with deterministic roughness that fades to nothing at its ends, and used by both
  neighbours with opposite winding.
- **Determinism.** The random stream is seeded from the reset seed and the quantised impact
  position, energy and direction. The unit tests check that repeated runs produce the same
  network, cells, crack graph and shard vertices, that the cells tile the bowl exactly once and are
  convex, that no two cracks cross, and that 40 random blows give closed shards with the right
  total volume.
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

## Testing

```bash
npm run typecheck
npm test
npm run test:e2e
```

- **Unit tests (Vitest, 62 tests).** Impact and hand: the severity model (rising with speed,
  ordered by contact, small for a glance, calibrated to the drop heights above), collision
  episodes judged once, the hand's smoothing, the release velocity fit, the servo, drawing between
  steps. Fracture: determinism of the whole network; cracks that never cross; a blow the other way
  round making different cracks; more length, branches, broken surface and pieces with more
  energy; a chip, a missing part and a smashed wall for light, medium and hard blows; the rim
  and the foot breaking differently; small pieces near the impact and large ones away from it;
  cells that tile the bowl once, convex, edge for edge; every shard a closed solid with positive
  volume and mass; the pieces adding up to the bowl; 40 random blows (rim, pole, any direction)
  all valid. Repair:
  resin stays within bounds and conserves volume, viscosity and temperature change the flow,
  curing, alignment with hysteresis, no bond between pieces that are apart or lack cured gold,
  a full repair ending as one piece, which pieces count as in place, a held piece guided to its
  own place rather than to a loose neighbour, and a brush stroke that carries on round a junction
  into closed cracks only. Recovery: what counts as off the table, and open places that never
  overlap.
- **Browser tests (Playwright, 24 tests).** Two check the fallback and run anywhere. Twenty-two
  need a real WebGPU adapter and are skipped when there is none: load and console, presets,
  fracture and full repair through the automation hook, determinism and reset, pause, orbit and
  zoom, a real strike, a real drop, picking up pieces and painting closed cracks with the pointer,
  the render quality levels, sliders and keyboard, and the phone sheet. Six handle the bowl with
  the real pointer: Strike stays armed for three balls and turns off with Escape and with its
  button; a gentle placement leaves the bowl whole; a hard throw downward breaks it from the
  contact it makes; a high drop breaks it where a low one does not, at the speed free fall gives;
  a sideways slide counts for little; a held bowl follows a steady pointer without jumps. Four
  mend by hand, with the pointer and nothing else: a piece let go about 2 cm off its place is drawn in, takes
  gold and bonds; one let go a hand's width away is left where it falls; the first visit to
  Repair shows its one line of guidance and drops it when a piece is picked up; and a piece
  pulled off the table is recovered without anything else moving. Locally they use the
  installed Chrome.
- **CI** runs type-check, unit tests and the build, plus the two fallback browser tests. Hosted
  runners have no GPU, so the WebGPU browser tests are not run there.

On the development machine (Windows 11, Chrome 154, Intel integrated GPU) all 62 unit tests and
all 24 browser tests pass.

Mending was also timed once, on the production build, in a session driven by mouse moves, presses
and the wheel alone: Strike bowl, a click on the bowl, a wait for the 14 pieces to lie still,
Repair, then one piece after another. Every piece seated on the first attempt after being let go
about 28 pixels off its place, within a few hundredths of a second of the pointer stopping. A
piece took 4 to 7 seconds to pick up, carry and seat, of which about 2 seconds was the scripted
pointer crossing the screen. Five pieces were seated, gilded and bonded 63 to 73 seconds after
entering Repair, and all 13 loose pieces of a bowl in just under three minutes, with one look
from above to reach the far wall. These are a script's timings on one laptop; no person was timed.

`window.__kintsugi` exposes a small automation surface used by the browser tests: `ready`,
`version`, `seed`, `state`, `stats`, `physics`, `reset()`, `fractureAt()`, `setMode()`,
`setMaterial()`, `setControl()`, `setQuality()`, `setPhysicsDebug()`, `paintCrack()`,
`alignAllForTest()`, `step()`, `getCracks()`, `getPieces()`, `getOverlaps()`,
`getFractureTimings()`, `getGpuInfo()`, `getScreenPoints()`, `getCamera()` and `probe()`.
`physics` holds the last impact and every one judged since the last reset (source, point, normal,
normal and tangential speed, effective mass, raw energy, concentration, severity, threshold, where
on the bowl, whether it broke), the speed of the hand, the last release, balls thrown and on the
table, the drawing interpolation, and the momentum check. `?debug` (or `setPhysicsDebug(true)`)
shows the same as a small read-out; a normal visitor never sees it.
Every method calls the same code the interface does, except `alignAllForTest()`, which puts every
piece back in its place and has no counterpart in the interface.

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
- Generating a fracture is a single hitch at the moment of impact, and its cost grows with the
  energy, since a harder blow means longer cracks. Run alone in Node, best of six per blow over 24
  varied blows, it took a median of 70–110 ms, 90% under 110–175 ms and none over 190 ms (a light
  blow 27–37 ms, a full-strength one 105–150 ms). Inside the page, on the production build,
  with the GPU busy drawing, the same code took a median of about 260 ms, 90% under about 370 ms
  and a worst of about 460 ms, roughly three times as long; the two stages (cutting the surface into
  pieces, and meshing the pieces) slowed alike, which points at the shared CPU and GPU of an
  integrated chip rather than at one function. The target of under 150 ms typically and 250 ms at
  worst was therefore met in Node and not in the page on this laptop. The way to get under it
  would be to run the generator in a worker.
- One fixed physics and repair step cost under 1 ms with everything at rest and 5–7.5 ms while all
  the pieces were moving.
- The canvas stays at device resolution at every level; only the scene is scaled. On this GPU the
  adaptive level therefore shows a 60% scene filtered up, which is softer than the fixed levels.
- The JavaScript bundle is 2.4 MB (0.9 MB gzipped). Almost all of it is Rapier's WebAssembly,
  which the `-compat` package embeds.

Nothing was measured on discrete GPUs, phones, Safari or Firefox.

## Limitations

- The fracture is a procedural crack network on the bowl's surface, extruded through the wall.
  Cracks run straight through the thickness, and there is no stress analysis: the network is a
  construction that looks and behaves like a brittle break, not a calculation of one.
- A bowl breaks once. Shards do not break again, though a steel ball or a falling piece will move
  them. After a very hard blow the foot is what is left standing; after a lighter one, more.
- A blow on the very centre of the underside has nowhere to put cracks (the disc there is one
  point in space) and falls back to the older power-diagram pattern, which looks like cells.
- A foot-first drop breaks the foot ring and sends some of the energy up the wall; how much is a
  tuning choice, not a measurement.
- Throws are limited by how fast a mouse moves: at this scale a quick flick is 10–15 units per
  second, so the foot breaks from a fall of about 6 cm and a hard throw is the fall plus the flick.
- The impact calibration (the fall heights above) is an interaction target and says nothing about
  how real porcelain behaves.
- Fracture generation takes 100–450 ms inside the page on this laptop, a visible hitch at the
  moment of impact.
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
