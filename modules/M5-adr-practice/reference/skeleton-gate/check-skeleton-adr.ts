#!/usr/bin/env bun
// Require recorded authority for a change to a skeleton file: the change
// updates the inventory, or a commit trailer names an approved decision
// record. Fails closed on a stale inventory and on an unresolvable record.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { cli, strictOptions } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { load } from "../../../../lib/vendor/js-yaml.mjs";

const GATE = "check-skeleton-adr";
const USAGE = `usage: check-skeleton-adr.ts [--inventory <file>] <commit-msg-file>
       check-skeleton-adr.ts [--inventory <file>] --base <ref> --head <ref>`;

/** Input the gate cannot read or parse: the run could not check. */
class Unreadable extends Error {}

export interface Inventory {
  /** Directory holding the decision records, relative to the repository. */
  decisionRecords: string;
  /** The `status` values that count as approved. */
  approvedStatuses: string[];
  /** The trailer key that names a record. */
  trailer: string;
  /**
   * Skeleton files: `path` is literal (a file, or a directory with a trailing
   * `/`); with `glob` set it is a pattern. Kept apart because a literal path
   * may hold pattern characters (`app/[id]/page.tsx`).
   */
  entries: { path: string; glob: boolean; why: string }[];
}

/** The inventory's own path is always compared as a normalized repo path. */
function repoRelative(path: string): string {
  return posix.normalize(path.replaceAll("\\", "/"));
}

export function parseInventory(text: string): Inventory {
  let data: unknown;
  try {
    data = load(text);
  } catch (error) {
    throw new Unreadable(
      `the inventory is not valid YAML: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!isRecord(data)) throw new Unreadable("the inventory is not a mapping");
  const text_ = (key: string, fallback: string): string => {
    const value = data[key];
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !value.trim())
      throw new Unreadable(`\`${key}\` must be a non-empty string`);
    return value.trim();
  };
  const statuses = data.approved_statuses ?? ["approved", "amended"];
  if (
    !Array.isArray(statuses) ||
    !statuses.length ||
    statuses.some((status) => typeof status !== "string" || !status.trim())
  )
    throw new Unreadable("`approved_statuses` must be a list of status names");
  const skeleton = data.skeleton;
  if (!Array.isArray(skeleton) || !skeleton.length)
    throw new Unreadable(
      "`skeleton` must list at least one file: an inventory that lists nothing protects nothing",
    );
  const entries = skeleton.map((raw: unknown, index) => {
    if (!isRecord(raw))
      throw new Unreadable(`skeleton[${index}] is not a mapping`);
    if ("path" in raw === "glob" in raw)
      throw new Unreadable(
        `skeleton[${index}] needs exactly one of \`path\` (literal) or \`glob\` (pattern)`,
      );
    const glob = "glob" in raw;
    const path = glob ? raw.glob : raw.path;
    const why = raw.why;
    const key = glob ? "glob" : "path";
    if (typeof path !== "string" || !path.trim())
      throw new Unreadable(`skeleton[${index}] has an empty \`${key}\``);
    if (typeof why !== "string" || !why.trim())
      throw new Unreadable(
        `skeleton[${index}] (${path}) has no \`why\`: say which contract the file holds`,
      );
    if (path.startsWith("/") || path.split("/").includes(".."))
      throw new Unreadable(
        `skeleton[${index}] path ${path} leaves the repository`,
      );
    return { path: path.trim(), glob, why: why.trim() };
  });
  return {
    decisionRecords: text_("decision_records", "docs/adr").replace(/\/+$/, ""),
    approvedStatuses: statuses.map((status: string) => status.trim()),
    trailer: text_("trailer", "Decision-Record"),
    entries,
  };
}

const matcher = (entry: Inventory["entries"][number]) => {
  const { path: listed } = entry;
  if (entry.glob) {
    const glob = new Bun.Glob(listed);
    return (path: string) => glob.match(path);
  }
  if (listed.endsWith("/")) return (path: string) => path.startsWith(listed);
  return (path: string) => path === listed;
};

/** The decision records a message names: its trailer block's `key: value`. */
export function namedRecords(message: string, trailer: string): string[] {
  // `git commit -v` appends the diff below a scissors line; it is not message.
  const scissors = message.search(/^# -+ >8 -+$/m);
  const lines = (scissors < 0 ? message : message.slice(0, scissors))
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trimEnd());
  while (lines.length && !lines.at(-1)) lines.pop();
  const start = lines.lastIndexOf("") + 1;
  const key = trailer.toLowerCase();
  return lines
    .slice(start)
    .map((line) => line.match(/^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/))
    .flatMap((match) =>
      match?.[1]?.toLowerCase() === key ? [(match[2] ?? "").trim()] : [],
    );
}

