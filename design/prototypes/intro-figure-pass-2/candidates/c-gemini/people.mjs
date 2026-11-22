import { C, castShadowBox, el, f, isoBox, isoCyl, ptsStr } from './lib.mjs';

// ============================================================================
// MERGE: THE PERSON AT THE GREEN SUMMIT DESK
// Strictly green (--accent-soft / --accent), matching style reference!
// ============================================================================
export function drawPersonAtDesk(P, cu, cv, z, sc = 1, opts = {}) {
  const { acting = false, hasQuestion = false } = opts;
  const out = [];
  const ps = P.scale || 1;
  const s = sc * ps;
  const swS = Math.sqrt(Math.max(0.65, s));
  const sw = 1.15 * swS;

  // Person seated behind desk (u = cu - 16*sc, v = cv + 4*sc)
  const pu = cu - 16 * sc;
  const pv = cv + 4 * sc;

  // Seated green solid bust/torso pedestal (echoing round1-line.png's iconic faceted green person!)
  const torsoZ0 = z;
  const torsoZ1 = z + 34 * sc;
  // Sculpted shoulder bust + cylindrical body in green
  out.push(isoCyl(P, pu, pv, torsoZ0, torsoZ1, 12.5 * sc, {
    green: true,
    topFill: C.accentSoft,
    bodyFill: C.accentSoft,
    sw,
    shadeLines: 6,
  }));
  // Rounded shoulders dome matched exactly to torso cylinder width (0.8523 * 12.5 * s = 10.65 * s)
  const shC = P(pu, pv, torsoZ1 + 1 * sc);
  const shW = 10.65 * s;
  out.push(el('path', {
    d: `M${f(shC[0] - shW)},${f(shC[1] + 1.5 * s)}C${f(shC[0] - shW)},${f(shC[1] - 9.2 * s)} ${f(shC[0] + shW)},${f(shC[1] - 9.2 * s)} ${f(shC[0] + shW)},${f(shC[1] + 1.5 * s)}Z`,
    fill: C.accentSoft,
    stroke: C.accent,
    'stroke-width': f(sw),
  }));
  // Head sphere with crisp vertical green engraving hatching (zero cartoon face!)
  const headShiftU = acting ? 4.5 * sc : 0;
  const headShiftZ = acting ? -2 * sc : 0;
  const hC = P(pu + headShiftU, pv, torsoZ1 + 16.5 * sc + headShiftZ);
  const hr = 8.4 * s;
  out.push(el('circle', {
    cx: f(hC[0]), cy: f(hC[1]), r: f(hr),
    fill: C.accentSoft, stroke: C.accent, 'stroke-width': f(sw),
  }));
  // Fine vertical green engraving lines across the head
  const hLines = [];
  for (let i = -3; i <= 3; i++) {
    const dx = i * 2.1 * s;
    if (Math.abs(dx) >= hr * 0.92) continue;
    const dy = Math.sqrt(Math.max(0, hr * hr - dx * dx)) * 0.92;
    hLines.push(`M${f(hC[0] + dx)},${f(hC[1] - dy)}L${f(hC[0] + dx)},${f(hC[1] + dy)}`);
  }
  out.push(el('path', { d: hLines.join(''), fill: 'none', stroke: C.accent, 'stroke-width': f(0.55 * swS), opacity: '0.65' }));

  // Green watchmaker's summit desk directly in front of the person (u = cu - 4 .. cu + 27)
  out.push(castShadowBox(P, cu - 4 * sc, cv - 28 * sc, cu + 27 * sc, cv + 28 * sc, z, 13 * sc, 5));
  out.push(isoBox(P, cu - 4 * sc, cv - 28 * sc, z, cu + 27 * sc, cv + 28 * sc, z + 18 * sc, {
    green: true,
    sw,
    leftHatch: 5,
    rightHatch: 5,
    leftDir: 'horiz',
    rightDir: 'horiz',
    bevelTop: true,
  }));

  // Small recessed chamfered Question shelf on the Drive-facing corner (v = cv - 22*sc)
  out.push(isoBox(P, cu + 1 * sc, cv - 26 * sc, z + 18 * sc, cu + 19 * sc, cv - 11 * sc, z + 20 * sc, {
    green: true,
    sw: sw * 0.8,
    leftHatch: 0,
    rightHatch: 0,
  }));

  // Waiting Question card in Step 4!
  if (hasQuestion) {
    const qu = cu + 10 * sc;
    const qv = cv - 18.5 * sc;
    const qz = z + 20 * sc;
    // Small cast shadow on desk
    out.push(castShadowBox(P, qu - 5 * sc, qv - 6 * sc, qu + 5 * sc, qv + 6 * sc, qz, 8 * sc, 3));
    // Upright folded watchmaker's query card/flag in warm --hl highlight with crisp --ink border
    const q0 = P(qu - 6 * sc, qv - 5 * sc, qz);
    const q1 = P(qu + 6 * sc, qv + 5 * sc, qz);
    const q2 = P(qu + 6 * sc, qv + 5 * sc, qz + 20 * sc);
    const q3 = P(qu - 6 * sc, qv - 5 * sc, qz + 20 * sc);
    // Little stand foot
    out.push(isoBox(P, qu - 5 * sc, qv - 5 * sc, qz, qu + 5 * sc, qv + 5 * sc, qz + 2.5 * sc, {
      topFill: C.card, leftFill: C.sunk, rightFill: C.line, sw: sw * 0.8, leftHatch: 0,
    }));
    out.push(el('polygon', {
      points: ptsStr([q0, q1, q2, q3]),
      fill: C.hl,
      stroke: C.ink,
      'stroke-width': f(sw * 1.05),
      'stroke-linejoin': 'round',
    }));
    // Pure vector '?' glyph drawn as <path> (never <text>, keeps vocabulary 100% verbatim!)
    const qc = P(qu, qv, qz + 11 * sc);
    const qr = 4.2 * s;
    out.push(el('path', {
      d: `M${f(qc[0] - qr * 0.55)},${f(qc[1] - qr * 0.45)}C${f(qc[0] - qr * 0.55)},${f(qc[1] - qr * 1.25)} ${f(qc[0] + qr * 0.72)},${f(qc[1] - qr * 1.2)} ${f(qc[0] + qr * 0.65)},${f(qc[1] - qr * 0.32)}C${f(qc[0] + qr * 0.58)},${f(qc[1] + qr * 0.25)} ${f(qc[0])},${f(qc[1] + qr * 0.25)} ${f(qc[0])},${f(qc[1] + qr * 0.72)}`,
      fill: 'none',
      stroke: C.ink,
      'stroke-width': f(1.7 * swS),
      'stroke-linecap': 'round',
    }));
    out.push(el('circle', {
      cx: f(qc[0]), cy: f(qc[1] + qr * 1.28), r: f(1.25 * s), fill: C.ink,
    }));
  }

  return {
    deskAndPerson: el('g', {}, out.join('')),
    // Drawn AFTER the Merged item on top of the desk in Step 6 so the person's hand & seal stamp press onto it!
    actingArmAndStamp: acting ? (() => {
      const aOut = [];
      const stampU = cu + 11 * sc;
      const stampV = cv + 6.5 * sc;
      const shPt = P(pu + 7 * sc, pv - 2 * sc, torsoZ1 - 1 * sc);
      const handPt = P(stampU - 1 * sc, stampV, z + 33 * sc);
      // Reaching green forearm
      const dx = handPt[0] - shPt[0];
      const dy = handPt[1] - shPt[1];
      const len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * 3.6 * s;
      const ny = (dx / len) * 3.6 * s;
      aOut.push(el('polygon', {
        points: ptsStr([
          [shPt[0] + nx, shPt[1] + ny],
          [handPt[0] + nx * 0.7, handPt[1] + ny * 0.7],
          [handPt[0] - nx * 0.7, handPt[1] - ny * 0.7],
          [shPt[0] - nx, shPt[1] - ny],
        ]),
        fill: C.accentSoft,
        stroke: C.accent,
        'stroke-width': f(sw),
        'stroke-linejoin': 'round',
      }));
      // Turned signet seal handle held in hand pressing squarely onto the Merged seal
      aOut.push(isoCyl(P, stampU, stampV, z + 27 * sc, z + 36 * sc, 3.6 * sc, {
        green: true, sw: sw * 0.9, shadeLines: 2,
      }));
      const knob = P(stampU, stampV, z + 39 * sc);
      aOut.push(el('circle', {
        cx: f(knob[0]), cy: f(knob[1]), r: f(4.2 * s),
        fill: C.accentSoft, stroke: C.accent, 'stroke-width': f(sw),
      }));
      return el('g', {}, aOut.join(''));
    })() : '',
  };
}

