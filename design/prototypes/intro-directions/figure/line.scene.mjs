/**
 * Jig's line, as an isometric engraving: ink on warm paper, faces shaded by
 * hatching, one green accent for the work item and the person's station.
 *
 * Step 1, "The line": seven stations stand on one slab floor around a closed
 * track (a rounded rectangle). Follow up feeds back to Pick up. The Merge
 * station is a person's: a hexagonal prism in green with a figure on it. One
 * work item travels the track from Pick up and waits at Merge.
 *
 * Step 2, "Two slots and the wall": the same floor, cleared and set again. One
 * account pad holds two slots, each with a work item; a third item waits on
 * the lane in front of a hatched wall that stands across it.
 *
 * Takes the runtime from `opts.kit` (no imports), so the file can live in any
 * repository. Pure: frame(t) depends only on t and constants. Colours are
 * tokens only; hatching is token-coloured <pattern>s, defined per frame with
 * ids built from `idPrefix`. Formats: 16:9 (desktop) and tall (phone).
 */
export const locales = ["en"];

const COPY = {
	title: { en: "Jig's line: seven stations in a loop, then two slots and the wall" },
	description: {
		en: "An engraved isometric floor. Seven stations stand around a closed track: Pick up, Build, Open, Drive, Repair, Merge and Follow up, which feeds back to Pick up. Merge is a person's station. One work item travels the track and waits at Merge. Then the floor is set again: one account pad with two slots, each holding a work item, and a third item waiting in front of a wall across the lane.",
	},
	stations: [{ en: "Pick up" }, { en: "Build" }, { en: "Open" }, { en: "Drive" }, { en: "Repair" }, { en: "Merge" }, { en: "Follow up" }],
	account: { en: "Account" },
	slot1: { en: "Slot 1" },
	slot2: { en: "Slot 2" },
	wall: { en: "The wall" },
	steps: [
		{ id: "line", label: { en: "The line" }, detail: { en: "Seven stations, run as a loop. A person merges at the sixth; the follow-up feeds back to the first." } },
		{ id: "slots", label: { en: "Two slots and the wall" }, detail: { en: "One account holds two sessions at once. At its usage limit the wall stands in front of it, and the next item waits." } },
	],
};

/**
 * Per-format world and picture. World units: x east, y north, z up. Stations
 * are given by the point of the track they stand at; each stands on the side
 * of the track away from the viewer, so the track and the item stay in sight.
 * `lift` and `side` place each label (lifts alternate where labels stand close).
 */
const LAYOUTS = {
	"16:9": {
		width: 960,
		height: 540,
		margin: { top: 30, right: 24, bottom: 16, left: 24 },
		font: 15,
		ink: 0.95,
		hatch: 0.6,
		floor: { x0: -10.2, x1: 10.2, y0: -6, y1: 6, h: 0.55 },
		loop: { a: 7, b: 2.8, r: 1.8 },
		plinth: 1.9,
		gap: 0.6,
		stations: [
			{ at: [-7, 0], lift: 18, side: "up" },
			{ at: [-3.5, -2.8], lift: 14, side: "up" },
			{ at: [0, -2.8], lift: 22, side: "up" },
			{ at: [3.5, -2.8], lift: 14, side: "up" },
			{ at: [7, 0], lift: 18, side: "up" },
			{ at: [2.6, 2.8], lift: 14, side: "up" },
			{ at: [-2.6, 2.8], lift: 14, side: "up" },
		],
		slots: {
			pad: { x: -4.4, y: -0.6, w: 6.2, d: 7, h: 0.55 },
			slot: [{ x: -4.4, y: -2.35 }, { x: -4.4, y: 1.15 }],
			slotPad: 2.4,
			item: 1.45,
			itemH: 1.15,
			wall: { x: 0.3, w: 0.45, d: 4.6, h: 2.6 },
			lane: { from: 9.2, to: -1.2, half: 1.1 },
			wait: 3,
			account: { x: -7, y: -3.6 },
			labels: { account: { lift: 106, side: "up" }, slot1: { lift: 86, side: "up" }, slot2: { lift: 34, side: "up" }, wall: { lift: 26, side: "right" } },
		},
	},
	tall: {
		width: 360,
		height: 430,
		margin: { top: 100, right: 8, bottom: 8, left: 8 },
		font: 14,
		ink: 0.85,
		hatch: 0.5,
		floor: { x0: -6.3, x1: 6.3, y0: -4.35, y1: 4.35, h: 0.5 },
		loop: { a: 3.6, b: 1.6, r: 1 },
		plinth: 1.85,
		gap: 0.42,
		stations: [
			{ at: [-3.6, 0], lift: 26, side: "left" },
			{ at: [-2.15, -1.6], lift: 14, side: "left" },
			{ at: [0, -1.6], lift: 110, side: "up" },
			{ at: [2.15, -1.6], lift: 94, side: "up" },
			{ at: [3.6, 0], lift: 18, side: "right" },
			{ at: [1.35, 1.6], lift: 14, side: "up" },
			{ at: [-1.35, 1.6], lift: 70, side: "right" },
		],
		slots: {
			pad: { x: -3.2, y: -0.3, w: 4.4, d: 6, h: 0.5 },
			slot: [{ x: -3.2, y: -1.75 }, { x: -3.2, y: 1.15 }],
			slotPad: 1.9,
			item: 1.15,
			itemH: 0.95,
			wall: { x: 0.2, w: 0.38, d: 3.6, h: 2.1 },
			lane: { from: 5.9, to: -1, half: 0.85 },
			wait: 2,
			account: { x: -5.1, y: -2.9 },
			labels: { account: { lift: 58, side: "up" }, slot1: { lift: 78, side: "up" }, slot2: { lift: 18, side: "up" }, wall: { lift: 50, side: "right" } },
		},
	},
};

