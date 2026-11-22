#!/usr/bin/env node
// Generates every SVG for candidate c-gemini ("the terraces") from one scene description.
// Zero dependencies; Node 26+.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const WIDE_DIR = path.join(ROOT, 'wide');
export const TALL_DIR = path.join(ROOT, 'tall');

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

// Strictly the ten permitted colour tokens with light fallbacks.
export const C = {
  bg: 'var(--bg,#f9f6f1)',
  card: 'var(--card,#fffdfa)',
  sunk: 'var(--sunk,#f0ece5)',
  ink: 'var(--ink,#251e18)',
  muted: 'var(--muted,#59514a)',
  line: 'var(--line,#d5d0c8)',
  strong: 'var(--line-strong,#867f77)',
  accent: 'var(--accent,#1a6444)',
  accentSoft: 'var(--accent-soft,#dbf2e4)',
  hl: 'var(--hl,#f7e8af)',
};

export const ALLOWED_WORDS = new Set([
  'Queue', 'Pick up', 'Build', 'Open', 'Drive', 'Repair', 'Merge', 'Follow up',
  'Dispatcher', 'Question', 'Issue', 'Pull request', 'Comments', 'Checks',
  'Merged', 'Memory', 'Processor', 'Disk', 'Forge budget', 'Usage limit',
]);

// Uniform 22-degree paraline projection across the whole candidate.
// +v climbs up-right along the line; +u moves down-right across depth; +z rises vertically.
const ANGLE = (22 * Math.PI) / 180;
export const CX = Math.cos(ANGLE);
export const CY = Math.sin(ANGLE);

export function makeProj(ox, oy, scale = 1) {
  const fn = (u, v, z = 0) => [
    +(ox + (u * CX + v * CX) * scale).toFixed(1),
    +(oy + (u * CY - v * CY - z) * scale).toFixed(1),
  ];
  fn.scale = scale;
  return fn;
}

export function f(n) {
  return Number.isInteger(n) ? String(n) : (+n.toFixed(1)).toString();
}

export function ptsStr(pts) {
  return pts.map(([x, y]) => `${f(x)},${f(y)}`).join(' ');
}

export function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function el(tag, attrs = {}, children = '') {
  const a = Object.entries(attrs)
    .filter(([k, v]) => {
      if (v === undefined || v === null) return false;
      // Inherit default stroke=ink, stroke-linejoin=round, stroke-linecap=round, font-family from root <g>
      if (tag !== 'text' && tag !== 'g' && k === 'stroke' && v === C.ink) return false;
      if (k === 'stroke-linejoin' && v === 'round') return false;
      if (k === 'stroke-linecap' && v === 'round') return false;
      if (k === 'font-family' && v === FONT) return false;
      if (k === 'stroke-width' && (v === '1' || v === '1.0')) return false;
      return true;
    })
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('');
  if (tag === 'text' && !('stroke' in attrs)) {
    return `<${tag}${a} stroke="none">${children}</${tag}>`;
  }
  if (children === '' || children === null || children === undefined) {
    return `<${tag}${a}/>`;
  }
  return `<${tag}${a}>${children}</${tag}>`;
}

export function lerpPt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Parallel engraving hatching across a quad [p0, p1, p2, p3]
// dir='horiz': lines parallel to p0->p1 & p3->p2 (stepping along p0->p3)
// dir='vert': lines parallel to p0->p3 & p1->p2 (stepping along p0->p1)
export function hatchQuad(p0, p1, p2, p3, count, stroke, sw = 0.65, dir = 'horiz', opacity) {
  if (count <= 0) return '';
  const segs = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    let a, b;
    if (dir === 'horiz') {
      a = lerpPt(p0, p3, t);
      b = lerpPt(p1, p2, t);
    } else {
      a = lerpPt(p0, p1, t);
      b = lerpPt(p3, p2, t);
    }
    segs.push(`M${f(a[0])},${f(a[1])}L${f(b[0])},${f(b[1])}`);
  }
  return el('path', {
    d: segs.join(''),
    fill: 'none',
    stroke,
    'stroke-width': f(sw),
    'stroke-linecap': 'round',
    opacity,
  });
}

// Signature horizontal-line cast shadow on a flat surface at elevation z.
export function castShadowBox(P, u0, v0, u1, v1, z, shiftX = 16, lines = 6) {
  const ps = P.scale || 1;
  const sx = shiftX * ps;
  const c0 = P(u0, v0, z);
  const c1 = P(u1, v0, z);
  const c2 = P(u1, v1, z);
  const c3 = P(u0, v1, z);
  // Project a simple parallelogram footprint shifted right by sx
  const a0 = [c1[0], c1[1]];
  const a1 = [c1[0] + sx, c1[1]];
  const a2 = [c2[0] + sx, c2[1]];
  const a3 = [c2[0], c2[1]];
  // Draw horizontal hatch lines spanning the cast polygon
  const segs = [];
  const y0 = Math.min(a0[1], a3[1]);
  const y1 = Math.max(a0[1], a3[1]);
  if (Math.abs(y1 - y0) < 1) return '';
  for (let i = 0; i <= lines; i++) {
    const t = (i + 0.5) / (lines + 1);
    const L = lerpPt(a3, a0, t);
    const R = lerpPt(a2, a1, t);
    segs.push(`M${f(L[0])},${f(L[1])}L${f(R[0])},${f(R[1])}`);
  }
  return el('path', {
    d: segs.join(''),
    fill: 'none',
    stroke: C.muted,
    'stroke-width': f(0.65 * Math.sqrt(Math.max(0.7, ps))),
    opacity: '0.6',
  });
}

