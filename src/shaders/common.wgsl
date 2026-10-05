// Shared by every pass: per-frame uniforms, hashing/noise, BRDF pieces and the procedural studio.

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  aoViewProj: mat4x4f,
  eye: vec4f,        // xyz camera position, w time (s)
  sunDir: vec4f,     // xyz direction towards the sun
  sunColor: vec4f,   // rgb radiance, w strength of the window gobo
  lightRight: vec4f, // basis of the plane perpendicular to the sun, for the gobo
  lightUp: vec4f,
  camRight: vec4f,
  camUp: vec4f,
  wall: vec4f,       // xyz wall normal (towards the room), w distance of the wall plane behind the origin
  viewport: vec4f,   // width, height, 1/width, 1/height
  glaze: vec4f,      // rgb glaze colour, a roughness
  glaze2: vec4f,     // rgb motif / secondary colour, a motif strength
  body: vec4f,       // rgb exposed ceramic body, a roughness
  preset: vec4f,     // x preset id, y crackle strength, z speckle amount, w grain amount
  misc: vec4f,       // x profile arc length, y exposure, z seam width, w reduced-motion flag
  quality: vec4f,    // x shadow filter taps, y shadow search taps, z ambient-occlusion taps, w 1 / shadow map size
  stage: vec4f,      // x table front edge (distance in front of the origin), y its bevel radius, z sun softness (penumbra per unit of gap), w 1 while mending
  meet: vec4f,       // xyz where a held piece's edge is about to close on its mate, w how far round that the cue reaches
}

@group(0) @binding(0) var<uniform> frame: Frame;

struct Object {
  model: mat4x4f,
  params: vec4f,     // x highlight, y per-object seed, z fade, w how nearly a held piece's edge has met its mate
}

const PI = 3.14159265359;
const TAU = 6.28318530718;

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn hash22(p: vec2f) -> vec2f {
  var q = fract(vec3f(p.x, p.y, p.x) * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

fn hash31(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q += dot(q, q.zyx + 31.32);
  return fract((q.x + q.y) * q.z);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y);
}

fn noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3f(1.0, 0.0, 0.0)), u.x),
        mix(hash31(i + vec3f(0.0, 1.0, 0.0)), hash31(i + vec3f(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(hash31(i + vec3f(0.0, 0.0, 1.0)), hash31(i + vec3f(1.0, 0.0, 1.0)), u.x),
        mix(hash31(i + vec3f(0.0, 1.0, 1.0)), hash31(i + vec3f(1.0, 1.0, 1.0)), u.x), u.y),
    u.z);
}

fn hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q += dot(q, q.yxz + 33.33);
  return fract((q.xxy + q.yxx) * q.zyx);
}

// Value noise together with its gradient: x is the value, yz its derivative with respect to p.
fn noise2d(p: vec2f) -> vec3f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash21(i);
  let b = hash21(i + vec2f(1.0, 0.0));
  let c = hash21(i + vec2f(0.0, 1.0));
  let d = hash21(i + vec2f(1.0, 1.0));
  let k1 = b - a;
  let k2 = c - a;
  let k4 = a - b - c + d;
  return vec3f(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2f(k1 + k4 * u.y, k2 + k4 * u.x));
}

// The same in three dimensions: x is the value, yzw the gradient.
fn noise3d(p: vec3f) -> vec4f {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let du = 6.0 * f * (1.0 - f);
  let a = hash31(i);
  let b = hash31(i + vec3f(1.0, 0.0, 0.0));
  let c = hash31(i + vec3f(0.0, 1.0, 0.0));
  let d = hash31(i + vec3f(1.0, 1.0, 0.0));
  let e = hash31(i + vec3f(0.0, 0.0, 1.0));
  let g = hash31(i + vec3f(1.0, 0.0, 1.0));
  let h = hash31(i + vec3f(0.0, 1.0, 1.0));
  let m = hash31(i + vec3f(1.0, 1.0, 1.0));
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + h;
  let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - h + m;
  let value = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  let gradient = du * vec3f(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4f(value, gradient);
}

// Two octaves: enough for the slow drifts of tone that only need to be smooth.
fn cloud2(p: vec2f) -> f32 {
  return 0.62 * noise2(p) + 0.38 * noise2(p * 2.03 + vec2f(17.3, 9.1));
}

fn fbm2(p: vec2f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    sum += amp * noise2(q);
    q = q * 2.03 + vec2f(17.3, 9.1);
    amp *= 0.5;
  }
  return sum;
}

fn fbm3(p: vec3f) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 3; i++) {
    sum += amp * noise3(q);
    q = q * 2.03 + vec3f(11.7, 5.3, 23.1);
    amp *= 0.5;
  }
  return sum;
}

