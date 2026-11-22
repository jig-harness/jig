import fs from 'node:fs';
import path from 'node:path';
import { ALLOWED_WORDS, ROOT, TALL_DIR, WIDE_DIR, f } from './lib.mjs';
import { STEPS, renderScene } from './scene.mjs';
import { renderAgentsSheet, renderItemStatesSheet } from './sheets.mjs';

// ============================================================================
// VALIDATOR & WRITE PIPELINE
// ============================================================================
const ALLOWED_COLOR_RE = /^(none|var\(--(bg|card|sunk|ink|muted|line|line-strong|accent|accent-soft|hl),#[0-9a-f]{6}\))$/;

function validateSvg(relPath, svg, minFont) {
  const bytes = Buffer.byteLength(svg, 'utf8');
  if (bytes > 80 * 1024) {
    throw new Error(`${relPath} exceeds 80 KB (${bytes} bytes)`);
  }
  if (/<(image|script|style|animate|animateTransform|set|foreignObject)\b/i.test(svg)) {
    throw new Error(`${relPath} contains forbidden SVG tag`);
  }
  const svgNoXmlns = svg.replace('xmlns="http://www.w3.org/2000/svg"', '');
  if (/https?:\/\/|xlink:href|@import/i.test(svgNoXmlns)) {
    throw new Error(`${relPath} contains external reference`);
  }
  // Check every fill and stroke attribute
  for (const m of svg.matchAll(/\b(?:fill|stroke)="([^"]+)"/g)) {
    if (!ALLOWED_COLOR_RE.test(m[1])) {
      throw new Error(`${relPath} has disallowed colour value: "${m[1]}"`);
    }
  }
  // Check every <text> content and font-size
  for (const m of svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)) {
    const attrs = m[1];
    const word = m[2].trim();
    if (!ALLOWED_WORDS.has(word)) {
      throw new Error(`${relPath} contains non-vocabulary word: "${word}"`);
    }
    const fsMatch = attrs.match(/font-size="([0-9.]+)"/);
    if (!fsMatch || Number(fsMatch[1]) < minFont) {
      throw new Error(`${relPath} has font-size < ${minFont} on "${word}"`);
    }
  }
  return bytes;
}

fs.mkdirSync(WIDE_DIR, { recursive: true });
fs.mkdirSync(TALL_DIR, { recursive: true });

const report = [];
for (const step of STEPS) {
  const wRes = renderScene(step, 'wide');
  const wPath = path.join(WIDE_DIR, `step-${step.id}.svg`);
  const wBytes = validateSvg(`wide/step-${step.id}.svg`, wRes.svg, 11);
  fs.writeFileSync(wPath, wRes.svg, 'utf8');
  const wInfo = wRes.itemPixelWidth ? `, item=${wRes.itemPixelWidth}px` : '';
  report.push(`wide/step-${step.id}.svg (${(wBytes / 1024).toFixed(1)} KB${wInfo}, maxLeader=${wRes.maxLeader}px)`);

  const tRes = renderScene(step, 'tall');
  const tPath = path.join(TALL_DIR, `step-${step.id}.svg`);
  const tBytes = validateSvg(`tall/step-${step.id}.svg`, tRes.svg, 14);
  fs.writeFileSync(tPath, tRes.svg, 'utf8');
  const tInfo = tRes.itemPixelWidth ? `, item=${tRes.itemPixelWidth}px` : '';
  report.push(`tall/step-${step.id}.svg (${(tBytes / 1024).toFixed(1)} KB${tInfo}, maxLeader=${tRes.maxLeader}px)`);
}

const agSvg = renderAgentsSheet();
const agBytes = validateSvg('agents.svg', agSvg, 11);
fs.writeFileSync(path.join(ROOT, 'agents.svg'), agSvg, 'utf8');
report.push(`agents.svg (${(agBytes / 1024).toFixed(1)} KB)`);

const itSvg = renderItemStatesSheet();
const itBytes = validateSvg('item-states.svg', itSvg, 11);
fs.writeFileSync(path.join(ROOT, 'item-states.svg'), itSvg, 'utf8');
report.push(`item-states.svg (${(itBytes / 1024).toFixed(1)} KB)`);

console.log('Generated and validated all 18 SVGs:\n' + report.join('\n'));

