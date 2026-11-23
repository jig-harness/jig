#!/usr/bin/env node
/**
 * Candidate A (Claude): the bench.
 *
 * One description of the world (stations, agents, poses, the item's five forms)
 * drawn as isometric engravings in two formats: `wide` (the whole plate) and
 * `tall` (the same scene, the camera following the action). Writes
 *   wide/step-1..8.svg   viewBox 0 0 960 540
 *   tall/step-1..8.svg   viewBox 0 0 390 520
 *   agents.svg           each agent in three poses (rest, reach, act)
 *   item-states.svg      the item's five forms
 *
 *   node build.mjs
 *
 * Projection: true isometric. x runs down-right, y runs down-left, z is up; the
 * viewer stands at +x +y +z. Light comes from the upper left, so faces turned to
 * +y are light and faces turned to +x are dark. Colours are the site's tokens as
 * custom properties with light fallbacks. No dependencies.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
import { C30, MAT, PLANE, SANS, SPACING, TOK, World, approxWidth, circ, defsOf, f, hull, makeProjector, order, pathOf, placeLabels, r2, renderWorld, tk, wrapDeco } from "./engine.mjs";

/* ======================================================================= */
/*                              THE DESCRIPTION                             */
/* ======================================================================= */

// Run coordinates (x along the line). Belt half width 0.75; belt top z = 0.18.
const BELT = { x0: 0.4, x1: 21.8, hw: 0.75, top: 0.18 };
const ST = { queue: [0.9, 3.3], pick: 4.6, build: 7.6, open: 10.6, drive: 13.6, repair: 16.6, merge: 19.6 };
const ITEM_X = { pick: 4.6, build: 7.6, open: 10.6, drive: 13.6, repair: 16.6, merge: 19.6 };
const ARM_Y = -2.3;

function plate(w) {
	w.box(-0.8, -3.5, -0.5, 22.8, 5.6, 0, "floor", { hatch: "edge" });
	w.box(BELT.x0, -BELT.hw, 0, BELT.x1, BELT.hw, BELT.top, "belt");
	// ties across the belt
	w.mark((P) => {
		const d = [];
		for (let x = 0.9; x < BELT.x1 - 0.3; x += 0.9) d.push(`M${f(P(x, -BELT.hw, BELT.top).x)} ${f(P(x, -BELT.hw, BELT.top).y)}L${f(P(x, BELT.hw, BELT.top).x)} ${f(P(x, BELT.hw, BELT.top).y)}`);
		return `<path d="${d.join("")}" stroke="${TOK.strong}" stroke-width="0.7" fill="none" opacity="0.85"/>`;
	});
}

/* ----------------------------------------------------------- the item   */
const CARD = { w: 1.5, d: 1.0 };
const TOPZ = BELT.top;

function cardSolid(w, x, y, z, h, mat = "paper", o = {}) {
	const hx = CARD.w / 2;
	const hy = CARD.d / 2;
	const c = 0.3;
	return w.prism(
		[{ x: x - hx, y: y - hy }, { x: x + hx, y: y - hy }, { x: x + hx, y: y + hy - c }, { x: x + hx - c, y: y + hy }, { x: x - hx, y: y + hy }],
		z,
		z + h,
		mat,
		o,
	);
}

/** Ruled lines and a mark on a card top. */
function topLines(x, y, z, kind = "issue", lines = 3) {
	return (P) => {
		const d = [];
		for (let i = 0; i < lines; i++) {
			const yy = y - 0.28 + i * 0.22;
			const a = P(x - 0.2, yy, z);
			const b = P(x + 0.55 - (i === lines - 1 ? 0.3 : 0), yy, z);
			d.push(`M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`);
		}
		return `<path d="${d.join("")}" stroke="${TOK.ink}" stroke-width="0.8" fill="none"/>`;
	};
}
const ringD = (P, c, plane, r, n = 20) => pathOf(circ(P, c, ...PLANE[plane], r, n));

function issueCard(w, x, y, z, o = {}) {
	const h = 0.14;
	const s = cardSolid(w, x, y, z, h, "paper", {
		deco: (P) => {
			const zt = z + h;
			const fold = [P(x + 0.75 - 0.3, y + 0.5, zt), P(x + 0.75, y + 0.5 - 0.3, zt), P(x + 0.75 - 0.3, y + 0.5 - 0.3, zt)];
			return `<path d="${pathOf(fold)}" fill="${TOK.sunk}" stroke="${TOK.ink}" stroke-width="0.8" stroke-linejoin="round"/><path d="${ringD(P, [x - 0.45, y - 0.28, zt], "z", 0.13)}" fill="none" stroke="${TOK.ink}" stroke-width="1.1"/>${topLines(x, y, zt)(P)}`;
		},
	});
	return s;
}

/** Form 2: the issue with a pull request sheet slid out of it, tied by a pin. */
function issueWithPR(w, x, y, z) {
	issueCard(w, x, y, z);
	const sx = x + 0.45;
	const sy = y + 0.38;
	const sheet = w.prism(
		[{ x: sx - 0.7, y: sy - 0.5 }, { x: sx + 0.7, y: sy - 0.5 }, { x: sx + 0.7, y: sy + 0.5 }, { x: sx - 0.7, y: sy + 0.5 }],
		z + 0.14,
		z + 0.3,
		"paper",
		{
			deco: (P) => {
				const zt = z + 0.3;
				const a = [sx - 0.42, sy - 0.1, zt];
				const b = [sx - 0.42, sy + 0.25, zt];
				return `<path d="M${f(P(...a).x)} ${f(P(...a).y)}L${f(P(...b).x)} ${f(P(...b).y)}" stroke="${TOK.ink}" stroke-width="1.1"/><path d="${ringD(P, a, "z", 0.09)}" fill="${TOK.card}" stroke="${TOK.ink}" stroke-width="1.1"/><path d="${ringD(P, b, "z", 0.09)}" fill="${TOK.ink}" stroke="${TOK.ink}" stroke-width="1.1"/><path d="M${f(P(sx - 0.1, sy - 0.1, zt).x)} ${f(P(sx - 0.1, sy - 0.1, zt).y)}L${f(P(sx + 0.45, sy - 0.1, zt).x)} ${f(P(sx + 0.45, sy - 0.1, zt).y)}M${f(P(sx - 0.1, sy + 0.12, zt).x)} ${f(P(sx - 0.1, sy + 0.12, zt).y)}L${f(P(sx + 0.45, sy + 0.12, zt).x)} ${f(P(sx + 0.45, sy + 0.12, zt).y)}" stroke="${TOK.ink}" stroke-width="0.8"/>`;
			},
		},
	);
	// the pin that ties the sheet to the card
	w.cyl(x - 0.52, y - 0.22, 0.07, z + 0.14, z + 0.38, "dark", { n: 8 });
	return sheet;
}

