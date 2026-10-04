#!/usr/bin/env bun
// Event-schema lint — process telemetry validated against its declared schema.
//
// A process-observability system is only as trustworthy as the events it emits.
// If a `review_completed` event ships without its `outcome`, or a typo'd
// `gate_reslt` type slips in, every metric built on it quietly lies. This gate
// validates a stream of emitted event records against the closed set of
// `event_types` declared in an event-schema (see ../../templates/event-schema.yaml):
//   * each event's `type` must be a REGISTERED event_type (an unknown type fails);
//   * every field the schema marks `required` for that type must be PRESENT and
//     NON-EMPTY (a missing or blank required field fails).
//
// Event stream format (portable, no jq): one event per line, whitespace-separated
// `key=value` tokens (logfmt-style). One token must be `type=<event_type>`. A
// value may itself contain `=` (only the first `=` splits key from value). Blank
// lines and `#` comment lines are ignored. Example:
//     type=review_completed pr=482 reviewer=shadow outcome=changes_requested findings=3 cost_unit=12
//
// Schema format: a `event_types:` block, each item two lines —
//     - type: review_completed
//       required: [pr, reviewer, outcome, findings, cost_unit]
// `required` is an inline flow list (`[]` for a type with no required fields).
//
// Native Bun/TypeScript. No yq / python / jq.
// Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
// exit 0 pass, 1 on a validation failure (unknown type / missing required field),
// 2 on a usage or format error (malformed schema, malformed event line).
// EVENTS via arg/env, SCHEMA via env so the self-test drives it with fixtures.
//
// Usage:
//   check-events.ts events.log
//   EVENTS=events.log SCHEMA=event-schema.yaml check-events.ts
import { readFileSync } from "node:fs";
const clean = (line: string) =>
  line
    .replace(/^[^:]*:\s*/, "")
    .replace(/\s+#.*$/, "")
    .replace(/^['"]|['"]\s*$/g, "")
    .trim();
export function main(args = process.argv.slice(2), env = process.env): number {
  const events = args[0] || env.EVENTS,
    schema = env.SCHEMA || "event-schema.yaml";
  if (!events) throw new Error("no events file given (arg or EVENTS=)");
  const stream = readFileSync(events, "utf8"),
    known = new Map<string, string[]>();
  let inside = false,
    cur = "";
  const required = new Set<string>();
  let schemaBad = false;
  const error = (msg: string) => {
    console.error(`ERROR: ${msg}`);
    schemaBad = true;
  };
  for (const line of readFileSync(schema, "utf8").split(/\r?\n/)) {
    if (/^event_types\s*:/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^[^\s#-]/.test(line)) inside = false;
    if (!inside) continue;
    if (/^\s*-\s*type\s*:/.test(line)) {
      cur = clean(line);
      if (!cur) {
        error("schema has an empty type value");
        continue;
      }
      if (known.has(cur)) {
        error(`schema declares duplicate event type ${cur}`);
        continue;
      }
      known.set(cur, []);
    } else if (/^\s*required\s*:/.test(line)) {
      if (!cur) {
        error("schema required: without a preceding type");
        continue;
      }
      if (required.has(cur)) {
        error(`schema type ${cur}: duplicate required: list`);
        continue;
      }
      required.add(cur);
      const r = line.replace(/^[^:]*:\s*/, "").replace(/\s+#.*$/, "");
      if (!/^\[.*\]$/.test(r)) {
        error(`schema type ${cur}: required must be a flow list [a, b]: ${r}`);
        continue;
      }
      known.set(
        cur,
        r.slice(1, -1).replace(/\s+/g, "").split(",").filter(Boolean),
      );
    }
  }
  if (!known.size) error("schema declares no event_types");
  for (const t of known.keys())
    if (!required.has(t)) error(`schema type ${t} has no required: list`);
  if (schemaBad) return 2;
  let format = false,
    failed = false,
    count = 0;
  for (const [i, line] of stream.split(/\r?\n/).entries()) {
    if (/^\s*(#|$)/.test(line)) continue;
    const fields = new Map<string, string>();
    let malformed = false;
    for (const token of line.trim().split(/\s+/)) {
      const eq = token.indexOf("=");
      if (eq < 1) {
        console.error(
          `ERROR: malformed token ${token} (line ${i + 1}): ${line}`,
        );
        format = true;
        malformed = true;
        break;
      }
      fields.set(token.slice(0, eq), token.slice(eq + 1));
    }
    if (malformed) continue;
    const type = fields.get("type");
    if (!type) {
      console.error(
        `ERROR: event has no usable type= field (line ${i + 1}): ${line}`,
      );
      format = true;
      continue;
    }
    count++;
    if (!known.has(type)) {
      console.log(`line ${i + 1}: unregistered event type '${type}'`);
      failed = true;
      continue;
    }
    for (const field of known.get(type) ?? [])
      if (!fields.has(field)) {
        console.log(`line ${i + 1}: ${type} missing required field '${field}'`);
        failed = true;
      } else if (fields.get(field) === "") {
        console.log(
          `line ${i + 1}: ${type} has empty required field '${field}'`,
        );
        failed = true;
      }
  }
  if (format) return 2;
  console.log("");
  if (!count) console.log("OK — no events to validate");
  else if (failed)
    console.log(`Event-schema lint FAILED across ${count} event(s).`);
  else console.log(`OK — ${count} event(s) valid against the schema`);
  return failed ? 1 : 0;
}
if (import.meta.main) {
  try {
    process.exit(await main());
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}
