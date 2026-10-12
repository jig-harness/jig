#!/usr/bin/env bun
// No-dark-instruments — every declared metric must be actually wired.
//
// The lesson it enforces: an instrument that is provisioned but fail-open (a
// metric on the dashboard whose source was never connected, an API key that
// was never set) is WORSE than none — it makes the
// "measure" step look done while the number is silently dark, so process
// decisions run on a gauge that reads zero because nothing feeds it. This gate
// reads a metrics registry (see ../../templates/metrics-registry.yaml) and FAILS
// if any metric's `source` (the wired event or query behind it) is missing,
// empty, or a placeholder — TODO / tbd / dark / none / fixme (case-insensitive) —
// i.e. a metric CLAIMED but not connected.
//
// Registry format: a `metrics:` block, each item a mapping with at least
//     - id: gate-pass-rate
//       source: query:gate_result_pass_ratio      # the wired event/query
//       owner: platform-team
// `source` is what this gate checks; a real registry also carries an `owner`.
//
// Native Bun/TypeScript. No yq / python / jq.
// Conventions: exit 0 pass, 1 when a metric is dark (unwired source), 2 on a
// usage / format error (no metrics collection, missing file).
// REGISTRY via arg/env so the self-test drives it with fixtures.
//
// Usage:
//   check-metrics-wired.ts metrics-registry.yaml
//   REGISTRY=metrics-registry.yaml check-metrics-wired.ts
import { readFileSync } from "node:fs";
const afterKey = (line: string) =>
  line
    .replace(/^[^:]*:\s*/, "")
    .replace(/\s+#.*$/, "")
    .replace(/^#.*$/, "");
const clean = (line: string) =>
  afterKey(line)
    .replace(/^['"]|['"]\s*$/g, "")
    .trim();
export function main(args = process.argv.slice(2), env = process.env): number {
  const registry = args[0] || env.REGISTRY || "metrics-registry.yaml",
    lines = readFileSync(registry, "utf8").split(/\r?\n/);
  const declaration = lines.find((line) => /^["']?metrics["']?\s*:/.test(line));
  if (!declaration)
    throw new Error(
      `no 'metrics:' collection found in ${registry} (nothing to check)`,
    );
  const val = afterKey(declaration).trim();
  if (val !== "" && val !== "[]")
    throw new Error(
      `'metrics:' must be a collection (a block list or []), not the scalar '${val}' in ${registry}`,
    );
  const metrics: { id: string; source: string }[] = [];
  let inside = false,
    itemIndent = 0,
    fieldIndent = -1,
    cur: { id: string; source: string } | undefined;
  for (const line of lines) {
    if (/^["']?metrics["']?\s*:\s*(#.*)?$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^[^\s#-]/.test(line)) {
      inside = false;
      cur = undefined;
    }
    if (!inside) continue;
    const indent = line.match(/^ */)?.[0].length ?? 0,
      marker = /^\s*-(\s|$)/.test(line);
    if (line.trim() !== "" && !/^\s*#/.test(line)) {
      if (!cur && !marker)
        throw new Error(
          `'metrics:' must hold a block list ('- id: ...' items), found '${line.trim()}' in ${registry}`,
        );
      if (cur && (indent < itemIndent || (indent === itemIndent && !marker)))
        throw new Error(
          `'metrics:' must hold only '- ' items and fields indented under them, found '${line.trim()}' in ${registry}`,
        );
    }
    const content = line.trim() !== "" && !/^\s*#/.test(line);
    let own = false;
    if (marker && (!cur || indent === itemIndent)) {
      if (!cur) itemIndent = indent;
      cur = { id: "", source: "" };
      metrics.push(cur);
      // Column of the metric mapping's own keys: where the first key starts (a bare `-` or one followed only by a comment has none yet).
      const first = line.match(/^\s*-\s+(?=[^\s#])/);
      fieldIndent = first ? first[0].length : -1;
      own = true;
    } else if (cur && content) {
      if (fieldIndent < 0) fieldIndent = indent;
      own = indent === fieldIndent && !marker;
    }
    // Only the metric's own keys count; nested content never sets id/source.
    if (!cur || !own) continue;
    if (/^\s*(-\s+)?["']?id["']?\s*:/.test(line)) cur.id = clean(line);
    if (/^\s*(-\s+)?["']?source["']?\s*:/.test(line)) cur.source = clean(line);
  }
  let errors = 0;
  for (const [i, m] of metrics.entries()) {
    const label = m.id || `(metric #${i + 1}, no id)`;
    if (
      [
        "",
        "~",
        "null",
        "[]",
        "{}",
        "todo",
        "tbd",
        "dark",
        "none",
        "fixme",
      ].includes(m.source.toLowerCase())
    ) {
      console.log(
        `DARK ${label} — source is '${m.source || "<unset>"}' (not wired)`,
      );
      errors++;
    } else console.log(`OK   ${label} — source: ${m.source}`);
  }
  console.log("");
  if (!metrics.length)
    console.log("OK — no metrics registered (empty registry)");
  else if (errors)
    console.log(
      `No-dark-instruments FAILED: ${errors} dark instrument(s) of ${metrics.length} metric(s).`,
    );
  else
    console.log(`OK — all ${metrics.length} metric(s) wired to a real source`);
  return errors ? 1 : 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