/** The `status` of a record and whether a later record replaced it. */
function recordState(
  content: string,
): { status: string; supersededBy: string | undefined } | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const front = load(match[1] ?? "");
  if (!isRecord(front)) return undefined;
  const text = (value: unknown) =>
    typeof value === "string" || typeof value === "number"
      ? String(value).trim()
      : "";
  // Absence is only null or a missing key; any other non-id value is malformed
  // and must not read as "nothing superseded it".
  const supersededBy = front.superseded_by;
  return {
    status: text(front.status),
    supersededBy:
      supersededBy === null || supersededBy === undefined
        ? ""
        : text(supersededBy) || undefined,
  };
}

/** Where the change's files and records are read from. */
export interface Source {
  /** Every path in the tree the change leaves behind. */
  files(): string[];
  read(path: string): string | undefined;
}

export interface Change {
  /** Paths added, modified or deleted; a rename lists both its paths. */
  touched: string[];
  /** Files git detected as moved, as [old, new] pairs. */
  renames: [string, string][];
  /** One message per commit that is part of the change. */
  messages: string[];
}

export function check(
  inventory: Inventory,
  inventoryPath: string,
  change: Change,
  source: Source,
): Finding[] {
  const findings: Finding[] = [];
  const present = source.files();
  const touched = new Set(change.touched);
  const owned = inventory.entries.map((entry) => ({
    ...entry,
    matches: matcher(entry),
  }));

  for (const entry of owned) {
    if (present.some(entry.matches)) continue;
    findings.push({
      rule: "skeleton-inventory-stale",
      file: inventoryPath,
      problem: `\`${entry.path}\` lists a skeleton file that no longer exists (renamed, moved or deleted)`,
      remedy: `Update the entry to the file's new path, or remove it, in the same change as the rename or deletion.`,
    });
  }

  const skeleton = [...touched].filter((path) =>
    owned.some((entry) => entry.matches(path)),
  );
  if (!skeleton.length) return findings;
  if (touched.has(repoRelative(inventoryPath))) return findings;

  const named = change.messages.flatMap((message) =>
    namedRecords(message, inventory.trailer),
  );
  const where = skeleton.join(", ");
  for (const [from, to] of change.renames) {
    if (!owned.some((entry) => entry.matches(from))) continue;
    if (owned.some((entry) => entry.matches(to))) continue;
    findings.push({
      rule: "skeleton-file-moved-out",
      file: from,
      problem: `skeleton file moved to ${to}, where no inventory entry covers it: it silently stops being protected`,
      remedy: `Edit the inventory (${inventoryPath}) so an entry covers ${to}, or remove the contract's entry on purpose.`,
    });
  }
  if (!named.length) {
    findings.push({
      rule: "skeleton-change-unauthorized",
      problem: `changes skeleton file(s) ${where} without recorded authority`,
      remedy: `Update the inventory (${inventoryPath}) in this change, or add a \`${inventory.trailer}: ADR-NNNN\` trailer naming an approved decision record. Agents: skeleton files are read-only, so stop and ask a person.`,
    });
    return findings;
  }
  for (const id of new Set(named)) {
    const reason = unapproved(id, inventory, source, present);
    if (reason)
      findings.push({
        rule: "skeleton-record-not-approved",
        problem: `\`${inventory.trailer}: ${id}\` ${reason}`,
        remedy: `Name a record under ${inventory.decisionRecords}/ whose status is ${inventory.approvedStatuses.join(" or ")}; a draft or deprecated record authorizes nothing.`,
      });
  }
  return findings;
}

/** Why a named record authorizes nothing, or undefined when it does. */
function unapproved(
  id: string,
  inventory: Inventory,
  source: Source,
  present: string[],
): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(id))
    return "is not a record id such as ADR-0007";
  const prefix = `${inventory.decisionRecords}/${id}`;
  const files = present.filter(
    (path) =>
      path.endsWith(".md") &&
      (path.startsWith(`${prefix}-`) || path === `${prefix}.md`),
  );
  if (!files.length)
    return `does not resolve to a record under ${inventory.decisionRecords}/`;
  if (files.length > 1)
    return `resolves to ${files.length} records (${files.join(", ")})`;
  const content = source.read(files[0] as string) ?? "";
  let state: ReturnType<typeof recordState>;
  try {
    state = recordState(content);
  } catch (error) {
    return `names ${files[0]}, whose frontmatter is not valid YAML: ${error instanceof Error ? error.message : error}`;
  }
  if (!state?.status)
    return `names ${files[0]}, which has no readable \`status\``;
  if (state.supersededBy === undefined)
    return `names ${files[0]}, whose \`superseded_by\` is not a record id or null`;
  if (state.supersededBy)
    return `names ${files[0]}, which ${state.supersededBy} superseded`;
  if (!inventory.approvedStatuses.includes(state.status))
    return `names ${files[0]}, whose status is \`${state.status}\``;
  return undefined;
}

