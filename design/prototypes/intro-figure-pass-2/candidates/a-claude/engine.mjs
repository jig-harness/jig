/**
 * The isometric engine of candidate A: solids with hatched faces, depth order, labels.
 * Pure functions and one class; no file access. build.mjs describes the scene and uses it.
 */
export const C30 = Math.cos(Math.PI / 6);
export const SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
export const tk = (name, light) => `var(--${name},${light})`;
export const TOK = {
	bg: tk("bg", "#f9f6f1"),
	card: tk("card", "#fffdfa"),
	sunk: tk("sunk", "#f0ece5"),
	ink: tk("ink", "#251e18"),
	muted: tk("muted", "#59514a"),
	line: tk("line", "#d5d0c8"),
	strong: tk("line-strong", "#867f77"),
	accent: tk("accent", "#1a6444"),
	soft: tk("accent-soft", "#dbf2e4"),
	hl: tk("hl", "#f7e8af"),
};

/* ------------------------------------------------------------- numbers */
export const r2 = (n) => Math.round(n * 100) / 100;
export const f = (n) => String(r2(n));

/* ------------------------------------------------------------ materials */
// top: fill of the top face. paper: under the hatching of the sides. ink: hatch colour. tone: extra darkness.
export const MAT = {
	steel: { top: "card", paper: "bg", ink: "ink", tone: 0 },
	dark: { top: "strong", paper: "bg", ink: "ink", tone: 2 },
	belt: { top: "sunk", paper: "bg", ink: "ink", tone: 0 },
	floor: { top: "bg", paper: "bg", ink: "ink", tone: 0 },
	paper: { top: "card", paper: "card", ink: "ink", tone: -1 },
	person: { top: "soft", paper: "soft", ink: "accent", tone: 0 },
	green: { top: "soft", paper: "soft", ink: "accent", tone: 0 },
	wall: { top: "card", paper: "bg", ink: "ink", tone: 1 },
	glass: { top: "card", paper: "card", ink: "muted", tone: -1 },
};
export const SPACING = [4.6, 3.2, 2.3, 3.0];

/* ---------------------------------------------------------------- world */
export class World {
	constructor() {
		this.solids = [];
		this.marks = []; // free-standing 2D things drawn over the solids: (P) => string
		this.labels = [];
		this.tf = null; // { k, cx, cy, z }: a uniform scale about a point, applied to what is added while it is set
		this.avoid = []; // 3D boxes a label pill must stay clear of: [x0, y0, z0, x1, y1, z1]
	}
	/** Add what `fn` builds scaled by k about (cx, cy) at height z. Used to draw the item larger than the machines read at plate scale. */
	scaled(k, cx, cy, z, fn) {
		this.tf = { k, cx, cy, z };
		fn();
		this.tf = null;
	}
	prism(pts, z0, z1, mat, o = {}) {
		const tf = this.tf;
		if (tf) {
			pts = pts.map((p) => ({ x: tf.cx + tf.k * (p.x - tf.cx), y: tf.cy + tf.k * (p.y - tf.cy) }));
			z0 = tf.z + tf.k * (z0 - tf.z);
			z1 = tf.z + tf.k * (z1 - tf.z);
			if (o.deco) o = { ...o, deco: wrapDeco(o.deco, tf) };
		}
		const area = pts.reduce((s, p, i) => s + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0);
		const ccw = area < 0 ? [...pts].reverse() : pts;
		const xs = ccw.map((p) => p.x);
		const ys = ccw.map((p) => p.y);
		this.solids.push({ pts: ccw, z0, z1, mat: MAT[mat], bb: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), z0, z1 }, ...o });
		return this.solids[this.solids.length - 1];
	}
	box(x0, y0, z0, x1, y1, z1, mat, o) {
		return this.prism([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], z0, z1, mat, o);
	}
	boxC(cx, cy, w, d, z0, z1, mat, o) {
		return this.box(cx - w / 2, cy - d / 2, z0, cx + w / 2, cy + d / 2, z1, mat, o);
	}
	cyl(cx, cy, r, z0, z1, mat, o = {}) {
		const n = o.n ?? 14;
		const rot = o.rot ?? 0;
		const ry = o.ry ?? r;
		const pts = Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(rot + (2 * Math.PI * i) / n), y: cy + ry * Math.sin(rot + (2 * Math.PI * i) / n) }));
		return this.prism(pts, z0, z1, mat, { hatch: "h", ...o });
	}
	mark(fn) {
		this.marks.push(this.tf ? wrapDeco(fn, this.tf) : fn);
	}
	label(text, at, o = {}) {
		this.labels.push({ text, at, ...o });
	}
}

/** A decoration drawn in the item's own units, projected through the same scale as its solids. */
export function wrapDeco(fn, tf) {
	return (P, pat) => fn((x, y, z = 0) => P(tf.cx + tf.k * (x - tf.cx), tf.cy + tf.k * (y - tf.cy), tf.z + tf.k * (z - tf.z)), pat);
}

