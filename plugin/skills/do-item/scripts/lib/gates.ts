/**
 * Review gates: the review skills that must approve a change before it is
 * pushed, when the item or its change matches the gate.
 *
 *   do_item:
 *     gates:
 *       - labels: [kind:db-migration]   # the issue carries one of these
 *         paths: ["db/migrations/**"]   # or the change touches one of these
 *         skill: migration-review
 *
 * Each gate is a rule over the item's labels and the change's paths that the
 * shared rule matcher reads (`do_item.gates` in its `RULE_FIELDS`): every
 * matching gate applies. Before the change exists its paths are known only
 * when the caller passes the files it plans to touch; without them a gate
 * that has paths and no matching label is printed apart (`byPath`), for the
 * orchestrator to apply when the change plausibly touches those paths.
 */
import { formatField } from "../../../../shared/config-layers.ts";
import { JigError } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import {
  parseEntryRule,
  type Rule,
  reason,
  resolve,
} from "../../../../shared/rule-matcher.ts";

const GATES = "do_item.gates";
const GATE_KEYS = ["labels", "paths", "skill"];

export interface Gate {
  rule: Rule;
  skill: string;
}

/** Validate `do_item.gates` from the `do_item` section. */
export function parseGates(section: Record<string, unknown>): Gate[] {
  const raw = section.gates;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new JigError(
      "gates-invalid",
      `${GATES} must be a list of {labels, paths, skill}`,
    );
  return raw.map((entry, i) => {
    const at = `${GATES}[${i}]`;
    if (!isRecord(entry))
      throw new JigError("gates-invalid", `${at} must be a mapping`);
    for (const key of Object.keys(entry))
      if (!GATE_KEYS.includes(key))
        throw new JigError(
          "gates-invalid",
          `${at}.${formatField([key])} is not a known field (${GATE_KEYS.join(", ")})`,
        );
    const rule = parseEntryRule(GATES, entry, at);
    if (!rule.ok) throw new JigError("gates-invalid", rule.failure.reason);
    const skill = entry.skill;
    if (typeof skill !== "string" || skill.trim() === "")
      throw new JigError("gates-invalid", `${at}.skill must name a skill`);
    return { rule: rule.value, skill };
  });
}

/** The gates an item meets, and those only its unknown paths could. */
export interface GateResolution {
  /** Each matching gate: where it is, its skill, and why it applies. */
  applied: Array<{ from: string; skill: string; why: string }>;
  /** Gates with paths and no matching label, when no planned paths were given. */
  byPath: Array<{ from: string; skill: string; paths: string[] }>;
}

/** The gates for an item with `labels` and planned `paths` (`null`: not known yet). */
export function resolveGates(
  gates: readonly Gate[],
  labels: readonly string[],
  paths: readonly string[] | null,
): GateResolution {
  const { matches, undecided } = resolve(
    GATES,
    gates.map((g) => g.rule),
    { labels, paths },
  );
  const at = (i: number) => `${GATES}[${i}]`;
  return {
    applied: matches.flatMap((m) => {
      const gate = typeof m.at === "number" ? gates[m.at] : undefined;
      return gate === undefined
        ? []
        : [{ from: at(m.at as number), skill: gate.skill, why: reason(m) }];
    }),
    byPath: undecided.flatMap((i) => {
      const gate = gates[i];
      return gate === undefined
        ? []
        : [
            {
              from: at(i),
              skill: gate.skill,
              paths: [...(gate.rule.paths ?? [])],
            },
          ];
    }),
  };
}
