#!/usr/bin/env node
/**
 * Layer-1 checks for a candidate's SVGs: structure, tokens, words, sizes.
 *
 *   node tools/check.mjs <candidate-dir> [<candidate-dir> ...]
 *
 * Exits 1 when any file fails. It cannot see a wrong picture: look at the contact sheets too.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const WORDS = new Set(["Queue", "Pick up", "Build", "Open", "Drive", "Repair", "Merge", "Follow up", "Dispatcher", "Question", "Issue", "Pull request", "Comments", "Checks", "Merged", "Memory", "Processor", "Disk", "Forge budget", "Usage limit"]);
const TOKENS = new Map([["bg", "#f9f6f1"], ["card", "#fffdfa"], ["sunk", "#f0ece5"], ["ink", "#251e18"], ["muted", "#59514a"], ["line", "#d5d0c8"], ["line-strong", "#867f77"], ["accent", "#1a6444"], ["accent-soft", "#dbf2e4"], ["hl", "#f7e8af"]]);
const SIZES = { wide: [960, 540], tall: [390, 520] };
const SHEETS = { "agents.svg": [960, 720], "item-states.svg": [960, 240] };
const MAX_BYTES = 80 * 1024;

let failed = 0;
const fail = (file, msg) => { failed++; console.log(`FAIL ${file}: ${msg}`); };

function checkFile(dir, rel, [w, h], minText) {
	const file = join(dir, rel);
	if (!existsSync(file)) return fail(rel, "missing");
	const svg = readFileSync(file, "utf8");
	const label = `${basename(dir)}/${rel}`;
	if (statSync(file).size > MAX_BYTES && !SHEETS[rel]) fail(label, `larger than ${MAX_BYTES / 1024} KB`);
	if (!new RegExp(`viewBox="0 0 ${w} ${h}"`).test(svg)) fail(label, `viewBox is not 0 0 ${w} ${h}`);
	for (const bad of [/<image\b/, /<script\b/, /@import/, /<animate/i, /<foreignObject/, /href="https?:/, /<filter\b/, /Gradient\b/]) if (bad.test(svg)) fail(label, `contains ${bad}`);
	// colour literals: only inside var(--token, fallback)
	const stripped = svg.replace(/var\(--([a-z-]+),\s*(#[0-9a-fA-F]{3,8})\)/g, (m, name, fb) => {
		if (!TOKENS.has(name)) fail(label, `unknown token --${name}`);
		else if (TOKENS.get(name) !== fb.toLowerCase()) fail(label, `token --${name} has fallback ${fb}, expected ${TOKENS.get(name)}`);
		return "";
	});
	const lit = stripped.match(/#[0-9a-fA-F]{3,8}\b(?![^<]*>[^<]*<\/title)/g);
	if (lit) fail(label, `colour literal outside a token: ${[...new Set(lit)].join(", ")}`);
	for (const m of stripped.matchAll(/\b(?:fill|stroke|stop-color|flood-color)="([^"]*)"/g)) {
		const v = m[1].trim();
		if (v && !/^(?:none|currentColor|inherit|transparent|url\(#[^)]+\))$/.test(v)) fail(label, `named or literal paint: ${v}`);
	}
	// ids unique
	const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
	const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
	if (dup.length) fail(label, `duplicate ids: ${[...new Set(dup)].slice(0, 3).join(", ")}`);
	for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) if (!ids.includes(m[1])) fail(label, `url(#${m[1]}) has no target`);
	// text: words only, no digits, size floor
	for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
		const txt = m[2].replace(/<[^>]+>/g, "").trim();
		const fs = +(m[1].match(/font-size="([\d.]+)"/)?.[1] ?? NaN);
		if (!SHEETS[rel] && txt && !WORDS.has(txt)) fail(label, `text not in the vocabulary: "${txt}"`);
		if (/\d/.test(txt)) fail(label, `digit in text: "${txt}"`);
		if (/software factory/i.test(txt)) fail(label, "software factory");
		if (!SHEETS[rel] && !(fs >= minText)) fail(label, `text size ${Number.isFinite(fs) ? fs : "missing"} is not at least ${minText}: "${txt}"`);
	}
	if (/software factory/i.test(svg)) fail(label, "mentions software factory");
	if (!/font-family="[^"]*system-ui/.test(svg) && /<text\b/.test(svg)) fail(label, "text without the system sans stack");
}

const candidates = process.argv.slice(2);
if (!candidates.length) {
	console.error("usage: node tools/check.mjs <candidate-dir> [<candidate-dir> ...]");
	process.exit(2);
}
for (const arg of candidates) {
	const dir = resolve(arg);
	for (const fmt of ["wide", "tall"]) for (let i = 1; i <= 8; i++) checkFile(dir, `${fmt}/step-${i}.svg`, SIZES[fmt], fmt === "wide" ? 11 : 14);
	for (const [f, size] of Object.entries(SHEETS)) checkFile(dir, f, size, 0);
	// well-formed XML (python's parser: no other XML tool is assumed)
	const files = ["wide", "tall"].flatMap((f) => Array.from({ length: 8 }, (_, i) => join(dir, f, `step-${i + 1}.svg`))).concat(Object.keys(SHEETS).map((f) => join(dir, f))).filter(existsSync);
	try {
		execFileSync("python3", ["-I", "-c", "import sys,xml.etree.ElementTree as E\nfor f in sys.argv[1:]:\n    E.parse(f)", ...files], { stdio: "pipe" });
	} catch (e) {
		fail(basename(dir), `not well-formed: ${String(e.stderr).split("\n").filter(Boolean).slice(-1)[0]}`);
	}
}
console.log(failed ? `${failed} problem(s)` : "all checks passed");
process.exit(failed ? 1 : 0);
