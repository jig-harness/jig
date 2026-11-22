import { ALLOWED_WORDS, C, CX, CY, FONT, castShadowBox, el, esc, f, hatchQuad, isoBox, makeProj, ptsStr , wrapSvg } from './lib.mjs';
import { drawItem } from './item.mjs';
import { drawMechanicalAgent } from './agents.mjs';
import { drawGauge, drawPersonAtDesk } from './people.mjs';

// ============================================================================
// CALLOUT LABEL PILL (matching round1-line.png & round1-wall.png style)
// ============================================================================
export function estimatePillWidth(text, fontSize) {
  return Math.ceil(text.length * fontSize * 0.60 + fontSize * 1.35);
}

export function drawCallout(cx, cy, text, tx, ty, opts = {}) {
  const {
    fontSize = 12,
    active = false,
    green = false,
    elbowX = null,
    elbowY = null,
    noLeader = false,
  } = opts;

  if (!ALLOWED_WORDS.has(text)) {
    throw new Error(`Disallowed label text: "${text}"`);
  }

  const w = estimatePillWidth(text, fontSize);
  const h = Math.round(fontSize * 1.72);
  const x = cx - w / 2;
  const y = cy - h / 2;
  const r = Math.round(h * 0.32);

  const out = [];
  if (!noLeader && tx !== null && ty !== null) {
    // Leader line from nearest edge of pill to target dot
    let sx = cx;
    let sy = cy;
    if (ty > cy + h / 2) sy = cy + h / 2;
    else if (ty < cy - h / 2) sy = cy - h / 2;
    else if (tx > cx + w / 2) sx = cx + w / 2;
    else if (tx < cx - w / 2) sx = cx - w / 2;

    let d;
    if (elbowX !== null && elbowY !== null) {
      d = `M${f(sx)},${f(sy)}L${f(elbowX)},${f(elbowY)}L${f(tx)},${f(ty)}`;
    } else if (Math.abs(sx - tx) > 8 && Math.abs(sy - ty) > 10) {
      // Crisp 1-elbow horizontal/vertical leader
      d = `M${f(sx)},${f(sy)}L${f(tx)},${f(ty)}`;
    } else {
      d = `M${f(sx)},${f(sy)}L${f(tx)},${f(ty)}`;
    }
    out.push(el('path', {
      d,
      fill: 'none',
      stroke: green ? C.accent : C.muted,
      'stroke-width': active ? '1.15' : '0.95',
    }));
    out.push(el('circle', {
      cx: f(tx),
      cy: f(ty),
      r: active ? '2.6' : '2.2',
      fill: green ? C.accent : C.ink,
    }));
  }

  out.push(el('rect', {
    x: f(x),
    y: f(y),
    width: f(w),
    height: f(h),
    rx: f(r),
    ry: f(r),
    fill: green ? C.accentSoft : C.card,
    stroke: green ? C.accent : active ? C.ink : C.muted,
    'stroke-width': active ? '1.45' : '1.0',
  }));
  out.push(el('text', {
    x: f(cx),
    y: f(cy + fontSize * 0.35),
    'text-anchor': 'middle',
    'font-family': FONT,
    'font-size': f(fontSize),
    'font-weight': active || green ? '700' : '600',
    fill: green ? C.accent : C.ink,
  }, esc(text)));

  return {
    svg: el('g', {}, out.join('')),
    box: { text, x, y, w, h, x2: x + w, y2: y + h },
  };
}

// ============================================================================
// ONE SHARED STORYBOARD DESCRIPTION (drives both wide and tall!)
// ============================================================================
export const STEPS = [
  {
    id: 1,
    name: 'Queue',
    queueCount: 3,
    activeStation: null, // every agent at rest
    item: null,
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 2,
    name: 'Pick up',
    queueCount: 2,
    activeStation: 'pickup',
    item: { station: 'pickup', form: 'issue', lifted: true },
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 3,
    name: 'Build and open',
    queueCount: 2,
    activeStation: 'open',
    item: { station: 'open', form: 'pr', lifted: false },
    buildShavings: true,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 4,
    name: 'Drive',
    queueCount: 2,
    activeStation: 'drive',
    item: { station: 'drive', form: 'review', lifted: false },
    buildShavings: false,
    questionOnDesk: true,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 5,
    name: 'Repair, then green',
    queueCount: 2,
    activeStation: 'repair',
    item: { station: 'repair', form: 'green', lifted: false },
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 6,
    name: 'Merge',
    queueCount: 2,
    activeStation: 'merge',
    item: { station: 'merge', form: 'merged', lifted: false },
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: false,
  },
  {
    id: 7,
    name: 'Follow up',
    queueCount: 2,
    activeStation: 'followup',
    item: null,
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: true,
    chuteItem: true,
    wallClosed: false,
  },
  {
    id: 8,
    name: 'Capacity',
    queueCount: 3,
    activeStation: 'dispatcher',
    item: null,
    buildShavings: false,
    questionOnDesk: false,
    mergedAtExit: false,
    chuteItem: false,
    wallClosed: true,
  },
];

