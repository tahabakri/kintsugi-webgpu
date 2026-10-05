import { STAGE } from '../config';
import { VERTEX_FLOATS, type MeshData } from '../fracture/mesh-assembler';
import { cross3, type Vec3 } from '../math/vec';

export interface GpuMesh {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
}

export function uploadMesh(device: GPUDevice, data: MeshData, label: string): GpuMesh {
  const vertexBuffer = device.createBuffer({
    label: `${label} vertices`,
    size: Math.max(VERTEX_FLOATS * 4, data.vertices.byteLength),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const indexBuffer = device.createBuffer({
    label: `${label} indices`,
    size: Math.max(12, data.indices.byteLength),
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(vertexBuffer, 0, data.vertices as Float32Array<ArrayBuffer>);
  device.queue.writeBuffer(indexBuffer, 0, data.indices as Uint32Array<ArrayBuffer>);
  return { vertexBuffer, indexBuffer, indexCount: data.indices.length };
}

export function destroyMesh(mesh: GpuMesh): void {
  mesh.vertexBuffer.destroy();
  mesh.indexBuffer.destroy();
}

class Builder {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];

  vertex(p: Vec3, n: Vec3, kind: number): number {
    this.vertices.push(p[0], p[1], p[2], n[0], n[1], n[2], 0, 0, kind, 0);
    return this.vertices.length / VERTEX_FLOATS - 1;
  }

  quad(a: number, b: number, c: number, d: number): void {
    this.indices.push(a, b, c, a, c, d);
  }

  build(): MeshData {
    return { vertices: new Float32Array(this.vertices), indices: new Uint32Array(this.indices) };
  }
}

/** Direction from the stage towards the default camera, i.e. the back wall's normal. */
export function stageFront(): Vec3 {
  return [Math.sin(STAGE.azimuth), 0, Math.cos(STAGE.azimuth)];
}

/**
 * The static studio: a table block with a softened front edge standing against a plaster wall,
 * and the floor below. Vertex `kind` selects the material in floor.wgsl:
 * 0 table top, 1 table front, 2 wall, 3 floor.
 */
export function buildStudioMesh(): MeshData {
  const b = new Builder();
  const front = stageFront();
  const side = cross3([0, 1, 0], front);
  const place = (s: number, f: number, y: number): Vec3 => [side[0] * s + front[0] * f, y, side[2] * s + front[2] * f];
  const W = STAGE.tableHalfWidth, bevel = STAGE.tableBevel, edge = STAGE.tableFront;

  // Cross-section from the wall forwards and down the front: [distance in front, y, normal forwards, normal up, kind].
  const section: Array<[number, number, number, number, number]> = [[-STAGE.wallDistance, 0, 0, 1, 0], [edge - bevel, 0, 0, 1, 0]];
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    section.push([edge - bevel + bevel * Math.sin(a), -bevel + bevel * Math.cos(a), Math.sin(a), Math.cos(a), i <= steps / 2 ? 0 : 1]);
  }
  section.push([edge, STAGE.floorY, 1, 0, 1]);
  const rows = section.map(([f, y, nf, ny, kind]) => {
    const normal: Vec3 = [front[0] * nf, ny, front[2] * nf];
    return [b.vertex(place(-W, f, y), normal, kind), b.vertex(place(W, f, y), normal, kind)];
  });
  for (let j = 0; j < rows.length - 1; j++) b.quad(rows[j][0], rows[j + 1][0], rows[j + 1][1], rows[j][1]);

  const wall = [place(-45, -STAGE.wallDistance, STAGE.floorY), place(45, -STAGE.wallDistance, STAGE.floorY), place(45, -STAGE.wallDistance, 18), place(-45, -STAGE.wallDistance, 18)]
    .map((p) => b.vertex(p, front, 2));
  b.quad(wall[0], wall[1], wall[2], wall[3]);

  const floor = ([[-60, -60], [-60, 60], [60, 60], [60, -60]] as const).map(([x, z]) => b.vertex([x, STAGE.floorY, z], [0, 1, 0], 3));
  b.quad(floor[0], floor[1], floor[2], floor[3]);
  return b.build();
}

/** UV sphere in the shared vertex layout, used for the steel striker. */
export function buildSphereMesh(radius: number, around = 40, down = 24): MeshData {
  const b = new Builder();
  const rows: number[][] = [];
  for (let j = 0; j <= down; j++) {
    const phi = (j / down) * Math.PI;
    const row: number[] = [];
    for (let i = 0; i <= around; i++) {
      const theta = (i / around) * Math.PI * 2;
      const n: Vec3 = [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
      row.push(b.vertex([n[0] * radius, n[1] * radius, n[2] * radius], n, 0));
    }
    rows.push(row);
  }
  for (let j = 0; j < down; j++) {
    for (let i = 0; i < around; i++) b.quad(rows[j][i], rows[j][i + 1], rows[j + 1][i + 1], rows[j + 1][i]);
  }
  return b.build();
}
