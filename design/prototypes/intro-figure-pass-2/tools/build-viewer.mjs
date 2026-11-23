#!/usr/bin/env node
/**
 * Build the blind pick viewer: one HTML page holding every candidate's stills, shuffled behind
 * letters, with the identities held back until a person locks a pick.
 *
 *   node tools/build-viewer.mjs <out.html> [--seed <text>]
 *
 * Reads candidates/<dir>/{wide,tall}/step-1..8.svg, agents.svg and item-states.svg, tools/reveal.json
 * (who drew what, in directory order) and tools/storyboard.json. The page is not committed: it is a
 * generated file of a few megabytes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { seed: { type: "string", default: "intro-figure-pass-2" } } });
const out = resolve(positionals[0] ?? "viewer.html");
const reveal = JSON.parse(readFileSync(join(HERE, "reveal.json"), "utf8"));
const story = JSON.parse(readFileSync(join(HERE, "storyboard.json"), "utf8"));

// seeded shuffle (mulberry32 over an FNV hash of the seed)
let h = 2166136261;
for (const ch of a.seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
const rnd = () => ((h = (h + 0x6d2b79f5) >>> 0), ((t) => ((t = Math.imul(t ^ (t >>> 15), t | 1)), (t ^= t + Math.imul(t ^ (t >>> 7), t | 61)), ((t ^ (t >>> 14)) >>> 0) / 4294967296))(h));
const order = reveal.map((_, i) => i);
for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }

const strip = (svg) => svg.replace(/<\?xml[^>]*\?>/, "").replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")}>`).trim();
const read = (dir, f) => strip(readFileSync(join(ROOT, "candidates", dir, f), "utf8"));
const cands = [];
const revealOut = [];
order.forEach((idx, k) => {
	const c = reveal[idx];
	const id = String.fromCharCode(65 + k);
	cands.push({
		id,
		wide: Array.from({ length: 8 }, (_, i) => read(c.dir, `wide/step-${i + 1}.svg`)),
		tall: Array.from({ length: 8 }, (_, i) => read(c.dir, `tall/step-${i + 1}.svg`)),
		agents: read(c.dir, "agents.svg"),
		items: read(c.dir, "item-states.svg"),
	});
	revealOut.push({ id, family: c.family, name: c.name, how: c.how, trait: c.trait });
});
const data = { steps: story.steps, prompt: story.prompt, cands, reveal: Buffer.from(JSON.stringify(revealOut), "utf8").toString("base64") };
// "</" inside a script block must not close it
const json = JSON.stringify(data).replace(/<\//g, "<\\/");
const html = readFileSync(join(HERE, "viewer.template.html"), "utf8").replace("__DATA__", () => json);
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1048576).toFixed(2)} MB), ${cands.length} candidates`);
console.log("order (letter = directory):", order.map((idx, k) => `${String.fromCharCode(65 + k)}=${reveal[idx].dir}`).join(" "));
