// Shadow map, contact shading and ambient occlusion for the passes that shade the scene.

@group(0) @binding(1) var shadowMap: texture_depth_2d;
@group(0) @binding(2) var shadowSampler: sampler_comparison;
@group(0) @binding(3) var occlusionMap: texture_2d<f32>;
@group(0) @binding(4) var linearSampler: sampler;
@group(0) @binding(5) var heightMap: texture_2d<f32>;

// Point i of n on a sunflower spiral over the unit disc: even coverage for any n.
fn spiral(i: i32, n: i32) -> vec2f {
  let r = sqrt((f32(i) + 0.5) / f32(n));
  let a = f32(i) * 2.39996323;
  return vec2f(cos(a), sin(a)) * r;
}

// World depth of the sun's shadow frustum, and the widest penumbra as a fraction of the map.
const SHADOW_DEPTH_RANGE = 41.0;
const SHADOW_WORLD_WIDTH = 14.4;
const PENUMBRA_MAX = 0.016;

// Sun visibility with a penumbra that widens with the distance to whatever casts the shadow:
// crisp where an object touches the table, soft where its shadow has travelled.
fn sunShadow(world: vec3f, normal: vec3f) -> f32 {
  let nDotL = dot(normal, frame.sunDir.xyz);
  // Push the lookup off the surface, more at grazing angles, to keep acne away without peter-panning.
  let offset = normal * (0.014 + 0.045 * (1.0 - clamp(nDotL, 0.0, 1.0)));
  let clip = frame.lightViewProj * vec4f(world + offset, 1.0);
  let uv = clip.xy * vec2f(0.5, -0.5) + 0.5;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0 || clip.z >= 1.0) { return 1.0; }
  let depth = clip.z - 0.0005;
  let texel = frame.quality.w;
  let size = 1.0 / texel;

  // How far away, on average, are the things between this point and the sun?
  let searchTaps = i32(frame.quality.y);
  var blockers = 0.0;
  var blockerDepth = 0.0;
  for (var i = 0; i < searchTaps; i++) {
    let at = uv + spiral(i, searchTaps) * PENUMBRA_MAX;
    let d = textureLoad(shadowMap, vec2i(clamp(at, vec2f(0.0), vec2f(0.9999)) * size), 0);
    if (d < depth) {
      blockers += 1.0;
      blockerDepth += d;
    }
  }
  if (blockers < 0.5) { return 1.0; }
  let gap = (depth - blockerDepth / blockers) * SHADOW_DEPTH_RANGE;
  let radius = clamp(gap * frame.stage.z / SHADOW_WORLD_WIDTH, 1.3 * texel, PENUMBRA_MAX);

  let taps = i32(frame.quality.x);
  var lit = 0.0;
  for (var i = 0; i < taps; i++) {
    lit += textureSampleCompareLevel(shadowMap, shadowSampler, uv + spiral(i, taps) * radius, depth);
  }
  return lit / f32(taps);
}

// How much of the sky is hidden from a point of the table by what lies on it and over it: 0 in
// the open, towards 1 underneath things. Worked out in the table's plane once per frame.
fn tableOcclusion(world: vec3f) -> f32 {
  let clip = frame.aoViewProj * vec4f(world, 1.0);
  let uv = clip.xy * vec2f(0.5, -0.5) + 0.5;
  if (uv.x <= 0.0 || uv.x >= 1.0 || uv.y <= 0.0 || uv.y >= 1.0) { return 0.0; }
  return textureSampleLevel(occlusionMap, linearSampler, uv, 0.0).r;
}

// Height of the topmost surface above a point of the table, from the top-down height map.
fn heightAbove(xz: vec2f) -> f32 {
  let clip = frame.aoViewProj * vec4f(xz.x, 0.0, xz.y, 1.0);
  let uv = clip.xy * vec2f(0.5, -0.5) + 0.5;
  return textureSampleLevel(heightMap, linearSampler, uv, 0.0).r;
}

// Ambient occlusion from the height map. Every texel is treated as a small patch of whatever is
// lying there, seen from below or from the side, and what it hides of the sky is its form factor:
// large for a shard a finger's width above the table, slight for a rim a hand's breadth overhead.
// Taps crowd towards the centre, where contact shading lives. Surfaces that face down see the
// table instead, and darken as they come close to it. Returns the fraction of ambient that arrives.
const OCCLUSION_RADIUS = 0.85;
const OCCLUSION_FALLOFF = 1.6;

fn ambientOcclusion(world: vec3f, normal: vec3f) -> f32 {
  let taps = i32(frame.quality.z);
  var hidden = 0.0;
  for (var i = 0; i < taps; i++) {
    let t = (f32(i) + 0.5) / f32(taps);
    let r = OCCLUSION_RADIUS * pow(t, OCCLUSION_FALLOFF);
    let a = f32(i) * 2.39996323;
    let d = vec2f(cos(a), sin(a)) * r;
    let rise = heightAbove(world.xz + d) - world.y - 0.02;
    if (rise > 0.0) {
      let distance2 = r * r + rise * rise;
      let towards = vec3f(d.x, rise, d.y) / sqrt(distance2);
      let receive = max(dot(towards, normal), 0.0);
      let emit = max(rise / sqrt(distance2), 0.35);
      // Area of the ring this tap stands for, over pi.
      hidden += receive * emit / distance2 * r * pow(t, OCCLUSION_FALLOFF - 1.0);
    }
  }
  hidden *= 2.0 * OCCLUSION_FALLOFF * OCCLUSION_RADIUS / f32(taps);
  let sky = 1.0 - clamp(hidden * 1.15, 0.0, 0.8);
  let ground = 1.0 - 0.55 * exp(-max(world.y, 0.0) * 3.4);
  return mix(ground, sky, clamp(normal.y * 1.5 + 0.35, 0.0, 1.0));
}
