// The consumer-actions record: every consumer action the changelog's
// released sections declare (consumer-actions.ts reads the grammar), as JSON
// a checker reads without the changelog. It lists each release that declares
// at least one action or retraction, oldest first, with each action's id,
// strength, levels, description, instruction and hints. It is derived from the
// changelog alone: the release step writes it in the same release that writes
// the notes into the changelog, and `--check` fails when the committed file is
// not what the changelog derives, so it is never edited by hand. A release
// whose entries carry no declaration adds nothing, so the record starts at the
// first release that declares one.
//
// Where it lives is the repository's `changelog.consumer_actions_record`; a
// repository without it derives no record. Only a format whose entries end
// where the note's did can carry one (Keep a Changelog): Common Changelog
// appends a reference and authors to every entry.
//
// Usage: bun consumer-actions-record.ts [--root <dir>] --write|--check
// Exit: 0 written, fresh, or not configured; 1 stale, or a malformed
// declaration in a released section; 2 a usage error, an invalid
// configuration or an unreadable file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { banner } from "./banner.ts";
import { loadResolved } from "./config.ts";
import {
  actionId,
  type Declared,
  type Hint,
  type Level,
  readDeclaration,
  type Strength,
} from "./consumer-actions.ts";
import { type Format, releaseVersion } from "./formats.ts";
import { blocks, fenced } from "./markdown-blocks.ts";

/** The record's schema version; a reader refuses one it does not know. */
export const RECORD_SCHEMA = 1;

export interface RecordedAction {
  id: string;
  strength: Strength;
  levels: Level[];
  /** The entry's text before its declaration, whitespace collapsed. */
  description: string;
  instruction: string;
  hints: Hint[];
}

export interface RecordedRelease {
  version: string;
  actions: RecordedAction[];
  /** The ids of earlier actions this release withdraws. */
  retracts: string[];
}

export interface ConsumerActionsRecord {
  $comment: string;
  schema: number;
  /** Oldest first; only releases with an action or a retraction. */
  releases: RecordedRelease[];
}

const COMMENT =
  "Derived from the changelog's released sections by the changelog skill (consumer-actions-record.ts); the release step rewrites it, so never edit it by hand.";

/** `declared` added to `release`: an action once per id, a retraction once per id. */
function add(release: RecordedRelease, declared: Declared): void {
  const { description, declaration } = declared;
  if (declaration.kind === "none") return;
  if (declaration.kind === "retracts") {
    if (!release.retracts.includes(declaration.id))
      release.retracts.push(declaration.id);
    return;
  }
  const id = actionId(release.version, description, declaration);
  if (release.actions.some((action) => action.id === id)) return;
  release.actions.push({
    id,
    strength: declaration.strength,
    levels: declaration.levels,
    description,
    instruction: declaration.instruction,
    hints: declaration.hints,
  });
}

/**
 * The top-level list items of a released section, each with its
 * continuation: the lines indented under it, and lines right after it that
 * continue its paragraph. An item ends at a blank line followed by a line that
 * is not indented, so a paragraph, a link reference definition or the file's
 * comparison links after the list never become part of its last item.
 */
export function releasedItems(text: string): string[] {
  const items: string[][] = [];
  let open = false;
  let blank = false;
  for (const { line, inFence } of fenced(text)) {
    const opens = !inFence && /^[-*] /.test(line);
    if (opens) items.push([]);
    else if (!open || (blank && line.trim() && !/^\s/.test(line))) {
      open = false;
      continue;
    }
    open = true;
    blank = !line.trim();
    items.at(-1)?.push(line);
  }
  return items.map((lines) => lines.join("\n").trimEnd());
}

/** One released section's declarations; the problems name the version. */
function releaseOf(
  version: string,
  text: string,
  problems: string[],
): RecordedRelease {
  const release: RecordedRelease = { version, actions: [], retracts: [] };
  const items = blocks(text, 3).parts.flatMap((section) =>
    releasedItems(section.text),
  );
  for (const read of items.map(readDeclaration))
    if (!read.ok) problems.push(`${version}: ${read.failure.reason}`);
    else if (read.value !== null) add(release, read.value);
  return release;
}

/**
 * The record the changelog's released sections derive: a failure naming each
 * malformed declaration, which the release and the check refuse.
 */
