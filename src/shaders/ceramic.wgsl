// Glazed ceramic and its exposed fracture faces. Everything is procedural: the glaze detail is a
// function of the bowl's material coordinates, so it stays put on a shard when the bowl breaks.

@group(1) @binding(0) var<uniform> object: Object;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) kindAux: vec2f,
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) kindAux: vec2f,
}

@vertex
fn vertexMain(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = object.model * vec4f(in.position, 1.0);
  out.clip = frame.viewProj * world;
  out.world = world.xyz;
  out.normal = (object.model * vec4f(in.normal, 0.0)).xyz;
  out.uv = in.uv;
  out.kindAux = in.kindAux;
  return out;
}

/** Latitude of the painted band, and the distance once round the bowl there (world units). */
const BAND_CENTRE = 0.842;
const BAND_LENGTH = 9.9;
/** The band is painted sprig by sprig; this many cells go once round. */
const BAND_CELLS = 26.0;

// A stable 3D point for noise lookups, periodic in u.
fn materialPoint(uv: vec2f) -> vec3f {
  let a = uv.x * TAU;
  let rho = 0.35 + 1.35 * uv.y;
  return vec3f(cos(a) * rho, uv.y * 2.75, sin(a) * rho);
}

fn rotate2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x + s * p.y, -s * p.x + c * p.y);
}

// How much pigment a soft-edged shape leaves: 1 well inside, 0 outside, with an edge at least a
// pixel wide so that fine strokes thin out in the distance instead of crawling.
fn brush(distance: f32, feather: f32) -> f32 {
  return 1.0 - smoothstep(-feather, feather, distance);
}

// Distance to a brush stroke from a to b whose half-width runs from wa to wb.
fn strokeDistance(p: vec2f, a: vec2f, b: vec2f, wa: f32, wb: f32) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - a - ab * t) - mix(wa, wb, t);
}

// One plum blossom: five petals, no two the same, laid on as a wash that pools a little darker
// along each petal's edge, round a pale heart with a dark eye. Returns the pigment density in x
// and how much of what is underneath the blossom covers in y: paint goes over paint.
fn blossom(p: vec2f, radius: f32, turn: f32, seed: f32, feather: f32) -> vec2f {
  let q = rotate2(p, turn) / radius;
  let rho = length(q);
  if (rho > 1.35) { return vec2f(0.0); }
  let sector = TAU / 5.0;
  let theta = atan2(q.y, q.x);
  let index = floor(theta / sector + 0.5);
  let h = hash22(vec2f(index * 3.7 + seed * 17.3, seed * 5.1 + 1.3));
  // Each petal has its own length, breadth and lean.
  let t = theta - sector * index + (h.x - 0.5) * 0.26;
  let petal = vec2f(cos(t), sin(t)) * rho;
  let reach = 0.50 + 0.14 * h.y;
  // The outline is whatever the brush left: never quite an ellipse.
  let ragged = (noise2(vec2f(theta * 2.3 + seed * 7.0, rho * 3.1 + seed)) - 0.5) * 0.2;
  let d = length((petal - vec2f(reach + 0.04, 0.0)) / vec2f(reach, 0.30 + 0.12 * h.x)) - 1.0 + ragged;
  let f = feather / radius;
  let body = brush(d * 0.4, f);
  let pool = mix(0.74, 1.0, smoothstep(-0.45, -0.03, d));
  // The heart of the flower is left nearly bare, with a dark eye and a few flecks for stamens.
  let heart = 1.0 - 0.62 * (1.0 - smoothstep(0.12, 0.34, rho));
  let eye = brush(rho - 0.085, f);
  let half = sector * 0.5;
  let st = theta - half * floor(theta / half + 0.5);
  let stamen = brush(length(vec2f(cos(st), sin(st)) * rho - vec2f(0.27, 0.0)) - 0.04, f) * step(0.3, h.y);
  let density = max(pool * heart * (0.7 + 0.36 * h.y), max(eye, stamen * 0.9));
  return vec2f(density, max(body, eye));
}

// Height of the main branch above the band's centre line, x in world units round the bowl.
fn branchHeight(x: f32) -> f32 {
  let k = TAU / BAND_LENGTH;
  return 0.075 * sin(k * 3.0 * x + 0.4) + 0.042 * sin(k * 7.0 * x + 1.3) + 0.02 * sin(k * 13.0 * x + 4.2);
}

