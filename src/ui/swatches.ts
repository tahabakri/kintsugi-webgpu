import type { MaterialName } from '../config';
import { PRESETS } from '../gpu/materials';
import { mulberry32 } from '../math/random';

/** Paints a small procedural sample of a ceramic preset. No images are loaded. */
export function drawSwatch(canvas: HTMLCanvasElement, material: MaterialName): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;
  const [glaze, accent, body] = PRESETS[material].swatch;
  const rand = mulberry32(material.length * 7919 + w);

  // Glaze with a soft highlight, as if lit from the upper left.
  const light = ctx.createLinearGradient(0, 0, w, h);
  light.addColorStop(0, glaze);
  light.addColorStop(1, glaze);
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);
  const sheen = ctx.createRadialGradient(w * 0.28, h * 0.2, 0, w * 0.28, h * 0.2, w * 0.9);
  sheen.addColorStop(0, 'rgba(255,255,255,0.34)');
  sheen.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);

  const speck = (count: number, colour: (a: number) => string, size: number) => {
    for (let i = 0; i < count; i++) {
      ctx.fillStyle = colour(rand());
      ctx.beginPath();
      ctx.arc(rand() * w, rand() * h, size * (0.4 + rand()), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  if (material === 'porcelain') {
    // A few brushed blossoms on a branch.
    ctx.strokeStyle = accent;
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, w * 0.014);
    ctx.beginPath();
    ctx.moveTo(-4, h * 0.74);
    ctx.bezierCurveTo(w * 0.3, h * 0.36, w * 0.55, h * 0.8, w + 4, h * 0.34);
    ctx.stroke();
    const flower = (x: number, y: number, r: number, turn: number) => {
      for (let k = 0; k < 5; k++) {
        const a = turn + (k / 5) * Math.PI * 2;
        ctx.fillStyle = k % 2 ? 'rgba(60,94,151,0.78)' : 'rgba(47,78,134,0.66)';
        ctx.beginPath();
        ctx.ellipse(x + Math.cos(a) * r * 0.56, y + Math.sin(a) * r * 0.56, r * 0.46, r * 0.33, a, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#263f6e';
      ctx.beginPath();
      ctx.arc(x, y, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
    };
    flower(w * 0.27, h * 0.42, h * 0.2, 0.3);
    flower(w * 0.6, h * 0.6, h * 0.24, 1.1);
    flower(w * 0.86, h * 0.3, h * 0.17, 2.0);
    flower(w * 0.44, h * 0.22, h * 0.1, 0.8);
  } else if (material === 'celadon') {
    const pool = ctx.createRadialGradient(w * 0.7, h * 0.75, 0, w * 0.7, h * 0.75, w * 0.7);
    pool.addColorStop(0, 'rgba(70,104,82,0.5)');
    pool.addColorStop(1, 'rgba(70,104,82,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(0, 0, w, h);
    // Crazing.
    ctx.strokeStyle = 'rgba(60,84,66,0.3)';
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 16; i++) {
      ctx.beginPath();
      let x = rand() * w, y = rand() * h;
      ctx.moveTo(x, y);
      for (let s = 0; s < 3; s++) {
        x += (rand() - 0.5) * w * 0.4;
        y += (rand() - 0.5) * h * 0.5;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  } else if (material === 'raku') {
    speck(26, (a) => `rgba(176,104,58,${0.25 + a * 0.5})`, w * 0.045);
    speck(60, (a) => `rgba(196,128,74,${0.2 + a * 0.6})`, w * 0.012);
    speck(14, (a) => `rgba(86,128,112,${0.15 + a * 0.3})`, w * 0.03);
  } else {
    speck(140, (a) => `rgba(110,56,30,${0.08 + a * 0.22})`, w * 0.012);
    speck(50, (a) => `rgba(232,178,140,${0.06 + a * 0.16})`, w * 0.01);
    ctx.fillStyle = body;
    ctx.globalAlpha = 0.18;
    ctx.fillRect(0, h * 0.78, w, h * 0.22);
    ctx.globalAlpha = 1;
  }

  // Fine grain over everything.
  speck(220, (a) => (a > 0.5 ? 'rgba(255,250,236,0.06)' : 'rgba(40,30,18,0.06)'), 0.8);
}