// ============================================================================
// SCENE RENDERER (shared engine for BOTH wide 960x540 and tall 390x520)
// ============================================================================
export function renderScene(step, format) {
  const isWide = format === 'wide';
  const W = isWide ? 960 : 390;
  const H = isWide ? 540 : 520;
  const isZoomed = step.id >= 2 && step.id <= 6;

  // Format-specific terrace proportions (same 22-deg projection, recomposed for portrait!)
  const cfg = isWide
    ? {
        ox: 178,
        oy: 414,
        scale: 0.87,
        agentScale: 0.88,
        itemScale: 1.04,
        gaugeScale: 0.96,
        dv: 84,
        dz: 16,
        uMin: -42,
        uMax: 38,
        queueV0: -46,
        queueV1: 34,
        wallV: 44,
        t1V0: 54,
        chuteU: -94,
        followU: -92,
        followVOffset: 6,
        labelSize: 12,
      }
    : {
        ox: 88,
        oy: 438,
        scale: 0.50,
        agentScale: isZoomed ? 0.74 : 0.92,
        itemScale: 0.86,
        gaugeScale: 1.24,
        dv: 58,
        dz: 50,
        uMin: -38,
        uMax: 34,
        queueV0: -46,
        queueV1: 24,
        wallV: 34,
        t1V0: 44,
        chuteU: -78,
        followU: -76,
        followVOffset: 2,
        labelSize: 14,
      };

  // Compute terrace geometry first so the camera can follow the active terrace in Steps 2-6!
  // 0: pickup, 1: build, 2: open, 3: drive, 4: repair, 5: merge (summit!)
  const stationKeys = ['pickup', 'build', 'open', 'drive', 'repair', 'merge'];
  const terraces = stationKeys.map((key, idx) => {
    const v0 = cfg.t1V0 + idx * cfg.dv;
    const isMerge = key === 'merge';
    const v1 = v0 + (isMerge ? cfg.dv * 1.18 : cfg.dv);
    const zTop = (idx + 1) * cfg.dz + (isMerge ? 4 : 0);
    return {
      key,
      idx,
      v0,
      v1,
      vMid: (v0 + v1) * 0.5,
      zTop,
    };
  });

  // Camera framing: Steps 1, 7, 8 keep the whole stair; Steps 2-6 crop and zoom to follow the action!
  let camOx = cfg.ox;
  let camOy = cfg.oy;
  let camScale = cfg.scale;
  const focusCam = (fu, fv, fz, sx, sy, zoomScale) => {
    camScale = zoomScale;
    camOx = sx - (fu * CX + fv * CX) * zoomScale;
    camOy = sy - (fu * CY - fv * CY - fz) * zoomScale;
  };

  if (isZoomed) {
    const personSc = cfg.agentScale * 1.02;
    if (isWide) {
      if (step.id === 2) {
        const t = terraces[0];
        focusCam(12, t.vMid, t.zTop + 11 * cfg.agentScale, 505, 276, 2.35);
      } else if (step.id === 3) {
        const t = terraces[2];
        focusCam(12, t.vMid, t.zTop + 1, 515, 276, 2.35);
      } else if (step.id === 4) {
        const t = terraces[3];
        focusCam(12, t.vMid, t.zTop + 1, 342, 404, 2.25);
      } else if (step.id === 5) {
        const t = terraces[4];
        focusCam(12, t.vMid, t.zTop + 1, 462, 314, 2.35);
      } else if (step.id === 6) {
        const t = terraces[5];
        focusCam(2 + 11 * personSc, t.vMid + 5 * personSc, t.zTop + 18 * personSc, 520, 294, 2.35);
      }
    } else {
      if (step.id === 2) {
        const t = terraces[0];
        focusCam(12, t.vMid, t.zTop + 11 * cfg.agentScale, 240, 236, 2.05);
      } else if (step.id === 3) {
        const t = terraces[2];
        focusCam(12, t.vMid, t.zTop + 1, 232, 234, 2.05);
      } else if (step.id === 4) {
        const t = terraces[3];
        focusCam(12, t.vMid, t.zTop + 1, 120, 428, 2.00);
      } else if (step.id === 5) {
        const t = terraces[4];
        focusCam(12, t.vMid, t.zTop + 1, 194, 316, 2.05);
      } else if (step.id === 6) {
        const t = terraces[5];
        focusCam(2 + 11 * personSc, t.vMid + 5 * personSc, t.zTop + 18 * personSc, 224, 282, 2.05);
      }
    }
  }

  const P = makeProj(camOx, camOy, camScale);
  const layers = [];

  // 1. Warm paper background
  layers.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.bg, stroke: 'none' }));

  // Outer engraved workshop plate slab
  if (isWide) {
    layers.push(isoBox(P, -118, -60, -14, 196, 650, 0, {
      topFill: C.bg,
      leftFill: C.sunk,
      rightFill: C.line,
      sw: 1.25,
      leftHatch: 3,
      rightHatch: 0,
      bevelTop: true,
    }));
  } else {
    layers.push(isoBox(P, -96, -54, -14, 166, 448, 0, {
      topFill: C.bg,
      leftFill: C.sunk,
      rightFill: C.line,
      sw: 1.15,
      leftHatch: 3,
      rightHatch: 0,
      bevelTop: true,
    }));
  }

  const mergeT = terraces[5];
  const exitV0 = mergeT.v1;
  const exitV1 = exitV0 + cfg.dv * 0.72;
  const exitVMid = (exitV0 + exitV1) * 0.5;
  const exitZ = mergeT.zTop;

  // Follow up sits on a stepped upper-back outpost connected to the summit exit pad
  const followV0 = mergeT.v1 - cfg.dv * 0.48 + cfg.followVOffset;
  const followV1 = followV0 + cfg.dv * 0.85;
  const followVMid = (followV0 + followV1) * 0.5;
  const followZ = mergeT.zTop - cfg.dz * 0.55;
  const followU0 = cfg.followU - 24;
  const followU1 = cfg.uMin;

  // --------------------------------------------------------------------------
  // 2. NARROW DESCENDING SIDE CHUTE (Follow up -> Queue tail, back-left flank)
  // Thin, subordinate, mostly empty!
  // --------------------------------------------------------------------------
  const chuteU0 = cfg.chuteU - 9;
  const chuteU1 = cfg.chuteU + 9;
  const chuteTopV = followV0;
  const chuteTopZ = followZ + 3;
  const chuteBotV = cfg.queueV0 + 10;
  const chuteBotZ = 5;

  // Slender support trestle posts under the descending chute
  const postVs = [0.22, 0.5, 0.78];
  for (const t of postVs) {
    const pv = chuteBotV + (chuteTopV - chuteBotV) * t;
    const pz = chuteBotZ + (chuteTopZ - chuteBotZ) * t;
    layers.push(isoBox(P, cfg.chuteU - 3, pv - 3, 0, cfg.chuteU + 3, pv + 3, pz, {
      topFill: C.sunk, leftFill: C.sunk, rightFill: C.line, sw: 0.75, leftHatch: 2,
    }));
  }

  // Inclined chute trough floor & thin raised side rails
  const cT0 = P(chuteU0, chuteTopV, chuteTopZ);
  const cT1 = P(chuteU1, chuteTopV, chuteTopZ);
  const cB1 = P(chuteU1, chuteBotV, chuteBotZ);
  const cB0 = P(chuteU0, chuteBotV, chuteBotZ);
  const cT1r = P(chuteU1, chuteTopV, chuteTopZ + 3.2);
  const cB1r = P(chuteU1, chuteBotV, chuteBotZ + 3.2);
  const cT0r = P(chuteU0, chuteTopV, chuteTopZ + 5);
  const cB0r = P(chuteU0, chuteBotV, chuteBotZ + 5);
  const cT1u = P(chuteU1, chuteTopV, chuteTopZ - 3.5);
  const cB1u = P(chuteU1, chuteBotV, chuteBotZ - 3.5);

  // Back wall of chute
  layers.push(el('polygon', {
    points: ptsStr([cT0, cB0, cB0r, cT0r]),
    fill: C.line, stroke: C.ink, 'stroke-width': '0.8', 'stroke-linejoin': 'round',
  }));
  // Trough bed
  layers.push(el('polygon', {
    points: ptsStr([cT0, cT1, cB1, cB0]),
    fill: C.sunk, stroke: C.ink, 'stroke-width': '0.9', 'stroke-linejoin': 'round',
  }));
  // Subtle engraved descent ribs inside chute
  layers.push(hatchQuad(cT0, cT1, cB1, cB0, 9, C.line, 0.65, 'horiz'));

  // Small horizontal feed elbow curving from chute bottom into Queue tail!
  const el0 = P(chuteU0, chuteBotV, chuteBotZ);
  const el1 = P(cfg.uMin + 4, chuteBotV, chuteBotZ - 1);
  const el2 = P(cfg.uMin + 4, chuteBotV + 18, chuteBotZ - 1);
  const el3 = P(chuteU1, chuteBotV + 18, chuteBotZ);
  layers.push(el('polygon', {
    points: ptsStr([el0, el1, el2, el3]),
    fill: C.sunk, stroke: C.ink, 'stroke-width': '0.85', 'stroke-linejoin': 'round',
  }));

  // Small fresh Issue sliding down the narrow chute in Step 7!
  if (step.chuteItem) {
    const tChute = isWide ? 0.44 : 0.54;
    const itemV = chuteBotV + (chuteTopV - chuteBotV) * tChute;
    const itemZ = chuteBotZ + (chuteTopZ - chuteBotZ) * tChute + 2.8;
    layers.push(drawItem(P, cfg.chuteU, itemV, itemZ, 'issue', cfg.itemScale * 0.78, { shadow: false }));
  }

  // Front lip rail of chute (drawn over sliding item so item sits INSIDE the trough!)
  layers.push(el('polygon', {
    points: ptsStr([cT1u, cB1u, cB1r, cT1r]),
    fill: C.card, stroke: C.ink, 'stroke-width': '0.9', 'stroke-linejoin': 'round',
  }));

  // --------------------------------------------------------------------------
  // 3. FOLLOW UP OUTPOST & AGENT (back-upper flank beside exit pad)
  // --------------------------------------------------------------------------
  layers.push(isoBox(P, followU0, followV0, 0, followU1, followV1, followZ, {
    topFill: C.sunk,
    leftFill: C.sunk,
    rightFill: C.line,
    sw: 1.0,
    leftHatch: Math.max(3, Math.round(followZ / 10)),
    rightHatch: 2,
  }));
  // Small bridge spur linking summit exit pad back to Follow up
  layers.push(isoBox(P, followU1 - 6, exitV0 - 4, followZ - 6, cfg.uMin + 8, exitV0 + 18, followZ, {
    topFill: C.sunk, leftFill: C.line, rightFill: C.line, sw: 0.85, leftHatch: 1,
  }));
  layers.push(drawMechanicalAgent(
    P,
    'followup',
    step.activeStation === 'followup' ? 'act' : 'rest',
    cfg.chuteU + 2,
    followVMid,
    followZ,
    cfg.agentScale * 0.88
  ));

  // --------------------------------------------------------------------------
  // 4. SUMMIT EXIT RESTING PAD (End of the line past Merge!)
  // --------------------------------------------------------------------------
  layers.push(isoBox(P, cfg.uMin + 12, exitV0, 0, cfg.uMax, exitV1, exitZ, {
    topFill: C.card,
    leftFill: C.sunk,
    rightFill: C.line,
    sw: 1.05,
    leftHatch: Math.max(3, Math.round(exitZ / 11)),
    rightHatch: 2,
    bevelTop: true,
  }));
  // Subtle engraved resting cradle mat on exit pad
  const pad0 = P(cfg.uMin + 24, exitV0 + 10, exitZ + 0.5);
  const pad1 = P(cfg.uMax - 8, exitV0 + 10, exitZ + 0.5);
  const pad2 = P(cfg.uMax - 8, exitV1 - 10, exitZ + 0.5);
  const pad3 = P(cfg.uMin + 24, exitV1 - 10, exitZ + 0.5);
  layers.push(el('polygon', {
    points: ptsStr([pad0, pad1, pad2, pad3]),
    fill: C.sunk, stroke: C.muted, 'stroke-width': '0.7',
  }));
  // In Step 7, the Merged item rests peacefully at the end of the line!
  if (step.mergedAtExit) {
    layers.push(drawItem(P, (cfg.uMin + 24 + cfg.uMax - 8) * 0.5, exitVMid, exitZ + 0.8, 'merged', cfg.itemScale * 0.96));
  }

  // --------------------------------------------------------------------------
  // 5. ASCENDING TERRACES (drawn back-to-front: Summit Merge -> Pick up!)
  // --------------------------------------------------------------------------
  const targets = {}; // anchor coords for callout leader lines
  let itemPixelWidth = 0;

  for (let i = terraces.length - 1; i >= 0; i--) {
    const t = terraces[i];
    const isMerge = t.key === 'merge';
    const isActive = step.activeStation === t.key;

    // Carved stepped terrace plinth rising from z=0 to t.zTop
    layers.push(isoBox(P, cfg.uMin, t.v0, 0, cfg.uMax, t.v1, t.zTop, {
      topFill: C.card,
      leftFill: C.sunk,
      rightFill: C.line,
      sw: 1.1,
      leftHatch: Math.max(2, Math.round(t.zTop / 10)),
      rightHatch: Math.max(1, Math.round(t.zTop / 18)),
      rightDir: 'horiz',
      bevelTop: true,
    }));

    // Twin precision brass dovetail rail lines along the work-track (u = +10)
    const railU0 = 2;
    const railU1 = 22;
    const rA0 = P(railU0, t.v0 + 2, t.zTop + 0.3);
    const rA1 = P(railU0, t.v1 - 2, t.zTop + 0.3);
    const rB0 = P(railU1, t.v0 + 2, t.zTop + 0.3);
    const rB1 = P(railU1, t.v1 - 2, t.zTop + 0.3);
    layers.push(el('path', {
      d: `M${f(rA0[0])},${f(rA0[1])}L${f(rA1[0])},${f(rA1[1])}M${f(rB0[0])},${f(rB0[1])}L${f(rB1[0])},${f(rB1[1])}`,
      fill: 'none',
      stroke: isMerge ? C.accent : C.strong,
      'stroke-width': '0.85',
      opacity: isMerge ? '0.45' : '0.8',
    }));

    // Subtle stepped riser guide-ramp connecting this terrace to the next terrace up
    if (i < terraces.length - 1) {
      const nextT = terraces[i + 1];
      const ramp0 = P(railU0 + 2, t.v1 - 5, t.zTop + 0.4);
      const ramp1 = P(railU1 - 2, t.v1 - 5, t.zTop + 0.4);
      const ramp2 = P(railU1 - 2, nextT.v0 + 5, nextT.zTop + 0.4);
      const ramp3 = P(railU0 + 2, nextT.v0 + 5, nextT.zTop + 0.4);
      layers.push(el('polygon', {
        points: ptsStr([ramp0, ramp1, ramp2, ramp3]),
        fill: C.sunk, stroke: C.muted, 'stroke-width': '0.7',
      }));
    }

    // Subtle warm --hl highlight pad under the currently acting station's work-spot
    if (isActive && !isMerge) {
      const h0 = P(-2, t.vMid - 20, t.zTop + 0.4);
      const h1 = P(26, t.vMid - 20, t.zTop + 0.4);
      const h2 = P(26, t.vMid + 20, t.zTop + 0.4);
      const h3 = P(-2, t.vMid + 20, t.zTop + 0.4);
      layers.push(el('polygon', {
        points: ptsStr([h0, h1, h2, h3]),
        fill: C.hl, stroke: C.muted, 'stroke-width': '0.65', opacity: '0.55',
      }));
    }

    const agentU = -18;
    const itemU = 12;

    if (isMerge) {
      const personSc = cfg.agentScale * 1.02;
      const person = drawPersonAtDesk(P, 2, t.vMid, t.zTop, personSc, {
        acting: step.activeStation === 'merge',
        hasQuestion: step.questionOnDesk,
      });
      layers.push(person.deskAndPerson);

      if (step.item && step.item.station === 'merge') {
        const iu = 2 + 11 * personSc;
        const iv = t.vMid + 5 * personSc;
        const iz = t.zTop + 18 * personSc;
        layers.push(drawItem(P, iu, iv, iz, step.item.form, cfg.itemScale));
        itemPixelWidth = +(57.02 * cfg.itemScale * camScale).toFixed(1);
        targets.item = P(iu + 6 * cfg.itemScale, iv - 6 * cfg.itemScale, iz + 6 * cfg.itemScale);
      }
      layers.push(person.actingArmAndStamp);

      targets.merge = P(2 - 16 * personSc, t.vMid + 4 * personSc, t.zTop + 58 * personSc);
      targets.question = P(2 + 10 * personSc, t.vMid - 18.5 * personSc, t.zTop + 36 * personSc);
    } else {
      // Draw subtle machined shavings on Build's bed in Step 3 to show Build has already worked on it!
      if (t.key === 'build' && step.buildShavings) {
        const sPt = P(itemU, t.vMid, t.zTop + 1);
        const ps = P.scale || 1;
        layers.push(el('path', {
          d: `M${f(sPt[0] - 8 * ps)},${f(sPt[1] + 1 * ps)}c${f(2 * ps)},${f(-3 * ps)} ${f(6 * ps)},${f(-3 * ps)} ${f(7 * ps)},0c${f(1 * ps)},${f(2 * ps)} ${f(-2 * ps)},${f(4 * ps)} ${f(-4 * ps)},${f(2 * ps)}M${f(sPt[0] + 3 * ps)},${f(sPt[1] - 2 * ps)}c${f(2 * ps)},${f(-3 * ps)} ${f(5 * ps)},${f(-2 * ps)} ${f(5 * ps)},${f(1 * ps)}M${f(sPt[0] - 2 * ps)},${f(sPt[1] + 5 * ps)}c${f(3 * ps)},${f(-2 * ps)} ${f(6 * ps)},${f(-1 * ps)} ${f(6 * ps)},${f(2 * ps)}`,
          fill: 'none', stroke: C.ink, 'stroke-width': f(0.95 * Math.sqrt(Math.max(0.7, ps))), 'stroke-linecap': 'round',
        }));
      }

      const pose = isActive ? 'act' : 'rest';
      const hasItemHere = step.item && step.item.station === t.key;
      if (hasItemHere) {
        const liftZ = step.item.lifted ? 11 * cfg.agentScale : 0.6;
        layers.push(drawItem(P, itemU, t.vMid, t.zTop + liftZ, step.item.form, cfg.itemScale));
        itemPixelWidth = +(57.02 * cfg.itemScale * camScale).toFixed(1);
        targets.item = P(itemU + 9 * cfg.itemScale, t.vMid - 10 * cfg.itemScale, t.zTop + liftZ + 6 * cfg.itemScale);
        targets.comments = P(itemU + 22 * cfg.itemScale, t.vMid + 2 * cfg.itemScale, t.zTop + 21 * cfg.itemScale);
        targets.checks = P(itemU + 6 * cfg.itemScale, t.vMid - 22 * cfg.itemScale, t.zTop + 4 * cfg.itemScale);
      }

      layers.push(drawMechanicalAgent(P, t.key, pose, agentU, t.vMid, t.zTop, cfg.agentScale));
      const anchorH = t.key === 'build' ? 28 : t.key === 'drive' && isActive ? 36 : 42;
      targets[t.key] = P(agentU, t.vMid, t.zTop + anchorH * cfg.agentScale);
    }
  }

  targets.followup = P(cfg.chuteU + 2, followVMid, followZ + 28 * cfg.agentScale);
  targets.exitItem = P((cfg.uMin + 24 + cfg.uMax - 8) * 0.5, exitVMid, exitZ + 11 * cfg.itemScale);
  const tChuteTarget = isWide ? 0.44 : 0.54;
  targets.chuteItem = P(cfg.chuteU, chuteBotV + (chuteTopV - chuteBotV) * tChuteTarget, chuteBotZ + (chuteTopZ - chuteBotZ) * tChuteTarget + 7);

  // --------------------------------------------------------------------------
  // 6. THRESHOLD SLOT / USAGE LIMIT WALL (between Queue and Pick up!)
  // --------------------------------------------------------------------------
  layers.push(isoBox(P, cfg.uMin - 4, cfg.wallV - 5, 0, cfg.uMax + 4, cfg.wallV + 5, 3, {
    topFill: C.strong, leftFill: C.line, rightFill: C.strong, sw: 0.9, leftHatch: 0,
  }));

  if (step.wallClosed) {
    const wallH = isWide ? 82 : 98;
    const sh0 = P(cfg.uMin - 4, cfg.wallV - 5, 1.5);
    const sh1 = P(cfg.uMax + 4, cfg.wallV - 5, 1.5);
    const sh2 = P(cfg.uMax + 4, cfg.wallV - 36, 1.5);
    const sh3 = P(cfg.uMin - 4, cfg.wallV - 36, 1.5);
    layers.push(hatchQuad(sh0, sh1, sh2, sh3, 9, C.muted, 0.7, 'horiz', '0.6'));
    layers.push(castShadowBox(P, cfg.uMax - 8, cfg.wallV - 5, cfg.uMax + 4, cfg.wallV + 5, 1, isWide ? 40 : 44, 8));
    layers.push(isoBox(P, cfg.uMin - 4, cfg.wallV - 5, 2, cfg.uMax + 4, cfg.wallV + 5, wallH, {
      topFill: C.card,
      leftFill: C.line,
      rightFill: C.strong,
      sw: 1.35,
      leftHatch: 11,
      leftDir: 'vert',
      rightHatch: 5,
      rightDir: 'vert',
    }));
    layers.push(isoBox(P, cfg.uMin - 6, cfg.wallV - 6.5, wallH, cfg.uMax + 6, cfg.wallV + 6.5, wallH + 5, {
      topFill: C.card, leftFill: C.sunk, rightFill: C.line, sw: 1.15, leftHatch: 1,
    }));
    targets.wall = P((cfg.uMin + cfg.uMax) * 0.5, cfg.wallV, wallH + 4);
  }

  // --------------------------------------------------------------------------
  // 7. QUEUE TRAY (bottom-left foot of the terraces)
  // --------------------------------------------------------------------------
  layers.push(isoBox(P, cfg.uMin, cfg.queueV0, 0, cfg.uMax, cfg.queueV1, 6, {
    topFill: C.sunk,
    leftFill: C.sunk,
    rightFill: C.line,
    sw: 1.1,
    leftHatch: 2,
    bevelTop: true,
  }));
  const q0 = P(cfg.uMin + 6, cfg.queueV0 + 5, 6.2);
  const q1 = P(cfg.uMax - 6, cfg.queueV0 + 5, 6.2);
  const q2 = P(cfg.uMax - 6, cfg.queueV1 - 5, 6.2);
  const q3 = P(cfg.uMin + 6, cfg.queueV1 - 5, 6.2);
  layers.push(el('polygon', {
    points: ptsStr([q0, q1, q2, q3]),
    fill: C.card, stroke: C.muted, 'stroke-width': '0.75',
  }));

  const qSlots = step.wallClosed
    ? [
        { u: 8, v: cfg.queueV1 - 14 },
        { u: -10, v: cfg.queueV0 + 36 },
        { u: 12, v: cfg.queueV0 + 18 },
      ]
    : [
        { u: 8, v: cfg.queueV1 - 16 },
        { u: -12, v: cfg.queueV0 + 34 },
        { u: 10, v: cfg.queueV0 + 16 },
      ];
  const visibleQ = qSlots.slice(0, step.queueCount).sort((a, b) => (a.u - a.v) - (b.u - b.v));
  for (const slot of visibleQ) {
    layers.push(drawItem(P, slot.u, slot.v, 6.4, 'issue', cfg.itemScale * 0.76));
  }
  targets.queue = P(6, (cfg.queueV0 + cfg.queueV1) * 0.5, 9);

  // --------------------------------------------------------------------------
  // 8. FRONT-RIGHT DISPATCHER PLINTH & FOUR READ-ONLY DIAL GAUGES
  // Physically separate from the track: gauges inform, NEVER block work!
  // --------------------------------------------------------------------------
  const dispActing = step.activeStation === 'dispatcher';
  const gSpecs = isWide
    ? {
        plinth: [100, 168, 0, 180, 476, 12],
        dispPos: [114, 318, 12],
        gauges: [
          { key: 'memory', label: 'Memory', u: 150, v: 205, frac: 0.42 },
          { key: 'processor', label: 'Processor', u: 150, v: 282, frac: 0.64 },
          { key: 'disk', label: 'Disk', u: 150, v: 360, frac: 0.34 },
          { key: 'forge', label: 'Forge budget', u: 150, v: 438, frac: 0.58 },
        ],
      }
    : {
        plinth: [64, 96, 0, 158, 396, 10],
        dispPos: [110, 355, 10],
        gauges: [
          { key: 'memory', label: 'Memory', u: 84, v: 266, frac: 0.42 },
          { key: 'processor', label: 'Processor', u: 138, v: 300, frac: 0.64 },
          { key: 'disk', label: 'Disk', u: 84, v: 134, frac: 0.34 },
          { key: 'forge', label: 'Forge budget', u: 138, v: 176, frac: 0.58 },
        ],
      };

  const [pu0, pv0, pz0, pu1, pv1, pz1] = gSpecs.plinth;
  layers.push(isoBox(P, pu0, pv0, pz0, pu1, pv1, pz1, {
    topFill: dispActing ? C.card : C.sunk,
    leftFill: C.sunk,
    rightFill: C.line,
    sw: dispActing ? 1.15 : 0.9,
    leftHatch: 2,
    bevelTop: true,
  }));

  const [du, dvPos, dzPos] = gSpecs.dispPos;
  layers.push(drawMechanicalAgent(
    P,
    'dispatcher',
    dispActing ? 'act' : 'rest',
    du,
    dvPos,
    dzPos,
    cfg.agentScale * (isWide ? 0.98 : 1.05)
  ));
  targets.dispatcher = P(du + 4, dvPos, dzPos + 28 * cfg.agentScale);

  const sortedGauges = [...gSpecs.gauges].sort((a, b) => (a.u - a.v) - (b.u - b.v));
  for (const g of sortedGauges) {
    layers.push(drawGauge(P, g.u, g.v, pz1, cfg.gaugeScale, g.frac));
    targets[g.key] = P(g.u, g.v, pz1 + 17 * cfg.gaugeScale);
  }

  // --------------------------------------------------------------------------
  // 9. CALLOUT LABELS (close to their targets, short leaders, ZERO overlap!)
  // --------------------------------------------------------------------------
  const calloutBoxes = [];
  let maxLeader = 0;
  const addLabel = (cx, cy, text, targetPt, opts = {}) => {
    const res = drawCallout(cx, cy, text, targetPt ? targetPt[0] : null, targetPt ? targetPt[1] : null, {
      fontSize: cfg.labelSize,
      ...opts,
    });
    if (targetPt) {
      const dist = Math.hypot(cx - targetPt[0], cy - targetPt[1]);
      if (dist > maxLeader) maxLeader = dist;
    }
    layers.push(res.svg);
    calloutBoxes.push(res.box);
  };
  // Place a label at (dx, dy) from its target, clamped cleanly inside the viewport!
  const addNear = (targetPt, dx, dy, text, opts = {}) => {
    const w = estimatePillWidth(text, cfg.labelSize);
    const h = Math.round(cfg.labelSize * 1.72);
    const cx = Math.max(w / 2 + 8, Math.min(W - w / 2 - 8, Math.round(targetPt[0] + dx)));
    const cy = Math.max(h / 2 + 8, Math.min(H - h / 2 - 8, Math.round(targetPt[1] + dy)));
    addLabel(cx, cy, text, targetPt, opts);
  };

  if (isWide) {
    if (step.id === 1) {
      addNear(targets.queue, -34, 62, 'Queue', { active: true });
      addNear(P(8, cfg.queueV1 - 16, 10), 42, 62, 'Issue');
      addLabel(220, 266, 'Pick up', targets.pickup);
      addLabel(292, 222, 'Build', targets.build);
      addLabel(364, 178, 'Open', targets.open);
      addLabel(436, 134, 'Drive', targets.drive);
      addLabel(508, 92, 'Repair', targets.repair);
      addLabel(550, 44, 'Follow up', targets.followup);
      addLabel(650, 44, 'Merge', targets.merge, { green: true });
    } else if (step.id === 2) {
      addNear(targets.queue, -10, 74, 'Queue');
      addNear(targets.pickup, -28, -52, 'Pick up', { active: true });
      addNear(targets.item, 80, 56, 'Issue', { active: true });
      addNear(targets.build, 54, -36, 'Build');
    } else if (step.id === 3) {
      addNear(targets.build, -44, -52, 'Build');
      addNear(targets.open, -18, -50, 'Open', { active: true });
      addNear(targets.item, 88, 52, 'Pull request', { active: true });
      addNear(targets.drive, -62, -14, 'Drive');
    } else if (step.id === 4) {
      addNear(targets.drive, -46, -54, 'Drive', { active: true });
      addNear(targets.comments, 84, 18, 'Comments', { active: true });
      addNear(targets.checks, 34, 52, 'Checks', { active: true });
      addNear(targets.repair, -46, -50, 'Repair');
      addNear(targets.merge, 48, -22, 'Merge', { green: true });
      addNear(targets.question, 108, -28, 'Question', { active: true });
    } else if (step.id === 5) {
      addNear(targets.drive, -50, -52, 'Drive');
      addNear(targets.repair, -26, -58, 'Repair', { active: true });
      addNear(targets.checks, 68, 54, 'Checks', { active: true, green: true });
      addNear(targets.merge, 10, -34, 'Merge', { green: true });
    } else if (step.id === 6) {
      addNear(targets.repair, -48, -50, 'Repair');
      addNear(targets.followup, -40, -52, 'Follow up');
      addNear(targets.merge, 4, -42, 'Merge', { active: true, green: true });
      addNear(targets.item, 82, 54, 'Merged', { active: true, green: true });
    } else if (step.id === 7) {
      // Short leaders for Merged and Issue — nothing crosses the stair!
      addNear(targets.queue, -34, 62, 'Queue');
      addLabel(220, 266, 'Pick up', targets.pickup);
      addLabel(292, 222, 'Build', targets.build);
      addLabel(364, 178, 'Open', targets.open);
      addLabel(436, 134, 'Drive', targets.drive);
      addLabel(508, 92, 'Repair', targets.repair);
      addNear(targets.followup, -46, -44, 'Follow up', { active: true });
      addNear(targets.merge, 18, -54, 'Merge', { green: true });
      addNear(targets.exitItem, 64, -34, 'Merged', { green: true });
      addNear(targets.chuteItem, -58, -32, 'Issue', { active: true });
    } else if (step.id === 8) {
      addNear(targets.queue, -34, 62, 'Queue', { active: true });
      addLabel(152, 266, 'Usage limit', targets.wall, { active: true });
      addLabel(510, 294, 'Dispatcher', targets.dispatcher, { active: true });
      addLabel(456, 486, 'Memory', targets.memory);
      addLabel(564, 468, 'Processor', targets.processor);
      addLabel(674, 444, 'Disk', targets.disk);
      addLabel(794, 418, 'Forge budget', targets.forge);
      addNear(targets.merge, 6, -48, 'Merge', { green: true });
    }
  } else {
    // TALL (390 x 520): Portrait-native label layout with 14px text, short crisp leaders!
    if (step.id === 1) {
      addLabel(58, 496, 'Queue', targets.queue, { active: true });
      addLabel(152, 496, 'Issue', P(8, cfg.queueV1 - 16, 10));
      addLabel(64, 342, 'Pick up', targets.pickup);
      addLabel(116, 230, 'Drive', targets.drive);
      addNear(targets.followup, -74, -40, 'Follow up');
      addNear(targets.merge, 12, -56, 'Merge', { green: true });
    } else if (step.id === 2) {
      addNear(targets.queue, 12, 66, 'Queue');
      addNear(targets.pickup, -24, -52, 'Pick up', { active: true });
      addNear(targets.item, 44, 66, 'Issue', { active: true });
    } else if (step.id === 3) {
      addNear(targets.build, -10, -52, 'Build');
      addNear(targets.open, -34, -52, 'Open', { active: true });
      addNear(targets.item, 48, 64, 'Pull request', { active: true });
    } else if (step.id === 4) {
      addNear(targets.drive, -10, -56, 'Drive', { active: true });
      addNear(targets.comments, 84, 8, 'Comments', { active: true });
      addNear(targets.checks, 66, 46, 'Checks', { active: true });
      addNear(targets.merge, -78, -10, 'Merge', { green: true });
      addNear(targets.question, -78, 34, 'Question', { active: true });
    } else if (step.id === 5) {
      addNear(targets.repair, -22, -58, 'Repair', { active: true });
      addNear(targets.checks, 68, 50, 'Checks', { active: true, green: true });
      addNear(targets.merge, -66, -24, 'Merge', { green: true });
    } else if (step.id === 6) {
      addNear(targets.merge, -14, -46, 'Merge', { active: true, green: true });
      addNear(targets.item, 46, 66, 'Merged', { active: true, green: true });
      addNear(targets.repair, 16, -54, 'Repair');
    } else if (step.id === 7) {
      // Short crisp leaders — Merged sits right above-right of exitItem, never crossing the stair!
      addLabel(58, 496, 'Queue', targets.queue);
      addNear(targets.followup, -74, -40, 'Follow up', { active: true });
      addNear(targets.merge, 12, -62, 'Merge', { green: true });
      addNear(targets.exitItem, 56, -12, 'Merged', { green: true });
      addNear(targets.chuteItem, -52, -26, 'Issue', { active: true });
    } else if (step.id === 8) {
      addLabel(52, 496, 'Queue', targets.queue, { active: true });
      addLabel(76, 304, 'Usage limit', targets.wall, { active: true });
      addLabel(326, 316, 'Dispatcher', targets.dispatcher, { active: true });
      addLabel(212, 326, 'Memory', targets.memory);
      addLabel(334, 454, 'Processor', targets.processor);
      addLabel(152, 496, 'Disk', targets.disk);
      addLabel(274, 496, 'Forge budget', targets.forge);
      addNear(targets.merge, 4, -52, 'Merge', { green: true });
    }
  }

  // Self-check label bounds and overlaps immediately
  for (const b of calloutBoxes) {
    if (b.x < 4 || b.y < 4 || b.x2 > W - 4 || b.y2 > H - 4) {
      throw new Error(`Label "${b.text}" out of bounds in ${format}/step-${step.id}: [${b.x},${b.y},${b.x2},${b.y2}]`);
    }
  }
  for (let i = 0; i < calloutBoxes.length; i++) {
    for (let j = i + 1; j < calloutBoxes.length; j++) {
      const a = calloutBoxes[i];
      const b = calloutBoxes[j];
      const overlap = !(a.x2 + 2 < b.x || b.x2 + 2 < a.x || a.y2 + 2 < b.y || b.y2 + 2 < a.y);
      if (overlap) {
        throw new Error(`Label overlap in ${format}/step-${step.id}: "${a.text}" vs "${b.text}"`);
      }
    }
  }

  return {
    svg: wrapSvg(W, H, layers.join('\n')),
    itemPixelWidth,
    maxLeader: Math.round(maxLeader),
  };
}