/* ----------------------------------------------------------- projection */
export function makeProjector(s, ox, oy) {
	return (x, y, z = 0) => ({ x: ox + s * (x - y) * C30, y: oy + s * ((x + y) * 0.5 - z) });
}
export const pathOf = (pts, close = true) => pts.map((p, i) => `${i ? "L" : "M"}${f(p.x)} ${f(p.y)}`).join("") + (close ? "Z" : "");

/** A circle (or ellipse) in a plane: centre c, in-plane axes u and v (3D vectors), radius r. */
export function circ(P, c, u, v, r, n = 24) {
	return Array.from({ length: n }, (_, i) => {
		const a = (2 * Math.PI * i) / n;
		const k = r * Math.cos(a);
		const m = r * Math.sin(a);
		return P(c[0] + u[0] * k + v[0] * m, c[1] + u[1] * k + v[1] * m, c[2] + u[2] * k + v[2] * m);
	});
}
export const PLANE = { z: [[1, 0, 0], [0, 1, 0]], y: [[1, 0, 0], [0, 0, 1]], x: [[0, 1, 0], [0, 0, 1]] };

/* ------------------------------------------------------------- ordering */
export function order(solids) {
	const n = solids.length;
	const before = Array.from({ length: n }, () => []);
	const indeg = new Array(n).fill(0);
	const eps = 1e-6;
	for (let i = 0; i < n; i++) {
		for (let j = i + 1; j < n; j++) {
			const a = solids[i].bb;
			const b = solids[j].bb;
			const aBehind = a.x1 <= b.x0 + eps || a.y1 <= b.y0 + eps || a.z1 <= b.z0 + eps;
			const bBehind = b.x1 <= a.x0 + eps || b.y1 <= a.y0 + eps || b.z1 <= a.z0 + eps;
			if (aBehind && !bBehind) (before[i].push(j), indeg[j]++);
			else if (bBehind && !aBehind) (before[j].push(i), indeg[i]++);
		}
	}
	const key = (s) => s.bb.x0 + s.bb.x1 + s.bb.y0 + s.bb.y1 + 0.6 * (s.bb.z0 + s.bb.z1);
	const ready = [];
	for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
	const out = [];
	while (ready.length) {
		ready.sort((p, q) => key(solids[q]) - key(solids[p]));
		const i = ready.pop();
		out.push(solids[i]);
		for (const j of before[i]) if (!--indeg[j]) ready.push(j);
	}
	if (out.length !== n) for (const s of solids) if (!out.includes(s)) out.push(s);
	return out;
}

/* -------------------------------------------------------------- drawing */
export function renderWorld(world, P, W, H, opts = {}) {
	const pats = new Map();
	const pat = (ink, paper, tone, angle) => {
		const a = Math.round(((angle % 180) + 180) % 180);
		const key = `${ink}|${paper}|${tone}|${a}`;
		if (!pats.has(key)) pats.set(key, { id: `${opts.id}-h${pats.size}`, ink, paper, tone, a });
		return `url(#${pats.get(key).id})`;
	};
	const out = [];
	const SW = 1;
	for (const s of order(world.solids)) {
		// leave out what lies wholly outside the frame
		const cs = s.pts.flatMap((p) => [P(p.x, p.y, s.z0), P(p.x, p.y, s.z1)]);
		if (!s.shadow && (Math.max(...cs.map((c) => c.x)) < -4 || Math.min(...cs.map((c) => c.x)) > W + 4 || Math.max(...cs.map((c) => c.y)) < -4 || Math.min(...cs.map((c) => c.y)) > H + 4)) continue;
		const g = [];
		const m = s.mat;
		const pts = s.pts;
		const n = pts.length;
		if (s.shadow) {
			const hh = s.z1 - s.z0;
			const d = { x: 0.5 * hh, y: -0.22 * hh };
			const all = pts.flatMap((p) => [P(p.x, p.y, 0), P(p.x + d.x, p.y + d.y, 0)]);
			g.push(`<path d="${pathOf(hull(all))}" fill="${pat("ink", null, 0, 0)}"/>`);
		}
		if (s.z1 - s.z0 > 1e-6) {
			for (let i = 0; i < n; i++) {
				const a = pts[i];
				const b = pts[(i + 1) % n];
				const len = Math.hypot(b.x - a.x, b.y - a.y);
				const nx = (b.y - a.y) / len;
				const ny = -(b.x - a.x) / len;
				if (nx + ny <= 1e-6) continue;
				const lit = (-nx + ny) / Math.SQRT2;
				const tone = Math.max(0, Math.min(3, (lit > 0.35 ? 0 : lit > -0.35 ? 1 : 2) + m.tone));
				const A = P(a.x, a.y, s.z0);
				const B = P(b.x, b.y, s.z0);
				const angle = s.hatch === "h" ? 0 : s.hatch === "v" ? 90 : (Math.atan2(B.y - A.y, B.x - A.x) * 180) / Math.PI;
				const face = [A, B, P(b.x, b.y, s.z1), P(a.x, a.y, s.z1)];
				g.push(`<path d="${pathOf(face)}" fill="${pat(m.ink, m.paper, tone, angle)}" stroke="${TOK[m.ink]}" stroke-width="${SW}" stroke-linejoin="round"/>`);
			}
		}
		g.push(`<path d="${pathOf(pts.map((p) => P(p.x, p.y, s.z1)))}" fill="${s.topFill ?? TOK[m.top]}" stroke="${TOK[m.ink]}" stroke-width="${SW}" stroke-linejoin="round"/>`);
		if (s.deco) g.push(s.deco(P, pat));
		out.push(g.join(""));
	}
	for (const mk of world.marks) out.push(mk(P, pat));
	return { body: out.join(""), pats };
}

