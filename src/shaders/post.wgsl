// Full-screen helpers: separable Gaussian blur, bloom prefilter and the final composite.

struct PostParams {
  direction: vec4f, // xy texel step for blurs, z threshold, w intensity
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;
@group(0) @binding(2) var<uniform> params: PostParams;

struct FullscreenOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOut {
  // One oversized triangle covers the viewport.
  let xy = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: FullscreenOut;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

@fragment
fn blurFragment(in: FullscreenOut) -> @location(0) vec4f {
  let delta = params.direction.xy;
  var sum = textureSampleLevel(source, sourceSampler, in.uv, 0.0) * 0.227027;
  sum += (textureSampleLevel(source, sourceSampler, in.uv + delta * 1.384615, 0.0)
        + textureSampleLevel(source, sourceSampler, in.uv - delta * 1.384615, 0.0)) * 0.316216;
  sum += (textureSampleLevel(source, sourceSampler, in.uv + delta * 3.230769, 0.0)
        + textureSampleLevel(source, sourceSampler, in.uv - delta * 3.230769, 0.0)) * 0.070270;
  return sum;
}

fn hashPost(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// How much of the sky each point of the table has hidden from it by what lies on and over it,
// worked out once per frame in the table's own plane from the top-down height map. Every texel
// of that map is a small patch of something, and what it hides is its form factor: nearly all for
// a shard a finger's width above the table, little for a rim a hand's breadth overhead.
// Here direction.xy is unused, z is the number of taps and w the half-width of the map in world units.
@fragment
fn tableOcclusionFragment(in: FullscreenOut) -> @location(0) vec4f {
  let taps = i32(params.direction.z);
  let toUv = 0.5 / params.direction.w;
  let radius = 0.95;
  let falloff = 1.7;
  // Each texel turns the tap pattern by its own angle; the blur that follows averages them.
  let turn = hashPost(floor(in.clip.xy)) * 6.2831853;
  var hidden = 0.0;
  for (var i = 0; i < taps; i++) {
    let t = (f32(i) + 0.5) / f32(taps);
    let r = radius * pow(t, falloff);
    let a = f32(i) * 2.39996323 + turn;
    let d = vec2f(cos(a), sin(a)) * r;
    let rise = textureSampleLevel(source, sourceSampler, in.uv + d * toUv, 0.0).r - 0.01;
    if (rise > 0.0) {
      let distance2 = r * r + rise * rise;
      let receive = rise / sqrt(distance2);
      hidden += receive * max(receive, 0.35) / distance2 * r * pow(t, falloff - 1.0);
    }
  }
  hidden *= 2.0 * falloff * radius / f32(taps);
  return vec4f(clamp(hidden, 0.0, 1.0), 0.0, 0.0, 1.0);
}

// Keeps only what is brighter than the threshold, with a soft knee, while downsampling.
@fragment
fn bloomPrefilterFragment(in: FullscreenOut) -> @location(0) vec4f {
  let texel = params.direction.xy;
  var colour = vec3f(0.0);
  colour += textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(-1.0, -1.0), 0.0).rgb;
  colour += textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(1.0, -1.0), 0.0).rgb;
  colour += textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(-1.0, 1.0), 0.0).rgb;
  colour += textureSampleLevel(source, sourceSampler, in.uv + texel * vec2f(1.0, 1.0), 0.0).rgb;
  colour *= 0.25;
  let brightness = max(colour.r, max(colour.g, colour.b));
  let threshold = params.direction.z;
  let knee = threshold * 0.5;
  let soft = clamp(brightness - threshold + knee, 0.0, 2.0 * knee);
  let weight = max(soft * soft / (4.0 * knee + 1e-4), brightness - threshold) / max(brightness, 1e-4);
  // Clamp fireflies so one hot texel cannot smear into a halo.
  return vec4f(min(colour * weight, vec3f(12.0)), 1.0);
}
