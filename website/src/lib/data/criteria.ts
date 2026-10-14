/**
 * Each module's maturity criteria, from the audit skill's criteria files
 * (plugin/skills/audit/criteria/M*.yaml): what the audit checks at each
 * level, and which rung of the enforcement ladder a criterion requires.
 */
import { parse } from "yaml";
import type { Level } from "./modules.ts";
import { isRecord } from "../../../../lib/record.ts";

export interface Criterion {
  id: string;
  level: Level;
  /** `convention`: written down is enough; `mechanical`: a check enforces it. */
  requires: "convention" | "mechanical";
  statement: string;
  observe: string[];
}

const KEYS = new Set([
  "id",
  "level",
  "requires",
  "statement",
  "observe",
  "probe",
  "since",
]);

/**
 * One criteria entry, held to the audit's own contract for it (its loader,
 * plugin/skills/audit/scripts/lib/criteria.ts, is the test oracle). A
 * malformed entry fails the build: published as it stands, a misspelled
 * `requires` would read as the weaker rung, a dropped entry as a criterion the
 * audit does not check, and an empty `observe` as a criterion with nothing to
 * look for. `probe` and `since` are the audit's to validate; the site does not
 * render them.
 */
function asCriterion(raw: unknown, at: number, seen: Set<string>): Criterion {
  const bad = (what: string) => new Error(`criteria entry ${at + 1}: ${what}`);
  if (!isRecord(raw)) throw bad("is not a map");
  const unknown = Object.keys(raw).find((key) => !KEYS.has(key));
  if (unknown) throw bad(`has an unknown key \`${unknown}\``);
  const { id, level, requires, statement, observe } = raw;
  if (typeof id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id))
    throw bad("has no kebab-case `id`");
  if (seen.has(id)) throw bad(`repeats the id ${id}`);
  seen.add(id);
  if (typeof statement !== "string" || !statement.trim())
    throw bad(`${id} has no \`statement\``);
  if (level !== "lite" && level !== "standard" && level !== "strict")
    throw bad(`${id} has level ${JSON.stringify(level)}`);
  if (requires !== "convention" && requires !== "mechanical")
    throw bad(`${id} requires ${JSON.stringify(requires)}`);
  if (
    !Array.isArray(observe) ||
    observe.length === 0 ||
    observe.some((o) => typeof o !== "string")
  )
    throw bad(`${id} has no \`observe\` list of what to look for`);
  return { id, level, requires, statement: statement.trim(), observe };
}

/** A module's criteria file, parsed; the module id it declares, and its criteria. */
export function parseCriteria(yamlText: string): {
  module: string;
  criteria: Criterion[];
} {
  const doc: unknown = parse(yamlText);
  if (!isRecord(doc) || !Array.isArray(doc.criteria))
    throw new Error("a criteria file has no `criteria` list");
  const { module, name, purpose } = doc;
  if (typeof module !== "string" || !/^M\d+$/.test(module))
    throw new Error("a criteria file declares no `module: M<n>`");
  if (typeof name !== "string" || !name)
    throw new Error(`${module}: the criteria file has no \`name\``);
  if (typeof purpose !== "string" || !purpose.trim())
    throw new Error(`${module}: the criteria file has no \`purpose\``);
  const seen = new Set<string>();
  return {
    module,
    criteria: doc.criteria.map((c, i) => asCriterion(c, i, seen)),
  };
}
