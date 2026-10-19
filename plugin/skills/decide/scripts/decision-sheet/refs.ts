/**
 * Explicit cross-references inside decision-source text.
 *
 * A source names an option or a call with a token, never with prose. The
 * reference renderer found them by pattern (`choose 4`, `a2`, `(c)`), and a
 * pattern over prose is always one example behind: "keep 1 year" linked to
 * option 1, and the citation "(c)" in a statute linked to call (c). A
 * grammar that names each reference outright is pinned, where a pattern over
 * prose can only deny the shapes it has seen. A token cannot be mistaken
 * for anything else, and `parseSource` rejects one that names an option or a
 * call that does not exist.
 *
 *   {opt:3}          option 3 of the call that holds the text
 *   {call:c}         call c
 *   {call:c,opt:1}   option 1 of call c
 *
 * Every projection shows a token as plain words (`option 3`, `(c)`,
 * `(c) option 1`). The document sheet also makes it a link.
 */
import { LABEL } from "./labels.ts";
import type { DecisionSource } from "./source.ts";

const ID = "[A-Za-z0-9]{1,8}";

/**
 * The pattern of a well-formed token, as source text. The document sheet's
 * script builds its own regex from this, so the grammar is written once.
 * Capture groups: 1 the call of `{call:c}` and `{call:c,opt:N}`, 2 the option
 * of `{call:c,opt:N}`, 3 the option of `{opt:N}`.
 */
export const REF_PATTERN = `\\{(?:call:(${ID})(?:,opt:(${ID}))?|opt:(${ID}))\\}`;

/** A well-formed token. Built fresh each time: a shared `g` regex keeps `lastIndex` between calls. */
const wellFormed = () => new RegExp(REF_PATTERN, "g");

/** Anything that starts like a token (any case, a space, `option:` for `opt:`), so a malformed one is an error and never literal text. */
const tokenLike = () => /\{\s*(?:opt(?:ion)?|call)\s*:[^}]*\}?/gi;

export type RefPart =
  | { kind: "text"; text: string }
  | { kind: "ref"; call?: string; opt?: string };

/** Split text into literal runs and reference tokens. Concatenating the text runs and the plain form of each reference gives `plainText`. */
export function splitRefs(text: string): RefPart[] {
  const parts: RefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(wellFormed())) {
    if (m.index > last)
      parts.push({ kind: "text", text: text.slice(last, m.index) });
    parts.push({
      kind: "ref",
      call: m[1],
      opt: m[2] ?? m[3],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

/** The words a reader sees for a reference. `call` is given when the token names one. */
export function refWords(ref: { call?: string; opt?: string }): string {
  const callWord = ref.call === undefined ? "" : `(${ref.call})`;
  const optWord = ref.opt === undefined ? "" : `${LABEL.refOption} ${ref.opt}`;
  return [callWord, optWord].filter(Boolean).join(" ");
}

/** Source text with every token written out as plain words. */
export function plainText(text: string): string {
  return splitRefs(text)
    .map((p) => (p.kind === "text" ? p.text : refWords(p)))
    .join("");
}

/** Source keys whose value is an identifier, a citation or a lookup key. A token there would break the lookup, so it is an error. */
export const NO_TOKEN_KEYS = new Set([
  "schema",
  "id",
  "url",
  "source",
  "term",
  "from",
  "to",
  "title",
  "name",
  "label",
  "tag",
  "commit",
  "date",
  "ruledAt",
  "recordUrl",
  "recommended",
  "option",
  "kind",
  // Shown as plain text on the document sheet, not as a link.
  "priority",
  "reversibility",
  "meaning",
]);

export interface RefProblem {
  path: string;
  message: string;
}

/**
 * Every problem with the tokens in an already structure-checked source.
 * `{opt:N}` belongs to the call that holds the text. Outside any call it is
 * allowed only in a one-call source, where there is exactly one call it can
 * mean; with several calls it must name its call.
 */
export function refProblems(source: DecisionSource): RefProblem[] {
  const out: RefProblem[] = [];
  const optionIds = new Map<string, Set<string>>(
    source.calls.map((c) => [c.id, new Set(c.options.map((o) => o.id))]),
  );
  const soleCall = source.calls.length === 1 ? source.calls[0]?.id : undefined;

  const checkText = (text: string, path: string, home: string | undefined) => {
    const covered = new Set<number>();
    for (const m of text.matchAll(wellFormed())) {
      for (let i = m.index; i < m.index + m[0].length; i++) covered.add(i);
      const call = m[1];
      const opt = m[2] ?? m[3];
      if (call !== undefined && opt === undefined && soleCall !== undefined) {
        out.push({
          path,
          message: `${m[0]} has no target in a source with one call; name an option with {opt:N}`,
        });
        continue;
      }
      const owner = call ?? home;
      if (owner === undefined) {
        out.push({
          path,
          message: `${m[0]} is ambiguous with several calls; write {call:<id>,opt:${opt}}`,
        });
        continue;
      }
      const options = optionIds.get(owner);
      if (!options) {
        out.push({ path, message: `${m[0]} names no call "${owner}"` });
        continue;
      }
      if (opt !== undefined && !options.has(opt))
        out.push({
          path,
          message: `${m[0]} names no option "${opt}" in call ${owner}`,
        });
    }
    for (const m of text.matchAll(tokenLike()))
      if (!covered.has(m.index))
        out.push({
          path,
          message: `malformed reference token ${m[0]}; use {opt:N}, {call:c} or {call:c,opt:N}`,
        });
  };

  const walk = (
    value: unknown,
    path: string,
    key: string,
    home: string | undefined,
  ): void => {
    if (typeof value === "string") {
      if (NO_TOKEN_KEYS.has(key)) {
        if (tokenLike().test(value))
          out.push({
            path,
            message: "reference tokens are not allowed in this field",
          });
      } else checkText(value, path, home);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`, key, home);
      });
    } else if (value && typeof value === "object") {
      // A map keyed by option id holds free text under each key. The id is a
      // lookup key, never the name of a field, so it must not pick the rule: an
      // option may be called `name` or `to` and still carry a reference.
      for (const [k, v] of Object.entries(value))
        walk(v, `${path}.${k}`, key === "byOption" ? key : k, home);
    }
  };

  for (const [k, v] of Object.entries(source)) {
    if (k === "calls") {
      source.calls.forEach((call, i) => {
        for (const [ck, cv] of Object.entries(call))
          walk(cv, `$.calls[${i}].${ck}`, ck, call.id);
      });
    } else walk(v, `$.${k}`, k, soleCall);
  }
  return out;
}

/** A deep copy of the source with every token written out as plain words. The compact sheet and the markdown read this copy. */
export function plainSource(source: DecisionSource): DecisionSource {
  const map = (value: unknown): unknown => {
    if (typeof value === "string") return plainText(value);
    if (Array.isArray(value)) return value.map(map);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, map(v)]),
      );
    return value;
  };
  return map(source) as DecisionSource;
}
