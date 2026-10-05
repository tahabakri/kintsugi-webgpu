// Dust motes thrown up by an impact, and the chips and powder a break leaves on the table:
// camera-facing instanced quads.

struct Instance {
  @location(0) positionSize: vec4f, // xyz world position, w radius
  @location(1) colourAlpha: vec4f,
  @location(2) shape: vec4f,        // x rotation, y 0 = dust mote / 1 = chip / 2 = powder grain, z per-particle seed
}

struct DustOut {
  @builtin(position) clip: vec4f,
  @location(0) corner: vec2f,
  @location(1) colourAlpha: vec4f,
  @location(2) shape: vec4f,
  @location(3) world: vec3f,
}

@vertex
fn vertexMain(@builtin(vertex_index) index: u32, instance: Instance) -> DustOut {
  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[index];
  let c = cos(instance.shape.x);
  let s = sin(instance.shape.x);
  let turned = vec2f(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
  let world = instance.positionSize.xyz
    + (frame.camRight.xyz * turned.x + frame.camUp.xyz * turned.y) * instance.positionSize.w;
  var out: DustOut;
  out.clip = frame.viewProj * vec4f(world, 1.0);
  out.corner = corner;
  out.colourAlpha = instance.colourAlpha;
  out.shape = instance.shape;
  out.world = world;
  return out;
}

@fragment
fn fragmentMain(in: DustOut) -> @location(0) vec4f {
  let d = length(in.corner);
  let kind = in.shape.y;
  let up = vec3f(0.0, 1.0, 0.0);
  var alpha = 0.0;
  var lit = ambientDiffuse(up) + frame.sunColor.rgb * gobo(in.world) * 0.55;
  if (kind < 0.5) {
    // A mote: soft, featureless.
    alpha = (1.0 - smoothstep(0.0, 1.0, d));
    alpha *= alpha;
  } else {
    if (kind < 1.5) {
      // A chip: an irregular angular flake.
      let angle = atan2(in.corner.y, in.corner.x);
      let facets = 0.62 + 0.2 * cos(angle * 3.0 + in.shape.z * 6.0) + 0.12 * cos(angle * 5.0 + in.shape.z * 11.0);
      alpha = 1.0 - smoothstep(facets - 0.08, facets, d);
    } else {
      // A grain of powder: a speck.
      alpha = 1.0 - smoothstep(0.35, 1.0, d);
    }
    // Debris lies on the table and is lit and shaded as the table is; a chip has a lit side.
    let facing = 0.55 + 0.3 * dot(normalize(in.corner + vec2f(1e-4)), vec2f(-0.7, 0.7)) * step(kind, 1.5);
    let shade = sunShadow(in.world, up);
    lit = ambientDiffuse(up) * (1.0 - min(tableOcclusion(in.world), 0.8)) + frame.sunColor.rgb * gobo(in.world) * shade * facing;
  }
  alpha *= in.colourAlpha.a;
  if (alpha < 0.004) { discard; }
  // Premultiplied alpha.
  return vec4f(in.colourAlpha.rgb * lit * alpha, alpha);
}
