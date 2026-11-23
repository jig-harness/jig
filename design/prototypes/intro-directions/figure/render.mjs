#!/usr/bin/env node
/**
 * Render the line figure's settled step frames.
 *
 *   node render.mjs [--motion-kit <dir>] [--chromium <path>] [--no-png]
 *
 * Writes, next to this file:
 *   line-step{1,2}-{light,dark}.svg        16:9, tokens resolved to the style's values
 *   line-step{1,2}.svg                     16:9, page custom properties (--ink, --bg, ...) with light fallbacks
 *   tall/line-step{1,2}-{light,dark}.svg   the phone layout, resolved
 *   tall/line-step{1,2}.svg                the phone layout, custom properties
 *   contact.html, contact.png              the frames at 1440 and 390 px wide, both themes
 * and prints every label problem (labelProblems) at each step, per format.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const { values: a } = parseArgs({ options: { "motion-kit": { type: "string" }, chromium: { type: "string" }, "no-png": { type: "boolean", default: false } } });
const MK = resolve(a["motion-kit"] ?? join(HERE, "../../motion-kit"));
const { loadScene, loadStyle } = await import(pathToFileURL(join(MK, "lib/load.mjs")).href);
const { renderSvg } = await import(pathToFileURL(join(MK, "runtime/scene.mjs")).href);
const { labelProblems } = await import(pathToFileURL(join(MK, "runtime/iso.mjs")).href);

const SCENE = join(HERE, "line.scene.mjs");
const style = loadStyle(join(HERE, "jig-plate.style.json"));

// motion-kit token → the site's custom property.
const PAGE_VARS = { bg: "--bg", surface: "--card", ink: "--ink", muted: "--muted", line: "--line-strong", accent: "--accent", onAccent: "--accent-soft", emphasis: "--hl" };

/** The live markup, with each token as the page's custom property and the light value as its fallback. */
function pageThemed(scene, t, idPrefix) {
	const svg = renderSvg(scene, t, { style, idPrefix, live: true });
	return svg.replace(/var\(--mk-([a-zA-Z]+)\)/g, (_, name) => {
		if (!PAGE_VARS[name]) throw new Error(`no page variable for token ${name}`);
		return `var(${PAGE_VARS[name]}, ${style.light[name]})`;
	});
}

const written = [];
const write = (rel, body) => {
	const file = join(HERE, rel);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, body);
	written.push(rel);
};

let problems = 0;
for (const [format, dir] of [["16:9", ""], ["tall", "tall/"]]) {
	const { scene } = await loadScene(SCENE, { format, locale: "en" });
	scene.steps.forEach((step, i) => {
		const n = i + 1;
		const boxes = scene.labelBoxes(step.at);
		const p = labelProblems(boxes, { width: scene.width, height: scene.height });
		for (const line of p) console.log(`  ${format} step ${n}: ${line}`);
		problems += p.length;
		for (const theme of ["light", "dark"]) write(`${dir}line-step${n}-${theme}.svg`, renderSvg(scene, step.at, { style, theme, standalone: true, background: true, idPrefix: `${scene.id}-s${n}-${theme}` }));
		write(`${dir}line-step${n}.svg`, pageThemed(scene, step.at, `${scene.id}-s${n}`));
	});
	console.log(`${format}: ${scene.width}×${scene.height}, ${scene.duration} s, steps at ${scene.steps.map((s) => s.at).join(", ")}`);
}
console.log(`label problems: ${problems}`);
for (const f of written) console.log(`wrote ${f} (${(readFileSync(join(HERE, f)).length / 1024).toFixed(1)} KB)`);

// Contact sheet: the 16:9 frames at 1440 px and the phone frames at 390 px, light and dark.
const cell = (src, w, label, dark) => `<figure style="margin:0;background:${dark ? "#1a1713" : "#f9f6f1"};color:${dark ? "#ebe7e0" : "#251e18"};padding:12px"><figcaption style="font:600 15px system-ui;margin:0 0 8px">${label}</figcaption><img src="${src}" width="${w}" style="display:block"></figure>`;
// The custom-property copies, inlined so the page's variables reach them (an <img> would not see them).
const DARK_VARS = "--bg:#1a1713;--card:#23201c;--ink:#ebe7e0;--muted:#b8b3ac;--line-strong:#847f78;--accent:#82d2a8;--accent-soft:#1b3427;--hl:#4e3e09";
const themed = (file, w, label, vars, dark) => `<figure style="margin:0;${vars};background:${dark ? "#1a1713" : "#f9f6f1"};color:${dark ? "#ebe7e0" : "#251e18"};padding:12px"><figcaption style="font:600 15px system-ui;margin:0 0 8px">${label}</figcaption><div style="width:${w}px">${readFileSync(join(HERE, file), "utf8").replace("<svg ", '<svg style="display:block;width:100%;height:auto" ')}</div></figure>`;
const html = `<!doctype html><meta charset="utf-8"><title>line figure contact sheet</title>
<body style="margin:0;background:#888;font-family:system-ui">
<div style="display:grid;grid-template-columns:1464px 1464px;gap:8px;padding:8px">
${cell("line-step1-light.svg", 1440, "Step 1 · The line · light · 1440", false)}
${cell("line-step1-dark.svg", 1440, "Step 1 · The line · dark · 1440", true)}
${cell("line-step2-light.svg", 1440, "Step 2 · Two slots and the wall · light · 1440", false)}
${cell("line-step2-dark.svg", 1440, "Step 2 · Two slots and the wall · dark · 1440", true)}
</div>
<div style="display:flex;gap:8px;padding:0 8px 8px">
${cell("tall/line-step1-light.svg", 390, "Step 1 · light · 390", false)}
${cell("tall/line-step1-dark.svg", 390, "Step 1 · dark · 390", true)}
${cell("tall/line-step2-light.svg", 390, "Step 2 · light · 390", false)}
${cell("tall/line-step2-dark.svg", 390, "Step 2 · dark · 390", true)}
</div>
<div style="display:flex;gap:8px;padding:0 8px 8px">
${themed("line-step2.svg", 720, "Step 2 · page variables, page sets the dark values", DARK_VARS, true)}
${themed("line-step1.svg", 720, "Step 1 · page variables, none set (light fallbacks)", "", false)}
</div></body>`;
write("contact.html", html);

if (!a["no-png"]) {
	const pw = join(process.env.HOME, ".cache/ms-playwright");
	const chrome = a.chromium ?? process.env.JIG_CHROMIUM ?? (existsSync(pw) ? readdirSync(pw).filter((d) => /^chromium-\d+$/.test(d)).map((d) => join(pw, d, "chrome-linux64/chrome")).find(existsSync) : undefined);
	if (!chrome) throw new Error("no Chromium: pass --chromium or set JIG_CHROMIUM");
	const out = join(HERE, "contact.png");
	execFileSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--window-size=2952,2900", `--screenshot=${out}`, pathToFileURL(join(HERE, "contact.html")).href], { stdio: "pipe" });
	console.log(`wrote contact.png with ${chrome}`);
}
