// Vertex layout sizes shared by CPU-side geometry builders and the GPU pipelines.
// Kept free of shader imports so simulation code can use them outside a browser.

/** Gold seam vertex: centre 3, binormal 3, normal 3, profile 2, ids 4. */
export const SEAM_VERTEX_FLOATS = 15;
/** Particle instance: position + size 4, colour + alpha 4, shape 4. */
export const PARTICLE_FLOATS = 12;
