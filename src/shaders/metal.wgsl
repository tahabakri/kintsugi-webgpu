// Polished dark steel for the striker ball.

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
  @location(2) local: vec3f,
}

@vertex
fn vertexMain(in: VertexIn) -> VertexOut {
  var out: VertexOut;
  let world = object.model * vec4f(in.position, 1.0);
  out.clip = frame.viewProj * world;
  out.world = world.xyz;
  out.normal = (object.model * vec4f(in.normal, 0.0)).xyz;
  out.local = in.position;
  return out;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  var n = normalize(in.normal);
  // Machining marks: faint, so the ball reads as steel rather than chrome.
  let brushed = noise3(in.local * vec3f(180.0, 30.0, 180.0)) - 0.5;
  let roughness = clamp(0.18 + brushed * 0.07, 0.08, 0.5);
  n = normalize(n + vec3f(brushed) * 0.02);
  let f0 = vec3f(0.42, 0.43, 0.45);

  let v = normalize(frame.eye.xyz - in.world);
  let l = frame.sunDir.xyz;
  let shadow = sunShadow(in.world, n);
  let sun = frame.sunColor.rgb * shadow * gobo(in.world);
  let nDotV = max(dot(n, v), 1e-3);
  let r = reflect(-v, n);
  // The table below is close and bright; let it into downward reflections.
  var env = studioEnv(r, roughness);
  let tableMix = smoothstep(0.1, -0.5, r.y);
  env = mix(env, vec3f(0.66, 0.60, 0.52) * (0.55 + 0.6 * shadow), tableMix * 0.8);
  var colour = sunSpecular(n, v, l, max(roughness, 0.2), f0) * sun;
  colour += env * fresnelRough(nDotV, f0, roughness) * mix(0.55, 1.0, shadow);
  return vec4f(colour, 1.0);
}
