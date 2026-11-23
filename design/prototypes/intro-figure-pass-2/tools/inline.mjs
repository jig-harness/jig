/** Helpers shared by the sheet writer, the checker and the viewer builder. */
import { readFileSync } from "node:fs";

export const THEMES = {
	light: { bg: "#f9f6f1", card: "#fffdfa", sunk: "#f0ece5", ink: "#251e18", muted: "#59514a", line: "#d5d0c8", "line-strong": "#867f77", accent: "#1a6444", "accent-soft": "#dbf2e4", hl: "#f7e8af" },
	dark: { bg: "#1a1713", card: "#23201c", sunk: "#13100d", ink: "#ebe7e0", muted: "#b8b3ac", line: "#433f3a", "line-strong": "#847f78", accent: "#82d2a8", "accent-soft": "#1b3427", hl: "#4e3e09" },
};

/** The custom properties of a theme as a CSS declaration list. */
export const themeVars = (name) => Object.entries(THEMES[name]).map(([k, v]) => `--${k}:${v}`).join(";");

/** Make every id in an SVG unique to a page that holds several. */
export function prefixIds(svg, prefix) {
	const ids = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
	let out = svg;
	for (const id of ids) {
		const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		out = out.replace(new RegExp(`\\bid="${esc}"`, "g"), `id="${prefix}${id}"`).replace(new RegExp(`url\\(#${esc}\\)`, "g"), `url(#${prefix}${id})`).replace(new RegExp(`href="#${esc}"`, "g"), `href="#${prefix}${id}"`);
	}
	return out;
}

/** An SVG file made safe to inline: no XML declaration, no fixed pixel size (it scales to its box). */
export function inlineSvg(file, prefix) {
	let svg = readFileSync(file, "utf8").replace(/<\?xml[^>]*\?>/, "").trim();
	svg = prefixIds(svg, prefix);
	return svg.replace(/<svg\b([^>]*)>/, (m, attrs) => `<svg${attrs.replace(/\s(width|height)="[^"]*"/g, "")} style="display:block;width:100%;height:auto">`);
}
