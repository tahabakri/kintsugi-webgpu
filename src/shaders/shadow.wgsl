// Light-space passes: the sun's shadow map, and a top-down height map used for ambient occlusion
// and contact shading.

@group(1) @binding(0) var<uniform> object: Object;

@vertex
fn shadowVertex(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return frame.lightViewProj * (object.model * vec4f(position, 1.0));
}

struct HeightOut {
  @builtin(position) clip: vec4f,
  @location(0) height: f32,
}

@vertex
fn heightVertex(@location(0) position: vec3f) -> HeightOut {
  let world = object.model * vec4f(position, 1.0);
  var out: HeightOut;
  out.clip = frame.aoViewProj * world;
  out.height = world.y;
  return out;
}

// Height above the table, seen from straight overhead. The target is cleared to the table's own
// height and blends with `max`, so each texel ends up holding the topmost surface.
@fragment
fn heightFragment(in: HeightOut) -> @location(0) vec4f {
  return vec4f(in.height, 0.0, 0.0, 1.0);
}
