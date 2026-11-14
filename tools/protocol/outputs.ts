/**
 * What the generator would write for every chapter, and what the chapter
 * list or the files hold that it refuses: a chapter file with no entry or an
 * entry with no file, a marker naming another source, a value with no
 * meaning, a value two chapters take, and a status that does not match the
 * plan.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../../lib/findings.ts";
import {
  type Chapter,
  COMMAND,
  chapterFile,
  DATA_DIR,
  type DataFile,
  type DataValue,
  dataFile,
  dataOf,
  dataText,
  type FieldSpec,
  INDEX_FILE,
  INDEX_SOURCE,
  PLAN_FILE,
  PROTOCOL_DIR,
} from "./chapter.ts";
import {
  renderChapter,
  renderIndex,
  type Splice,
  statusLine,
} from "./render.ts";

export const RULE = "protocol";

/** One file the generator writes, with what it holds now and the parts that make it up. */
export type Output =
  | {
      kind: "markdown";
      path: string;
      text: string;
      /** The status line, for a chapter; null for the index page. */
      status: string | null;
      sources: readonly string[];
      sections: readonly string[];
      current: readonly string[];
    }
  | { kind: "json"; path: string; data: DataFile; text: string };

export interface Plan {
  outputs: Output[];
  findings: Finding[];
  data: Map<string, DataFile>;
}

const finding = (
  file: string | undefined,
  problem: string,
  remedy: string,
): Finding => ({ rule: RULE, file, problem, remedy });

function read(root: string, path: string): string | null {
  const full = join(root, path);
  return existsSync(full)
    ? readFileSync(full, "utf8").replace(/\r\n/g, "\n")
    : null;
}

/** The plan items `design/plan.md` holds open: each `### <n>.` heading. */
function openPlanItems(root: string): Set<number> {
  const plan = read(root, PLAN_FILE) ?? "";
  return new Set(
    [...plan.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1])),
  );
}

function statusFindings(chapter: Chapter, open: Set<number>): Finding[] {
  const file = chapterFile(chapter.id);
  const out: Finding[] = [];
  if (!Number.isInteger(chapter.version) || chapter.version < 1)
    out.push(
      finding(
        file,
        `version ${chapter.version} is not a whole number from 1`,
        "give the chapter an integer version in tools/protocol/chapters.ts",
      ),
    );
  if (chapter.status === "stable" && chapter.planItems.length)
    out.push(
      finding(
        file,
        `a stable chapter names plan items (${chapter.planItems.map((p) => p.item).join(", ")})`,
        "remove its plan items, or mark it provisional, in tools/protocol/chapters.ts",
      ),
    );
  if (chapter.status === "provisional" && !chapter.planItems.length)
    out.push(
      finding(
        file,
        "a provisional chapter names no plan item that still moves it",
        "name its plan items with their epic issues, or mark it stable, in tools/protocol/chapters.ts",
      ),
    );
  if (chapter.status === "provisional")
    for (const p of chapter.planItems)
      if (!open.has(p.item))
        out.push(
          finding(
            file,
            `plan item ${p.item} is not in ${PLAN_FILE}`,
            `name an open plan item, or mark the chapter stable once its items are finished`,
          ),
        );
  return out;
}

const typeOf = (value: unknown): string =>
  value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;

function fieldFits(spec: FieldSpec, value: unknown): boolean {
  if (value === undefined) return !spec.required;
  if (value === null) return spec.nullable;
  return typeOf(value) === spec.type;
}

/**
 * What makes a chapter's identity unusable: no identifying field, or a value
 * listed twice. Checked on every chapter as the code generates it, whatever
 * its status or version, and never waived by a breaking note: a reader that
 * selects the first match must meet the value the comparison saw.
 */
function identityFindings(chapter: Chapter, values: readonly DataValue[]) {
  const file = chapterFile(chapter.id);
  const remedy =
    "list each value once: a reader selecting the first match must meet the value the comparison saw";
  const identity = Object.entries(chapter.fields)
    .filter(([, spec]) => spec.identifies)
    .map(([name]) => name);
  if (identity.length === 0)
    return [
      finding(file, "the chapter's fields name no identifying field", remedy),
    ];
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const shown = identity
      .map((f) => `${f} ${JSON.stringify(v[f] ?? null)}`)
      .join(", ");
    if (seen.has(shown))
      out.push(
        finding(file, `the value ${shown} is listed more than once`, remedy),
      );
    seen.add(shown);
  }
  return out;
}

function valueFindings(chapter: Chapter, values: readonly DataValue[]) {
  const file = chapterFile(chapter.id);
  const out: Finding[] = [];
  values.forEach((value, i) => {
    const name = String(value.name ?? `value ${i + 1}`);
    const meaning = value.meaning;
    if (typeof meaning !== "string" || meaning.trim() === "")
      out.push(
        finding(
          file,
          `${name} has no meaning`,
          "write what the value means to a reader in the `meaning` beside it in the code",
        ),
      );
    for (const [field, spec] of Object.entries(chapter.fields))
      if (!fieldFits(spec, value[field]))
        out.push(
          finding(
            file,
            `${name}'s ${field} is ${JSON.stringify(value[field])}, which its field declaration (${spec.type}${spec.nullable ? " or null" : ""}${spec.required ? ", required" : ""}) does not allow`,
            "make the chapter's values and its fields agree in its module",
          ),
        );
    for (const field of Object.keys(value))
      if (!(field in chapter.fields))
        out.push(
          finding(
            file,
            `${name} carries the undeclared field ${field}`,
            "declare the field in the chapter's fields",
          ),
        );
  });
  return out;
}

/** Files in a directory with an extension, by name. */
function filesIn(root: string, dir: string, ext: string): string[] {
  const full = join(root, dir);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(ext))
    .map((e) => e.name);
}