// What tops each station's plinth, so the seven read as different machines,
// as in an engraved line of benches. Merge (index 5) is the person's prism.
const MACHINES = [
	{ kind: "box", w: 1.2, d: 0.8, h: 0.42, plinth: 0.95 }, // Pick up: a tray
	{ kind: "box", w: 0.6, d: 0.6, h: 0.95, plinth: 0.95 }, // Build: a press column
	{ kind: "box", w: 1.3, d: 1.3, h: 0.24, plinth: 1.1 }, // Open: a flat bed
	{ kind: "oct", r: 0.55, h: 0.55, plinth: 0.95 }, // Drive: a wheel housing
	{ kind: "jaws", w: 0.42, d: 1.2, h: 0.5, plinth: 0.95 }, // Repair: vise jaws
	{ kind: "merge", h: 1.9 }, // Merge: the person's station
	{ kind: "oct", r: 0.42, h: 0.75, plinth: 0.85 }, // Follow up: a drum
];

// Timeline, in seconds. Each beat ends before the next starts; both step frames are settled.
const FLOOR_IN = 0;
const RISE_AT = 0.25;
const RISE = 0.5;
const RISE_GAP = 0.09;
const TRACK_AT = 0.7;
const TRACK = 1.0;
const LABELS1_IN = 1.5;
const LABEL_FADE = 0.35;
const ITEM_AT = 1.9;
const ITEM_TRIP = 2.1;
const STEP1 = 4.15;
const CLEAR_AT = 4.3;
const CLEAR = 0.55;
const SET_AT = 4.85;
const PAD_RISE = 0.5;
const DROP_AT = 5.2;
const DROP = 0.45;
const WALL_AT = 5.55;
const WALL = 0.55;
const WAIT_AT = 5.3;
const WAIT_TRIP = 0.9;
const LABELS2_IN = 6.25;
const STEP2 = 6.7;
const DURATION = 6.9;

