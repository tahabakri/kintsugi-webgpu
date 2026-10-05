// The studio itself: a table block with a fine mineral finish, a hand-trowelled plaster wall
// behind it and the floor beneath. All of the texture is computed here.
// kind: 0 table top (and the upper half of its rounded edge), 1 table front, 2 wall, 3 floor.

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
  out.normal = in.normal;
  out.uv = in.uv;
  out.kindAux = in.kindAux;
  return out;
}

// An octave of grit with its slope: x is the height, yz its derivative across the surface. It
// fades out as its grains become smaller than a pixel, so the texture never turns into shimmer
// in the distance.
fn grit(q: vec2f, frequency: f32, footprint: f32) -> vec3f {
  let visible = clamp(1.5 - footprint * frequency * 1.6, 0.0, 1.0);
  if (visible <= 0.0) { return vec3f(0.0); }
  let n = noise2d(q * frequency);
  return vec3f(n.x - 0.5, n.yz * frequency) * visible;
}

// Slow swells with their slope: three octaves of the same.
fn swell(q: vec2f) -> vec3f {
  let n0 = noise2d(q);
  let n1 = noise2d(q * 2.03 + vec2f(17.3, 9.1));
  let n2 = noise2d(q * 4.12 + vec2f(5.7, 23.4));
  return vec3f(0.5 * n0.x + 0.25 * n1.x + 0.125 * n2.x - 0.44, 0.5 * n0.yz + 0.25 * 2.03 * n1.yz + 0.125 * 4.12 * n2.yz);
}

// The table's surface in world units, height and slope: a sandy tooth over slow, shallow swells.
fn tableRelief(q: vec2f, footprint: f32) -> vec3f {
  let tooth = grit(q, 36.0, footprint) + grit(q + vec2f(3.7, 1.1), 83.0, footprint) * 0.55 + grit(q + vec2f(9.2, 5.5), 180.0, footprint) * 0.3;
  let s = swell(q * 2.3);
  return tooth * 0.0019 + vec3f(s.x, s.yz * 2.3) * 0.009;
}

// The plaster: wide sweeps left by the trowel, and a much finer tooth.
fn wallRelief(q: vec2f, footprint: f32) -> vec3f {
  // The sweeps run on a slant: w = M q, so the slope comes back through M's transpose.
  let w = vec2f(q.x * 0.8 + q.y * 0.5, q.y * 2.2 - q.x * 0.25) + vec2f(5.0, 1.0);
  let s = swell(w);
  let sweep = vec3f(s.x, s.y * 0.8 - s.z * 0.25, s.y * 0.5 + s.z * 2.2);
  let tooth = grit(q, 44.0, footprint) + grit(q + vec2f(4.1, 2.3), 101.0, footprint) * 0.5;
  return sweep * 0.016 + tooth * 0.0007;
}

@fragment
fn fragmentMain(in: VertexOut) -> @location(0) vec4f {
  let kind = in.kindAux.x;
  let p = in.world;
  let geometric = normalize(in.normal);
  let footprint = max(length(dpdx(p)), length(dpdy(p)));
  let front = frame.wall.xyz;
  let side = cross(vec3f(0.0, 1.0, 0.0), front);
  let across = dot(p, side);
  let ahead = dot(p, front);

  // Surface coordinates in world units. On the table they run over the top, round the softened
  // edge and down the front without a break.
  let bevel = frame.stage.y;
  let flat = frame.stage.x - bevel;
  var along = ahead;
  if (ahead > flat) {
    if (p.y > -bevel) { along = flat + bevel * atan2(ahead - flat, p.y + bevel); }
    else { along = flat + bevel * 1.5708 - bevel - p.y; }
  }

  var albedo = vec3f(0.0);
  var occlusion = 1.0;
  var n = geometric;
  if (kind < 1.5) {
    // Table: pale mineral render. Broad clouds of tone, a sandy tooth, the odd open pore.
    let q = vec2f(across, along);
    albedo = vec3f(0.865, 0.83, 0.788);
    let cloud = cloud2(q * 0.42 + vec2f(4.0, 1.0));
    let blotch = cloud2(q * 2.1 + vec2f(1.0, 8.0));
    albedo *= 0.915 + 0.11 * cloud + 0.055 * blotch;
    albedo = mix(albedo, albedo * vec3f(1.025, 1.0, 0.955), noise2(q * 1.3 + vec2f(7.0, 3.0)));
    let pore = smoothstep(0.76, 0.9, noise2(q * 52.0 + vec2f(2.0, 9.0))) * clamp(1.4 - footprint * 80.0, 0.0, 1.0);
    let relief = tableRelief(q, footprint);
    albedo *= 1.0 + relief.x * 9.0 - pore * 0.1;
    n = normalize(geometric - side * relief.y + cross(geometric, side) * relief.z);

    // It darkens softly into the corner with the wall, and under and between whatever is on it.
    let toWall = ahead + frame.wall.w;
    occlusion *= 1.0 - 0.26 * exp(-max(toWall, 0.0) * 1.7);
    if (kind < 0.5) {
      occlusion *= 1.0 - min(tableOcclusion(p) * 1.12, 0.84);
    } else {
      occlusion *= mix(0.66, 1.0, smoothstep(-1.6, 0.0, p.y));
    }
  } else if (kind < 2.5) {
    // Wall: lime plaster laid on by hand. Wide sweeps of the trowel, slow drifts of tone.
    let q = vec2f(across, p.y);
    albedo = vec3f(0.835, 0.798, 0.76);
    let cloud = cloud2(q * 0.34 + vec2f(9.0, 2.0));
    let stain = cloud2(q * 1.45 + vec2f(2.0, 5.0));
    albedo *= 0.90 + 0.13 * cloud + 0.05 * stain;
    let relief = wallRelief(q, footprint);
    albedo *= 1.0 + relief.x * 2.2;
    n = normalize(geometric - side * relief.y - cross(geometric, side) * relief.z);
    // Darkens into the corner with the table and behind anything that stands close to it.
    occlusion *= 1.0 - 0.3 * exp(-max(p.y, 0.0) * 1.8);
    occlusion *= 1.0 - 0.45 * tableOcclusion(vec3f(p.x, 0.0, p.z) + front * 0.3) * exp(-max(p.y, 0.0) * 1.2);
  } else {
    albedo = vec3f(0.42, 0.39, 0.35) * (0.9 + 0.2 * fbm2(p.xz * 0.5));
    occlusion = 0.6;
  }

  let l = frame.sunDir.xyz;
  let shadow = sunShadow(p, geometric);
  let sun = frame.sunColor.rgb * shadow * gobo(p) * max(dot(n, l), 0.0);
  var ambient = ambientDiffuse(n) * occlusion;
  // The sunlit table throws warm light back onto the foot of the wall.
  if (kind > 1.5 && kind < 2.5) { ambient += vec3f(0.11, 0.09, 0.064) * exp(-max(p.y, 0.0) * 0.55); }
  return vec4f(albedo * (ambient + sun), 1.0);
}