// Under-glaze cobalt brushwork round the upper wall: a wandering branch with twigs, blossoms and
// buds, every sprig different. `local` is in world units (x round the bowl, y up the wall from
// the band's centre line), `feather` the softness of an edge. Returns pigment density 0…1.
fn sakuraBand(local: vec2f, feather: f32) -> f32 {
  if (abs(local.y) > 0.5) { return 0.0; }
  // The hand is never quite steady.
  let wobble = vec2f(noise2(local * 21.0), noise2(local * 21.0 + vec2f(17.0, 5.0))) - 0.5;
  let p = local + wobble * 0.0065;
  let cellWidth = BAND_LENGTH / BAND_CELLS;
  let cell = floor(p.x / cellWidth);
  var ink = 0.0;

  // The branch: thicker where the brush was full, thinning and skipping where it ran dry.
  let by = branchHeight(p.x);
  let slope = (branchHeight(p.x + 0.01) - by) / 0.01;
  let load = noise2(vec2f(p.x * 1.9, 3.1));
  let dry = 0.62 + 0.38 * smoothstep(0.15, 0.6, noise2(vec2f(p.x * 6.3, 9.4)));
  ink = brush(abs(p.y - by) / sqrt(1.0 + slope * slope) - (0.009 + 0.011 * load), feather) * dry;

  for (var n = -1; n <= 1; n++) {
    let id = cell + f32(n);
    let wrapped = id - BAND_CELLS * floor(id / BAND_CELLS);
    for (var k = 0; k < 3; k++) {
      let key = vec2f(wrapped * 7.13 + f32(k) * 3.7, f32(k) * 11.9 + 2.3);
      let h = hash22(key);
      let h2 = hash22(key * 1.37 + vec2f(5.1, 8.3));
      let h3 = hash22(key * 2.11 + vec2f(1.7, 3.9));
      let side = select(-1.0, 1.0, h3.x > 0.5);
      let ax = (id + (f32(k) + 0.2 + 0.6 * h.x) / 3.0) * cellWidth;
      let anchor = vec2f(ax, branchHeight(ax));

      // A twig leaves the branch at its own angle and ends in a blossom, or in a bud or two.
      let lean = (h.y - 0.5) * 1.5;
      let length = 0.07 + 0.2 * h2.x * h2.x;
      let tip = anchor + vec2f(sin(lean), side * cos(lean)) * length;
      ink = max(ink, brush(strokeDistance(p, anchor, tip, 0.0085, 0.004), feather) * 0.9);
      if (h2.y > 0.3) {
        let radius = 0.07 + 0.055 * h3.y;
        let flower = blossom(p - tip - vec2f(sin(lean), side * cos(lean)) * radius * 0.55, radius, h.x * TAU, wrapped + f32(k) * 0.37, feather);
        ink = mix(ink, flower.x, flower.y);
      } else {
        ink = max(ink, brush(length2(p - tip) - (0.017 + 0.01 * h3.y), feather) * 0.95);
        let second = tip + vec2f(h3.x - 0.5, side * 0.6) * 0.07;
        ink = max(ink, brush(strokeDistance(p, tip, second, 0.004, 0.003), feather) * 0.85);
        ink = max(ink, brush(length2(p - second) - (0.011 + 0.008 * h.y), feather) * 0.9);
      }
      // Now and then a blossom sits right on the branch.
      if (h3.y > 0.5) {
        let onBranch = vec2f(ax + (h2.x - 0.5) * 0.2, 0.0);
        let radius = 0.06 + 0.045 * h.y;
        let flower = blossom(p - vec2f(onBranch.x, branchHeight(onBranch.x) - side * radius * 0.5), radius, h2.y * TAU, wrapped * 1.7 + 9.0 + f32(k), feather);
        ink = mix(ink, flower.x, flower.y);
      }
    }
  }
  return clamp(ink, 0.0, 1.0);
}

fn length2(p: vec2f) -> f32 {
  return length(p);
}