export default function make({ format = "16:9", locale = "en", kit, labelPlan } = {}) {
	if (!kit) throw new Error("line.scene: needs the motion-kit runtime as opts.kit");
	const { easeOut, easeStandard, progress, ISO_ELEVATION, camera, fitCamera, labelAnchor, orderSolids, path3, prism, box, slab, projector, regularPolygon, localize, tok, el, fade, num, wrapLabel } = kit;
	const base = LAYOUTS[format];
	if (!base) throw new Error(`line.scene: format "${format}" is not laid out (16:9, tall)`);
	// `labelPlan` (a scene option) replaces the label placement, to try a placement without editing the layout.
	const L = labelPlan
		? { ...base, stations: base.stations.map((st, i) => ({ ...st, ...(labelPlan.stations?.[i] ?? {}) })), slots: { ...base.slots, labels: { ...base.slots.labels, ...(labelPlan.slots ?? {}) } } }
		: base;
	const W = L.width;
	const H = L.height;
	const TOP = L.floor.h;
	const fs = L.font;

	/* ------------------------------------------------------------ the track */

	/** A rounded rectangle as world points, counter-clockwise from (-a, 0), going south first. */
	function loopPoints(a, b, r) {
		const pts = [{ x: -a, y: 0 }];
		const arc = (cx, cy, from) => {
			for (let i = 0; i <= 12; i++) {
				const ang = ((from + (90 * i) / 12) * Math.PI) / 180;
				pts.push({ x: cx + r * Math.cos(ang), y: cy + r * Math.sin(ang) });
			}
		};
		arc(-a + r, -b + r, 180);
		arc(a - r, -b + r, 270);
		arc(a - r, b - r, 0);
		arc(-a + r, b - r, 90);
		pts.push({ x: -a, y: 0 });
		return pts;
	}
	/** Cumulative lengths of a polyline. */
	const lengths = (pts) => pts.reduce((acc, p, i) => (i === 0 ? [0] : [...acc, acc[i - 1] + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y)]), /** @type {number[]} */ ([]));
	/** The polyline up to length s. */
	function upTo(pts, cum, s) {
		const out = [pts[0]];
		for (let i = 1; i < pts.length; i++) {
			if (cum[i] <= s) out.push(pts[i]);
			else {
				const k = (s - cum[i - 1]) / (cum[i] - cum[i - 1]);
				if (k > 1e-6) out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * k });
				break;
			}
		}
		return out;
	}
	/** The point, unit tangent and length along the polyline nearest a world point. */
	function nearest(pts, cum, q) {
		let best = { d: Infinity, s: 0, p: pts[0], t: { x: 1, y: 0 } };
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1];
			const b = pts[i];
			const len = cum[i] - cum[i - 1];
			const k = Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / (len * len)));
			const p = { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
			const d = Math.hypot(q.x - p.x, q.y - p.y);
			if (d < best.d - 1e-9) best = { d, s: cum[i - 1] + len * k, p, t: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
		}
		return best;
	}
	/** Point and tangent at length s. */
	function at(pts, cum, s) {
		let i = 1;
		while (i < pts.length - 1 && cum[i] < s) i++;
		const a = pts[i - 1];
		const b = pts[i];
		const len = cum[i] - cum[i - 1];
		const k = len === 0 ? 0 : (s - cum[i - 1]) / len;
		return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, t: { x: (b.x - a.x) / len, y: (b.y - a.y) / len } };
	}

	const { a: LA, b: LB, r: LR } = L.loop;
	const centre = loopPoints(LA, LB, LR);
	const centreCum = lengths(centre);
	const PERIM = centreCum[centreCum.length - 1];
	const RAIL = 0.42;
	const railOut = loopPoints(LA + RAIL, LB + RAIL, LR + RAIL);
	const railIn = loopPoints(LA - RAIL, LB - RAIL, LR - RAIL);
	const railOutCum = lengths(railOut);
	const railInCum = lengths(railIn);
	const ties = [];
	for (let s = 0.4; s < PERIM - 0.2; s += 0.75) ties.push(at(centre, centreCum, s));

	// Stations: outside the track (the track runs counter-clockwise, so outward is the tangent turned clockwise).
	const STATIONS = L.stations.map((st, i) => {
		const n = nearest(centre, centreCum, { x: st.at[0], y: st.at[1] });
		const nx = n.t.y;
		const ny = -n.t.x;
		const off = L.plinth / 2 + L.gap;
		return { ...st, i, s: n.s, track: n.p, x: n.p.x + nx * off, y: n.p.y + ny * off };
	});
	const MERGE = STATIONS[5];
	const itemRoute = path3([...upTo(centre, centreCum, MERGE.s)].map((p) => ({ x: p.x, y: p.y, z: TOP })));

	/* ----------------------------------------------------------- the camera */

	const S = L.slots;
	const tallest = 2.6;
	const extent = [
		...[L.floor.x0, L.floor.x1].flatMap((x) => [L.floor.y0, L.floor.y1].flatMap((y) => [{ x, y, z: 0 }, { x, y, z: TOP }])),
		...STATIONS.map((s) => ({ x: s.x, y: s.y, z: TOP + tallest })),
		{ x: S.wall.x, y: S.pad.y + S.wall.d / 2, z: TOP + S.wall.h },
	];
	const CAM = fitCamera(extent, camera({ azimuth: 45, elevation: ISO_ELEVATION }), { width: W, height: H, margin: L.margin });
	const to = projector(CAM);
	const rad = (d) => (d * Math.PI) / 180;
	const SA = Math.sin(rad(CAM.azimuth));
	const CA = Math.cos(rad(CAM.azimuth));
	const CE = Math.cos(rad(CAM.elevation));
	const SE = Math.sin(rad(CAM.elevation));

	/* ------------------------------------------------------------- hatching */

	// Line spacing per tone, in picture units: 0 light, 1 middle, 2 dense, 3 cross-hatched.
	const SPACING = [3.6, 2.5, 1.75, 2.6, 7.2];

	/** A registry of the hatch patterns a frame uses; ids from idPrefix, in order of first use. */
	function patterns(idPrefix) {
		const used = new Map();
		return {
			/** @param {string} ink @param {string | null} paper @param {number} tone @param {number} angle */
			use(ink, paper, tone, angle) {
				const a = Math.round(((angle % 180) + 180) % 180);
				const key = `${ink}|${paper}|${tone}|${a}`;
				if (!used.has(key)) used.set(key, { id: `${idPrefix}-h${used.size}`, ink, paper, tone, a });
				return `url(#${used.get(key).id})`;
			},
			defs() {
				if (!used.size) return "";
				const body = [...used.values()].map(({ id, ink, paper, tone, a }) => {
					const s = SPACING[tone];
					const d = tone === 3 ? `M0 ${num(s / 2)}H${num(s)}M${num(s / 2)} 0V${num(s)}` : `M0 ${num(s / 2)}H${num(s)}`;
					return el(
						"pattern",
						{ id, patternUnits: "userSpaceOnUse", width: s, height: s, patternTransform: `rotate(${a})` },
						paper ? el("rect", { width: s, height: s, fill: tok(paper) }) : "",
						el("path", { d, stroke: tok(ink), "stroke-width": tone === 3 ? L.hatch * 0.85 : L.hatch, fill: "none" }),
					);
				});
				return el("defs", {}, ...body);
			},
		};
	}

	const pathD = (points) => `${points.map((p, i) => `${i === 0 ? "M" : "L"}${num(p.x)} ${num(p.y)}`).join("")}Z`;
	const lineD = (points) => points.map((p, i) => `${i === 0 ? "M" : "L"}${num(p.x)} ${num(p.y)}`).join("");

	/**
	 * Materials: `ink` draws the outline and the hatching, `paper` lies under the
	 * hatching of the sides, `top` fills the top; `tone` darkens every side by one step.
	 */
	const MAT = {
		bench: { ink: "ink", paper: "bg", top: "surface", tone: 0 },
		floor: { ink: "ink", paper: "bg", top: "bg", tone: 0 },
		person: { ink: "accent", paper: "onAccent", top: "onAccent", tone: 0 },
		item: { ink: "accent", paper: "onAccent", top: "onAccent", tone: 0 },
		wall: { ink: "ink", paper: "bg", top: "surface", tone: 0, joints: true },
		pad: { ink: "ink", paper: "bg", top: "surface", tone: 0 },
	};

	/** One solid's visible faces, hatched: sides by how far each turns from the light (screen left), the top plain. */
	function drawHatched(solid, mat, P) {
		const pts = solid.points;
		const out = [];
		const sw = mat === MAT.floor ? L.ink * 1.15 : L.ink;
		if (solid.z1 - solid.z0 > 1e-6) {
			for (let i = 0; i < pts.length; i++) {
				const a = pts[i];
				const b = pts[(i + 1) % pts.length];
				const len = Math.hypot(b.x - a.x, b.y - a.y);
				const nx = (b.y - a.y) / len;
				const ny = -(b.x - a.x) / len;
				if ((nx * SA - ny * CA) * CE <= 1e-9) continue;
				const turn = nx * CA + ny * SA; // -1 faces the light, 1 faces away
				const tone = Math.min(3, (turn < -0.35 ? 0 : turn < 0.35 ? 1 : 2) + mat.tone);
				const A = to({ ...a, z: solid.z0 });
				const B = to({ ...b, z: solid.z0 });
				const angle = (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
				const face = [A, B, to({ ...b, z: solid.z1 }), to({ ...a, z: solid.z1 })];
				out.push(el("path", { d: pathD(face), fill: P.use(mat.ink, mat.paper, tone, angle), stroke: tok(mat.ink), "stroke-width": sw, "stroke-linejoin": "round" }));
				// A wall's courses: vertical joints over its hatching, so it reads as built, not as a shadow.
				if (mat.joints) out.push(el("path", { d: pathD(face), fill: P.use(mat.ink, null, 4, 90), stroke: "none" }));
			}
		}
		out.push(el("path", { d: pathD(pts.map((p) => to({ ...p, z: solid.z1 }))), fill: tok(mat.top), stroke: tok(mat.ink), "stroke-width": sw, "stroke-linejoin": "round" }));
		return fade(solid.opacity, {}, ...out);
	}

	/** Convex hull (monotone chain) of screen points. */
	function hull(points) {
		const p = [...points].sort((u, v) => u.x - v.x || u.y - v.y);
		const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
		const lower = [];
		for (const q of p) {
			while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
			lower.push(q);
		}
		const upper = [];
		for (const q of p.reverse()) {
			while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
			upper.push(q);
		}
		return [...lower.slice(0, -1), ...upper.slice(0, -1)];
	}

	// The light comes from the upper left and behind the viewer: a shadow falls back and to the right.
	const SHADOW = { x: 0.42, y: 0.72 };
	/** The hatched shadow a solid casts on the floor. */
	function shadow(solid, P) {
		const h = solid.z1 - TOP;
		if (h <= 0.02 || solid.z0 > TOP + 1e-6) return "";
		const pts = solid.points.flatMap((p) => [to({ ...p, z: TOP }), to({ x: p.x + SHADOW.x * h, y: p.y + SHADOW.y * h, z: TOP })]);
		return fade(solid.opacity, {}, el("path", { d: pathD(hull(pts)), fill: P.use("ink", null, 1, 0), stroke: "none" }));
	}

	/** A filled arrowhead on the floor at a point, pointing along a tangent. */
	function arrowhead(p, t, size) {
		const n = { x: -t.y, y: t.x };
		const tip = { x: p.x + t.x * size, y: p.y + t.y * size };
		const l = { x: p.x - t.x * size * 0.55 + n.x * size * 0.62, y: p.y - t.y * size * 0.55 + n.y * size * 0.62 };
		const r = { x: p.x - t.x * size * 0.55 - n.x * size * 0.62, y: p.y - t.y * size * 0.55 - n.y * size * 0.62 };
		return pathD([tip, l, r].map((q) => to({ ...q, z: TOP })));
	}

	/* --------------------------------------------------------------- solids */

	/** Step 1's solids at time t, each with its material. */
	function lineSolids(t) {
		const clear = progress(t, CLEAR_AT, CLEAR, easeStandard);
		const out = [];
		for (const st of STATIONS) {
			const grow = progress(t, RISE_AT + st.i * RISE_GAP, RISE, easeOut) * (1 - clear);
			const opacity = Math.min(progress(t, RISE_AT + st.i * RISE_GAP, RISE * 0.6), 1 - clear);
			if (opacity <= 0) continue;
			const m = MACHINES[st.i];
			const k = Math.max(0.02, grow);
			if (m.kind === "merge") {
				const r = L.plinth * 0.62;
				const hex = prism({ id: `st${st.i}`, points: regularPolygon(st.x, st.y, r, 6, 0), z: TOP, h: m.h * k, fill: "onAccent", opacity });
				// The person stands on it: an engraved bust, drawn in the picture's plane on the prism's top.
				out.push({ solid: hex, mat: MAT.person, bust: { x: st.x, y: st.y, z: TOP + m.h * k, size: k } });
				continue;
			}
			const ph = m.plinth * k;
			out.push({ solid: box({ id: `st${st.i}`, x: st.x, y: st.y, w: L.plinth, d: L.plinth, h: ph, z: TOP, fill: "surface", opacity }), mat: MAT.bench });
			const z = TOP + ph;
			const s = L.plinth / 2;
			if (m.kind === "box") out.push({ solid: box({ id: `m${st.i}`, x: st.x, y: st.y, w: m.w * s, d: m.d * s, h: m.h * k, z, fill: "surface", opacity }), mat: MAT.bench });
			if (m.kind === "oct") out.push({ solid: prism({ id: `m${st.i}`, points: regularPolygon(st.x, st.y, m.r * s, 8, 22.5), h: m.h * k, z, fill: "surface", opacity }), mat: MAT.bench });
			if (m.kind === "jaws")
				for (const dx of [-1, 1]) out.push({ solid: box({ id: `m${st.i}${dx}`, x: st.x + dx * 0.42 * s, y: st.y, w: m.w * s, d: m.d * s, h: m.h * k, z, fill: "surface", opacity }), mat: MAT.bench });
		}
		// The work item: travels from Pick up and waits at Merge.
		const go = progress(t, ITEM_AT, ITEM_TRIP, easeStandard);
		const itemOpacity = Math.min(progress(t, ITEM_AT - 0.25, 0.25), 1 - clear);
		if (itemOpacity > 0) {
			const p = itemRoute.at(go);
			const sz = L.plinth * 0.42;
			out.push({ solid: box({ id: "item", x: p.x, y: p.y, w: sz, d: sz, h: sz * 0.78, z: TOP, fill: "onAccent", opacity: itemOpacity }), mat: MAT.item });
		}
		return out;
	}

	/** Step 2's solids at time t. */
	function slotSolids(t) {
		const out = [];
		const set = progress(t, SET_AT, PAD_RISE, easeOut);
		if (set <= 0) return out;
		const opacity = progress(t, SET_AT, PAD_RISE * 0.6);
		const pad = box({ id: "pad", x: S.pad.x, y: S.pad.y, w: S.pad.w, d: S.pad.d, h: Math.max(0.02, S.pad.h * set), z: TOP, fill: "surface", opacity });
		out.push({ solid: pad, mat: MAT.pad });
		const padTop = TOP + S.pad.h * set;
		S.slot.forEach((p, i) => {
			out.push({ solid: box({ id: `slot${i}`, x: p.x, y: p.y, w: S.slotPad, d: S.slotPad, h: 0.14 * set, z: padTop, fill: "surface", opacity }), mat: MAT.pad });
			const drop = progress(t, DROP_AT + i * 0.12, DROP, easeOut);
			if (drop > 0) out.push({ solid: box({ id: `slotItem${i}`, x: p.x, y: p.y, w: S.item, d: S.item, h: S.itemH, z: padTop + 0.14 + (1 - drop) * 2.2, fill: "onAccent", opacity: progress(t, DROP_AT + i * 0.12, DROP * 0.5) }), mat: MAT.item });
		});
		const wall = progress(t, WALL_AT, WALL, easeOut);
		if (wall > 0) out.push({ solid: box({ id: "wall", x: S.wall.x, y: S.pad.y, w: S.wall.w, d: S.wall.d, h: Math.max(0.02, S.wall.h * wall), z: TOP, fill: "surface", opacity: progress(t, WALL_AT, WALL * 0.4) }), mat: MAT.wall });
		const come = progress(t, WAIT_AT, WAIT_TRIP, easeStandard);
		if (come > 0) {
			const x = S.lane.from - 0.8 + (S.wait - (S.lane.from - 0.8)) * come;
			out.push({ solid: box({ id: "waiting", x, y: S.pad.y, w: S.item, d: S.item, h: S.itemH, z: TOP, fill: "onAccent", opacity: progress(t, WAIT_AT, 0.2) }), mat: MAT.item });
		}
		return out;
	}

	/* --------------------------------------------------------------- labels */

	const names = COPY.stations.map((s) => wrapLabel(localize(s, locale), 12, 1));
	const stationTop = (st) => {
		const m = MACHINES[st.i];
		if (m.kind === "merge") return TOP + m.h + (BUST_TALL * 1.08) / CE;
		return TOP + m.plinth + m.h;
	};

	function labels(t) {
		const in1 = progress(t, LABELS1_IN, LABEL_FADE) * (1 - progress(t, CLEAR_AT, 0.25));
		const in2 = progress(t, LABELS2_IN, LABEL_FADE);
		const out = STATIONS.map((st) => labelAnchor(CAM, { id: `station-${st.i}`, at: { x: st.x, y: st.y, z: stationTop(st) }, lines: names[st.i], fontSize: fs, lift: st.lift, side: st.side, opacity: in1 }));
		const padTop = TOP + S.pad.h + 0.14;
		const lab = S.labels;
		out.push(
			labelAnchor(CAM, { id: "account", at: { x: S.account.x, y: S.account.y, z: TOP + S.pad.h }, lines: [localize(COPY.account, locale)], fontSize: fs, lift: lab.account.lift, side: lab.account.side, opacity: in2 }),
			labelAnchor(CAM, { id: "slot-1", at: { x: S.slot[0].x, y: S.slot[0].y, z: padTop + S.itemH }, lines: [localize(COPY.slot1, locale)], fontSize: fs, lift: lab.slot1.lift, side: lab.slot1.side, opacity: in2 }),
			labelAnchor(CAM, { id: "slot-2", at: { x: S.slot[1].x, y: S.slot[1].y, z: padTop + S.itemH }, lines: [localize(COPY.slot2, locale)], fontSize: fs, lift: lab.slot2.lift, side: lab.slot2.side, opacity: in2 }),
			labelAnchor(CAM, { id: "wall", at: { x: S.wall.x, y: S.pad.y + S.wall.d / 2 - 0.4, z: TOP + S.wall.h }, lines: [localize(COPY.wall, locale)], fontSize: fs, lift: lab.wall.lift, side: lab.wall.side, opacity: in2 }),
		);
		return out;
	}

	/* ---------------------------------------------------------------- frame */

	function track(t, P) {
		const clear = 1 - progress(t, CLEAR_AT, CLEAR, easeStandard);
		const drawn = progress(t, TRACK_AT, TRACK, easeStandard);
		if (drawn <= 0 || clear <= 0) return "";
		const proj = (pts) => pts.map((p) => to({ ...p, z: TOP }));
		const out = [];
		const sTo = drawn * PERIM;
		const tieLines = ties.filter((tie) => nearest(centre, centreCum, tie.p).s <= sTo + 1e-6);
		const tieD = tieLines
			.map(({ p, t: tg }) => {
				const n = { x: -tg.y, y: tg.x };
				const a = to({ x: p.x + n.x * (RAIL + 0.12), y: p.y + n.y * (RAIL + 0.12), z: TOP });
				const b = to({ x: p.x - n.x * (RAIL + 0.12), y: p.y - n.y * (RAIL + 0.12), z: TOP });
				return `M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}`;
			})
			.join("");
		if (tieD) out.push(el("path", { d: tieD, stroke: tok("line"), "stroke-width": L.hatch * 1.1, fill: "none" }));
		const frac = sTo / PERIM;
		out.push(el("path", { d: lineD(proj(upTo(railOut, railOutCum, frac * railOutCum[railOutCum.length - 1]))) + lineD(proj(upTo(railIn, railInCum, frac * railInCum[railInCum.length - 1]))), stroke: tok("ink"), "stroke-width": L.ink, fill: "none", "stroke-linejoin": "round" }));
		// Direction marks between the stations, and the return into Pick up, larger.
		const marks = [];
		for (let i = 0; i < STATIONS.length; i++) {
			const s0 = STATIONS[i].s;
			const s1 = i + 1 < STATIONS.length ? STATIONS[i + 1].s : PERIM;
			const mid = i + 1 < STATIONS.length ? (s0 + s1) / 2 : PERIM - 1.15;
			if (mid > sTo) continue;
			const { p, t: tg } = at(centre, centreCum, mid);
			marks.push(arrowhead(p, tg, i + 1 < STATIONS.length ? 0.42 : 0.62));
		}
		if (marks.length) out.push(el("path", { d: marks.join(""), fill: tok("ink"), stroke: tok("ink"), "stroke-width": L.hatch, "stroke-linejoin": "round" }));
		return fade(clear, {}, ...out);
	}

	function lane(t) {
		const drawn = progress(t, SET_AT, 0.7, easeStandard);
		if (drawn <= 0) return "";
		const x1 = S.lane.from;
		const x0 = x1 + (S.lane.to - x1) * drawn;
		const out = [];
		let d = "";
		for (const y of [S.pad.y - S.lane.half, S.pad.y + S.lane.half]) {
			const a = to({ x: x1, y, z: TOP });
			const b = to({ x: x0, y, z: TOP });
			d += `M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}`;
		}
		out.push(el("path", { d, stroke: tok("ink"), "stroke-width": L.ink, fill: "none" }));
		let tie = "";
		for (let x = x1 - 0.4; x > x0; x -= 0.75) {
			const a = to({ x, y: S.pad.y - S.lane.half - 0.12, z: TOP });
			const b = to({ x, y: S.pad.y + S.lane.half + 0.12, z: TOP });
			tie += `M${num(a.x)} ${num(a.y)}L${num(b.x)} ${num(b.y)}`;
		}
		if (tie) out.push(el("path", { d: tie, stroke: tok("line"), "stroke-width": L.hatch * 1.1, fill: "none" }));
		if (drawn >= 1) {
			const p = { x: (S.wall.x + S.wall.w / 2 + S.wait - S.item / 2) / 2 - 0.1, y: S.pad.y };
			out.push(el("path", { d: arrowhead(p, { x: -1, y: 0 }, 0.55), fill: tok("ink"), stroke: tok("ink"), "stroke-width": L.hatch }));
		}
		return el("g", {}, ...out);
	}

	function floorPlate(t, P) {
		const opacity = progress(t, FLOOR_IN, 0.4);
		const { x0, x1, y0, y1 } = L.floor;
		const f = slab({ x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, d: y1 - y0, h: TOP, fill: "bg" });
		// An engraved border, inset on the floor's top.
		const inset = 0.4;
		const border = [
			{ x: x0 + inset, y: y0 + inset },
			{ x: x1 - inset, y: y0 + inset },
			{ x: x1 - inset, y: y1 - inset },
			{ x: x0 + inset, y: y1 - inset },
		].map((p) => to({ ...p, z: TOP }));
		return fade(opacity, {}, drawHatched(f, MAT.floor, P), el("path", { d: pathD(border), fill: "none", stroke: tok("line"), "stroke-width": L.hatch }));
	}

	// The bust's height in world units, head included: what the Merge label stands on.
	const BUST_TALL = 1.15;
	/** A person's bust standing on a point: shoulders (a half ellipse) and a head, hatched in the accent. */
	function bust({ x, y, z, size }, P) {
		const base = to({ x, y, z });
		const u = (BUST_TALL / 3.2) * CAM.zoom * size; // the head's radius, in pixels
		const w = u * 1.7;
		const h = u * 1.35;
		const by = base.y - u * 0.15;
		const shoulders = `M${num(base.x - w)} ${num(by)}C${num(base.x - w)} ${num(by - h * 1.05)} ${num(base.x + w)} ${num(by - h * 1.05)} ${num(base.x + w)} ${num(by)}Z`;
		const hy = by - h - u * 0.95;
		return (
			el("path", { d: shoulders, fill: P.use("accent", "onAccent", 2, 90), stroke: tok("accent"), "stroke-width": L.ink, "stroke-linejoin": "round" }) +
			el("circle", { cx: base.x, cy: hy, r: u, fill: P.use("accent", "onAccent", 0, 90), stroke: tok("accent"), "stroke-width": L.ink })
		);
	}

	function frame(t, { idPrefix } = { idPrefix: "line" }) {
		const P = patterns(idPrefix);
		const items = [...lineSolids(t), ...slotSolids(t)];
		const byId = new Map(items.map((it) => [it.solid.id, it]));
		const parts = [floorPlate(t, P), track(t, P), lane(t)];
		parts.push(items.map((it) => shadow(it.solid, P)).join(""));
		for (const solid of orderSolids(items.map((it) => it.solid), CAM)) {
			const it = byId.get(solid.id);
			parts.push(drawHatched(solid, it.mat, P));
			if (it.bust && it.bust.size > 0.05) parts.push(fade(solid.opacity, {}, bust(it.bust, P)));
		}
		parts.push(...labels(t).map((l) => l.markup));
		return P.defs() + parts.join("");
	}

	return {
		id: `jig-line-${format.replace(":", "x")}`,
		width: W,
		height: H,
		duration: DURATION,
		title: localize(COPY.title, locale),
		description: localize(COPY.description, locale),
		stepLabelsInFrame: false,
		steps: [
			{ at: STEP1, id: COPY.steps[0].id, label: localize(COPY.steps[0].label, locale), detail: localize(COPY.steps[0].detail, locale) },
			{ at: STEP2, id: COPY.steps[1].id, label: localize(COPY.steps[1].label, locale), detail: localize(COPY.steps[1].detail, locale) },
		],
		contrastPairs: [
			{ fg: "accent", bg: "onAccent", min: 3, use: "outlines and hatching of the work items and the person's station, on their pale green faces" },
			{ fg: "ink", bg: "surface", min: 4.5, use: "label text in its box" },
		],
		labelBoxes: (t) => labels(t).map((l) => l.box),
		// Not part of the scene contract: the screen boxes of the solids at t, for tune-labels.mjs.
		obstacles: (t) =>
			[...lineSolids(t), ...slotSolids(t)].map(({ solid, mat }) => {
				const pts = solid.points.flatMap((p) => [to({ ...p, z: solid.z0 }), to({ ...p, z: solid.z1 })]);
				const xs = pts.map((p) => p.x);
				const ys = pts.map((p) => p.y);
				return { id: solid.id, key: mat === MAT.item || mat === MAT.person, x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
			}),
		frame,
	};
}
