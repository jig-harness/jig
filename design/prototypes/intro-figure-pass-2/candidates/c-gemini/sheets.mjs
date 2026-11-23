import { C, FONT, el, esc, f, isoBox, makeProj, ptsStr , wrapSvg } from './lib.mjs';
import { drawItem } from './item.mjs';
import { drawMechanicalAgent } from './agents.mjs';
import { drawPersonAtDesk } from './people.mjs';
import { drawCallout, estimatePillWidth } from './scene.mjs';

// ============================================================================
// REFERENCE SHEET 1: agents.svg (960 x 720)
// All 7 mechanical agents in their 3 poses (rest, reach, act) side by side,
// labelled strictly by station name (verbatim vocabulary!).
// ============================================================================
export function renderAgentsSheet() {
  const W = 960;
  const H = 720;
  const out = [];

  out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.bg, stroke: 'none' }));
  // Outer hairline plate frame
  out.push(el('rect', {
    x: 16, y: 16, width: W - 32, height: H - 32, rx: 6, ry: 6,
    fill: 'none', stroke: C.line, 'stroke-width': '1.1',
  }));

  const agents = [
    { key: 'pickup', label: 'Pick up', col: 0, row: 0 },
    { key: 'build', label: 'Build', col: 0, row: 1 },
    { key: 'open', label: 'Open', col: 0, row: 2 },
    { key: 'drive', label: 'Drive', col: 0, row: 3 },
    { key: 'repair', label: 'Repair', col: 1, row: 0 },
    { key: 'followup', label: 'Follow up', col: 1, row: 1 },
    { key: 'dispatcher', label: 'Dispatcher', col: 1, row: 2 },
  ];

  const colW = 452;
  const rowH = 162;
  const padX = 24;
  const padY = 26;
  const gapX = 8;
  const gapY = 8;

  for (const ag of agents) {
    const x0 = padX + ag.col * (colW + gapX);
    const y0 = padY + ag.row * (rowH + gapY);

    // Engraved card enclosure
    out.push(el('rect', {
      x: f(x0), y: f(y0), width: f(colW), height: f(rowH), rx: 5, ry: 5,
      fill: C.card, stroke: C.line, 'stroke-width': '1.0',
    }));

    // Station label pill at top-left (verbatim vocabulary!)
    const pillW = estimatePillWidth(ag.label, 13);
    const pillH = 22;
    out.push(el('rect', {
      x: f(x0 + 12), y: f(y0 + 10), width: f(pillW), height: f(pillH), rx: 6, ry: 6,
      fill: C.sunk, stroke: C.muted, 'stroke-width': '0.95',
    }));
    out.push(el('text', {
      x: f(x0 + 12 + pillW / 2),
      y: f(y0 + 10 + 15),
      'text-anchor': 'middle',
      'font-family': FONT,
      'font-size': '13',
      'font-weight': '600',
      fill: C.ink,
    }, esc(ag.label)));

    // Three pose plinths side-by-side: rest, reach, act
    const poses = ['rest', 'reach', 'act'];
    poses.forEach((pose, pi) => {
      const cx = x0 + 82 + pi * 142;
      const cy = y0 + 124;
      const P = makeProj(cx, cy, 1.0);

      // Subtle isometric display tile plinth
      out.push(isoBox(P, -28, -24, -6, 30, 24, 0, {
        topFill: pose === 'act' ? C.card : C.sunk,
        leftFill: C.sunk,
        rightFill: C.line,
        sw: pose === 'act' ? 1.0 : 0.85,
        leftHatch: 1,
      }));
      // Subtle warm highlight spot under active pose
      if (pose === 'act') {
        const h0 = P(-18, -14, 0.3);
        const h1 = P(24, -14, 0.3);
        const h2 = P(24, 14, 0.3);
        const h3 = P(-18, 14, 0.3);
        out.push(el('polygon', {
          points: ptsStr([h0, h1, h2, h3]),
          fill: C.hl, stroke: 'none', opacity: '0.45',
        }));
      }

      // Draw agent in this pose
      out.push(drawMechanicalAgent(P, ag.key, pose, -4, 0, 0, 1.05));

      // Subtle engraved chevron arrow between poses (pure path, zero extra text)
      if (pi < 2) {
        const ax = cx + 68;
        const ay = y0 + 92;
        out.push(el('path', {
          d: `M${f(ax - 3)},${f(ay - 5)}L${f(ax + 3)},${f(ay)}L${f(ax - 3)},${f(ay + 5)}`,
          fill: 'none', stroke: C.strong, 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }));
      }
    });
  }

  // Right-bottom 8th slot: Merge (the person at the green summit desk — rest vs act)
  // Shows contrast: person in green vs mechanical agents in ink/grey!
  {
    const x0 = padX + 1 * (colW + gapX);
    const y0 = padY + 3 * (rowH + gapY);
    out.push(el('rect', {
      x: f(x0), y: f(y0), width: f(colW), height: f(rowH), rx: 5, ry: 5,
      fill: C.card, stroke: C.accent, 'stroke-width': '1.0', opacity: '0.9',
    }));
    const pillW = estimatePillWidth('Merge', 13);
    out.push(el('rect', {
      x: f(x0 + 12), y: f(y0 + 10), width: f(pillW), height: '22', rx: 6, ry: 6,
      fill: C.accentSoft, stroke: C.accent, 'stroke-width': '1.0',
    }));
    out.push(el('text', {
      x: f(x0 + 12 + pillW / 2), y: f(y0 + 25), 'text-anchor': 'middle',
      'font-family': FONT, 'font-size': '13', 'font-weight': '700', fill: C.accent,
    }, 'Merge'));

    // Rest pose (left), Question waiting (middle), Act/Merge stamping (right)
    const variants = [
      { acting: false, hasQuestion: false, merged: false },
      { acting: false, hasQuestion: true, merged: false },
      { acting: true, hasQuestion: false, merged: true },
    ];
    variants.forEach((v, vi) => {
      const cx = x0 + 82 + vi * 142;
      const cy = y0 + 128;
      const P = makeProj(cx, cy, 0.92);
      out.push(isoBox(P, -34, -30, -6, 34, 30, 0, {
        topFill: C.sunk, leftFill: C.sunk, rightFill: C.line, sw: 0.85, leftHatch: 2,
      }));
      const person = drawPersonAtDesk(P, 2, 0, 0, 0.88, { acting: v.acting, hasQuestion: v.hasQuestion });
      out.push(person.deskAndPerson);
      if (v.merged) {
        out.push(drawItem(P, 11, 4, 18 * 0.88, 'merged', 0.72));
      }
      out.push(person.actingArmAndStamp);
      if (vi < 2) {
        const ax = cx + 68;
        const ay = y0 + 92;
        out.push(el('path', {
          d: `M${f(ax - 3)},${f(ay - 5)}L${f(ax + 3)},${f(ay)}L${f(ax - 3)},${f(ay + 5)}`,
          fill: 'none', stroke: C.accent, 'stroke-width': '1.2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }));
      }
    });
  }

  return wrapSvg(W, H, out.join('\n'));
}

// ============================================================================
// REFERENCE SHEET 2: item-states.svg (960 x 240)
// The item's five forms in a row, greyscale-readable, verbatim vocabulary!
// ============================================================================
export function renderItemStatesSheet() {
  const W = 960;
  const H = 240;
  const out = [];

  out.push(el('rect', { x: 0, y: 0, width: W, height: H, fill: C.bg, stroke: 'none' }));
  out.push(el('rect', {
    x: 16, y: 14, width: W - 32, height: H - 28, rx: 6, ry: 6,
    fill: 'none', stroke: C.line, 'stroke-width': '1.1',
  }));

  const states = [
    { form: 'issue', labels: [{ text: 'Issue', dx: 0, green: false }] },
    { form: 'pr', labels: [{ text: 'Pull request', dx: 0, green: false }] },
    {
      form: 'review',
      labels: [
        { text: 'Comments', dx: -44, green: false },
        { text: 'Checks', dx: 42, green: false },
      ],
    },
    { form: 'green', labels: [{ text: 'Checks', dx: 0, green: true }] },
    { form: 'merged', labels: [{ text: 'Merged', dx: 0, green: true }] },
  ];

  states.forEach((st, idx) => {
    const cx = 108 + idx * 186;
    const cy = 122;
    const P = makeProj(cx, cy, 1.0);

    // Display pedestal plinth
    out.push(isoBox(P, -40, -44, -10, 40, 44, 0, {
      topFill: C.card,
      leftFill: C.sunk,
      rightFill: C.line,
      sw: 1.0,
      leftHatch: 3,
      bevelTop: true,
    }));

    // Item form at large showcase scale
    out.push(drawItem(P, 0, 2, 0.5, st.form, 1.55));

    // Progression arrow between pedestals
    if (idx < states.length - 1) {
      const ax = cx + 93;
      const ay = 114;
      out.push(el('path', {
        d: `M${f(ax - 9)},${f(ay)}L${f(ax + 7)},${f(ay)}M${f(ax + 2)},${f(ay - 5)}L${f(ax + 7)},${f(ay)}L${f(ax + 2)},${f(ay + 5)}`,
        fill: 'none', stroke: C.strong, 'stroke-width': '1.35', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    }

    // Verbatim vocabulary pills below each pedestal
    for (const lb of st.labels) {
      const lx = cx + lb.dx;
      const ly = 200;
      const res = drawCallout(lx, ly, lb.text, null, null, {
        fontSize: 12,
        green: lb.green,
        active: lb.green,
        noLeader: true,
      });
      out.push(res.svg);
    }
  });

  return wrapSvg(W, H, out.join('\n'));
}


