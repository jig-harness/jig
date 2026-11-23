#!/usr/bin/env node
/**
 * Contact sheets of a candidate's frames, rendered in headless Chrome.
 *
 *   node tools/sheet.mjs <candidate-dir> <out-dir> [--theme light|dark] [--grey] [--format wide|tall] [--chrome <path>]
 *
 * Writes <out-dir>/<candidate>-<format>-<theme>[-grey]-1.png (steps 1-4) and -2.png (steps 5-8),
 * plus the pose sheet and the item sheet.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { inlineSvg, themeVars } from "./inline.mjs";

const { values: a, positionals } = parseArgs({ allowPositionals: true, options: { theme: { type: "string", default: "light" }, grey: { type: "boolean", default: false }, format: { type: "string", default: "wide" }, chrome: { type: "string" }, only: { type: "string" } } });
const [dir, out] = positionals.map((p) => resolve(p));
const chrome = a.chrome ?? process.env.JIG_CHROMIUM ?? "google-chrome";
mkdirSync(out, { recursive: true });
const name = basename(dir);
const wide = a.format === "wide";
const colW = wide ? 720 : 390;
const cols = wide ? 2 : 4;

function page(files, extra = "") {
	const cells = files.map((f, i) => `<figure style="margin:0;width:${colW}px"><div style="font:600 12px system-ui;color:var(--muted);padding:2px 4px">${f.label}</div>${inlineSvg(f.file, `s${i}-`)}</figure>`).join("");
	return `<!doctype html><meta charset="utf-8"><body style="margin:0;${themeVars(a.theme)};background:var(--bg);${a.grey ? "filter:grayscale(1)" : ""}"><div style="display:grid;grid-template-columns:repeat(${cols},${colW}px);gap:6px;padding:6px">${cells}</div>${extra}`;
}
function shot(html, png, w, h) {
	const f = png.replace(/\.png$/, ".html");
	writeFileSync(f, html);
	execFileSync(chrome, ["--headless", "--no-sandbox", "--disable-gpu", `--user-data-dir=${join(process.env.HOME, "scratch-fig/.chrome")}`, "--hide-scrollbars", `--window-size=${w},${h}`, `--screenshot=${png}`, `file://${f}`], { stdio: "pipe" });
}
const tag = `${name}-${a.format}-${a.theme}${a.grey ? "-grey" : ""}`;
const frames = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => ({ label: `${name} · step ${from + k} · ${a.format} · ${a.theme}${a.grey ? " · grey" : ""}`, file: join(dir, a.format, `step-${from + k}.svg`) }));
if (!a.only || a.only === "steps") {
	if (wide) {
		shot(page(frames(1, 4)), join(out, `${tag}-1.png`), colW * 2 + 18, 2 * (405 + 26) + 12);
		shot(page(frames(5, 8)), join(out, `${tag}-2.png`), colW * 2 + 18, 2 * (405 + 26) + 12);
	} else {
		shot(page(frames(1, 4)), join(out, `${tag}-1.png`), colW * 4 + 30, 520 + 36);
		shot(page(frames(5, 8)), join(out, `${tag}-2.png`), colW * 4 + 30, 520 + 36);
	}
}
if (!a.only || a.only === "sheets") {
	for (const [file, label, w, h] of [["agents.svg", "agents", 960, 720], ["item-states.svg", "item states", 960, 240]]) {
		const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;${themeVars(a.theme)};background:var(--bg);${a.grey ? "filter:grayscale(1)" : ""}"><div style="width:${w}px">${inlineSvg(join(dir, file), "x-")}</div>`;
		shot(html, join(out, `${name}-${label.replace(" ", "-")}-${a.theme}${a.grey ? "-grey" : ""}.png`), w, h);
	}
}
console.log(`wrote sheets for ${name} (${tag}) in ${out}`);
