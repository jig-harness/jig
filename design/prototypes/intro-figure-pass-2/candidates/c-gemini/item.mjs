import { C, CX, CY, castShadowBox, el, f, hatchQuad, isoBox, isoCyl, lerpPt, ptsStr } from './lib.mjs';

// ============================================================================
// THE ITEM'S FIVE FORMS (notched watchmaker's movement folio-plate family)
// Forms: 'issue' | 'pr' | 'review' | 'green' | 'merged'
// ============================================================================
export function drawItem(P, cu, cv, z, form = 'issue', sz = 1, opts = {}) {
  const { shadow = true } = opts;
  const ps = P.scale || 1;
  const s = sz * ps; // screen-space scale for circles, ellipses, rings, marks
  const swS = Math.sqrt(Math.max(0.65, s));
  const hw = 14 * sz; // half u-width
  const hl = 19 * sz; // half v-length
  const th = 3.6 * sz; // base plate thickness
  const out = [];

  if (shadow) {
    out.push(castShadowBox(P, cu - hw, cv - hl, cu + hw, cv + hl, z, 9 * sz, 4));
  }

  // Notched rectangular base movement plate: registration notch cut at corner (cu-hw, cv-hl)
  const n = 4.5 * sz;
  const topPoly = [
    P(cu - hw + n, cv - hl, z + th),
    P(cu + hw, cv - hl, z + th),
    P(cu + hw, cv + hl, z + th),
    P(cu - hw, cv + hl, z + th),
    P(cu - hw, cv - hl + n, z + th),
  ];
  const b0 = P(cu - hw + n, cv - hl, z);
  const b1 = P(cu + hw, cv - hl, z);
  const b2 = P(cu + hw, cv + hl, z);
  const b4 = P(cu - hw, cv - hl + n, z);

  // Notch bevel edge + front-left edge + front-right edge
  out.push(el('polygon', {
    points: ptsStr([b4, b0, topPoly[0], topPoly[4]]),
    fill: C.sunk,
    stroke: C.ink,
    'stroke-width': f(0.85 * swS),
    'stroke-linejoin': 'round',
  }));
  out.push(el('polygon', {
    points: ptsStr([b0, b1, topPoly[1], topPoly[0]]),
    fill: C.sunk,
    stroke: C.ink,
    'stroke-width': f(0.9 * swS),
    'stroke-linejoin': 'round',
  }));
  out.push(el('polygon', {
    points: ptsStr([b1, b2, topPoly[2], topPoly[1]]),
    fill: C.line,
    stroke: C.ink,
    'stroke-width': f(0.9 * swS),
    'stroke-linejoin': 'round',
  }));
  // Top face of base plate
  out.push(el('polygon', {
    points: ptsStr(topPoly),
    fill: C.card,
    stroke: C.ink,
    'stroke-width': f(1.05 * swS),
    'stroke-linejoin': 'round',
  }));

  // Helper: ruled ink lines on the flat base plate
  const drawBaseLines = (zTop) => {
    const segs = [];
    for (let i = 0; i < 3; i++) {
      const vv = cv - hl * 0.44 + i * hl * 0.42;
      const len = i === 2 ? hw * 0.42 : hw * 0.68;
      const a = P(cu - hw * 0.62, vv, zTop);
      const b = P(cu + len, vv, zTop);
      segs.push(`M${f(a[0])},${f(a[1])}L${f(b[0])},${f(b[1])}`);
    }
    return el('path', {
      d: segs.join(''),
      fill: 'none',
      stroke: C.muted,
      'stroke-width': f(0.95 * swS),
      'stroke-linecap': 'round',
    });
  };

  if (form === 'issue') {
    // Crisp engraved registration index ring + 3 ruled lines
    const pin = P(cu - hw * 0.45, cv + hl * 0.64, z + th);
    const rr = 3.0 * s;
    out.push(el('ellipse', {
      cx: f(pin[0]),
      cy: f(pin[1]),
      rx: f(rr),
      ry: f(rr * 0.56),
      fill: C.sunk,
      stroke: C.ink,
      'stroke-width': f(0.95 * swS),
    }));
    out.push(el('ellipse', {
      cx: f(pin[0]),
      cy: f(pin[1]),
      rx: f(rr * 0.44),
      ry: f(rr * 0.25),
      fill: C.card,
      stroke: C.ink,
      'stroke-width': f(0.75 * swS),
    }));
    out.push(drawBaseLines(z + th));
    return el('g', {}, out.join(''));
  }

  // Barrel hinges along the left spine (u = cu - hw) for Forms 2, 3, 4, 5
  const drawHinges = () => {
    const h1 = isoBox(P, cu - hw - 1.8 * sz, cv - hl * 0.55, z + th - 0.5 * sz, cu - hw + 1.4 * sz, cv - hl * 0.15, z + th + 2.2 * sz, {
      sw: 0.75 * swS,
      topFill: C.line,
      leftFill: C.strong,
      rightFill: C.strong,
      leftHatch: 0,
    });
    const h2 = isoBox(P, cu - hw - 1.8 * sz, cv + hl * 0.18, z + th - 0.5 * sz, cu - hw + 1.4 * sz, cv + hl * 0.58, z + th + 2.2 * sz, {
      sw: 0.75 * swS,
      topFill: C.line,
      leftFill: C.strong,
      rightFill: C.strong,
      leftHatch: 0,
    });
    return h1 + h2;
  };

  if (form === 'pr' || form === 'review' || form === 'green') {
    // Subtle inner recess lines visible on lower base plate
    out.push(drawBaseLines(z + th));

    // Shadow cast onto base plate beneath the open upper leaf
    const sh0 = P(cu - hw * 0.85, cv - hl * 0.75, z + th);
    const sh1 = P(cu + hw * 0.65, cv - hl * 0.75, z + th);
    const sh2 = P(cu + hw * 0.65, cv + hl * 0.75, z + th);
    const sh3 = P(cu - hw * 0.85, cv + hl * 0.75, z + th);
    out.push(hatchQuad(sh0, sh1, sh2, sh3, 5, C.line, 0.7 * swS, 'horiz'));

    // Upper hinged folio-leaf lifted boldly open (~68 deg) along the left spine u = cu - hw
    // so its drafted face opens wide toward the camera in 22-deg paraline projection!
    const leafLift = 23.5 * sz;
    const leafSpanU = hw * 0.62;
    const l00 = P(cu - hw + 0.5 * sz, cv - hl * 0.82, z + th + 1.4 * sz);
    const l01 = P(cu - hw + 0.5 * sz, cv + hl * 0.86, z + th + 1.4 * sz);
    const l11 = P(cu - hw + leafSpanU, cv + hl * 0.86, z + th + 1.4 * sz + leafLift);
    const l10 = P(cu - hw + leafSpanU, cv - hl * 0.82, z + th + 1.4 * sz + leafLift);
    const leafTh = 1.9 * sz;
    const l10b = P(cu - hw + leafSpanU, cv - hl * 0.82, z + th + 1.4 * sz + leafLift - leafTh);
    const l11b = P(cu - hw + leafSpanU, cv + hl * 0.86, z + th + 1.4 * sz + leafLift - leafTh);
    const l00b = P(cu - hw + 0.5 * sz, cv - hl * 0.82, z + th + 1.4 * sz - leafTh * 0.5);

    // Leaf thickness edges
    out.push(el('polygon', {
      points: ptsStr([l00b, l10b, l10, l00]),
      fill: C.sunk,
      stroke: C.ink,
      'stroke-width': f(0.8 * swS),
      'stroke-linejoin': 'round',
    }));
    out.push(el('polygon', {
      points: ptsStr([l10b, l11b, l11, l10]),
      fill: C.line,
      stroke: C.ink,
      'stroke-width': f(0.8 * swS),
      'stroke-linejoin': 'round',
    }));
    // Leaf top surface
    out.push(el('polygon', {
      points: ptsStr([l00, l10, l11, l01]),
      fill: C.card,
      stroke: C.ink,
      'stroke-width': f(1.05 * swS),
      'stroke-linejoin': 'round',
    }));

    // Drafted diff/code bars etched onto the open pull-request leaf
    const leafPt = (tu, tv) => {
      const a = lerpPt(l00, l01, tv);
      const b = lerpPt(l10, l11, tv);
      return lerpPt(a, b, tu);
    };
    const barSegs = [];
    const bars = [
      [0.16, 0.82, 0.24],
      [0.16, 0.64, 0.44],
      [0.24, 0.84, 0.64],
      [0.16, 0.56, 0.82],
    ];
    for (const [uA, uB, tv] of bars) {
      const pA = leafPt(uA, tv);
      const pB = leafPt(uB, tv);
      barSegs.push(`M${f(pA[0])},${f(pA[1])}L${f(pB[0])},${f(pB[1])}`);
    }
    out.push(el('path', {
      d: barSegs.join(''),
      fill: 'none',
      stroke: C.ink,
      'stroke-width': f(0.95 * swS),
      'stroke-linecap': 'round',
    }));
    // Small hinge barrels on spine
    out.push(drawHinges());

    // Form 3: Two bold clamped margin comment tabs jutting horizontally outward (+u) from the open leaf edge!
    if (form === 'review') {
      const tabSpecs = [
        { tv0: 0.08, tv1: 0.42, fill: C.hl },
        { tv0: 0.54, tv1: 0.88, fill: C.sunk },
      ];
      for (const tab of tabSpecs) {
        const vA = cv - hl * 0.82 + (hl * 1.68) * tab.tv0;
        const vB = cv - hl * 0.82 + (hl * 1.68) * tab.tv1;
        const tabZ = z + th + 1.4 * sz + leafLift * 0.84;
        const uBase = cu - hw + leafSpanU * 0.90;
        const uTip = cu + hw + 8.5 * sz;
        const a0 = P(uBase, vA, tabZ);
        const a1 = P(uTip, vA, tabZ + 1.8 * sz);
        const a2 = P(uTip, vB, tabZ + 1.8 * sz);
        const a3 = P(uBase, vB, tabZ);
        out.push(el('polygon', {
          points: ptsStr([a0, a1, a2, a3]),
          fill: tab.fill,
          stroke: C.ink,
          'stroke-width': f(1.05 * swS),
        }));
        // Small metal clip collar clamping tab to the leaf edge
        const c0 = lerpPt(a0, a3, 0.28);
        const c1 = lerpPt(a0, a3, 0.72);
        const c2 = lerpPt(lerpPt(a0, a1, 0.18), lerpPt(a3, a2, 0.18), 0.72);
        const c3 = lerpPt(lerpPt(a0, a1, 0.18), lerpPt(a3, a2, 0.18), 0.28);
        out.push(el('polygon', {
          points: ptsStr([c0, c3, c2, c1]),
          fill: C.strong,
          stroke: C.ink,
          'stroke-width': f(0.75 * swS),
        }));
        // Crisp ink ruling on each comment tab
        const m1 = lerpPt(a0, a3, 0.35);
        const m2 = lerpPt(a1, a2, 0.35);
        const m3 = lerpPt(a0, a3, 0.68);
        const m4 = lerpPt(a1, a2, 0.68);
        const p1 = lerpPt(m1, m2, 0.26);
        const p2 = lerpPt(m1, m2, 0.84);
        const p3 = lerpPt(m3, m4, 0.26);
        const p4 = lerpPt(m3, m4, 0.70);
        out.push(el('path', {
          d: `M${f(p1[0])},${f(p1[1])}L${f(p2[0])},${f(p2[1])}M${f(p3[0])},${f(p3[1])}L${f(p4[0])},${f(p4[1])}`,
          fill: 'none',
          stroke: C.ink,
          'stroke-width': f(0.9 * swS),
        }));
      }
    }

    // Front bevel check sockets (Forms 3 & 4) mounted squarely on a front flange bar along v = cv - hl
    if (form === 'review' || form === 'green') {
      const stripV0 = cv - hl - 7.4 * sz;
      const stripV1 = cv - hl + 1.2 * sz;
      out.push(isoBox(P, cu - hw + n * 0.4, stripV0, z, cu + hw, stripV1, z + th + 0.7 * sz, {
        topFill: C.sunk,
        leftFill: C.line,
        rightFill: C.strong,
        sw: 0.9 * swS,
        leftHatch: 2,
      }));

      const us = [cu - hw * 0.48, cu + hw * 0.06, cu + hw * 0.60];
      const vMid = (stripV0 + stripV1) * 0.5;
      const zS = z + th + 0.95 * sz;

      us.forEach((su, idx) => {
        const c = P(su, vMid, zS);
        const r = 3.4 * s;
        if (form === 'review') {
          if (idx < 2) {
            // Pending socket: hollow open concentric ring (reads unmistakably as pending in greyscale!)
            out.push(el('ellipse', {
              cx: f(c[0]),
              cy: f(c[1]),
              rx: f(r),
              ry: f(r * 0.60),
              fill: C.card,
              stroke: C.ink,
              'stroke-width': f(1.0 * swS),
            }));
            out.push(el('ellipse', {
              cx: f(c[0]),
              cy: f(c[1]),
              rx: f(r * 0.46),
              ry: f(r * 0.28),
              fill: 'none',
              stroke: C.muted,
              'stroke-width': f(0.8 * swS),
              'stroke-dasharray': `${f(1.5 * s)} ${f(1.2 * s)}`,
            }));
          } else {
            // Failed socket: raised notched collar + warm highlight tint + bold dark X
            out.push(el('ellipse', {
              cx: f(c[0]),
              cy: f(c[1] - 0.8 * s),
              rx: f(r * 1.16),
              ry: f(r * 0.72),
              fill: C.hl,
              stroke: C.ink,
              'stroke-width': f(1.2 * swS),
            }));
            const xr = r * 0.58;
            const yr = r * 0.40;
            const cy = c[1] - 0.8 * s;
            out.push(el('path', {
              d: `M${f(c[0] - xr)},${f(cy - yr)}L${f(c[0] + xr)},${f(cy + yr)}M${f(c[0] + xr)},${f(cy - yr)}L${f(c[0] - xr)},${f(cy + yr)}`,
              fill: 'none',
              stroke: C.ink,
              'stroke-width': f(1.55 * swS),
              'stroke-linecap': 'round',
            }));
          }
        } else {
          // Form 4: Every check green! Seated solid green bezel + crisp vector checkmark
          out.push(el('ellipse', {
            cx: f(c[0]),
            cy: f(c[1]),
            rx: f(r * 1.08),
            ry: f(r * 0.66),
            fill: C.accentSoft,
            stroke: C.accent,
            'stroke-width': f(1.15 * swS),
          }));
          const ck = [
            `M${f(c[0] - r * 0.50)},${f(c[1] + r * 0.02)}`,
            `L${f(c[0] - r * 0.10)},${f(c[1] + r * 0.34)}`,
            `L${f(c[0] + r * 0.58)},${f(c[1] - r * 0.34)}`,
          ].join('');
          out.push(el('path', {
            d: ck,
            fill: 'none',
            stroke: C.accent,
            'stroke-width': f(1.5 * swS),
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }));
        }
      });
    }

    return el('g', {}, out.join(''));
  }

  // Form 5: Merged — closed locked double-thickness plate crowned by a raised green scalloped signet seal + twin tails!
  if (form === 'merged') {
    // Upper closed leaf resting flush on top of base plate
    out.push(isoBox(P, cu - hw + 1 * sz, cv - hl + 1 * sz, z + th, cu + hw - 0.8 * sz, cv + hl - 0.8 * sz, z + th + 2.6 * sz, {
      topFill: C.card,
      leftFill: C.sunk,
      rightFill: C.line,
      sw: 0.95 * swS,
      leftHatch: 1,
    }));
    out.push(drawHinges());

    const zTop = z + th + 2.7 * sz;
    // Twin ribbon tails trailing from beneath the seal toward front-left edge
    const r0 = P(cu - 2.2 * sz, cv - 2 * sz, zTop);
    const r1 = P(cu - 6.4 * sz, cv - hl * 0.84, zTop);
    const r2 = P(cu - 1.2 * sz, cv - hl * 0.72, zTop);
    const r3 = P(cu + 2.0 * sz, cv - hl * 0.86, zTop);
    const r4 = P(cu + 6.0 * sz, cv - hl * 0.74, zTop);
    const r5 = P(cu + 3.6 * sz, cv - 1 * sz, zTop);
    out.push(el('polygon', {
      points: ptsStr([r0, r1, r2, r3, r4, r5]),
      fill: C.accentSoft,
      stroke: C.accent,
      'stroke-width': f(1.0 * swS),
      'stroke-linejoin': 'round',
    }));

    // Raised cylindrical green scalloped signet seal centered on the closed folio
    const sealR = 8.2 * sz;
    out.push(isoCyl(P, cu, cv + 1.5 * sz, zTop, zTop + 4.6 * sz, sealR, {
      green: true,
      sw: 1.15 * swS,
      shadeLines: 4,
    }));
    // Inner engraved concentric dashed ring + crisp checkmark emblem matched exactly to isoCyl's top ellipse!
    const sc = P(cu, cv + 1.5 * sz, zTop + 4.7 * sz);
    const sealRx = 0.8523 * sealR * ps;
    const sealRy = sealRx * (CY / CX);
    const srx = sealRx * 0.78;
    const sry = sealRy * 0.78;
    out.push(el('ellipse', {
      cx: f(sc[0]),
      cy: f(sc[1]),
      rx: f(srx),
      ry: f(sry),
      fill: 'none',
      stroke: C.accent,
      'stroke-width': f(0.85 * swS),
      'stroke-dasharray': `${f(1.8 * s)} ${f(1.1 * s)}`,
    }));
    out.push(el('path', {
      d: `M${f(sc[0] - srx * 0.48)},${f(sc[1] + sry * 0.04)}L${f(sc[0] - srx * 0.08)},${f(sc[1] + sry * 0.44)}L${f(sc[0] + srx * 0.56)},${f(sc[1] - sry * 0.42)}`,
      fill: 'none',
      stroke: C.accent,
      'stroke-width': f(1.6 * swS),
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }));
    return el('g', {}, out.join(''));
  }

  return el('g', {}, out.join(''));
}

