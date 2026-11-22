import { C, castShadowBox, el, f, isoBox, isoCyl, lerpPt, ptsStr } from './lib.mjs';

// ============================================================================
// THE SEVEN MECHANICAL WATCHMAKER AGENTS (rest | reach | act)
// Pure ink, paper and grey. NEVER green. No faces or human features.
// Each stands anchored on a bolted base flange at (cu, cv, z).
// ============================================================================
export function drawMechanicalAgent(P, kind, pose, cu, cv, z, sc = 1) {
  const out = [];
  const ps = P.scale || 1;
  const s = sc * ps; // screen-space scale factor for radii, thicknesses, offsets
  const sw = 1.1 * Math.sqrt(Math.max(0.65, s));
  const swThin = 0.75 * Math.sqrt(Math.max(0.65, s));
  const swS = Math.sqrt(Math.max(0.65, s));

  // Utility: bolted octagonal/cylindrical mounting pedestal
  const drawPedestal = (r = 10, h = 6) => {
    let str = castShadowBox(P, cu - r * sc, cv - r * sc, cu + r * sc, cv + r * sc, z, 11 * sc, 4);
    str += isoCyl(P, cu, cv, z, z + h * sc, r * sc, {
      topFill: C.card,
      bodyFill: C.sunk,
      sw,
      shadeLines: 4,
    });
    return str;
  };

  // Utility: thick isometric mechanical bar/arm segment between two 3D points
  const drawArm = (pA, pB, thick = 4.2, fill = C.card) => {
    const a = P(...pA);
    const b = P(...pB);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (thick * 0.5 * s);
    const ny = (dx / len) * (thick * 0.5 * s);
    const pts = [
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
      [b[0] - nx, b[1] - ny],
      [a[0] - nx, a[1] - ny],
    ];
    return el('polygon', {
      points: ptsStr(pts),
      fill,
      stroke: C.ink,
      'stroke-width': f(sw),
      'stroke-linejoin': 'round',
    });
  };

  const drawJoint = (pt, r = 3.2, fill = C.line) => {
    const p = P(...pt);
    return (
      el('circle', { cx: f(p[0]), cy: f(p[1]), r: f(r * s), fill, stroke: C.ink, 'stroke-width': f(sw) }) +
      el('circle', { cx: f(p[0]), cy: f(p[1]), r: f(r * 0.38 * s), fill: C.ink, stroke: 'none' })
    );
  };

  // --------------------------------------------------------------------------
  // 1. PICK UP — Articulated Tweezer Crane
  // --------------------------------------------------------------------------
  if (kind === 'pickup') {
    out.push(drawPedestal(10.5, 5.5));
    // Vertical fluted pillar
    out.push(isoCyl(P, cu, cv, z + 5.5 * sc, z + 36 * sc, 4.4 * sc, {
      topFill: C.line,
      bodyFill: C.sunk,
      sw,
      shadeLines: 3,
    }));

    const pivot = [cu, cv, z + 34 * sc];
    let tail, tip, dropZ, spread;
    if (pose === 'rest') {
      tail = [cu - 11 * sc, cv + 8 * sc, z + 30 * sc];
      tip = [cu + 15 * sc, cv - 8 * sc, z + 42 * sc];
      dropZ = 18 * sc;
      spread = 2.6 * sc;
    } else if (pose === 'reach') {
      tail = [cu - 11 * sc, cv + 12 * sc, z + 38 * sc];
      tip = [cu + 18 * sc, cv - 24 * sc, z + 31 * sc];
      dropZ = 19 * sc;
      spread = 8.5 * sc;
    } else {
      // act: gripping lifted item squarely over work pad
      tail = [cu - 13 * sc, cv - 5 * sc, z + 31 * sc];
      tip = [cu + 31 * sc, cv + 1 * sc, z + 37 * sc];
      dropZ = 20 * sc;
      spread = 7.2 * sc;
    }

    // Counterweight jib + brass ball
    out.push(drawArm(tail, tip, 4.2, C.card));
    const cwP = P(...tail);
    out.push(el('circle', { cx: f(cwP[0]), cy: f(cwP[1]), r: f(4.4 * s), fill: C.strong, stroke: C.ink, 'stroke-width': f(sw) }));
    out.push(drawJoint(pivot, 3.6, C.sunk));

    // Suspended twin spring-loaded watchmaker tweezer blades
    const collar = [tip[0], tip[1], tip[2] - 4.5 * sc];
    const bL = [tip[0] - spread, tip[1] - spread * 0.55, tip[2] - dropZ];
    const bR = [tip[0] + spread, tip[1] + spread * 0.55, tip[2] - dropZ];
    const cPt = P(...collar);
    const lPt = P(...bL);
    const rPt = P(...bR);
    const midL = lerpPt(cPt, lPt, 0.55);
    const midR = lerpPt(cPt, rPt, 0.55);

    out.push(drawArm(tip, collar, 2.8, C.line));
    out.push(el('path', {
      d: `M${f(cPt[0])},${f(cPt[1])}Q${f(midL[0] - 2.5 * s)},${f(midL[1])} ${f(lPt[0])},${f(lPt[1])}`,
      fill: 'none',
      stroke: C.ink,
      'stroke-width': f(2.1 * swS),
      'stroke-linecap': 'round',
    }));
    out.push(el('path', {
      d: `M${f(cPt[0])},${f(cPt[1])}Q${f(midR[0] + 2.5 * s)},${f(midR[1])} ${f(rPt[0])},${f(rPt[1])}`,
      fill: 'none',
      stroke: C.ink,
      'stroke-width': f(2.1 * swS),
      'stroke-linecap': 'round',
    }));
    // Small brass knurled collar at tweezer crown
    out.push(drawJoint(tip, 2.6, C.card));
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 2. BUILD — Jeweller's Lathe
  // --------------------------------------------------------------------------
  if (kind === 'build') {
    // Ribbed cast-iron lathe bed along v-axis
    out.push(castShadowBox(P, cu - 10 * sc, cv - 18 * sc, cu + 10 * sc, cv + 18 * sc, z, 11 * sc, 5));
    // Twin cast feet
    out.push(isoBox(P, cu - 9 * sc, cv - 17 * sc, z, cu + 9 * sc, cv - 11 * sc, z + 7 * sc, { sw, leftHatch: 2, rightFill: C.strong }));
    out.push(isoBox(P, cu - 9 * sc, cv + 11 * sc, z, cu + 9 * sc, cv + 17 * sc, z + 7 * sc, { sw, leftHatch: 2, rightFill: C.strong }));
    // Horizontal dovetail bed bar
    out.push(isoBox(P, cu - 7.5 * sc, cv - 18 * sc, z + 7 * sc, cu + 7.5 * sc, cv + 18 * sc, z + 13 * sc, {
      sw,
      topFill: C.card,
      leftFill: C.sunk,
      rightFill: C.line,
      leftHatch: 2,
    }));
    // Headstock housing (at +v end)
    out.push(isoBox(P, cu - 7.5 * sc, cv + 6 * sc, z + 13 * sc, cu + 7.5 * sc, cv + 17 * sc, z + 27 * sc, {
      sw,
      topFill: C.card,
      leftFill: C.sunk,
      rightFill: C.line,
      leftHatch: 4,
    }));
    // Spoked brass handwheel on outer headstock
    const hwC = P(cu, cv + 20 * sc, z + 21 * sc);
    const wr = 9.5 * s;
    out.push(el('ellipse', { cx: f(hwC[0]), cy: f(hwC[1]), rx: f(wr * 0.72), ry: f(wr), fill: C.sunk, stroke: C.ink, 'stroke-width': f(sw * 1.15) }));
    out.push(el('ellipse', { cx: f(hwC[0]), cy: f(hwC[1]), rx: f(wr * 0.5), ry: f(wr * 0.7), fill: C.card, stroke: C.ink, 'stroke-width': f(swThin) }));
    const rot = pose === 'act' ? 0.55 : pose === 'reach' ? 0.25 : 0;
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 4;
      const dx = Math.cos(a) * wr * 0.5;
      const dy = Math.sin(a) * wr * 0.7;
      out.push(el('line', {
        x1: f(hwC[0] - dx), y1: f(hwC[1] - dy), x2: f(hwC[0] + dx), y2: f(hwC[1] + dy),
        stroke: C.ink, 'stroke-width': f(swThin),
      }));
    }
    out.push(el('circle', { cx: f(hwC[0]), cy: f(hwC[1]), r: f(2.2 * s), fill: C.strong, stroke: C.ink, 'stroke-width': f(swThin) }));

    // Horizontal spindle chuck + tailstock
    out.push(drawArm([cu, cv + 6 * sc, z + 21 * sc], [cu, cv - 12 * sc, z + 21 * sc], 3.0, C.line));
    out.push(isoBox(P, cu - 5 * sc, cv - 16 * sc, z + 13 * sc, cu + 5 * sc, cv - 11 * sc, z + 24 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 2,
    }));

    // Sliding cross-slide tool carriage + cutter arm (moves per pose!)
    const slideV = pose === 'rest' ? cv - 6 * sc : pose === 'reach' ? cv - 1 * sc : cv + 1 * sc;
    out.push(isoBox(P, cu - 4 * sc, slideV - 4 * sc, z + 13 * sc, cu + 10 * sc, slideV + 4 * sc, z + 19 * sc, {
      sw, topFill: C.line, leftFill: C.sunk, rightFill: C.strong, leftHatch: 2,
    }));
    const armBase = [cu + 6 * sc, slideV, z + 19 * sc];
    let armTip;
    if (pose === 'rest') {
      armTip = [cu + 7 * sc, slideV - 2 * sc, z + 33 * sc];
    } else if (pose === 'reach') {
      armTip = [cu + 18 * sc, slideV, z + 26 * sc];
    } else {
      armTip = [cu + 24 * sc, slideV, z + 15 * sc];
    }
    out.push(drawArm(armBase, armTip, 3.2, C.card));
    out.push(drawJoint(armBase, 2.5, C.sunk));
    // Fine cutting chisel tip
    const t0 = P(...armTip);
    const t1 = P(armTip[0] + (pose === 'rest' ? 0 : 4.5 * sc), armTip[1], armTip[2] + (pose === 'rest' ? 4 * sc : -3.5 * sc));
    out.push(el('line', { x1: f(t0[0]), y1: f(t0[1]), x2: f(t1[0]), y2: f(t1[1]), stroke: C.ink, 'stroke-width': f(1.9 * swS), 'stroke-linecap': 'round' }));

    // Tiny curled brass shavings beside the cutter in act pose
    if (pose === 'act') {
      const sh = P(cu + 20 * sc, slideV - 4 * sc, z + 6 * sc);
      out.push(el('path', {
        d: `M${f(sh[0] - 4 * s)},${f(sh[1])}c${f(2 * s)},${f(-3 * s)} ${f(5 * s)},${f(-3 * s)} ${f(6 * s)},0c${f(1 * s)},${f(2 * s)} ${f(-2 * s)},${f(4 * s)} ${f(-4 * s)},${f(2 * s)}M${f(sh[0] + 4 * s)},${f(sh[1] + 2 * s)}c${f(2 * s)},${f(-2 * s)} ${f(4 * s)},${f(-1 * s)} ${f(4 * s)},${f(2 * s)}`,
        fill: 'none',
        stroke: C.ink,
        'stroke-width': f(0.95 * swS),
        'stroke-linecap': 'round',
      }));
    }
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 3. OPEN — Screw Clasp Press (Twin-pillar arch press with leadscrew)
  // --------------------------------------------------------------------------
  if (kind === 'open') {
    out.push(castShadowBox(P, cu - 12 * sc, cv - 13 * sc, cu + 12 * sc, cv + 13 * sc, z, 12 * sc, 5));
    // Solid platen base
    out.push(isoBox(P, cu - 11 * sc, cv - 13 * sc, z, cu + 11 * sc, cv + 13 * sc, z + 6 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 2,
    }));
    // Twin vertical guide pillars
    out.push(isoCyl(P, cu, cv - 10 * sc, z + 6 * sc, z + 36 * sc, 2.7 * sc, { sw, shadeLines: 2 }));
    out.push(isoCyl(P, cu, cv + 10 * sc, z + 6 * sc, z + 36 * sc, 2.7 * sc, { sw, shadeLines: 2 }));
    // Crown arch crossbar connecting the pillars
    out.push(isoBox(P, cu - 5.5 * sc, cv - 13 * sc, z + 35 * sc, cu + 5.5 * sc, cv + 13 * sc, z + 41 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 2,
    }));

    // Screw height & crossbar angle by pose
    const screwDrop = pose === 'rest' ? 0 : pose === 'reach' ? 9 * sc : 18 * sc;
    const footZ = z + 27 * sc - screwDrop;
    const screwTopZ = z + 51 * sc - screwDrop;

    // Threaded vertical leadscrew (with engraved screw thread ticks!)
    out.push(isoCyl(P, cu, cv, footZ + 2 * sc, screwTopZ, 2.5 * sc, { sw, topFill: C.line, bodyFill: C.card, shadeLines: 0 }));
    const threadSegs = [];
    for (let tz = footZ + 4 * sc; tz < screwTopZ - 2 * sc; tz += 2.8 * sc) {
      const a = P(cu - 2.3 * sc, cv, tz);
      const b = P(cu + 2.3 * sc, cv, tz + 1.1 * sc);
      threadSegs.push(`M${f(a[0])},${f(a[1])}L${f(b[0])},${f(b[1])}`);
    }
    out.push(el('path', { d: threadSegs.join(''), fill: 'none', stroke: C.ink, 'stroke-width': f(0.65 * swS) }));

    // Crimping foot / hinged presser bar extending forward (+u) onto the hinge spine
    const reachU = pose === 'act' ? 24 * sc : pose === 'reach' ? 18 * sc : 11 * sc;
    out.push(isoBox(P, cu - 5 * sc, cv - 7 * sc, footZ, cu + reachU, cv + 7 * sc, footZ + 4 * sc, {
      sw, topFill: C.line, leftFill: C.sunk, rightFill: C.strong, leftHatch: 2,
    }));

    // Weighted fly-press crossbar atop the leadscrew
    const barAng = pose === 'rest' ? 0 : pose === 'reach' ? 0.55 : 1.15;
    const rBar = 16 * sc;
    const bA = [cu + Math.sin(barAng) * rBar, cv - Math.cos(barAng) * rBar, screwTopZ];
    const bB = [cu - Math.sin(barAng) * rBar, cv + Math.cos(barAng) * rBar, screwTopZ];
    out.push(drawArm(bA, bB, 3.0, C.card));
    const pA = P(...bA);
    const pB = P(...bB);
    out.push(el('circle', { cx: f(pA[0]), cy: f(pA[1]), r: f(3.6 * s), fill: C.strong, stroke: C.ink, 'stroke-width': f(sw) }));
    out.push(el('circle', { cx: f(pB[0]), cy: f(pB[1]), r: f(3.6 * s), fill: C.strong, stroke: C.ink, 'stroke-width': f(sw) }));
    out.push(drawJoint([cu, cv, screwTopZ], 3.0, C.sunk));
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 4. DRIVE — Articulated Loupe & Caliper Probe
  // --------------------------------------------------------------------------
  if (kind === 'drive') {
    out.push(drawPedestal(10, 6));
    out.push(isoCyl(P, cu, cv, z + 6 * sc, z + 21 * sc, 4.2 * sc, { sw, shadeLines: 3 }));

    const shoulder = [cu, cv, z + 20 * sc];
    let elbow, wrist, lensTilt, probeTip;
    if (pose === 'rest') {
      elbow = [cu - 6 * sc, cv + 4 * sc, z + 39 * sc];
      wrist = [cu + 4 * sc, cv + 2 * sc, z + 48 * sc];
      lensTilt = 'up';
      probeTip = [cu + 9 * sc, cv - 4 * sc, z + 42 * sc];
    } else if (pose === 'reach') {
      elbow = [cu + 6 * sc, cv + 4 * sc, z + 37 * sc];
      wrist = [cu + 19 * sc, cv + 1 * sc, z + 34 * sc];
      lensTilt = 'mid';
      probeTip = [cu + 22 * sc, cv - 9 * sc, z + 23 * sc];
    } else {
      // act: loupe hovering squarely above the open pull request + caliper needle pointing at failed check!
      elbow = [cu + 10 * sc, cv + 5 * sc, z + 38 * sc];
      wrist = [cu + 26 * sc, cv + 2 * sc, z + 29 * sc];
      lensTilt = 'flat';
      probeTip = [cu + 35 * sc, cv - 21 * sc, z + 8 * sc];
    }

    // Double-jointed pantograph swing-arm
    out.push(drawArm(shoulder, elbow, 3.8, C.card));
    out.push(drawArm(elbow, wrist, 3.4, C.card));
    out.push(drawJoint(shoulder, 3.2, C.sunk));
    out.push(drawJoint(elbow, 3.4, C.line));

    // Fine micrometer caliper probe branching from wrist
    out.push(drawArm(wrist, probeTip, 1.5, C.strong));
    const ptTip = P(...probeTip);
    out.push(el('circle', { cx: f(ptTip[0]), cy: f(ptTip[1]), r: f(1.5 * s), fill: C.ink }));

    // Wide bevelled watchmaker's optical loupe (cylindrical rim + gleaming glass lens!)
    const lC = P(...wrist);
    const rx = (lensTilt === 'up' ? 5.5 : 10.5) * s;
    const ry = (lensTilt === 'up' ? 9.5 : lensTilt === 'mid' ? 6.8 : 5.4) * s;
    // Outer metal bezel cylinder rim
    out.push(el('ellipse', {
      cx: f(lC[0]), cy: f(lC[1] + 2.4 * s), rx: f(rx), ry: f(ry),
      fill: C.strong, stroke: C.ink, 'stroke-width': f(sw),
    }));
    out.push(el('ellipse', {
      cx: f(lC[0]), cy: f(lC[1]), rx: f(rx), ry: f(ry),
      fill: C.line, stroke: C.ink, 'stroke-width': f(sw),
    }));
    // Inner glass lens disc
    out.push(el('ellipse', {
      cx: f(lC[0]), cy: f(lC[1]), rx: f(rx * 0.74), ry: f(ry * 0.72),
      fill: C.card, stroke: C.ink, 'stroke-width': f(swThin),
    }));
    // Engraved diagonal glass reflection glint lines
    out.push(el('path', {
      d: `M${f(lC[0] - rx * 0.38)},${f(lC[1] + ry * 0.15)}L${f(lC[0] + rx * 0.12)},${f(lC[1] - ry * 0.42)}M${f(lC[0] - rx * 0.1)},${f(lC[1] + ry * 0.34)}L${f(lC[0] + rx * 0.34)},${f(lC[1] - ry * 0.16)}`,
      fill: 'none', stroke: C.muted, 'stroke-width': f(0.8 * swS), 'stroke-linecap': 'round',
    }));
    out.push(drawJoint(wrist, 2.2, C.sunk));
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 5. REPAIR — Indexing Staking Turret (Watchmaker's Graver & Die)
  // --------------------------------------------------------------------------
  if (kind === 'repair') {
    out.push(drawPedestal(11, 5.5));
    // Stout C-frame anvil column
    out.push(isoBox(P, cu - 6 * sc, cv - 6 * sc, z + 5.5 * sc, cu + 5 * sc, cv + 6 * sc, z + 35 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 5,
    }));

    // Cantilever overhang reaching forward (+u) depending on pose
    const ext = pose === 'rest' ? 11 * sc : pose === 'reach' ? 19 * sc : 30 * sc;
    const headZ = z + 32 * sc;
    out.push(isoBox(P, cu - 4 * sc, cv - 5 * sc, headZ, cu + ext, cv + 5 * sc, headZ + 6 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 2,
    }));

    // Rotating multi-punch staking turret drum mounted under the overhang
    const drumU = cu + ext - 3 * sc;
    out.push(isoCyl(P, drumU, cv, headZ - 8 * sc, headZ + 1 * sc, 7.2 * sc, {
      sw, topFill: C.line, bodyFill: C.sunk, shadeLines: 4,
    }));
    // Indexing flutes/punches around turret rim
    const punchDrop = pose === 'rest' ? 6 * sc : pose === 'reach' ? 13 * sc : 19 * sc;
    const tipZ = headZ - 8 * sc - punchDrop;
    // Vertical striker shaft + spring above crown
    out.push(drawArm([drumU, cv, headZ + 6 * sc], [drumU, cv, headZ + 17 * sc - (pose === 'act' ? 5 * sc : 0)], 2.8, C.line));
    const knob = P(drumU, cv, headZ + 17 * sc - (pose === 'act' ? 5 * sc : 0));
    out.push(el('ellipse', { cx: f(knob[0]), cy: f(knob[1]), rx: f(4.6 * s), ry: f(2.6 * s), fill: C.strong, stroke: C.ink, 'stroke-width': f(sw) }));
    // Active graver/staking punch descending from turret
    out.push(drawArm([drumU, cv, headZ - 8 * sc], [drumU, cv, tipZ], 2.4, C.card));
    // Secondary idle side punches tucked on drum
    const side1 = P(drumU - 4.5 * sc, cv - 4 * sc, headZ - 8 * sc);
    const side1b = P(drumU - 4.5 * sc, cv - 4 * sc, headZ - 14 * sc);
    const side2 = P(drumU + 4.5 * sc, cv + 4 * sc, headZ - 8 * sc);
    const side2b = P(drumU + 4.5 * sc, cv + 4 * sc, headZ - 14 * sc);
    out.push(el('path', {
      d: `M${f(side1[0])},${f(side1[1])}L${f(side1b[0])},${f(side1b[1])}M${f(side2[0])},${f(side2[1])}L${f(side2b[0])},${f(side2b[1])}`,
      fill: 'none', stroke: C.ink, 'stroke-width': f(1.3 * swS), 'stroke-linecap': 'round',
    }));

    // Subtle crisp engraved concentric strike tick-marks at tip when acting!
    if (pose === 'act') {
      const stP = P(drumU, cv, tipZ);
      out.push(el('path', {
        d: `M${f(stP[0] - 6 * s)},${f(stP[1])}L${f(stP[0] - 3 * s)},${f(stP[1])}M${f(stP[0] + 3 * s)},${f(stP[1])}L${f(stP[0] + 6 * s)},${f(stP[1])}`,
        fill: 'none', stroke: C.ink, 'stroke-width': f(0.95 * swS), 'stroke-linecap': 'round',
      }));
    }
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 6. FOLLOW UP — Escapement Chute Pusher
  // --------------------------------------------------------------------------
  if (kind === 'followup') {
    out.push(castShadowBox(P, cu - 9 * sc, cv - 9 * sc, cu + 9 * sc, cv + 9 * sc, z, 9 * sc, 4));
    out.push(isoBox(P, cu - 8.5 * sc, cv - 8.5 * sc, z, cu + 8.5 * sc, cv + 8.5 * sc, z + 10 * sc, {
      sw, topFill: C.card, leftFill: C.sunk, rightFill: C.line, leftHatch: 3,
    }));
    // Watchmaker's toothed escapement wheel standing vertically above housing
    const wC = P(cu, cv, z + 21 * sc);
    const wr = 9 * s;
    const rot = pose === 'act' ? 0.65 : pose === 'reach' ? 0.3 : 0;
    const teethPts = [];
    const nTeeth = 10;
    for (let i = 0; i < nTeeth; i++) {
      const a0 = rot + (i / nTeeth) * Math.PI * 2;
      const a1 = rot + ((i + 0.45) / nTeeth) * Math.PI * 2;
      teethPts.push([wC[0] + Math.cos(a0) * wr * 0.95, wC[1] + Math.sin(a0) * wr * 0.95]);
      teethPts.push([wC[0] + Math.cos(a1) * wr * 0.68, wC[1] + Math.sin(a1) * wr * 0.68]);
    }
    out.push(el('polygon', {
      points: ptsStr(teethPts),
      fill: C.sunk,
      stroke: C.ink,
      'stroke-width': f(sw * 0.95),
      'stroke-linejoin': 'round',
    }));
    out.push(el('circle', { cx: f(wC[0]), cy: f(wC[1]), r: f(wr * 0.38), fill: C.card, stroke: C.ink, 'stroke-width': f(swThin) }));
    out.push(el('circle', { cx: f(wC[0]), cy: f(wC[1]), r: f(1.8 * s), fill: C.ink }));

    // Bell-crank pusher lever tipping down toward the chute (-v direction!)
    const piv = [cu, cv, z + 21 * sc];
    let elbow, foot;
    if (pose === 'rest') {
      elbow = [cu + 2 * sc, cv + 5 * sc, z + 33 * sc];
      foot = [cu + 3 * sc, cv + 9 * sc, z + 29 * sc];
    } else if (pose === 'reach') {
      elbow = [cu, cv - 9 * sc, z + 28 * sc];
      foot = [cu, cv - 15 * sc, z + 20 * sc];
    } else {
      // act: swept firmly down into the chute mouth (-v)
      elbow = [cu, cv - 13 * sc, z + 19 * sc];
      foot = [cu, cv - 22 * sc, z + 10 * sc];
    }
    out.push(drawArm(piv, elbow, 3.2, C.card));
    out.push(drawArm(elbow, foot, 2.8, C.line));
    out.push(drawJoint(elbow, 2.2, C.sunk));
    // Small flat brass pusher shoe at lever tip
    const shoeA = P(foot[0] - 3 * sc, foot[1], foot[2] + 2 * sc);
    const shoeB = P(foot[0] + 3 * sc, foot[1], foot[2] - 2 * sc);
    out.push(el('line', { x1: f(shoeA[0]), y1: f(shoeA[1]), x2: f(shoeB[0]), y2: f(shoeB[1]), stroke: C.ink, 'stroke-width': f(2.2 * swS), 'stroke-linecap': 'round' }));
    return el('g', {}, out.join(''));
  }

  // --------------------------------------------------------------------------
  // 7. DISPATCHER — Dial-Reading Optical Vernier Arm (Reads gauges, never touches track!)
  // --------------------------------------------------------------------------
  if (kind === 'dispatcher') {
    out.push(drawPedestal(9.5, 5));
    // Calibrated azimuth collar (unnumbered ticks)
    out.push(isoCyl(P, cu, cv, z + 5 * sc, z + 15 * sc, 5.4 * sc, { sw, topFill: C.card, bodyFill: C.line, shadeLines: 3 }));

    const piv = [cu, cv, z + 15 * sc];
    let mid, sight, lensP;
    if (pose === 'rest') {
      mid = [cu - 2 * sc, cv + 2 * sc, z + 30 * sc];
      sight = [cu + 2 * sc, cv - 1 * sc, z + 38 * sc];
      lensP = [cu + 6 * sc, cv - 2 * sc, z + 38 * sc];
    } else if (pose === 'reach') {
      mid = [cu + 8 * sc, cv - 2 * sc, z + 29 * sc];
      sight = [cu + 17 * sc, cv - 4 * sc, z + 24 * sc];
      lensP = [cu + 21 * sc, cv - 5 * sc, z + 20 * sc];
    } else {
      // act: bent low forward (+u) over the dial gauge bank, twin vernier sight reading!
      mid = [cu + 11 * sc, cv - 3 * sc, z + 27 * sc];
      sight = [cu + 25 * sc, cv - 5 * sc, z + 17 * sc];
      lensP = [cu + 29 * sc, cv - 6 * sc, z + 12 * sc];
    }

    out.push(drawArm(piv, mid, 3.2, C.card));
    out.push(drawArm(mid, sight, 2.8, C.card));
    out.push(drawJoint(piv, 2.8, C.sunk));
    out.push(drawJoint(mid, 2.6, C.line));

    // Twin-prong optical vernier sight / magnifying pointer
    const sPt = P(...sight);
    const lPt = P(...lensP);
    out.push(el('line', { x1: f(sPt[0]), y1: f(sPt[1]), x2: f(lPt[0]), y2: f(lPt[1]), stroke: C.ink, 'stroke-width': f(1.7 * swS), 'stroke-linecap': 'round' }));
    // Small brass vernier sighting ring (no green!)
    out.push(el('ellipse', {
      cx: f(sPt[0]), cy: f(sPt[1]), rx: f(5.2 * s), ry: f(3.4 * s),
      fill: C.card, stroke: C.ink, 'stroke-width': f(sw),
    }));
    out.push(el('circle', { cx: f(sPt[0]), cy: f(sPt[1]), r: f(1.3 * s), fill: C.ink }));
    return el('g', {}, out.join(''));
  }

  return '';
}

