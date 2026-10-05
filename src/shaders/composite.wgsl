// Final pass: add restrained bloom, compress highlights, encode to sRGB and dither.

struct CompositeParams {
  settings: vec4f, // x exposure, y bloom strength, z vignette, w time
  canvas: vec4f,   // xy size of one canvas pixel in uv, z how much larger than the canvas the scene was rendered
}

@group(0) @binding(0) var sceneTexture: texture_2d<f32>;
@group(0) @binding(1) var bloomTexture: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> params: CompositeParams;

struct FullscreenOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn fullscreenVertex(@builtin(vertex_index) index: u32) -> FullscreenOut {
  let xy = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  var out: FullscreenOut;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

// Film-like response: an exponential shoulder that rolls bright values off towards white without
// clipping, per channel so that strong highlights lose saturation the way they do on film.
fn filmic(x: vec3f) -> vec3f {
  return vec3f(1.0) - exp(-max(x, vec3f(0.0)));
}

fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(max(c, vec3f(0.0)), vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn hash(p: vec2f) -> f32 {
  var q = fract(vec3f(p.x, p.y, p.x) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// One tap of the scene for the resampling filters. Very bright values are held back so that a
// filter with negative lobes cannot ring round a highlight; the bloom carries what is cut.
fn tap(uv: vec2f) -> vec3f {
  return min(textureSampleLevel(sceneTexture, linearSampler, uv, 0.0).rgb, vec3f(9.0));
}

// The scene at a canvas pixel.
//  - Rendered larger than the canvas: four bilinear taps spread over the pixel's footprint filter
//    it down instead of letting detail alias.
//  - Rendered smaller, because the GPU could not keep up: a Catmull-Rom filter (nine bilinear
//    taps) brings it up, which keeps edges far crisper than stretching the canvas would.
fn scene(uv: vec2f) -> vec3f {
  let ratio = params.canvas.z;
  if (ratio > 1.01) {
    let o = params.canvas.xy * 0.25;
    return 0.25 * (tap(uv + vec2f(-o.x, -o.y)) + tap(uv + vec2f(o.x, -o.y)) + tap(uv + vec2f(-o.x, o.y)) + tap(uv + vec2f(o.x, o.y)));
  }
  if (ratio > 0.99) { return textureSampleLevel(sceneTexture, linearSampler, uv, 0.0).rgb; }

  let size = vec2f(textureDimensions(sceneTexture));
  let at = uv * size;
  let centre = floor(at - 0.5) + 0.5;
  let f = at - centre;
  let w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  let w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  let w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  let w3 = f * f * (-0.5 + 0.5 * f);
  let w12 = w1 + w2;
  let p0 = (centre - 1.0) / size;
  let p3 = (centre + 2.0) / size;
  let p12 = (centre + w2 / w12) / size;
  var sum = tap(vec2f(p0.x, p0.y)) * w0.x * w0.y + tap(vec2f(p12.x, p0.y)) * w12.x * w0.y + tap(vec2f(p3.x, p0.y)) * w3.x * w0.y;
  sum += tap(vec2f(p0.x, p12.y)) * w0.x * w12.y + tap(vec2f(p12.x, p12.y)) * w12.x * w12.y + tap(vec2f(p3.x, p12.y)) * w3.x * w12.y;
  sum += tap(vec2f(p0.x, p3.y)) * w0.x * w3.y + tap(vec2f(p12.x, p3.y)) * w12.x * w3.y + tap(vec2f(p3.x, p3.y)) * w3.x * w3.y;
  return max(sum, vec3f(0.0));
}

@fragment
fn fragmentMain(in: FullscreenOut) -> @location(0) vec4f {
  var colour = scene(in.uv);
  colour += textureSampleLevel(bloomTexture, linearSampler, in.uv, 0.0).rgb * params.settings.y;
  colour = filmic(colour * params.settings.x);

  // A gentle S-curve for depth, then a grade: shadows a touch cool, lights a touch warm.
  let shaped = colour * colour * (3.0 - 2.0 * colour);
  colour = mix(colour, shaped, 0.22);
  let luma = dot(colour, vec3f(0.2126, 0.7152, 0.0722));
  colour *= mix(vec3f(0.975, 0.995, 1.03), vec3f(1.02, 1.0, 0.965), smoothstep(0.05, 0.8, luma));
  colour = mix(vec3f(luma), colour, 1.05);

  // A breath of vignette keeps the eye on the bowl.
  let centred = in.uv - vec2f(0.5);
  colour *= 1.0 - params.settings.z * dot(centred, centred) * 1.6;

  var encoded = toSrgb(clamp(colour, vec3f(0.0), vec3f(1.0)));
  // Triangular dither, one LSB wide, hides banding in the soft wall gradients.
  let pixel = in.clip.xy;
  let noise = hash(pixel) + hash(pixel + vec2f(57.0, 113.0)) - 1.0;
  encoded += vec3f(noise / 255.0);
  return vec4f(encoded, 1.0);
}
