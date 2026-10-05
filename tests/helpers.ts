import type { MeshData } from '../src/fracture/mesh-assembler';
import { VERTEX_FLOATS } from '../src/fracture/mesh-assembler';

/**
 * Checks that a triangle mesh is a closed, consistently oriented surface: after welding vertices
 * that share a position, every directed edge must be matched by exactly one opposite edge.
 */
export function closedness(mesh: MeshData): { open: number; nonManifold: number; triangles: number } {
  const ids = new Map<string, number>();
  const weld = new Int32Array(mesh.vertices.length / VERTEX_FLOATS);
  for (let i = 0; i < weld.length; i++) {
    const o = i * VERTEX_FLOATS;
    const key = `${mesh.vertices[o]},${mesh.vertices[o + 1]},${mesh.vertices[o + 2]}`;
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    weld[i] = id;
  }
  const edges = new Map<number, number>();
  const size = ids.size + 1;
  let triangles = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = weld[mesh.indices[i]], b = weld[mesh.indices[i + 1]], c = weld[mesh.indices[i + 2]];
    if (a === b || b === c || a === c) continue; // collapsed at the pole
    triangles++;
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = p * size + q;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  let open = 0, nonManifold = 0;
  for (const [key, count] of edges) {
    const p = Math.floor(key / size), q = key % size;
    if (count > 1) nonManifold++;
    if (!edges.has(q * size + p)) open++;
  }
  return { open, nonManifold, triangles };
}

export function allFinite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}
