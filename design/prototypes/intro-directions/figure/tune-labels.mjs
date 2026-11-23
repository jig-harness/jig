#!/usr/bin/env node
/**
 * Search label placements (lift and side per label) for the line figure, per
 * format, and print the best plan as JSON to paste into LAYOUTS.
 *
 *   node tune-labels.mjs [--motion-kit <dir>]
 *
 * Cost: every label problem the gate would report (G15) is prohibitive; then
 * the area a label box covers of a solid (three times as much for the work
 * items and the person's station), then the stem's length. Coordinate descent
 * from the layout's own plan, a fixed number of passes: deterministic.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { "motion-kit": { type: "string" } } });
const MK = resolve(a["motion-kit"] ?? join(HERE, "../../motion-kit"));
const { loadScene } = await import(pathToFileURL(join(MK, "lib/load.mjs")).href);
const { labelProblems } = await import(pathToFileURL(join(MK, "runtime/iso.mjs")).href);
const SCENE = join(HERE, "line.scene.mjs");

const LIFTS = Array.from({ length: 50 }, (_, i) => 14 + i * 4);
const SIDES = ["up", "left", "right"];
const overlap = (p, q) => Math.max(0, Math.min(p.x + p.width, q.x + q.width) - Math.max(p.x, q.x)) * Math.max(0, Math.min(p.y + p.height, q.y + q.height) - Math.max(p.y, q.y));

async function cost(format, plan, stepIndex) {
	const { scene } = await loadScene(SCENE, { format, locale: "en", options: { labelPlan: plan } });
	const t = scene.steps[stepIndex].at;
	const boxes = scene.labelBoxes(t).filter((b) => (b.opacity ?? 1) > 0);
	const problems = labelProblems(boxes, { width: scene.width, height: scene.height }).length;
	let covered = 0;
	const obstacles = scene.obstacles(t);
	for (const b of boxes)
		for (const o of obstacles) {
			covered += overlap(b, o) * (o.key ? 4 : 1.5);
			// A stem through another solid (not the one it stands on) reads as pinning that solid.
			const s = b.stem;
			const inside = (x, y) => x >= o.x && x <= o.x + o.width && y >= o.y && y <= o.y + o.height;
			if (s && !inside(s.x1, s.y1) && s.x1 > o.x && s.x1 < o.x + o.width) covered += Math.max(0, Math.min(s.y1, o.y + o.height) - Math.max(s.y2, o.y)) * (o.key ? 40 : 15);
		}
	const stems = boxes.reduce((n, b) => n + (b.stem ? b.stem.y1 - b.stem.y2 : 0), 0);
	return { total: problems * 1e6 + covered + stems * 4, problems, covered: Math.round(covered), stems: Math.round(stems) };
}

for (const format of ["16:9", "tall"]) {
	const { scene } = await loadScene(SCENE, { format, locale: "en" });
	const stations = scene.labelBoxes(scene.steps[0].at).filter((b) => b.id.startsWith("station-")).map(() => ({ lift: 40, side: "up" }));
	const slots = { account: { lift: 40, side: "up" }, slot1: { lift: 40, side: "up" }, slot2: { lift: 40, side: "up" }, wall: { lift: 40, side: "up" } };
	const plan = { stations, slots };
	// Step 1's labels, then step 2's: each set is only drawn in its own step.
	const groups = [
		{ step: 0, keys: stations.map((_, i) => ["stations", i]) },
		{ step: 1, keys: Object.keys(slots).map((k) => ["slots", k]) },
	];
	for (const g of groups) {
		// Several fixed starts (a seeded walk would do as well); the best result wins.
		const starts = [40, 100, 160].flatMap((base) => [0, 1].map((alt) => g.keys.map((_, i) => ({ lift: base + (alt && i % 2 ? 50 : 0), side: "up" }))));
		let winner = null;
		for (const start of starts) {
			g.keys.forEach(([group, key], i) => (plan[group][key] = start[i]));
			let best = await cost(format, plan, g.step);
			for (let pass = 0; pass < 8; pass++) {
				const before = best.total;
				for (const [group, key] of g.keys) {
					let pick = plan[group][key];
					for (const side of SIDES)
						for (const lift of LIFTS) {
							plan[group][key] = { lift, side };
							const c = await cost(format, plan, g.step);
							if (c.total < best.total - 1e-9) {
								best = c;
								pick = { lift, side };
							}
						}
					plan[group][key] = pick;
				}
				if (best.total >= before - 1e-9) break;
			}
			if (!winner || best.total < winner.best.total) winner = { best, picks: g.keys.map(([group, key]) => plan[group][key]) };
		}
		g.keys.forEach(([group, key], i) => (plan[group][key] = winner.picks[i]));
		const best = winner.best;
		console.log(`${format} step ${g.step + 1}: problems ${best.problems}, covered ${best.covered}, stems ${best.stems}`);
	}
	console.log(JSON.stringify(plan));
}