// A banding line drawn on the wheel: the brush wavers a little, and is darker where the line
// closes on itself. `v0` is the latitude, `width` the half-width in world units.
fn bandLine(uv: vec2f, v0: f32, width: f32, arc: f32, feather: f32) -> f32 {
  let waver = (noise2(vec2f(uv.x * 37.0, v0 * 91.0)) - 0.5) * 0.004;
  let weight = width * (0.8 + 0.4 * noise2(vec2f(uv.x * 11.0, v0 * 53.0)));
  let overlap = 1.0 + 0.25 * (1.0 - smoothstep(0.0, 0.03, abs(fract(uv.x + v0 * 3.1) - 0.5)));
  let tone = (0.74 + 0.26 * noise2(vec2f(uv.x * 23.0, v0 * 17.0))) * overlap;
  return brush(abs(uv.y - v0 + waver) * arc - weight, feather) * min(tone, 1.0);
}

// Crazing: the web of hairline cracks an old glaze grows as it ages. Cells of a 3D Voronoi
// pattern, so it has no seam and no stretch anywhere on the bowl; the value is small on a cell wall.
fn craze(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  var first = 8.0;
  var second = 8.0;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let g = vec3f(f32(x), f32(y), f32(z));
        let d = length(g + hash33(i + g) - f);
        if (d < first) { second = first; first = d; } else if (d < second) { second = d; }
      }
    }
  }
  return second - first;
}

struct Surface {
  albedo: vec3f,
  roughness: f32,
  f0: f32,
  occlusion: f32,
  normal: vec3f,
}

