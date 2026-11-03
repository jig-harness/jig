// Python-compatible rendering for the Simplified Technical English linter.
import type { Finding } from "./ste-lint.ts";

/** Python `round(x, 1)`: the exact binary value, ties to even. */
export function pyRound1(x: number): number {
  // `toFixed` also rounds the exact binary value (1.95 is below 1.95, so it
  // gives 1.9), but breaks a true tie upward. The only binary values exactly
  // halfway between two tenths are odd multiples of 0.25.
  const quarters = x * 4;
  if (Number.isInteger(quarters) && quarters % 2 !== 0) {
    const floor = Math.floor(x * 10);
    return (floor % 2 === 0 ? floor : floor + 1) / 10;
  }
  return Number(x.toFixed(1));
}

/** Python `repr()` of a float in the range this tool prints. */
function pyFloat(x: number): string {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

class PyFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

/** Python `json.dumps(value, indent=2)`, with its default `ensure_ascii`. */
function pyDumps(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth + 1);
  const end = "  ".repeat(depth);
  if (value instanceof PyFloat) return pyFloat(value.value);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((v) => pad + pyDumps(v, depth + 1)).join(",\n")}\n${end}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return `{\n${entries.map(([k, v]) => `${pad}${pyDumps(k)}: ${pyDumps(v, depth + 1)}`).join(",\n")}\n${end}}`;
  }
  return JSON.stringify(value).replace(
    /[\u0080-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Render the report exactly as the Python originals print it. */
export function report(
  findings: Finding[],
  wordsTotal: number,
  asJson: boolean,
  hardCount: number,
  baseline: number,
): string {
  const rate = wordsTotal ? pyRound1((findings.length * 100) / wordsTotal) : 0;
  if (asJson) {
    return `${pyDumps({
      violations: findings,
      count: findings.length,
      hard_count: hardCount,
      baseline,
      words: wordsTotal,
      per_100_words: new PyFloat(rate),
    })}\n`;
  }
  const out = findings.map(
    (f) =>
      `${f.file}:${f.line}:${f.col} ${f.rule}: ${f.message} [${f.match}]\n`,
  );
  out.push(
    `\n${findings.length} violations (${hardCount} hard, baseline ${baseline}), ` +
      `${wordsTotal} words, ${pyFloat(rate)} per 100 words\n`,
  );
  out.push(
    "Hedges/modality (may, might, could) are never flagged: confidence is content.\n",
  );
  return out.join("");
}