function orphanFindings(root: string, chapters: readonly Chapter[]) {
  const ids = new Set(chapters.map((c) => c.id));
  const out: Finding[] = [];
  for (const name of filesIn(root, PROTOCOL_DIR, ".md"))
    if (name !== "README.md" && !ids.has(name.slice(0, -3)))
      out.push(
        finding(
          `${PROTOCOL_DIR}/${name}`,
          "a chapter file with no entry in the chapter list",
          "add the chapter to tools/protocol/chapters.ts, or remove the file",
        ),
      );
  for (const name of filesIn(root, DATA_DIR, ".json"))
    if (!ids.has(name.slice(0, -5)))
      out.push(
        finding(
          `${DATA_DIR}/${name}`,
          "a data file with no entry in the chapter list",
          "add the chapter to tools/protocol/chapters.ts, or remove the file",
        ),
      );
  return out;
}

function takenTwice(chapters: readonly Chapter[]): Finding[] {
  const owner = new Map<string, string>();
  const out: Finding[] = [];
  const ids = new Set<string>();
  for (const chapter of chapters) {
    if (ids.has(chapter.id))
      out.push(
        finding(
          chapterFile(chapter.id),
          `the chapter list names ${chapter.id} twice`,
          "list each chapter once in tools/protocol/chapters.ts",
        ),
      );
    ids.add(chapter.id);
    for (const taken of chapter.takes()) {
      const first = owner.get(taken);
      if (first !== undefined && first !== chapter.id)
        out.push(
          finding(
            chapterFile(chapter.id),
            `${taken} is taken by ${first} and ${chapter.id}`,
            "give each value to one chapter, and list it in the other's exclusions",
          ),
        );
      else owner.set(taken, chapter.id);
    }
  }
  return out;
}

/** A Markdown file spliced as `splice` gives it: its output, or a finding per problem. */
function markdownOutput(
  path: string,
  text: string | null,
  missing: Finding,
  splice: (text: string) => Splice,
  remedy: string,
  status: string | null,
  sources: readonly string[],
): { output: Output | null; findings: Finding[] } {
  if (text === null) return { output: null, findings: [missing] };
  const spliced = splice(text);
  if (!spliced.ok)
    return {
      output: null,
      findings: spliced.problems.map((p) => finding(path, p, remedy)),
    };
  return {
    output: {
      kind: "markdown",
      path,
      text: spliced.text,
      status,
      sources,
      sections: spliced.sections,
      current: spliced.current,
    },
    findings: [],
  };
}

/** One chapter's file and data file, with what it holds that the generator refuses. */
function chapterOutputs(
  root: string,
  chapter: Chapter,
  open: Set<number>,
): { outputs: Output[]; findings: Finding[]; data: DataFile } {
  const file = chapterFile(chapter.id);
  const data = dataOf(chapter);
  const markdown = markdownOutput(
    file,
    read(root, file),
    finding(
      file,
      "the chapter list names this chapter, but its file does not exist",
      `write the chapter's prose with a marker for each generated section (design/protocol.md § The chapter template), then run ${COMMAND}`,
    ),
    (text) => renderChapter(chapter, text),
    "fix the markers to name the sources tools/protocol/chapters.ts lists",
    statusLine(chapter),
    chapter.sections.map((s) => s.source),
  );
  return {
    outputs: [
      { kind: "json", path: dataFile(chapter.id), data, text: dataText(data) },
      ...(markdown.output ? [markdown.output] : []),
    ],
    findings: [
      ...statusFindings(chapter, open),
      ...valueFindings(chapter, data.values),
      ...identityFindings(chapter, data.values),
      ...markdown.findings,
    ],
    data,
  };
}

/** Each chapter's file, the index page and each data file as the generator writes them. */
export function planOutputs(root: string, chapters: readonly Chapter[]): Plan {
  const findings: Finding[] = [
    ...orphanFindings(root, chapters),
    ...takenTwice(chapters),
  ];
  const outputs: Output[] = [];
  const data = new Map<string, DataFile>();
  const open = openPlanItems(root);
  for (const chapter of chapters) {
    const planned = chapterOutputs(root, chapter, open);
    outputs.push(...planned.outputs);
    findings.push(...planned.findings);
    data.set(chapter.id, planned.data);
  }
  const index = markdownOutput(
    INDEX_FILE,
    read(root, INDEX_FILE),
    finding(
      INDEX_FILE,
      "the Protocol's index page does not exist",
      `write its introduction with a marker for the chapter list, then run ${COMMAND}`,
    ),
    (text) => renderIndex(chapters, text),
    `fix the marker to name ${INDEX_SOURCE}`,
    null,
    [INDEX_SOURCE],
  );
  if (index.output) outputs.push(index.output);
  findings.push(...index.findings);
  return { outputs, findings, data };
}

/** What differs between an output and its file: each part named, or nothing. */
export function staleness(root: string, output: Output): string[] {
  const text = read(root, output.path);
  if (text === null) return ["the file does not exist"];
  if (output.kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return ["the file is not valid JSON"];
    }
    return Bun.deepEquals(parsed, output.data, true)
      ? []
      : ["its values differ from the code's"];
  }
  if (text === output.text) return [];
  const parts: string[] = [];
  const lines = text.split("\n");
  if (output.status !== null && lines[0] !== output.text.split("\n")[0])
    parts.push("the title differs from the chapter list's");
  if (output.status !== null && lines[2] !== output.status)
    parts.push(`the status line differs: it should read "${output.status}"`);
  output.sources.forEach((source, i) => {
    if (output.current[i] !== output.sections[i])
      parts.push(
        `the generated section from ${source} differs from the code's`,
      );
  });
  return parts.length ? parts : ["the generated parts differ"];
}