// ---- Cook–Torrance pieces ---------------------------------------------------------------

fn distributionGGX(nDotH: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let a2 = a * a;
  let d = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d + 1e-6);
}

// Height-correlated Smith visibility (already divided by 4·N·L·N·V).
fn visibilitySmith(nDotV: f32, nDotL: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let gv = nDotL * sqrt(nDotV * nDotV * (1.0 - a * a) + a * a);
  let gl = nDotV * sqrt(nDotL * nDotL * (1.0 - a * a) + a * a);
  return 0.5 / max(gv + gl, 1e-5);
}

fn fresnelSchlick(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn fresnelRough(cosTheta: f32, f0: vec3f, roughness: f32) -> vec3f {
  return f0 + (max(vec3f(1.0 - roughness), f0) - f0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn sunSpecular(n: vec3f, v: vec3f, l: vec3f, roughness: f32, f0: vec3f) -> vec3f {
  let h = normalize(v + l);
  let nDotL = max(dot(n, l), 0.0);
  let nDotV = max(dot(n, v), 1e-3);
  let d = distributionGGX(max(dot(n, h), 0.0), roughness);
  let vis = visibilitySmith(nDotV, nDotL, roughness);
  return d * vis * fresnelSchlick(max(dot(v, h), 0.0), f0) * nDotL;
}

// ---- Procedural studio --------------------------------------------------------------------

// A rectangular softbox seen in direction `dir`; edges soften with roughness.
fn softbox(dir: vec3f, centre: vec3f, right: vec3f, up: vec3f, halfSize: vec2f, blur: f32) -> f32 {
  let c = dot(dir, centre);
  if (c <= 0.0) { return 0.0; }
  let p = vec2f(dot(dir, right), dot(dir, up)) / c;
  let edge = smoothstep(vec2f(0.0), vec2f(blur), halfSize - abs(p) + blur * 0.5);
  return edge.x * edge.y;
}

// Radiance of the studio in a given direction, for reflections. There is no HDRI: the sunlit
// table, the sunlit plaster wall behind it, a tall window on the sun's side that runs from just
// above the table to well overhead, a dim room behind the camera and a cool strip of fill
// opposite the window. Values are in the same units as the shaded scene, so a mirror shows the
// table as bright as the table is.
fn studioEnv(dir: vec3f, roughness: f32) -> vec3f {
  let blur = 0.05 + roughness * 1.3;
  let sun = frame.sunDir.xyz;
  let front = frame.wall.xyz;
  let sideways = normalize(cross(vec3f(0.0, 1.0, 0.0), sun));
  let toSun = normalize(vec3f(sun.x, 0.0, sun.z));

  let up = smoothstep(-0.20 - roughness * 0.5, 0.16 + roughness * 0.5, dir.y);
  // The table is brightest towards the window, where the reflection looks across its lit top.
  let table = vec3f(1.55, 1.38, 1.12) * mix(0.62, 1.0, smoothstep(-0.6, 0.7, dot(dir, toSun)));
  // The wall is bright where the sun rakes it; the room behind the camera is dim.
  let toWall = smoothstep(-0.30, 0.85, dot(dir, -front));
  let lit = vec3f(1.12, 1.0, 0.84) * mix(0.7, 1.1, smoothstep(-0.5, 0.9, dot(dir, toSun)));
  let room = mix(vec3f(0.22, 0.215, 0.21), lit, toWall);
  let ceiling = vec3f(0.5, 0.49, 0.48);
  var radiance = mix(table, mix(room, ceiling, smoothstep(0.5, 1.0, dir.y)), up);

  // Key: the window. Its glazing bars only read on very glossy surfaces, and nothing of it shows
  // below the table's horizon.
  let keyDir = normalize(toSun + vec3f(0.0, 0.34, 0.0) + front * 0.1);
  let keyRight = normalize(cross(vec3f(0.0, 1.0, 0.0), keyDir));
  let keyUp = cross(keyDir, keyRight);
  let key = softbox(dir, keyDir, keyRight, keyUp, vec2f(0.5, 0.56), blur) * smoothstep(-0.12, 0.06 + roughness * 0.3, dir.y);
  let pane = vec2f(dot(dir, keyRight), dot(dir, keyUp)) / max(dot(dir, keyDir), 1e-3);
  let sharp = 1.0 - smoothstep(0.0, 0.45, roughness);
  let barX = 1.0 - smoothstep(0.014, 0.04 + blur * 0.5, abs(pane.x - 0.05));
  let barY = 1.0 - smoothstep(0.012, 0.035 + blur * 0.5, abs(pane.y - 0.08));
  let bars = 1.0 - max(barX, barY) * 0.6 * sharp;
  radiance += vec3f(30.0, 26.5, 21.5) * key * bars / (1.0 + roughness * 3.2);

  // Fill: a tall narrow strip on the far side, slightly cool.
  let fillDir = normalize(-sideways * 0.92 + vec3f(0.0, 0.30, 0.0) + front * 0.25);
  let fillRight = normalize(cross(vec3f(0.0, 1.0, 0.0), fillDir));
  let fillUp = cross(fillDir, fillRight);
  radiance += vec3f(1.6, 1.78, 2.05) * softbox(dir, fillDir, fillRight, fillUp, vec2f(0.15, 0.7), blur) / (1.0 + roughness * 2.0);
  return radiance;
}

// Irradiance-like ambient term for diffuse surfaces: cool light from the room above, warm light
// thrown back up by the sunlit table and across from the wall.
fn ambientDiffuse(n: vec3f) -> vec3f {
  let sun = frame.sunDir.xyz;
  let front = frame.wall.xyz;
  let sky = vec3f(0.52, 0.525, 0.54);
  let bounce = vec3f(0.60, 0.52, 0.41);
  let hemi = mix(bounce, sky, n.y * 0.5 + 0.5);
  let fromWall = max(dot(n, -front), 0.0);
  let keySide = max(dot(n, normalize(sun + vec3f(0.0, 0.35, 0.0))), 0.0);
  return hemi + vec3f(0.115, 0.098, 0.075) * fromWall + vec3f(0.15, 0.135, 0.11) * keySide;
}

// Where the pattern of light and shade sits across the room: chosen so that the bowl stands in a
// bar of light with shade falling just behind it.
const GOBO_PHASE = 2.7;

// Sunlight reaches the scene through a slatted blind and whatever grows outside it: broad soft
// bars of light and shade that run across the wall along the light's own slant, broken up so that
// no two are alike. Returns the fraction of sun that gets through, 0…1.
fn gobo(world: vec3f) -> f32 {
  let strength = frame.sunColor.w;
  let sun = frame.sunDir.xyz;
  // Each slat throws a sheet of shadow that contains the sun's direction and the slat's own.
  // Slats lie roughly along the wall's normal, so on the wall the bars follow the light downwards.
  let slat = normalize(frame.wall.xyz * 0.94 + frame.lightRight.xyz * 0.2 + vec3f(0.0, 0.26, 0.0));
  let across = normalize(cross(slat, sun));
  let along = normalize(cross(sun, across));
  // The blind is not far away, so the bars are not quite parallel: they open out like a fan as
  // the light crosses the room.
  let reach = max(dot(world, -sun) + 11.0, 2.0);
  let c = dot(world, across) * 11.0 / reach;
  let a = dot(world, along);

  // Bars of three widths with soft, out-of-focus edges; their spacing drifts along their length.
  let drift = (noise2(vec2f(a * 0.22, c * 0.35)) - 0.5) * 0.9;
  let s = c * 1.04 + drift + GOBO_PHASE;
  let wide = smoothstep(0.28, 0.80, sin(s * 1.5 + 0.6) * 0.5 + 0.5);
  let mid = smoothstep(0.44, 0.92, sin(s * 3.6 + 2.1) * 0.5 + 0.5) * 0.82;
  let fine = smoothstep(0.56, 1.0, sin(s * 8.1 + a * 0.3 + 0.9) * 0.5 + 0.5) * 0.46;
  var shade = max(wide, max(mid, fine));
  // Leaves: irregular blots that close some gaps and open others.
  let blot = cloud2(vec2f(c * 0.9 + 3.0, a * 0.55 - 1.7) * 1.25);
  shade = clamp(shade + (blot - 0.47) * 1.1, 0.0, 1.0);
  shade = smoothstep(0.1, 0.9, shade);
  // The light is strongest where it enters and falls away across the room.
  let falloff = mix(1.12, 0.86, smoothstep(-6.0, 7.0, dot(world, frame.lightRight.xyz)));
  return (1.0 - strength * shade) * falloff;
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

// Surface gradient of a height function whose screen-space derivatives are (dhdx, dhdy), for a
// surface at `p` with normal `n`: the bump-mapping construction that needs no tangent frame.
fn bumpNormal(p: vec3f, n: vec3f, dhdx: f32, dhdy: f32, scale: f32) -> vec3f {
  let dpx = dpdx(p);
  let dpy = dpdy(p);
  let r1 = cross(dpy, n);
  let r2 = cross(n, dpx);
  let det = dot(dpx, r1);
  if (abs(det) < 1e-12) { return n; }
  let gradient = (r1 * dhdx + r2 * dhdy) / det;
  return normalize(n - gradient * scale);
}