export function deriveRecord(
  changelog: string,
  format: Format,
): Outcome<ConsumerActionsRecord> {
  const problems: string[] = [];
  const releases = blocks(changelog, 2).parts.flatMap((part) => {
    const version = releaseVersion(part.title, format);
    if (version === null) return [];
    const release = releaseOf(version, part.text, problems);
    return release.actions.length || release.retracts.length ? [release] : [];
  });
  if (problems.length)
    return failed(
      "malformed-declaration",
      `consumer actions the record cannot read:\n  ${problems.join("\n  ")}`,
    );
  releases.sort((a, b) => Bun.semver.order(a.version, b.version));
  return ok({ $comment: COMMENT, schema: RECORD_SCHEMA, releases });
}

/** The width a line of the record keeps to, as JSON formatters lay it out. */
const WIDTH = 80;

/**
 * `value` as JSON laid out the way common formatters (Biome, Prettier) lay it
 * out, so a repository that formats its JSON leaves the record as derived:
 * every object expanded, two spaces a level, and an array of plain values on
 * one line when the line keeps to 80 columns, one value a line otherwise.
 * `prefix` is the width of the line before the value, `suffix` of what
 * follows it (a comma).
 */
function layout(
  value: unknown,
  pad: string,
  prefix: number,
  suffix: number,
): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const inner = `${pad}  `;
  const comma = (i: number, length: number) => (i < length - 1 ? 1 : 0);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    const inline = `[${value.map((v) => JSON.stringify(v)).join(", ")}]`;
    if (
      value.every((v) => v === null || typeof v !== "object") &&
      prefix + inline.length + suffix <= WIDTH
    )
      return inline;
    const items = value.map(
      (v, i) =>
        `${inner}${layout(v, inner, inner.length, comma(i, value.length))}`,
    );
    return `[\n${items.join(",\n")}\n${pad}]`;
  }
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  const fields = entries.map(([key, v], i) => {
    const head = `${inner}${JSON.stringify(key)}: `;
    return `${head}${layout(v, inner, head.length, comma(i, entries.length))}`;
  });
  return `{\n${fields.join(",\n")}\n${pad}}`;
}

/** The record as its file holds it. */
export const recordText = (record: ConsumerActionsRecord): string =>
  `${layout(record, "", 0, 0)}\n`;

/**
 * The ids of every action the changelog has released: null when there is no
 * changelog to read, a failure when a released declaration is malformed.
 */
export function releasedIds(
  changelog: string | null,
  format: Format,
): Outcome<Set<string> | null> {
  if (changelog === null) return ok(null);
  const record = deriveRecord(changelog, format);
  return record.ok
    ? ok(
        new Set(
          record.value.releases.flatMap((r) => r.actions.map((a) => a.id)),
        ),
      )
    : record;
}

/**
 * The text the record at `path` (relative to `root`) should hold for
 * `changelog`, or null when it already does.
 */
export function recordUpdate(
  root: string,
  path: string,
  changelog: string,
  format: Format,
): Outcome<string | null> {
  const record = deriveRecord(changelog, format);
  if (!record.ok) return record;
  const text = recordText(record.value);
  const file = join(root, path);
  return ok(
    existsSync(file) && readFileSync(file, "utf8") === text ? null : text,
  );
}

/** Write or check the record of the repository at `root`; the exit status. */
export function runRecord(root: string, mode: "write" | "check"): number {
  console.log(banner("consumer-actions-record"));
  const resolved = loadResolved(root);
  const path = resolved?.config.consumerActionsRecord ?? null;
  if (resolved === null || path === null) {
    console.log(
      "consumer-actions record: not configured (no changelog.consumer_actions_record in .config/jig.yaml)",
    );
    return 0;
  }
  const changelog = readFileSync(join(root, resolved.changelog), "utf8");
  const update = recordUpdate(root, path, changelog, resolved.format);
  if (!update.ok) {
    console.error(update.failure.reason);
    return 1;
  }
  if (update.value === null) {
    console.log(
      `consumer-actions record: ${path} is what ${resolved.changelog} derives`,
    );
    return 0;
  }
  if (mode === "check") {
    console.error(
      `${path} is not what ${resolved.changelog} derives: regenerate it with \`bun <changelog skill>/scripts/consumer-actions-record.ts --write\`, never by hand`,
    );
    return 1;
  }
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), update.value);
  console.log(
    `consumer-actions record: wrote ${path} from ${resolved.changelog}`,
  );
  return 0;
}

if (import.meta.main)
  runMain("consumer-actions-record", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          write: { type: "boolean", default: false },
          check: { type: "boolean", default: false },
        },
      });
      if (values.write === values.check)
        fail(2, "give one of --write and --check");
      return runRecord(
        values.root ? resolve(values.root) : consumerRoot(),
        values.write ? "write" : "check",
      );
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