fn glazeSurface(in: VertexOut, n: vec3f, footprint: f32) -> Surface {
  var s: Surface;
  let preset = frame.preset.x;
  let kind = in.kindAux.x;
  let inner = kind > 0.5 && kind < 1.5;
  let rim = kind > 2.5;
  let uv = in.uv;
  let mp = materialPoint(uv);
  let arc = frame.misc.x;
  // Edges of the brushwork are never sharper than the image can show.
  let feather = max(0.0035, footprint * 0.9);

  var colour = frame.glaze.rgb;
  var rough = frame.glaze.a;
  s.f0 = 0.045;
  s.occlusion = 1.0;

  // Slow drifts of tone where the glaze lies thicker or thinner, and the odd pin-hole.
  let mottle = fbm3(mp * 2.1) - 0.5;
  let grain = noise3(mp * 60.0) - 0.5;
  colour *= 1.0 + mottle * 0.045 + grain * frame.preset.w * 0.05;
  rough += (noise3(mp * 9.0) - 0.5) * 0.04;
  let pin = smoothstep(0.94, 0.99, noise3(mp * 41.0 + vec3f(3.0))) * clamp(1.3 - footprint * 60.0, 0.0, 1.0);
  colour *= 1.0 - pin * 0.14;

  if (preset < 0.5) {
    // Porcelain: a warm white glaze over cobalt brushwork. The glaze gathers a little where the
    // wall turns into the foot, and is a breath cooler there.
    let gather = 1.0 - smoothstep(0.0, 0.06, abs(uv.y - 0.33));
    colour *= mix(vec3f(1.0), vec3f(0.955, 0.975, 0.985), gather * 0.6 + smoothstep(0.2, -0.3, mottle) * 0.15);

    var ink = 0.0;
    if (!inner && !rim) {
      ink = sakuraBand(vec2f(uv.x * BAND_LENGTH, (uv.y - BAND_CENTRE) * arc), feather);
      ink = max(ink, bandLine(uv, 0.9665, 0.0125, arc, feather));
      ink = max(ink, bandLine(uv, 0.9485, 0.0048, arc, feather) * 0.9);
      ink = max(ink, bandLine(uv, 0.2700, 0.0095, arc, feather));
      ink = max(ink, bandLine(uv, 0.2880, 0.0040, arc, feather) * 0.85);
    } else if (inner) {
      ink = bandLine(uv, 0.9700, 0.0065, arc, feather) * 0.8;
    }
    // Cobalt under the glaze works like a filter: thin washes stay clearly blue instead of
    // greying out. The pigment thins and pools unevenly along a stroke, and bleeds a little.
    let pigment = 0.74 + 0.36 * noise3(mp * 19.0) - 0.16 * noise3(mp * 63.0);
    let density = ink * pigment * frame.glaze2.a * 1.55;
    colour *= pow(frame.glaze2.rgb, vec3f(density));
    rough += ink * 0.025;
  } else if (preset < 1.5) {
    // Celadon: the glaze pools darker in hollows and breaks pale over edges.
    let hollow = (1.0 - smoothstep(0.0, 0.05, abs(uv.y - 0.325))) * 0.5 + select(0.0, 1.0 - smoothstep(0.0, 0.35, uv.y), inner) * 0.45;
    let thin = select(0.0, 0.8, rim) + smoothstep(0.975, 1.0, uv.y) * 0.5;
    colour = mix(colour, frame.glaze2.rgb, clamp(hollow, 0.0, 1.0));
    colour = mix(colour, vec3f(0.74, 0.72, 0.62), clamp(thin, 0.0, 1.0) * 0.6);
    colour *= 0.96 + 0.08 * fbm3(mp * 1.3);
    s.f0 = 0.055;
  } else if (preset < 2.5) {
    // Raku: smoke-black glaze with copper flashes from the firing.
    let flash = smoothstep(0.52, 0.78, fbm3(mp * 1.9 + vec3f(7.0)));
    let fleck = smoothstep(0.80, 0.93, noise3(mp * 23.0)) * frame.preset.z;
    let copper = mix(frame.glaze2.rgb, vec3f(0.30, 0.44, 0.38), smoothstep(0.55, 0.9, noise3(mp * 3.7)));
    colour = mix(colour, copper, clamp(flash * 0.55 + fleck, 0.0, 1.0));
    rough += flash * 0.16 + (noise3(mp * 5.0) - 0.5) * 0.14;
    s.f0 = mix(0.05, 0.22, clamp(flash * 0.6 + fleck, 0.0, 1.0));
  } else {
    // Terracotta: satin slip over burnt clay, with visible grog.
    let grog = smoothstep(0.7, 0.9, noise3(mp * 33.0));
    colour *= 0.92 + 0.16 * fbm3(mp * 3.1);
    colour = mix(colour, frame.glaze2.rgb, grog * 0.5 * frame.preset.z);
    rough += grog * 0.2 + grain * 0.1;
    // The foot is left unglazed.
    let bare = 1.0 - smoothstep(0.285, 0.31, uv.y);
    colour = mix(colour, frame.body.rgb * 1.05, bare * select(1.0, 0.0, inner));
    rough = mix(rough, 0.8, bare * select(1.0, 0.0, inner));
    s.f0 = 0.035;
  }

  // Crazing: hairlines in the glaze layer, stained by years of tea. A property of the glaze, not
  // of the fracture. Too fine to see from across the room; it comes up as the view moves in.
  let crackle = frame.preset.y;
  if (crackle > 0.0) {
    let scale = 6.4;
    let warp = noise3d(mp * 3.1).yzw * 0.22;
    let wall = craze(mp * scale + warp);
    let width = 0.011;
    let pixel = footprint * scale;
    let hairline = (1.0 - smoothstep(width, width + max(pixel, 0.006), wall)) * clamp(width * 2.6 / max(pixel, 1e-4), 0.0, 1.0);
    colour *= mix(vec3f(1.0), vec3f(0.69, 0.60, 0.47), hairline * crackle);
  }

  // The lip wears through to the body very slightly.
  if (rim) { colour = mix(colour, frame.body.rgb, 0.12 * sin(in.kindAux.y * PI)); }

  s.albedo = colour;
  s.roughness = clamp(rough, 0.06, 1.0);
  // The glaze is never optically flat: a slow waviness, and a finer orange peel over it.
  let bump = noise3d(mp * 5.5).yzw * 0.011 + noise3d(mp * 21.0).yzw * 0.0032;
  s.normal = normalize(n - bump);
  return s;
}

