/**
 * The framing a stored parked item carries (`framed-park.ts`), the decision
 * class and the decision record, and how a framed decision is printed. Kept
 * apart from `framed-park.ts` so the state schema and the handoff import no
 * command code.
 */
import type { ParkedItem } from "./schema.ts";

/** A forge login, excluding whitespace and mention syntax. */
export function isPerson(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})(?:\[bot\])?$/.test(value)
  );
}

/** A parked item every reader can match and render (`ParkedItem`). */
export function isParkedItem(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const e = p as Record<string, unknown>;
  return (
    typeof e.key === "string" &&
    e.key.length > 0 &&
    !/[\n\r]/.test(e.key) &&
    (e.kind === "thread" || e.kind === "finding") &&
    typeof e.reason === "string" &&
    e.reason.length > 0 &&
    (e.person === undefined || isPerson(e.person)) &&
    isOptionalFrame(e) &&
    typeof e.round === "number" &&
    Number.isInteger(e.round) &&
    e.round >= 0 &&
    (e.at === undefined ||
      (typeof e.at === "string" && Number.isFinite(Date.parse(e.at))))
  );
}

/** The framing fields: absent on a park from before framing, else well-formed. */
export function isOptionalFrame(e: Record<string, unknown>): boolean {
  return (
    (e.class === undefined ||
      (typeof e.class === "string" && /^[a-z][a-z0-9-]*$/.test(e.class))) &&
    (e.record === undefined ||
      (typeof e.record === "string" && e.record.trim() !== ""))
  );
}

/**
 * One parked decision in full, for the stop, the handoff and the ledger
 * reader: its key, kind, class and round, then the record. A park written
 * before parks were framed prints its reason.
 */
export function framedDecisionLines(p: ParkedItem): string[] {
  const head = `[${p.kind}] ${p.key} · class ${p.class ?? "(none recorded)"} · parked at round ${p.round}`;
  if (p.record === undefined) return [head, `  ${p.reason}`];
  return [head, ...p.record.split("\n").map((l) => (l === "" ? "" : `  ${l}`))];
}

/** `- ` items of a record's section, each with its continuation lines joined. */
export function items(text: string): { items: string[]; stray: boolean } {
  const out: string[] = [];
  let stray = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    if (/^- /.test(line)) out.push(line.slice(2).trim());
    else if (/^\s+\S/.test(line) && out.length > 0)
      out[out.length - 1] = `${out[out.length - 1]} ${line.trim()}`;
    else stray = true;
  }
  return { items: out, stray };
}

/** The bold name an option opens with, or `null`. */
export function optionName(item: string): string | null {
  return /^\*\*([^*]+)\*\*/.exec(item)?.[1]?.trim() ?? null;
}

/** The labelled fields an option carries, each once with a value of its own. */
const OPTION_FIELDS = ["Changes", "Costs"] as const;

/**
 * An option's `Changes:` and `Costs:` values, split at the labels: each
 * value runs to the next label or the item's end, so one label cannot stand
 * in for the other's value.
 */
export function optionFields(item: string): {
  values: Partial<Record<(typeof OPTION_FIELDS)[number], string>>;
  repeated: string[];
} {
  const labels = [...item.matchAll(/\b(changes|costs):/gi)].map((m) => ({
    field: OPTION_FIELDS.find(
      (f) => f.toLowerCase() === (m[1] ?? "").toLowerCase(),
    ),
    start: m.index,
    end: m.index + m[0].length,
  }));
  const values: Partial<Record<(typeof OPTION_FIELDS)[number], string>> = {};
  const repeated: string[] = [];
  for (const [i, l] of labels.entries()) {
    if (l.field === undefined) continue;
    if (values[l.field] !== undefined) repeated.push(l.field);
    values[l.field] = item
      .slice(l.end, labels[i + 1]?.start ?? item.length)
      .trim();
  }
  return { values, repeated };
}

/** One framed option as a reader shows it. */
export interface FramedOption {
  name: string;
  changes: string | null;
  costs: string | null;
  /** Whether `## Recommended` names it. */
  recommended: boolean;
}

/**
 * The options of a record's `## Options` text, each with what it changes and
 * costs, and which one `## Recommended` names. An item with no bold name is
 * left out: a reader of a stored record shows what it can and checks nothing.
 */
export function recordOptions(
  options: string,
  recommended: string | null,
): FramedOption[] {
  return items(options).items.flatMap((item) => {
    const name = optionName(item);
    if (name === null) return [];
    const { values } = optionFields(item);
    return [
      {
        name,
        changes: values.Changes ?? null,
        costs: values.Costs ?? null,
        recommended: recommended?.includes(`**${name}**`) ?? false,
      },
    ];
  });
}

/** The steps of a record's `## Steps for a person` text; none for `None.`. */
export function recordSteps(steps: string): string[] {
  return /^none\.?$/i.test(steps.trim()) ? [] : items(steps).items;
}