/** The status rack standing at the back of a pull request: three lamps. */
function statusRack(w, x, y, z, lamps) {
	const rack = w.box(x - 0.62, y - 0.58, z, x + 0.62, y - 0.46, z + 0.5, "steel", {
		deco: (P) => {
			const yy = y - 0.46;
			return lamps
				.map((st, i) => {
					const cx = x - 0.4 + i * 0.4;
					const c = [cx, yy, z + 0.26];
					const poly = ringD(P, c, "y", 0.14);
					if (st === "pass") {
						const t = [P(cx - 0.07, yy, z + 0.26), P(cx - 0.02, yy, z + 0.21), P(cx + 0.08, yy, z + 0.33)];
						return `<path d="${poly}" fill="${TOK.accent}" stroke="${TOK.accent}" stroke-width="1"/><path d="${pathOf(t, false)}" fill="none" stroke="${TOK.soft}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
					}
					if (st === "fail") {
						const a = P(cx - 0.08, yy, z + 0.18);
						const b = P(cx + 0.08, yy, z + 0.34);
						const c2 = P(cx + 0.08, yy, z + 0.18);
						const d2 = P(cx - 0.08, yy, z + 0.34);
						return `<path d="${poly}" fill="${TOK.ink}" stroke="${TOK.ink}" stroke-width="1"/><path d="M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}M${f(c2.x)} ${f(c2.y)}L${f(d2.x)} ${f(d2.y)}" stroke="${TOK.card}" stroke-width="1.5" stroke-linecap="round"/>`;
					}
					return `<path d="${poly}" fill="${TOK.card}" stroke="${TOK.ink}" stroke-width="1.2" stroke-dasharray="2.2 1.6"/>`;
				})
				.join("");
		},
	});
	return rack;
}

/** A comment tab: a small bubble standing on the edge of the sheet. */
function commentTab(w, x, y, z, resolved) {
	w.box(x - 0.18, y - 0.1, z, x + 0.18, y + 0.1, z + 0.34, "steel", {
		deco: (P) => {
			const c = [x, y + 0.1, z + 0.18];
			const t = P(x, y + 0.1, z + 0.18);
			if (resolved) {
				const tt = [P(x - 0.09, y + 0.1, z + 0.17), P(x - 0.02, y + 0.1, z + 0.1), P(x + 0.11, y + 0.1, z + 0.26)];
				return `<path d="${pathOf(tt, false)}" fill="none" stroke="${TOK.accent}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`;
			}
			return `<path d="${ringD(P, c, "y", 0.05, 10)}" fill="${TOK.ink}"/><path d="M${f(t.x - 3)} ${f(t.y - 0.6)}h6" stroke="${TOK.ink}" stroke-width="0"/>`;
		},
	});
}

/** Form 3 and form 4: the pull request with comments and build status. */
function pullRequest(w, x, y, z, state) {
	const sheet = w.prism(
		[{ x: x - 0.78, y: y - 0.52 }, { x: x + 0.78, y: y - 0.52 }, { x: x + 0.78, y: y + 0.52 }, { x: x - 0.78, y: y + 0.52 }],
		z,
		z + 0.2,
		"paper",
		{
			deco: (P) => {
				const zt = z + 0.2;
				return `${topLines(x + 0.05, y + 0.02, zt, "pr", 4)(P)}`;
			},
		},
	);
	// the issue's card, a step under the sheet
	w.box(x - 0.55, y - 0.42, z - 0.1, x + 0.55, y + 0.42, z, "steel");
	const resolved = state === "green";
	commentTab(w, x - 0.4, y + 0.52, z + 0.2, resolved);
	commentTab(w, x + 0.0, y + 0.52, z + 0.2, resolved);
	commentTab(w, x + 0.4, y + 0.52, z + 0.2, resolved);
	const lamps = state === "green" ? ["pass", "pass", "pass"] : ["pass", "pend", "fail"];
	statusRack(w, x, y, z + 0.2, lamps);
	return sheet;
}

/** Form 5: the merged slab: the sheet folded into a block with a green seal. */
function mergedSlab(w, x, y, z) {
	w.box(x - 0.8, y - 0.55, z, x + 0.8, y + 0.55, z + 0.28, "steel");
	w.box(x - 0.68, y - 0.45, z + 0.28, x + 0.68, y + 0.45, z + 0.46, "paper", {
		deco: (P) => {
			const zt = z + 0.46;
			const c = [x + 0.12, y, zt];
			const tt = [P(x + 0.12 - 0.14, y + 0.06, zt), P(x + 0.12 - 0.02, y + 0.06, zt), P(x + 0.12 - 0.02, y - 0.26, zt)];
			return `<path d="${ringD(P, c, "z", 0.34)}" fill="${TOK.soft}" stroke="${TOK.accent}" stroke-width="1.4"/><path d="${ringD(P, c, "z", 0.24)}" fill="none" stroke="${TOK.accent}" stroke-width="0.8"/><path d="${pathOf(tt, false)}" fill="none" stroke="${TOK.accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
		},
	});
}

/* ------------------------------------------------------------ the queue */
function queue(w, count) {
	const [qx0, qx1] = ST.queue;
	// the file tray the issues stand in
	w.box(qx0 - 0.1, -0.7, 0, qx1 + 0.05, 0.7, BELT.top + 0.12, "steel", { hatch: "edge" });
	w.box(qx0 - 0.1, -0.7, BELT.top + 0.12, qx0 + 0.06, 0.7, BELT.top + 0.7, "steel");
	w.box(qx0 - 0.1, -0.7, BELT.top + 0.12, qx1 + 0.05, -0.55, BELT.top + 0.44, "steel");
	w.box(qx0 - 0.1, 0.55, BELT.top + 0.12, qx1 + 0.05, 0.7, BELT.top + 0.44, "steel");
	for (let i = 0; i < count; i++) {
		const x = qx1 - 0.25 - i * 0.42;
		w.box(x - 0.07, -0.5, BELT.top + 0.12, x + 0.07, 0.5, BELT.top + 0.98, "paper", {
			deco: (P) => {
				const zt = BELT.top + 0.98;
				// a ring on the card's edge face reads as an open issue
				return `<path d="${ringD(P, [x + 0.07, 0.15, BELT.top + 0.66], "x", 0.1)}" fill="none" stroke="${TOK.ink}" stroke-width="1"/><path d="M${f(P(x + 0.07, -0.25, BELT.top + 0.66).x)} ${f(P(x + 0.07, -0.25, BELT.top + 0.66).y)}L${f(P(x + 0.07, -0.05, BELT.top + 0.66).x)} ${f(P(x + 0.07, -0.05, BELT.top + 0.66).y)}" stroke="${TOK.ink}" stroke-width="0.9"/><!--${zt}-->`;
			},
		});
	}
}

/* -------------------------------------------------------------- agents  */
const AGENT_Y = { pick: ARM_Y, build: ARM_Y, drive: ARM_Y, repair: ARM_Y };
const Z = { shoulder: 1.5, elbow: 1.5, fore: 1.9, tip: 2.25 };

/** A two-link arm that reaches a point: shoulder along y, forearm along x, a head and a tool. */
function arm(w, { px, py = ARM_Y, tx, ty = 0, pose }) {
	// pedestal
	w.box(px - 0.8, py - 0.8, 0, px + 0.8, py + 0.8, 0.16, "dark", { hatch: "edge" });
	w.box(px - 0.6, py - 0.6, 0.16, px + 0.6, py + 0.6, 0.95, "steel", { shadow: true });
	w.cyl(px, py, 0.46, 0.95, 1.45, "steel");
	let elbow;
	let tip;
	if (pose === "rest") {
		elbow = { x: px + 1.05, y: py };
		tip = { x: px + 0.3, y: py };
	} else {
		elbow = { x: px, y: ty };
		tip = { x: tx, y: ty };
	}
	const hw = 0.27;
	const seg = (a, b, z0, z1, mat = "steel") => {
		const x0 = Math.min(a.x, b.x) - (a.x === b.x ? hw : 0);
		const x1 = Math.max(a.x, b.x) + (a.x === b.x ? hw : 0);
		const y0 = Math.min(a.y, b.y) - (a.y === b.y ? hw : 0);
		const y1 = Math.max(a.y, b.y) + (a.y === b.y ? hw : 0);
		return w.box(x0, y0, z0, x1, y1, z1, mat);
	};
	seg({ x: px, y: py }, elbow, 1.45, 1.85);
	w.cyl(elbow.x, elbow.y, 0.36, 1.45, 2.35, "steel", { n: 12 });
	w.cyl(elbow.x, elbow.y, 0.16, 2.35, 2.5, "dark", { n: 8 });
	seg(elbow, tip, 1.95, 2.35);
	// the head under the forearm's end
	const headBottom = pose === "rest" ? 1.95 : 1.65;
	w.cyl(tip.x, tip.y, 0.3, headBottom, 2.35, "steel", { n: 12 });
	return { tip, headZ: headBottom };
}

/** A tool hung under an arm's head. `pose`: rest (stowed), reach (open, above), act (working). */
function tool(w, kind, a, pose, targetTopZ) {
	const { tip, headZ } = a;
	if (pose === "rest") {
		if (kind === "grip") {
			w.box(tip.x - 0.36, tip.y - 0.08, headZ - 0.42, tip.x - 0.22, tip.y + 0.08, headZ, "dark");
			w.box(tip.x + 0.22, tip.y - 0.08, headZ - 0.42, tip.x + 0.36, tip.y + 0.08, headZ, "dark");
		}
		return;
	}
	const lowZ = pose === "act" ? targetTopZ : targetTopZ + 0.7;
	const stem = headZ;
	switch (kind) {
		case "grip": {
			const open = pose === "act" ? 1.5 : 1.95;
			w.box(tip.x - 0.09, tip.y - 0.09, lowZ + 0.5, tip.x + 0.09, tip.y + 0.09, stem, "dark");
			w.box(tip.x - open / 2 - 0.14, tip.y - 0.14, lowZ + 0.5, tip.x + open / 2 + 0.14, tip.y + 0.14, lowZ + 0.64, "dark");
			w.box(tip.x - open / 2 - 0.14, tip.y - 0.14, lowZ, tip.x - open / 2 + 0.02, tip.y + 0.14, lowZ + 0.5, "dark");
			w.box(tip.x + open / 2 - 0.02, tip.y - 0.14, lowZ, tip.x + open / 2 + 0.14, tip.y + 0.14, lowZ + 0.5, "dark");
			break;
		}
		case "weld": {
			w.box(tip.x - 0.12, tip.y - 0.12, lowZ + 0.55, tip.x + 0.12, tip.y + 0.12, stem, "dark");
			w.box(tip.x - 0.08, tip.y - 0.08, lowZ + 0.25, tip.x + 0.08, tip.y + 0.08, lowZ + 0.55, "steel");
			w.box(tip.x - 0.04, tip.y - 0.04, lowZ, tip.x + 0.04, tip.y + 0.04, lowZ + 0.25, "dark");
			if (pose === "act") {
				w.mark((P) => {
					const base = [tip.x, tip.y, lowZ];
					const d = [];
					[[0.5, 0.14], [-0.44, 0.22], [0.1, 0.55], [-0.18, -0.5], [0.42, -0.32], [-0.52, -0.08], [0.3, 0.42], [-0.3, 0.4]].forEach(([dx, dy], i) => {
						const a0 = P(base[0] + dx * 0.3, base[1] + dy * 0.3, base[2] + 0.02);
						const a1 = P(base[0] + dx, base[1] + dy, base[2] + 0.1 + (i % 3) * 0.1);
						d.push(`M${f(a0.x)} ${f(a0.y)}L${f(a1.x)} ${f(a1.y)}`);
					});
					return `<path d="${d.join("")}" stroke="${TOK.ink}" stroke-width="1.4" stroke-linecap="round"/>`;
				});
			}
			break;
		}
		case "probe": {
			w.box(tip.x - 0.1, tip.y - 0.1, lowZ + 0.55, tip.x + 0.1, tip.y + 0.1, stem, "dark");
			w.cyl(tip.x, tip.y, 0.46, lowZ + 0.3, lowZ + 0.55, "steel", { n: 16 });
			w.cyl(tip.x, tip.y, 0.3, lowZ + 0.12, lowZ + 0.3, "dark", { n: 12 });
			w.mark((P) => {
				const bz = lowZ + 0.12;
				const d = [];
				for (const [dx, dy] of [[-0.7, -0.5], [0.7, -0.5], [0.7, 0.5], [-0.7, 0.5]]) {
					const a0 = P(tip.x + dx * 0.4, tip.y + dy * 0.4, bz);
					const a1 = P(tip.x + dx, tip.y + dy, targetTopZ);
					d.push(`M${f(a0.x)} ${f(a0.y)}L${f(a1.x)} ${f(a1.y)}`);
				}
				const plane = [P(tip.x - 0.7, tip.y - 0.5, targetTopZ + 0.01), P(tip.x + 0.7, tip.y - 0.5, targetTopZ + 0.01), P(tip.x + 0.7, tip.y + 0.5, targetTopZ + 0.01), P(tip.x - 0.7, tip.y + 0.5, targetTopZ + 0.01)];
				return pose === "act" ? `<path d="${d.join("")}" stroke="${TOK.ink}" stroke-width="1" stroke-dasharray="2.6 2.2" fill="none"/><path d="${pathOf(plane)}" fill="none" stroke="${TOK.ink}" stroke-width="1" stroke-dasharray="3.2 2.2"/>` : "";
			});
			break;
		}
		case "wrench": {
			w.box(tip.x - 0.1, tip.y - 0.1, lowZ + 0.5, tip.x + 0.1, tip.y + 0.1, stem, "dark");
			w.cyl(tip.x, tip.y, 0.24, lowZ + 0.12, lowZ + 0.5, "steel", { n: 6 });
			const hx = pose === "act" ? 1.1 : 0.3;
			w.box(tip.x - 0.1, tip.y - 0.1, lowZ + 0.5, tip.x + hx, tip.y + 0.1, lowZ + 0.64, "dark");
			break;
		}
	}
}

/** The Open station: a C-frame press. One column behind the line, a head that reaches over it, a platen that comes down. */
function press(w, x, pose, targetTopZ) {
	const yb = -1.55;
	w.box(x - 0.55, yb - 0.4, 0, x + 0.55, yb + 0.4, 0.2, "dark", { hatch: "edge" });
	w.box(x - 0.45, yb - 0.3, 0.2, x + 0.45, yb + 0.3, 3.0, "steel", { shadow: true });
	// the head reaches from the column to over the line
	w.box(x - 0.45, yb - 0.3, 3.0, x + 0.45, 0.45, 3.4, "steel");
	w.box(x - 0.14, -0.14, 2.5, x + 0.14, 0.14, 3.0, "dark");
	const pz = pose === "act" ? targetTopZ + 0.35 : pose === "reach" ? targetTopZ + 1.0 : targetTopZ + 1.6;
	const ram = pose === "act" ? targetTopZ + 0.53 : pose === "reach" ? targetTopZ + 1.18 : targetTopZ + 1.78;
	w.box(x - 0.07, -0.07, ram, x + 0.07, 0.07, 2.5, "dark");
	w.box(x - 0.8, -0.58, pz, x + 0.8, 0.58, pz + 0.18, "steel");
}

/** The Follow up rover: a small tracked chassis with a bin and a beacon. */
function rover(w, x, y, withCard) {
	w.boxC(x, y, 1.5, 0.8, 0.12, 0.42, "steel", { shadow: true });
	for (const dx of [-0.5, 0.5]) for (const dy of [-0.46, 0.46]) w.boxC(x + dx, y + dy, 0.3, 0.12, 0.02, 0.34, "dark");
	w.boxC(x, y, 1.1, 0.6, 0.42, 0.62, "steel");
	w.cyl(x + 0.42, y, 0.08, 0.62, 1.15, "dark", { n: 8 });
	w.cyl(x + 0.42, y, 0.14, 1.15, 1.28, "steel", { n: 8 });
	if (withCard) {
		w.prism([{ x: x - 0.4, y: y - 0.22 }, { x: x + 0.3, y: y - 0.22 }, { x: x + 0.3, y: y + 0.22 }, { x: x - 0.4, y: y + 0.22 }], 0.62, 0.74, "paper", {
			deco: (P) => `<path d="${ringD(P, [x - 0.22, y - 0.05, 0.74], "z", 0.07, 14)}" fill="none" stroke="${TOK.ink}" stroke-width="1"/>`,
		});
	}
}

/** The follow-up feed: a thin rail beside the line, going back toward the queue. */
function feed(w, active) {
	const y = 2.35;
	w.box(1.0, y - 0.5, 0, 19.0, y + 0.5, 0.08, "belt", { hatch: "edge" });
	w.mark((P) => {
		const d = [];
		for (let x = 1.4; x < 18.8; x += 0.8) {
			const a = P(x, y - 0.5, 0.08);
			const b = P(x, y + 0.5, 0.08);
			d.push(`M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`);
		}
		const chev = [];
		const marks = active ? [3.5, 6.5, 9.5, 12.5, 15.5] : [];
		for (const x of marks) {
			const a = P(x + 0.45, y, 0.09);
			const b = P(x - 0.1, y - 0.28, 0.09);
			const c = P(x - 0.1, y + 0.28, 0.09);
			chev.push(`M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}L${f(c.x)} ${f(c.y)}Z`);
		}
		const a1 = P(1.0, y - 0.5, 0.08);
		return `<path d="${d.join("")}" stroke="${TOK.strong}" stroke-width="0.7" fill="none" opacity="0.8"/><path d="${chev.join("")}" fill="${TOK.ink}" stroke="${TOK.ink}" stroke-width="0.8"/><!--${a1.x}-->`;
	});
}

/** A person: a green plinth with a figure on it (torso, shoulders, neck, head, arms). `reach` puts a hand out to the key. */
function person(w, x, y, reach = false, kx = x, ky = -1.4) {
	w.cyl(x, y, 0.72, 0, 0.5, "person", { n: 6, rot: Math.PI / 6, hatch: "h" });
	w.cyl(x, y, 0.42, 0.5, 1.5, "person", { n: 16, ry: 0.3 });
	w.cyl(x, y, 0.74, 1.35, 1.72, "person", { n: 18, ry: 0.32 });
	w.cyl(x, y, 0.13, 1.72, 1.95, "person", { n: 8 });
	w.mark((P, pat) => {
		const c = P(x, y, 2.3);
		const u = Math.abs(P(1, 0, 0).x - P(0, 0, 0).x);
		return `<circle cx="${f(c.x)}" cy="${f(c.y)}" r="${f(0.4 * u * 1.15)}" fill="${pat("accent", "soft", 1, 0)}" stroke="${TOK.accent}" stroke-width="1.2"/>`;
	});
	w.cyl(x - 0.8, y + 0.02, 0.12, 0.85, 1.6, "person", { n: 8 });
	if (reach) {
		w.box(x + 0.7, y, 1.3, x + 0.92, ky - 0.1, 1.55, "person");
		w.box(x + 0.7, ky - 0.2, 0.9, x + 1.05, ky + 0.1, 1.55, "person");
	} else {
		w.cyl(x + 0.8, y + 0.02, 0.12, 0.85, 1.6, "person", { n: 8 });
	}
}

/** The merge desk: a console with a key, and the person's question card holder. */
function desk(w, x, pressed, question) {
	w.box(x - 1.3, -1.8, 0, x + 2.0, -1.0, 0.55, "steel", { shadow: true });
	const kz = pressed ? 0.6 : 0.82;
	w.box(x - 0.4, -1.65, 0.55, x + 0.4, -1.15, kz, "green");
	if (question) {
		const qx = x + 1.45;
		w.box(qx - 0.05, -1.55, 0.55, qx + 0.05, -1.25, 0.72, "dark");
		w.box(qx - 0.05, -1.7, 0.72, qx + 0.07, -1.1, 1.5, "paper", {
			deco: (P) => {
				const arc = circ(P, [qx + 0.07, -1.4, 1.22], ...PLANE.x, 0.2, 16).slice(2, 13);
				const d1 = P(qx + 0.07, -1.4, 1.0);
				return `<path d="${pathOf(arc, false)}" fill="none" stroke="${TOK.ink}" stroke-width="1.6" stroke-linecap="round"/><circle cx="${f(d1.x)}" cy="${f(d1.y)}" r="1.5" fill="${TOK.ink}"/>`;
			},
		});
	}
}

/** The dispatcher: a cart on a low rail along the front strip, with a mast and a reading eye. */
const DISP = { y: 3.35, x0: 0.8, x1: 12.4 };
function dispatcher(w, cx, pose = "rest") {
	w.box(DISP.x0, DISP.y - 0.2, 0, DISP.x1, DISP.y + 0.2, 0.12, "dark", { hatch: "edge" });
	w.box(cx - 0.55, DISP.y - 0.35, 0.12, cx + 0.55, DISP.y + 0.35, 0.5, "steel", { shadow: true });
	w.box(cx - 0.09, DISP.y - 0.09, 0.5, cx + 0.09, DISP.y + 0.09, 1.55, "dark");
	w.cyl(cx, DISP.y, 0.3, 1.55, 1.9, "steel", { n: 12 });
	w.cyl(cx, DISP.y, 0.14, 1.9, 2.02, "dark", { n: 8 });
}

/* ------------------------------------------------------------ the steps */
const STEPS = [
	{ id: "queue", name: "Queue", cam: { fx: 11, fy: 0, fz: 0.8, wide: "fit", tall: 34, tfx: 5.2, tfy: 0 } },
	{ id: "pick", name: "Pick up", cam: { fx: 4.6, fy: 0, fz: 0.7, wide: 62, tall: 50 } },
	{ id: "open", name: "Build and open", cam: { fx: 10.2, fy: 0, fz: 0.7, wide: 62, tall: 50 } },
	{ id: "drive", name: "Drive", cam: { fx: 16.8, fy: -0.3, fz: 0.7, wide: 56, tall: 44 } },
	{ id: "repair", name: "Repair, then green", cam: { fx: 16.6, fy: 0, fz: 0.7, wide: 62, tall: 50 } },
	{ id: "merge", name: "Merge", cam: { fx: 19.8, fy: -0.5, fz: 0.7, wide: 62, tall: 44, tfx: 19.6, tfy: -0.9 } },
	{ id: "followup", name: "Follow up", cam: { fx: 10.2, fy: 0, fz: 0.8, wide: "fit", tall: 44 } },
	{ id: "capacity", name: "Capacity", cam: { fx: 6.2, fy: 1.4, fz: 0.8, wide: 50, tall: 36 } },
];

/** Build the world for step i (1-based). */
function buildStep(i, { tall = false } = {}) {
	const w = new World();
	plate(w);
	const act = (k) => (i === k ? "act" : "rest");
	const L = []; // label requests, in priority order
	const capacity = i === 8;

	// queue
	const qCount = i === 1 ? 6 : 5;
	queue(w, qCount);
	L.push(["Queue", [ST.queue[0] + 1.0, 0, 0.9], "up"]);

	// the stations
	const pickPose = act(2);
	const a1 = arm(w, { px: ST.pick + 1.0, tx: ST.pick - 0.5, ty: 0, pose: pickPose, tool: "grip", quillAct: 1.0, target: TOPZ + 0.5 });
	tool(w, "grip", a1, pickPose, i === 2 ? TOPZ + 0.7 : TOPZ);
	L.push(["Pick up", [ST.pick + 1.0, ARM_Y, 2.6], "up"]);

	const buildPose = "rest";
	const a2 = arm(w, { px: ST.build + 1.0, tx: ST.build, ty: 0, pose: buildPose, tool: "weld" });
	tool(w, "weld", a2, buildPose, TOPZ);
	L.push(["Build", [ST.build + 1.0, ARM_Y, 2.6], "up"]);

	const pressPose = act(3);
	press(w, ST.open, pressPose, i === 3 ? TOPZ + 0.3 : TOPZ + 0.3);
	L.push(["Open", [ST.open, -1.55, 3.4], "up"]);

	const drivePose = act(4);
	const a4 = arm(w, { px: ST.drive + 1.0, tx: ST.drive, ty: 0, pose: drivePose, tool: "probe" });
	tool(w, "probe", a4, drivePose, TOPZ + 0.55);
	L.push(["Drive", [ST.drive + 1.0, ARM_Y, 2.6], "up"]);

	const repairPose = act(5);
	const a5 = arm(w, { px: ST.repair + 1.0, tx: ST.repair, ty: 0, pose: repairPose, tool: "wrench" });
	tool(w, "wrench", a5, repairPose, TOPZ + 0.55);
	L.push(["Repair", [ST.repair + 1.0, ARM_Y, 2.6], "up"]);

	// the person's desk
	person(w, ST.merge, ARM_Y - 0.5, i === 6, ST.merge + 0.3);
	desk(w, ST.merge + 0.3, i === 6, i === 4);
	L.push(["Merge", [ST.merge, ARM_Y - 0.5, 2.7], "up"]);
	if (i === 4) L.push(["Question", [ST.merge + 1.75, -1.4, 1.5], "right"]);

	// the follow-up feed and rover
	feed(w, i === 7);
	w.scaled(1.3, i === 7 ? 10.2 : 17.4, 2.35, 0, () => rover(w, i === 7 ? 10.2 : 17.4, 2.35, i === 7));
	L.push(["Follow up", [i === 7 ? 10.2 : 17.4, 2.35, 1.3], "down"]);

	// the item
	const iz = TOPZ;
	const K = 1.3;
	const at = (x, y, z) => (fn) => w.scaled(K, x, y, z, fn);
	switch (i) {
		case 2:
			at(ST.pick - 0.5, 0, iz + 1.25)(() => issueCard(w, ST.pick - 0.5, 0, iz + 1.25));
			L.push(["Issue", [ST.pick - 0.5, 0, iz + 1.45], "down"]);
			break;
		case 3:
			at(ITEM_X.open, 0, iz)(() => issueWithPR(w, ITEM_X.open, 0, iz));
			L.push(["Pull request", [ITEM_X.open + 0.4, 0.4, iz + 0.5], "down"]);
			break;
		case 4:
			at(ITEM_X.drive, 0, iz)(() => pullRequest(w, ITEM_X.drive, 0, iz + 0.1, "review"));
			L.push(["Checks", [ITEM_X.drive, -0.52, iz + 0.5], "left"]);
			L.push(["Comments", [ITEM_X.drive + 0.4, 0.55, iz + 0.7], "down"]);
			break;
		case 5:
			at(ITEM_X.repair, 0, iz)(() => pullRequest(w, ITEM_X.repair, 0, iz + 0.1, "green"));
			L.push(["Checks", [ITEM_X.repair, -0.52, iz + 0.5], "left"]);
			break;
		case 6:
			at(ITEM_X.merge, 0, iz)(() => mergedSlab(w, ITEM_X.merge, 0, iz));
			L.push(["Merged", [ITEM_X.merge, 0, iz + 0.6], "down"]);
			break;
		case 7:
			at(ITEM_X.merge, 0, iz)(() => mergedSlab(w, ITEM_X.merge, 0, iz));
			at(10.2, 2.35, 0.74)(() => issueCard(w, 10.2, 2.35, 0.74));
			break;
	}
	const AV = { 2: [ST.pick - 0.5, 0, TOPZ + 1.25], 3: [ITEM_X.open, 0, TOPZ], 4: [ITEM_X.drive, 0, TOPZ + 0.1], 5: [ITEM_X.repair, 0, TOPZ + 0.1], 6: [ITEM_X.merge, 0, TOPZ], 7: [ITEM_X.merge, 0, TOPZ] }[i];
	if (AV) w.avoid.push([AV[0] - 0.9, AV[1] - 0.7, AV[2], AV[0] + 0.9, AV[1] + 0.7, AV[2] + 0.9]);
	dispatcher(w, capacity ? 3.9 : 1.6);
	L.push(["Dispatcher", [capacity ? 3.9 : 1.6, DISP.y, 2.0], "up"]);
	if (capacity) capacityBank(w, L);
	w.labelPlan = L;
	return w;
}

/** Step 8: the wall across the lane, the host's gauges, the dispatcher reading them. */
function capacityBank(w, L) {
	const wallX = 4.0;
	w.box(wallX, -1.5, 0, wallX + 0.45, 1.5, 2.6, "wall", { hatch: "v", shadow: true });
	// courses
	w.mark((P) => {
		const d = [];
		for (let k = 1; k < 6; k++) {
			const y = -1.5 + k * 0.5;
			const a = P(wallX + 0.45, y, 0);
			const b = P(wallX + 0.45, y, 2.6);
			d.push(`M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`);
		}
		return `<path d="${d.join("")}" stroke="${TOK.ink}" stroke-width="0.7" fill="none"/>`;
	});
	L.push(["Usage limit", [wallX + 0.2, 0.4, 2.6], "up"]);
	// the issue waiting at the wall
	issueCard(w, wallX - 0.9, 0, TOPZ);
	// the console in front, with four gauges
	const cy = 4.5;
	w.box(1.0, cy - 0.7, 0, 12.2, cy + 0.7, 0.6, "steel", { hatch: "edge", shadow: false });
	const gz = 0.6;
	// Memory: three columns
	[0.55, 0.95, 0.75].forEach((hh, k) => {
		w.box(1.8 + k * 0.4, cy - 0.25, gz, 2.1 + k * 0.4, cy + 0.25, gz + 0.3 + hh * 1.3, "steel");
	});
	L.push(["Memory", [2.4, cy, gz + 1.6], "up"]);
	// Processor: a dial
	w.cyl(5.2, cy, 0.7, gz, gz + 0.9, "steel", {
		n: 20,
		deco: (P) => {
			const c = [5.2, cy, gz + 0.9];
			const arcPts = Array.from({ length: 9 }, (_, k) => {
				const a = Math.PI * (1.15 - 1.3 * (k / 8));
				return P(c[0] + 0.5 * Math.cos(a), c[1] + 0.5 * Math.sin(a), c[2]);
			});
			const needle = [P(...c), P(c[0] + 0.45 * Math.cos(0.9), c[1] + 0.45 * Math.sin(0.9), c[2])];
			const ticks = Array.from({ length: 9 }, (_, k) => {
				const a = Math.PI * (1.15 - 1.3 * (k / 8));
				const p0 = P(c[0] + 0.5 * Math.cos(a), c[1] + 0.5 * Math.sin(a), c[2]);
				const p1 = P(c[0] + 0.38 * Math.cos(a), c[1] + 0.38 * Math.sin(a), c[2]);
				return `M${f(p0.x)} ${f(p0.y)}L${f(p1.x)} ${f(p1.y)}`;
			}).join("");
			return `<path d="${pathOf(arcPts, false)}" fill="none" stroke="${TOK.ink}" stroke-width="1"/><path d="${ticks}" stroke="${TOK.ink}" stroke-width="0.8"/><path d="${pathOf(needle, false)}" stroke="${TOK.ink}" stroke-width="1.6" stroke-linecap="round"/>`;
		},
	});
	L.push(["Processor", [5.2, cy, gz + 0.95], "up"]);
	// Disk: stacked platters
	[0, 0.2, 0.4].forEach((dz, k) => w.cyl(8.0, cy, 0.65 - k * 0.04, gz + dz, gz + dz + 0.14, k === 2 ? "dark" : "steel", { n: 20 }));
	w.box(8.5, cy - 0.06, gz + 0.62, 9.2, cy + 0.06, gz + 0.74, "dark");
	L.push(["Disk", [8.0, cy, gz + 0.8], "up"]);
	// Forge budget: a tank with a level
	w.cyl(10.9, cy, 0.62, gz, gz + 0.5, "glass", { n: 18 });
	w.cyl(10.9, cy, 0.62, gz + 0.5, gz + 1.35, "glass", { n: 18, topFill: TOK.card });
	L.push(["Forge budget", [10.9, cy, gz + 1.4], "up"]);
	// sensor lines from the dispatcher to each gauge
	w.mark((P) => {
		const from = [3.9, DISP.y, 1.95];
		const to = [[2.4, cy - 0.3, gz + 1.0], [5.2, cy - 0.5, gz + 0.9], [8.0, cy - 0.5, gz + 0.5], [10.9, cy - 0.5, gz + 0.9]];
		const d = to.map((t) => `M${f(P(...from).x)} ${f(P(...from).y)}L${f(P(...t).x)} ${f(P(...t).y)}`).join("");
		return `<path d="${d}" stroke="${TOK.ink}" stroke-width="0.9" stroke-dasharray="3 3" fill="none"/>`;
	});
}

/* --------------------------------------------------------------- frames */
function bounds(world, P1) {
	let x0 = Infinity;
	let x1 = -Infinity;
	let y0 = Infinity;
	let y1 = -Infinity;
	for (const s of world.solids) {
		for (const p of s.pts) {
			for (const z of [s.z0, s.z1]) {
				const q = P1(p.x, p.y, z);
				x0 = Math.min(x0, q.x);
				x1 = Math.max(x1, q.x);
				y0 = Math.min(y0, q.y);
				y1 = Math.max(y1, q.y);
			}
		}
	}
	return { x0, x1, y0, y1 };
}

const FORMATS = {
	wide: { W: 960, H: 540, fs: 12, margin: 40 },
	tall: { W: 390, H: 520, fs: 14, margin: 18, zoom: 40 },
};

function frame(i, format) {
	const F = FORMATS[format];
	const w = buildStep(i, { tall: format === "tall" });
	const cam = STEPS[i - 1].cam;
	const P1 = makeProjector(1, 0, 0);
	let s;
	let ox;
	let oy;
	const zoom = format === "wide" ? cam.wide : cam.tall;
	if (zoom === "fit") {
		// the line from the queue to the merge, plate edges allowed to run off the frame
		const pts = [];
		for (const x of [0.2, 21.8]) for (const y of [-3.0, 3.0]) for (const z of [0, 3.3]) pts.push(P1(x, y, z));
		const b = { x0: Math.min(...pts.map((p) => p.x)), x1: Math.max(...pts.map((p) => p.x)), y0: Math.min(...pts.map((p) => p.y)), y1: Math.max(...pts.map((p) => p.y)) };
		s = Math.min((F.W - 2 * F.margin) / (b.x1 - b.x0), (F.H - 2 * F.margin) / (b.y1 - b.y0));
		ox = F.W / 2 - (s * (b.x0 + b.x1)) / 2;
		oy = F.H / 2 - (s * (b.y0 + b.y1)) / 2 + 4;
	} else {
		s = zoom;
		const c = P1(format === "tall" && cam.tfx !== undefined ? cam.tfx : cam.fx, format === "tall" && cam.tfy !== undefined ? cam.tfy : cam.fy, cam.fz);
		ox = F.W / 2 - s * c.x;
		oy = F.H / 2 - s * c.y + 0;
	}
	const P = makeProjector(s, ox, oy);
	const { body, pats } = renderWorld(w, P, F.W, F.H, { id: `a-${format}-${i}` });
	const OWN = new Set(["Issue", "Pull request", "Checks", "Comments", "Merged"]);
	const labels = placeLabels(w.labelPlan.map(([text, at, dir]) => ({ text, at, dir, own: OWN.has(text) })).sort((p, q) => Number(q.own) - Number(p.own)), P, F.W, F.H, F.fs, w.avoid);
	const clip = `<clipPath id="a-${format}-${i}-clip"><rect width="${F.W}" height="${F.H}"/></clipPath>`;
	const title = `Step ${i}: ${STEPS[i - 1].name}`;
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${F.W} ${F.H}" width="${F.W}" height="${F.H}" role="img" aria-label="${title}"><title>${title}</title>${defsOf(pats)}${clip}<rect width="${F.W}" height="${F.H}" fill="${TOK.bg}"/><g clip-path="url(#a-${format}-${i}-clip)">${body}</g>${labels}</svg>`;
}

/* ------------------------------------------------ the sheets (agents, item) */
function miniWorld(fill) {
	const w = new World();
	w.box(-2.0, -0.75, 0, 2.0, 0.75, BELT.top, "belt");
	fill(w);
	return w;
}
function cell(world, x, y, cw, ch, id, extra = "", ref = null) {
	const P1 = makeProjector(1, 0, 0);
	const b = ref ?? bounds(world, P1);
	const s = Math.min((cw - 16) / (b.x1 - b.x0), (ch - 12) / (b.y1 - b.y0));
	const P = makeProjector(s, 0, 0);
	const ox = cw / 2 - s * (b.x0 + b.x1) / 2;
	const oy = ch / 2 - s * (b.y0 + b.y1) / 2;
	const Pc = makeProjector(s, ox, oy);
	const { body, pats } = renderWorld(world, Pc, cw, ch, { id });
	return { markup: `<g transform="translate(${f(x)} ${f(y)})">${body}${extra}</g>`, pats, P };
}

function agentsSheet() {
	const rows = [
		["Pick up", (pose) => (w) => {
			const a = arm(w, { px: 1.0, tx: -0.5, ty: 0, py: -2.0, pose, tool: "grip", quillAct: 1.0 });
			tool(w, "grip", a, pose, pose === "act" ? TOPZ + 0.7 : TOPZ);
			if (pose === "act") issueCard(w, -0.5, 0, TOPZ + 1.25);
			else issueCard(w, -0.5, 0, TOPZ);
		}],
		["Build", (pose) => (w) => {
			const a = arm(w, { px: 1.0, tx: 0, ty: 0, py: -2.0, pose, tool: "weld" });
			tool(w, "weld", a, pose, TOPZ + 0.14);
			issueCard(w, 0, 0, TOPZ);
		}],
		["Open", (pose) => (w) => {
			press(w, 0, pose, TOPZ + 0.3);
			issueWithPR(w, 0, 0, TOPZ);
		}],
		["Drive", (pose) => (w) => {
			const a = arm(w, { px: 1.0, tx: 0, ty: 0, py: -2.0, pose, tool: "probe" });
			tool(w, "probe", a, pose, TOPZ + 0.55);
			pullRequest(w, 0, 0, TOPZ + 0.1, "review");
		}],
		["Repair", (pose) => (w) => {
			const a = arm(w, { px: 1.0, tx: 0, ty: 0, py: -2.0, pose, tool: "wrench" });
			tool(w, "wrench", a, pose, TOPZ + 0.55);
			pullRequest(w, 0, 0, TOPZ + 0.1, pose === "act" ? "green" : "review");
		}],
		["Follow up", (pose) => (w) => {
			w.scaled(1.3, 0, 2.35, 0, () => rover(w, pose === "rest" ? 1.4 : pose === "reach" ? 0.3 : -0.9, 2.35, pose === "act"));
		}],
		["Dispatcher", (pose) => (w) => {
			const cx = pose === "rest" ? -1.4 : pose === "reach" ? 0 : 1.2;
			w.box(-2.0, 2.0, 0, 2.6, 2.4, 0.12, "dark");
			w.box(cx - 0.55, 1.85, 0.12, cx + 0.55, 2.55, 0.5, "steel");
			w.box(cx - 0.09, 2.11, 0.5, cx + 0.09, 2.29, 1.55, "dark");
			w.cyl(cx, 2.2, 0.3, 1.55, 1.9, "steel", { n: 12 });
			w.cyl(cx, 2.2, 0.14, 1.9, 2.02, "dark", { n: 8 });
		}],
	];
	const W = 960;
	const H = 720;
	const cw = 270;
	const ch = 96;
	const poses = ["rest", "reach", "act"];
	let allPats = new Map();
	let body = "";
	rows.forEach(([name, mk], r) => {
		// one scale and centre for the row, so the three poses can be compared
		const worlds = poses.map((pose) => miniWorld(mk(pose)));
		const bs = worlds.map((wd) => bounds(wd, makeProjector(1, 0, 0)));
		const ref = { x0: Math.min(...bs.map((b) => b.x0)), x1: Math.max(...bs.map((b) => b.x1)), y0: Math.min(...bs.map((b) => b.y0)), y1: Math.max(...bs.map((b) => b.y1)) };
		poses.forEach((pose, c) => {
			const world = worlds[c];
			const x = 150 + c * (cw + 0);
			const y = 6 + r * (ch + 2);
			const cl = cell(world, x, y, cw, ch, `a-ag-${r}${c}`, "", ref);
			body += cl.markup;
			for (const [k, v] of cl.pats) allPats.set(`${r}${c}${k}`, v);
		});
		body += `<text x="16" y="${6 + r * (ch + 2) + ch / 2 + 5}" font-family="${SANS}" font-size="14" font-weight="600" fill="${TOK.ink}">${name}</text>`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Each agent in three poses: rest, reach, act"><title>Agents: rest, reach, act</title>${defsOf(allPats)}<rect width="${W}" height="${H}" fill="${TOK.bg}"/>${body}</svg>`;
}

function itemSheet() {
	const forms = [
		(w) => issueCard(w, 0, 0, TOPZ),
		(w) => issueWithPR(w, 0, 0, TOPZ),
		(w) => pullRequest(w, 0, 0, TOPZ + 0.1, "review"),
		(w) => pullRequest(w, 0, 0, TOPZ + 0.1, "green"),
		(w) => mergedSlab(w, 0, 0, TOPZ),
	];
	const names = ["Issue", "Pull request", "Checks", "Checks", "Merged"];
	let allPats = new Map();
	let body = "";
	forms.forEach((mk, k) => {
		const w = new World();
		w.box(-1.6, -1.3, -0.3, 1.6, 1.3, 0, "floor", { hatch: "edge" });
		w.box(-1.6, -0.75, 0, 1.6, 0.75, BELT.top, "belt");
		mk(w);
		const cl = cell(w, k * 192, 0, 192, 200, `a-it-${k}`);
		body += cl.markup;
		for (const [key, v] of cl.pats) allPats.set(`${k}${key}`, v);
		if (k !== 3) body += `<text x="${k * 192 + 96}" y="228" font-family="${SANS}" font-size="14" font-weight="600" text-anchor="middle" fill="${TOK.ink}">${names[k]}</text>`;
		else body += `<text x="${k * 192 + 96}" y="228" font-family="${SANS}" font-size="14" font-weight="600" text-anchor="middle" fill="${TOK.ink}">Checks</text>`;
	});
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 240" width="960" height="240" role="img" aria-label="The item's five forms"><title>The item's five forms</title>${defsOf(allPats)}<rect width="960" height="240" fill="${TOK.bg}"/>${body}</svg>`;
}

/* ----------------------------------------------------------------- write */
for (const fmt of ["wide", "tall"]) {
	mkdirSync(join(HERE, fmt), { recursive: true });
	for (let i = 1; i <= 8; i++) writeFileSync(join(HERE, fmt, `step-${i}.svg`), frame(i, fmt));
}
writeFileSync(join(HERE, "agents.svg"), agentsSheet());
writeFileSync(join(HERE, "item-states.svg"), itemSheet());
console.log("wrote 16 frames, agents.svg and item-states.svg");