fn fractureSurface(in: VertexOut, n: vec3f) -> Surface {
  var s: Surface;
  let depth = in.kindAux.y; // 0 at the outer glaze, 1 at the inner glaze
  let mp = materialPoint(in.uv) * (1.0 - 0.06 * depth) + vec3f(0.0, depth * 0.11, 0.0);
  var colour = frame.body.rgb;
  // Chalky biscuit: soft blotches, grit and open pores.
  colour *= 0.88 + 0.22 * fbm3(mp * 9.0);
  let grit = noise3(mp * 85.0);
  colour *= 0.91 + 0.16 * grit;
  let pore = smoothstep(0.80, 0.94, noise3(mp * 96.0 + vec3f(5.0)));
  colour *= 1.0 - pore * 0.3;
  // The glaze is a thin glassy skin at both edges of the break.
  let skin = max(1.0 - smoothstep(0.0, 0.08, depth), 1.0 - smoothstep(0.0, 0.08, 1.0 - depth));
  colour = mix(colour, frame.glaze.rgb * 0.95, skin * 0.8);
  s.albedo = colour;
  s.roughness = mix(frame.body.a, frame.glaze.a + 0.08, skin * 0.85);
  s.f0 = mix(0.028, 0.045, skin);
  s.occlusion = mix(0.8, 1.0, 1.0 - pore) * mix(0.84, 1.0, abs(depth - 0.5) * 2.0);
  let bump = noise3d(mp * 38.0).yzw * 0.042;
  s.normal = normalize(n - bump * (1.0 - skin));
  return s;
}

@fragment
fn fragmentMain(in: VertexOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  // World size of a pixel here: used to keep fine painted detail from aliasing.
  let footprint = max(length(dpdx(in.world)), length(dpdy(in.world)));
  let kind = in.kindAux.x;
  let glazed = !(kind > 1.5 && kind < 2.5);
  var s: Surface;
  if (glazed) { s = glazeSurface(in, n, footprint); } else { s = fractureSurface(in, n); }

  let v = normalize(frame.eye.xyz - in.world);
  let l = frame.sunDir.xyz;
  let nDotV = max(dot(s.normal, v), 1e-3);
  let shadow = sunShadow(in.world, n);
  let through = gobo(in.world);
  let sun = frame.sunColor.rgb * shadow * through;
  let open = ambientOcclusion(in.world, n) * s.occlusion;

  // Body colour. The clay under the glaze scatters light a little way: the terminator is soft.
  let wrap = clamp((dot(s.normal, l) + 0.22) / 1.22, 0.0, 1.0);
  var colour = s.albedo * (ambientDiffuse(s.normal) * open + sun * wrap);
  // Pale ceramic lights itself: what one part hides of the sky, it largely gives back as its own
  // reflected light. This is what keeps the inside of a white bowl from going grey.
  let enclosed = 1.0 - open;
  colour += s.albedo * s.albedo * enclosed * (ambientDiffuse(vec3f(0.0, 1.0, 0.0)) * 0.55 + frame.sunColor.rgb * through * 0.2);
  // A thin wall lets a little of the sun on its far side through.
  if (glazed) { colour += s.albedo * frame.sunColor.rgb * through * max(dot(-s.normal, l), 0.0) * 0.045; }

  // The glaze: a clear glassy coat. Its highlight is the window, mirrored; where the wall or the
  // table is what it mirrors, that is what shows.
  let f0 = vec3f(s.f0);
  let r = reflect(-v, s.normal);
  let fresnel = fresnelRough(nDotV, f0, s.roughness);
  let facing = mix(0.45, 1.0, shadow) * mix(0.72, 1.0, through);
  colour += studioEnv(r, s.roughness) * fresnel * facing * mix(0.35, 1.0, open);
  // The sun itself, softened by the window it comes through.
  colour += sunSpecular(s.normal, v, l, max(s.roughness, 0.28), f0) * sun;

  // Hover highlight while a piece can be picked up.
  colour += vec3f(0.10, 0.085, 0.05) * object.params.x * pow(1.0 - nDotV, 2.0);
  // A piece that is being fitted, and the edge it is about to meet: the broken faces warm
  // faintly as they close, as if the gold were already there.
  let meeting = object.params.w;
  if (meeting > 0.0) {
    // Only round the place where the two will touch: the cue points, it does not light the piece.
    let near = 1.0 - smoothstep(0.4 * frame.meet.w, frame.meet.w, distance(in.world, frame.meet.xyz));
    colour += vec3f(0.95, 0.62, 0.2) * meeting * near * select(0.06 * pow(1.0 - nDotV, 2.0), 0.34, !glazed);
  }
  return vec4f(colour, 1.0);
}
