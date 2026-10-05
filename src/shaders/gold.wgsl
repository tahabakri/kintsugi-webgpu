// Gold resin along the crack network. The geometry is static per fracture; how much of it shows
// is driven every frame by the resin simulation through two storage buffers.

@group(1) @binding(0) var<uniform> object: Object;
@group(2) @binding(0) var<storage, read> resin: array<vec4f>; // per sample: fill, cure, temperature, flow
@group(2) @binding(1) var<storage, read> edges: array<vec4f>; // per edge: show side A, show side B, mated, ready

struct SeamIn {
  @location(0) centre: vec3f,   // point on the crack, in the owning shard's frame
  @location(1) binormal: vec3f, // across the crack, along the surface
  @location(2) normal: vec3f,   // surface normal (bead) or face normal (film)
  @location(3) profile: vec2f,  // cos / sin around the bead's cross-section
  @location(4) ids: vec4f,      // sample index, edge index, side (0 = A, 1 = B), part
}

struct SeamOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) state: vec4f,    // cure, ready, part, temperature
  @location(3) local: vec3f,    // position in the shard's frame, for texture that travels with it
  @location(4) shape: vec2f,    // height on the bead (0 where it meets the glaze, 1 on its crest), fill
}

// part: 0 bead on the outer skin, 1 bead on the inner skin, 2 film on the fracture face,
//       3 hairline marking an unfilled crack between two mated shards.

fn noise1(x: f32) -> f32 {
  let i = floor(x);
  let f = fract(x);
  return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f));
}

@vertex
fn vertexMain(in: SeamIn) -> SeamOut {
  var out: SeamOut;
  let s = resin[u32(in.ids.x)];
  let e = edges[u32(in.ids.y)];
  let part = in.ids.w;
  let sideShown = select(e.x, e.y, in.ids.z > 0.5);
  let fill = s.x;
  let wet = step(0.02, fill);

  var local = in.centre;
  var n = in.normal;
  var crest = 1.0;
  if (part < 1.5) {
    // A raised bead of lacquer and gold. It is laid on by hand, so its width wanders along the
    // seam; liquid, it stands tall and round, and as it cures it settles a little flatter.
    let amount = smoothstep(0.02, 0.45, fill) * sideShown;
    let along = in.ids.x * 0.31 + in.ids.y * 5.3;
    let wander = 0.7 + 0.66 * noise1(along) * (0.62 + 0.38 * noise1(along * 3.3 + 9.0));
    let width = frame.misc.z * amount * wander;
    let height = width * mix(0.66, 0.47, s.y);
    local += in.binormal * (width * 0.5 * in.profile.x) + in.normal * (height * (in.profile.y - 0.12) - (1.0 - amount) * 0.004);
    n = normalize(in.binormal * (in.profile.x * height) + in.normal * (in.profile.y * width * 0.5) + in.normal * 1e-4);
    crest = in.profile.y;
  } else if (part < 2.5) {
    // A skin of resin on the broken face of a separated shard. For film vertices `binormal`
    // holds the way to the middle of the wall: with nothing to show, the strip folds shut there.
    let shown = wet * sideShown * (1.0 - e.z);
    local += mix(in.binormal - in.normal * 0.01, in.normal * 0.006, shown);
  } else {
    let shown = (1.0 - wet) * e.z * sideShown;
    local += in.binormal * (mix(0.0052, 0.0085, frame.stage.w) * shown * in.profile.x) + in.normal * mix(-0.01, 0.0016, shown);
  }

  let world = object.model * vec4f(local, 1.0);
  out.clip = frame.viewProj * world;
  out.world = world.xyz;
  out.normal = (object.model * vec4f(n, 0.0)).xyz;
  out.state = vec4f(s.y, e.w, part, s.z);
  out.local = local;
  out.shape = vec2f(crest, fill);
  return out;
}

@fragment
fn fragmentMain(in: SeamOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  var n = normalize(in.normal);
  if (!front) { n = -n; }
  let cure = in.state.x;
  let ready = in.state.y;
  let part = in.state.z;

  if (part > 2.5) {
    // An open hairline: a fine, soft, dark thread, as an unfilled crack looks in a pale glaze.
    // While the bowl is being mended a closed crack shows a first thread of gold instead: this
    // is where the brush goes next.
    let thread = mix(vec3f(0.2, 0.165, 0.13), vec3f(0.74, 0.5, 0.17), frame.stage.w);
    return vec4f(thread * ambientDiffuse(n), 1.0);
  }
  let film = part > 1.5;
  // How far up the bead this is: its foot sits in the shade of its own shoulder.
  let rise = select(smoothstep(0.0, 0.55, clamp(in.shape.x, 0.0, 1.0)), 0.75, film);

  // Liquid, the resin is a smooth swollen bead, a shade redder where the lacquer shows through.
  // Cured and burnished, the gold powder has a fine grain that scatters the highlight along
  // the seam and a deeper, cleaner colour.
  let grainAt = in.local * 190.0;
  let grain = vec3f(noise3(grainAt), noise3(grainAt + vec3f(17.0, 3.0, 9.0)), noise3(grainAt + vec3f(5.0, 23.0, 11.0))) - 0.5;
  n = normalize(n + grain * mix(0.035, 0.19, cure));
  let roughness = mix(0.075, 0.185, cure) + select(0.0, 0.12, film);
  let f0 = mix(vec3f(0.98, 0.66, 0.30), vec3f(1.0, 0.76, 0.33), cure);

  let v = normalize(frame.eye.xyz - in.world);
  let l = frame.sunDir.xyz;
  let shadow = sunShadow(in.world, n);
  let through = gobo(in.world);
  let sun = frame.sunColor.rgb * shadow * through;
  let nDotV = max(dot(n, v), 1e-3);
  let r = reflect(-v, n);

  // Gold keeps its colour towards grazing angles; letting Fresnel run all the way to white
  // would turn thin seams silver along their edges.
  let grazing = mix(f0, vec3f(1.0), 0.25);
  let fresnel = f0 + (grazing - f0) * pow(1.0 - nDotV, 5.0);
  let facing = mix(0.5, 1.0, shadow) * mix(0.75, 1.0, through);
  var colour = studioEnv(r, roughness) * fresnel * facing * mix(0.28, 1.0, rise);
  colour += sunSpecular(n, v, l, max(roughness, 0.16), f0) * sun * 1.3;
  // Under the gold is lacquer: a dark warm ground that shows at the foot of the bead and keeps
  // a seam in shadow from going black.
  let ground = vec3f(0.30, 0.165, 0.04) * mix(1.0, 0.55, rise);
  colour += ground * (ambientDiffuse(n) * 0.5 + sun * max(dot(n, l), 0.0) * 0.4);
  // Seams whose two sides are aligned and ready to bond catch a little more light.
  colour *= 1.0 + 0.22 * ready * (1.0 - cure);
  return vec4f(colour, 1.0);
}