function git(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  // A git killed by a signal has a null exit code: only an explicit 0 is a
  // complete answer, or a truncated diff would read as "nothing changed".
  if (result.exitCode !== 0)
    throw new Unreadable(
      `git ${args[0]} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

const names = (out: string) => out.split("\0").filter(Boolean);

/** The [old, new] pairs of `git diff --name-status -z -M` output. */
function renamed(out: string): [string, string][] {
  const fields = names(out);
  const pairs: [string, string][] = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      if (status.startsWith("R"))
        pairs.push([fields[index + 1] ?? "", fields[index + 2] ?? ""]);
      index += 3;
    } else index += 2;
  }
  return pairs;
}

/**
 * A source over a listing: a path outside it reads as absent, and a path in it
 * that git cannot show is an error, never an absent file.
 */
function listedSource(list: () => string[], prefix: string): Source {
  let listing: Set<string> | undefined;
  const files = () => {
    listing ??= new Set(list());
    return [...listing];
  };
  return {
    files,
    read: (path) => {
      files();
      return listing?.has(path) ? git(["show", `${prefix}${path}`]) : undefined;
    },
  };
}

/** The staged change, read from the index (the commit-msg hook's view). */
function stagedChange(messageFile: string): [Change, Source] {
  let message: string;
  try {
    message = readFileSync(messageFile, "utf8");
  } catch {
    throw new Unreadable(`cannot read the commit message file ${messageFile}`);
  }
  const touched = names(
    git(["diff", "--cached", "--name-only", "--no-renames", "-z"]),
  );
  return [
    {
      touched,
      renames: renamed(
        git([
          "diff",
          "--cached",
          "--name-status",
          "-M",
          "--diff-filter=R",
          "-z",
        ]),
      ),
      messages: [message],
    },
    listedSource(() => names(git(["ls-files", "-z"])), ":"),
  ];
}

/** A range of commits taken as one change (CI's view of a pull request). */
function rangeChange(base: string, head: string): [Change, Source] {
  const touched = names(
    git(["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`]),
  );
  const messages = git(["log", "--format=%B%x00", `${base}..${head}`])
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
  return [
    {
      touched,
      renames: renamed(
        git([
          "diff",
          "--name-status",
          "-M",
          "--diff-filter=R",
          "-z",
          `${base}...${head}`,
        ]),
      ),
      messages,
    },
    listedSource(
      () => names(git(["ls-tree", "-r", "--name-only", "-z", head])),
      `${head}:`,
    ),
  ];
}

export function main(argv = process.argv.slice(2)): number {
  const { values, positionals } = strictOptions(
    {
      args: argv,
      allowPositionals: true,
      options: {
        inventory: { type: "string", default: ".config/skeleton.yaml" },
        base: { type: "string" },
        head: { type: "string" },
      },
    },
    USAGE,
  );
  const range = values.base !== undefined || values.head !== undefined;
  if (
    range
      ? !values.base || !values.head || positionals.length
      : positionals.length !== 1
  )
    throw new Error(USAGE);
  const inventoryPath = repoRelative(values.inventory);
  // A merge brings in changes already checked on the branch they came from;
  // the range form reads them from the merge-base, so the hook leaves it be.
  if (
    !range &&
    Bun.spawnSync(["git", "rev-parse", "-q", "--verify", "MERGE_HEAD"])
      .exitCode === 0
  )
    return 0;
  try {
    const [change, source] = range
      ? rangeChange(values.base as string, values.head as string)
      : stagedChange(positionals[0] as string);
    const text = source.read(inventoryPath);
    if (text === undefined)
      throw new Unreadable(
        `the inventory ${inventoryPath} is not in the tree being checked`,
      );
    const findings = check(parseInventory(text), inventoryPath, change, source);
    if (!findings.length) return 0;
    reportFindings(findings);
    return 1;
  } catch (error) {
    if (error instanceof Unreadable) return couldNotCheck(GATE, error.message);
    throw error;
  }
}

if (import.meta.main) cli(() => main());