// ============================================================================
// READ-ONLY ANALOG DIAL GAUGE (NO NUMERALS, NO COUNTS, NO TICK NUMBERS!)
// ============================================================================
export function drawGauge(P, cu, cv, z, sc = 1, needleFrac = 0.55) {
  const out = [];
  const ps = P.scale || 1;
  const s = sc * ps;
  const swS = Math.sqrt(Math.max(0.65, s));
  const sw = 1.05 * swS;
  const r = 14.0 * s;

  // Small angled watchmaker cradle plinth
  out.push(castShadowBox(P, cu - 10 * sc, cv - 10 * sc, cu + 10 * sc, cv + 10 * sc, z, 9 * sc, 3));
  out.push(isoBox(P, cu - 10 * sc, cv - 10 * sc, z, cu + 10 * sc, cv + 10 * sc, z + 5 * sc, {
    sw: sw * 0.9, topFill: C.sunk, leftFill: C.line, rightFill: C.strong, leftHatch: 1,
  }));

  // Cylindrical dial bezel facing slightly upward/front
  const dC = P(cu, cv, z + 18 * sc);
  const rx = r * 1.06;
  const ry = r * 0.92;
  // Back casing depth offset slightly up-left
  out.push(el('ellipse', {
    cx: f(dC[0] - 2.6 * s), cy: f(dC[1] - 1.6 * s), rx: f(rx), ry: f(ry),
    fill: C.line, stroke: C.ink, 'stroke-width': f(sw),
  }));
  // Front brass/paper bezel ring
  out.push(el('ellipse', {
    cx: f(dC[0]), cy: f(dC[1]), rx: f(rx), ry: f(ry),
    fill: C.sunk, stroke: C.ink, 'stroke-width': f(sw),
  }));
  // Pale engraved dial face
  out.push(el('ellipse', {
    cx: f(dC[0]), cy: f(dC[1]), rx: f(rx * 0.8), ry: f(ry * 0.8),
    fill: C.card, stroke: C.ink, 'stroke-width': f(sw * 0.75),
  }));

  // Unnumbered radiating tick marks around upper 220-degree arc (ZERO numerals!)
  const startA = -Math.PI * 1.15;
  const endA = Math.PI * 0.15;
  const tickSegs = [];
  const nTicks = 9;
  for (let i = 0; i < nTicks; i++) {
    const a = startA + (i / (nTicks - 1)) * (endA - startA);
    const major = i % 2 === 0;
    const r0 = major ? 0.56 : 0.64;
    const r1 = 0.76;
    tickSegs.push(
      `M${f(dC[0] + Math.cos(a) * rx * r0)},${f(dC[1] + Math.sin(a) * ry * r0)}` +
      `L${f(dC[0] + Math.cos(a) * rx * r1)},${f(dC[1] + Math.sin(a) * ry * r1)}`
    );
  }
  out.push(el('path', {
    d: tickSegs.join(''),
    fill: 'none',
    stroke: C.muted,
    'stroke-width': f(0.8 * swS),
    'stroke-linecap': 'round',
  }));

  // Pointer needle
  const nA = startA + needleFrac * (endA - startA);
  const nx = dC[0] + Math.cos(nA) * rx * 0.62;
  const ny = dC[1] + Math.sin(nA) * ry * 0.62;
  const bx = dC[0] - Math.cos(nA) * rx * 0.2;
  const by = dC[1] - Math.sin(nA) * ry * 0.2;
  out.push(el('line', {
    x1: f(bx), y1: f(by), x2: f(nx), y2: f(ny),
    stroke: C.ink, 'stroke-width': f(1.45 * swS), 'stroke-linecap': 'round',
  }));
  out.push(el('circle', {
    cx: f(dC[0]), cy: f(dC[1]), r: f(1.9 * s),
    fill: C.ink,
  }));

  return el('g', {}, out.join(''));
}