export function hull(points) {
	const p = [...points].sort((u, v) => u.x - v.x || u.y - v.y);
	const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
	const lower = [];
	for (const q of p) {
		while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
		lower.push(q);
	}
	const upper = [];
	for (const q of [...p].reverse()) {
		while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
		upper.push(q);
	}
	return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function defsOf(pats) {
	const body = [...pats.values()].map(({ id, ink, paper, tone, a }) => {
		const s = SPACING[tone];
		const d = tone === 3 ? `M0 ${f(s / 2)}H${f(s)}M${f(s / 2)} 0V${f(s)}` : `M0 ${f(s / 2)}H${f(s)}`;
		return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}" patternTransform="rotate(${a})">${paper ? `<rect width="${s}" height="${s}" fill="${TOK[paper]}"/>` : ""}<path d="${d}" stroke="${TOK[ink]}" stroke-width="0.6" fill="none"/></pattern>`;
	});
	return `<defs>${body.join("")}</defs>`;
}

/* --------------------------------------------------------------- labels */
export const approxWidth = (text, fs) => text.length * fs * 0.56 + 14;
/** Pills with a leader to their anchor, placed without overlap, kept inside the frame. */
export function placeLabels(labels, P, W, H, fs, avoid = []) {
	const placed = avoid.map((b) => {
		const pts = [];
		for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) pts.push(P(x, y, z));
		const x0 = Math.min(...pts.map((p) => p.x));
		const y0 = Math.min(...pts.map((p) => p.y));
		return { x: x0, y: y0, w: Math.max(...pts.map((p) => p.x)) - x0, h: Math.max(...pts.map((p) => p.y)) - y0 };
	});
	const out = [];
	const pad = 5;
	const hh = fs + 8;
	const overlaps = (r) => placed.some((q) => r.x < q.x + q.w + 4 && r.x + r.w + 4 > q.x && r.y < q.y + q.h + 3 && r.y + r.h + 3 > q.y);
	const solidsHit = [];
	for (const l of labels) {
		const A = P(...l.at);
		if (A.x < pad || A.x > W - pad || A.y < pad || A.y > H - pad) continue;
		const w = approxWidth(l.text, fs);
		const dirs = l.dir ? [l.dir, ...(l.own ? ["down", "left", "right", "up"] : [])] : ["up", "down", "left", "right"];
		let done = false;
		for (const lift of l.own ? [56, 74, 92] : [26, 44, 62, 80]) {
			for (const dir of dirs) {
				const cx = dir === "left" ? A.x - lift - w / 2 : dir === "right" ? A.x + lift + w / 2 : A.x;
				const cy = dir === "up" ? A.y - lift : dir === "down" ? A.y + lift : A.y;
				const r = { x: cx - w / 2, y: cy - hh / 2, w, h: hh };
				if (r.x < pad || r.y < pad || r.x + r.w > W - pad || r.y + r.h > H - pad) continue;
				if (overlaps(r)) continue;
				placed.push(r);
				const ex = dir === "left" ? r.x + r.w : dir === "right" ? r.x : A.x;
				const ey = dir === "up" ? r.y + r.h : dir === "down" ? r.y : A.y;
				out.push(
					`<path d="M${f(A.x)} ${f(A.y)}L${f(ex)} ${f(ey)}" stroke="${TOK.ink}" stroke-width="0.8" fill="none"/><circle cx="${f(A.x)}" cy="${f(A.y)}" r="2.2" fill="${TOK.ink}"/><rect x="${f(r.x)}" y="${f(r.y)}" width="${f(r.w)}" height="${f(r.h)}" rx="4" fill="${TOK.card}" stroke="${TOK.strong}" stroke-width="1"/><text x="${f(cx)}" y="${f(cy + fs * 0.34)}" font-family="${SANS}" font-size="${fs}" font-weight="600" text-anchor="middle" fill="${TOK.ink}">${l.text}</text>`,
				);
				done = true;
				break;
			}
			if (done) break;
		}
		if (!done) out.push(`<!-- label dropped: ${l.text} -->`);
	}
	return out.join("");
}