// Crisp isometric rectangular solid with engraving hatching on shaded faces.
export function isoBox(P, u0, v0, z0, u1, v1, z1, opts = {}) {
  const {
    green = false,
    topFill,
    leftFill,
    rightFill,
    stroke,
    hatchStroke,
    sw = 1.1,
    leftHatch = 4,
    rightHatch = 0,
    leftDir = 'horiz',
    rightDir = 'vert',
    bevelTop = false,
  } = opts;

  const st = stroke || (green ? C.accent : C.ink);
  const hs = hatchStroke || (green ? C.accent : C.muted);
  const tFill = topFill || (green ? C.accentSoft : C.card);
  const lFill = leftFill || (green ? C.accentSoft : C.sunk);
  const rFill = rightFill || (green ? C.accentSoft : C.line);

  const b00 = P(u0, v0, z0);
  const b10 = P(u1, v0, z0);
  const b11 = P(u1, v1, z0);
  const t00 = P(u0, v0, z1);
  const t10 = P(u1, v0, z1);
  const t11 = P(u1, v1, z1);
  const t01 = P(u0, v1, z1);

  const out = [];
  // Front-left face (v = v0)
  out.push(el('polygon', {
    points: ptsStr([b00, b10, t10, t00]),
    fill: lFill,
    stroke: st,
    'stroke-width': f(sw),
  }));
  if (leftHatch > 0) {
    out.push(hatchQuad(t00, t10, b10, b00, leftHatch, hs, 0.55, leftDir, green ? '0.65' : '0.75'));
  }

  // Front-right face (u = u1)
  out.push(el('polygon', {
    points: ptsStr([b10, b11, t11, t10]),
    fill: rFill,
    stroke: st,
    'stroke-width': f(sw),
  }));
  if (rightHatch > 0) {
    out.push(hatchQuad(t10, t11, b11, b10, rightHatch, hs, 0.55, rightDir, green ? '0.75' : '0.55'));
  }

  // Top face (z = z1)
  out.push(el('polygon', {
    points: ptsStr([t00, t10, t11, t01]),
    fill: tFill,
    stroke: st,
    'stroke-width': f(sw),
  }));

  if (bevelTop) {
    const du = (u1 - u0) * 0.08;
    const dv = (v1 - v0) * 0.08;
    const i00 = P(u0 + du, v0 + dv, z1);
    const i10 = P(u1 - du, v0 + dv, z1);
    const i11 = P(u1 - du, v1 - dv, z1);
    const i01 = P(u0 + du, v1 - dv, z1);
    out.push(el('polygon', {
      points: ptsStr([i00, i10, i11, i01]),
      fill: 'none',
      stroke: green ? C.accent : C.line,
      'stroke-width': '0.7',
      opacity: green ? '0.5' : '1',
    }));
  }

  return out.join('');
}

// Isometric vertical cylinder (pillars, turret drums, base flanges, dial bezels).
export function isoCyl(P, cu, cv, z0, z1, r, opts = {}) {
  const {
    green = false,
    topFill,
    bodyFill,
    stroke,
    sw = 1.05,
    shadeLines = 4,
    scale = 1,
  } = opts;
  const st = stroke || (green ? C.accent : C.ink);
  const bFill = bodyFill || (green ? C.accentSoft : C.sunk);
  const tFill = topFill || (green ? C.accentSoft : C.card);

  const bot = P(cu, cv, z0);
  const top = P(cu, cv, z1);
  // Compute screen radii directly from projection scale
  const rx = Math.hypot(P(cu + r, cv, z0)[0] - bot[0], P(cu - r, cv, z0)[0] - bot[0]) * 0.65;
  const ry = rx * (CY / CX);
  const h = bot[1] - top[1];

  const out = [];
  if (h > 0.3) {
    const bodyD = [
      `M${f(top[0] - rx)},${f(top[1])}`,
      `L${f(bot[0] - rx)},${f(bot[1])}`,
      `A${f(rx)},${f(ry)} 0 0 0 ${f(bot[0] + rx)},${f(bot[1])}`,
      `L${f(top[0] + rx)},${f(top[1])}`,
      'Z',
    ].join('');
    out.push(el('path', {
      d: bodyD,
      fill: bFill,
      stroke: st,
      'stroke-width': f(sw),
      'stroke-linejoin': 'round',
    }));
    // Right-side shading arc hatch lines
    if (shadeLines > 0) {
      const segs = [];
      for (let i = 0; i < shadeLines; i++) {
        const ang = (0.15 + (i / Math.max(1, shadeLines - 1)) * 0.72) * (Math.PI / 2);
        const dx = Math.cos(ang) * rx * 0.92;
        const dy = Math.sin(ang) * ry * 0.92;
        segs.push(`M${f(top[0] + dx)},${f(top[1] + dy)}L${f(bot[0] + dx)},${f(bot[1] + dy)}`);
      }
      out.push(el('path', {
        d: segs.join(''),
        fill: 'none',
        stroke: green ? C.accent : C.muted,
        'stroke-width': '0.55',
        opacity: '0.75',
      }));
    }
  }
  out.push(el('ellipse', {
    cx: f(top[0]),
    cy: f(top[1]),
    rx: f(rx),
    ry: f(ry),
    fill: tFill,
    stroke: st,
    'stroke-width': f(sw),
  }));
  return out.join('');
}

export function wrapSvg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><g stroke="${C.ink}" stroke-width="1" stroke-linejoin="round" stroke-linecap="round" font-family="${esc(FONT)}">${body}</g></svg>\n`;
}
