// Turn a branch that edited the changelog or the version itself into one that
// carries a change note, against its merge base with the integration branch:
// the release sections it added and its additions to Unreleased become one
// note whose `release` is the bump the branch made, the base's open sections
// and version come back (the branch's edits to earlier releases stay), and a
// placeholder the branch filled with its own version goes back to its `from`.
// The result is left uncommitted for a person to review.
//
// A branch stacked on another converts against that branch (`--base`), so only
// its own edits become its note.
//
// Usage: bun convert.ts [--root <dir>] [--base <ref>] [--dry-run] [--json]
// Exit: 0 converted, nothing to convert, or the skill is not configured; 1 a
// refusal (a merge, rebase or cherry-pick that has stopped, uncommitted
// changes, a base git cannot compare against, a note that cannot be read or
// links that cannot be rewritten); 2 a usage error, an invalid configuration
// or an unreadable file.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { errnoCode } from "../../../shared/errors.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { checkBase } from "./branches.ts";
import {
  type Bump,
  type ChangeNote,
  entries,
  parseNote,
  rebaseLinks,
} from "./change-notes.ts";
import {
  type ChangelogConfig,
  configAtBase,
  type Resolved,
  resolve as resolveConfig,
} from "./config.ts";
import { ChangelogError } from "./errors.ts";
import { type Format, releasedVersions, releaseVersion } from "./formats.ts";
import { authorsIn, isBot } from "./history.ts";
import { trailingLinks } from "./keep-a-changelog.ts";
import { blocks, fenced, heading } from "./markdown-blocks.ts";
import {
  isNoteFile,
  noteName,
  tagsOf,
  tryGit,
  workingTree,
} from "./notes-dir.ts";
import {
  compareVersions,
  currentVersion,
  type FileReader,
  type VersionSource,
  withVersion,
} from "./versions.ts";

type Env = Record<string, string | undefined>;

/** An invalid configuration at the base: a usage error, not a refusal of the branch. */
class InvalidConfig extends ChangelogError {}

/** `fn`'s result, its ChangelogError an InvalidConfig. */
function configured<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ChangelogError) throw new InvalidConfig(error.message);
    throw error;
  }
}

export interface ConvertResult {
  configured: boolean;
  /** The revision the branch was compared with. */
  base: string | null;
  /** The note written (or merged into); null when the branch needs none. */
  note: string | null;
  /** The release the note asks for; null when the branch did not move the version. */
  release: Bump | null;
  /** The files put back to the merge base's text, in part or whole. */
  restored: string[];
  /** The files in which a placeholder the branch filled went back. */
  reverted: string[];
  /** Added lines that still name the branch's version, for a person to check. */
  check: string[];
  /** What is not right about the note or the conversion, though it was written. */
  problems: string[];
}

const PLAIN = /^\d+\.\d+\.\d+$/;

/** Text with Unix line endings, so a Windows checkout compares with git's copy. */
const lf = (text: string): string => text.replace(/\r\n/g, "\n");

/** `text` (Unix line endings) in the line endings `like` uses. */
const eolOf = (text: string, like: string): string =>
  like.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text;

/** What a merge, rebase or cherry-pick leaves in the git directory while it is stopped. */
const STOPPED: [string, string][] = [
  ["MERGE_HEAD", "merge"],
  ["rebase-merge", "rebase"],
  ["rebase-apply", "rebase"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
];

/** Refuses while an operation is stopped and on uncommitted changes: the result must be reviewable on its own. */
function refuseUnfinished(root: string): void {
  for (const [name, operation] of STOPPED) {
    const path = tryGit(root, ["rev-parse", "--git-path", name])?.trim();
    if (path && existsSync(resolve(root, path)))
      throw new ChangelogError(
        `a ${operation} is stopped: finish or abort it first, since converting would mix its changes into the note`,
      );
  }
  const status = tryGit(root, ["status", "--porcelain", "-z"]);
  if (status === null)
    throw new ChangelogError(
      "git could not read the state of the working tree",
    );
  if (status)
    throw new ChangelogError(
      "the working tree has uncommitted changes: commit or set them aside first, so the conversion is the only change left to review",
    );
}

/** A file's text split by the `##` sections the changelog is made of. */
interface Layout {
  head: string[];
  sections: { title: string; lines: string[] }[];
  /** The run of link definitions and blank lines that ends the file. */
  tail: string[];
}

function layout(text: string): Layout {
  const lines = fenced(text);
  const tailAt = trailingLinks(lines);
  const marks = lines.flatMap(({ line, inFence }, i) =>
    i < tailAt && !inFence && heading(line)?.level === 2 ? [i] : [],
  );
  const raw = lines.map((l) => l.line);
  return {
    head: raw.slice(0, marks[0] ?? tailAt),
    sections: marks.map((from, k) => ({
      title: heading(raw[from] ?? "")?.title ?? "",
      lines: raw.slice(from, marks[k + 1] ?? tailAt),
    })),
    tail: raw.slice(tailAt),
  };
}

const trimmed = (lines: string[]): string => lines.join("\n").trim();

/** The text of a layout, its parts one blank line apart. */
function render(parts: Layout): string {
  return `${[
    trimmed(parts.head),
    ...parts.sections.map((s) => trimmed(s.lines)),
    trimmed(parts.tail),
  ]
    .filter(Boolean)
    .join("\n\n")}\n`;
}

const isUnreleased = (title: string): boolean => /^\[Unreleased\]/i.test(title);

/** The label of a link definition line; null for any other line. */
const labelOf = (line: string): string | null =>
  /^\[([^\]]+)\]: \S+\s*$/.exec(line)?.[1] ?? null;

/**
 * The items of `after` that `before` does not have, each of `before`'s
 * consumed once so a repeated item counts for what it repeats. Returns their
 * indexes in `after`.
 */
function fresh(before: string[], after: string[]): number[] {
  const left = new Map<string, number>();
  for (const item of before) left.set(item, (left.get(item) ?? 0) + 1);
  return after.flatMap((item, i) => {
    const n = left.get(item) ?? 0;
    if (n > 0) {
      left.set(item, n - 1);
      return [];
    }
    return [i];
  });
}

/** What the branch brought into the changelog, as a note's parts. */
interface Collected {
  lead: string[];
  sections: Map<string, string[]>;
  authors: string[];
}

function addItems(into: Collected, title: string, items: string[]): void {
  if (items.length)
    into.sections.set(title, [...(into.sections.get(title) ?? []), ...items]);
}

/**
 * A Common Changelog entry as a note holds it: the reference to its change
 * and its authors, which the release step appends, taken off; the authors
 * returned.
 */
const CREDIT =
  /\s*\((?:\[(?:#\d+|`[0-9a-f]+`)\]\([^()\s]+\)|#\d+|`[0-9a-f]+`)\)(?:\s*\(((?:[^()\\]|\\.)*)\))?\s*$/;

function uncredited(item: string): { item: string; authors: string[] } {
  const found = CREDIT.exec(item);
  if (!found) return { item, authors: [] };
  return {
    item: item.slice(0, found.index),
    authors: (found[1] ?? "")
      .split(",")
      .map((n) => n.replace(/\\(.)/g, "$1").trim())
      .filter(Boolean),
  };
}

/** The first version `from` is below `to` by, as a bump; null when `to` is not above it. */
function bumpBetween(from: string, to: string): Bump | null {
  if (!PLAIN.test(from) || !PLAIN.test(to) || compareVersions(to, from) <= 0)
    return null;
  const [a, b] = [from, to].map((v) => v.split(".").map(Number));
  if (a?.[0] !== b?.[0]) return "major";
  return a?.[1] !== b?.[1] ? "minor" : "patch";
}

const RANK: Bump[] = ["patch", "minor", "major"];

const larger = (a: Bump | null, b: Bump | null): Bump | null =>
  RANK.indexOf(a ?? "patch") >= RANK.indexOf(b ?? "patch") ? (a ?? b) : b;

/** A note as a file: its front matter, its summary and its sections in the format's order. */
function renderNote(note: ChangeNote, format: Format): string {
  const front = [
    note.release ? `release: ${note.release}` : "",
    note.authors === null
      ? ""
      : `authors: ${note.authors.length ? note.authors.join(", ") : "[]"}`,
  ].filter(Boolean);
  const rank = (title: string) => {
    const i = format.sections.indexOf(title);
    return i === -1 ? format.sections.length : i;
  };
  const sections = [...note.sections]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([title, items]) => `### ${title}\n\n${items.join("\n")}`);
  const body = [note.lead, ...sections].filter(Boolean).join("\n\n");
  return `${front.length ? `---\n${front.join("\n")}\n---\n\n` : ""}${body}\n`;
}

/** The version, as a token, in a line: not part of a longer number. */
const naming = (version: string): RegExp =>
  new RegExp(`(?<![\\d.])${version.replaceAll(".", "\\.")}(?!\\d|\\.\\d)`);

/** The branch and the repository's configuration, as the steps of the conversion read them. */
interface Branch {
  base: string;
  /** The branch's name, which names its note. */
  name: string;
  mergeBase: string;
  config: ChangelogConfig;
  resolved: Resolved;
  atBase: FileReader;
  now: FileReader;
  /** The changelog at the merge base and now, with Unix line endings. */
  baseText: string;
  nowText: string;
  /** The changelog as the working tree holds it, to keep its line endings. */
  nowRaw: string;
  baseVersion: string;
  nowVersion: string;
  baseLayout: Layout;
  nowLayout: Layout;
  /** The release sections the branch added, and their versions. */
  added: Layout["sections"];
  addedVersions: string[];
}

/**
 * The files the configuration names that the merge base does not have: the
 * base created or moved them after the branch forked. `absent` the branch
 * lacks too, so it cannot have edited them; `created` the branch holds as
 * well, made on its own, so its edits cannot be told from the base's.
 */
function newerThanFork(
  resolved: Resolved,
  atBase: FileReader,
  now: FileReader,
): { absent: string[]; created: string[] } {
  const files = [
    resolved.changelog,
    ...(resolved.version.kind === "files"
      ? resolved.version.files.map((f) => f.path)
      : []),
  ].filter((path) => atBase(path) === null);
  return {
    absent: files.filter((path) => now(path) === null),
    created: files.filter((path) => now(path) !== null),
  };
}

/**
 * The version source without the files the branch never had: where none is
 * left, the version is the changelog's, as for a repository without files.
 */
function withoutFiles(version: VersionSource, absent: string[]): VersionSource {
  if (version.kind !== "files") return version;
  const files = version.files.filter((f) => !absent.includes(f.path));
  return files.length ? { kind: "files", files } : { kind: "tags" };
}

/**
 * The branch checked out in `root` against `base`; "off" where the base never
 * adopted the skill. A file the configuration names that neither the fork
 * point nor the branch has is left out, the changelog read as empty; one the
 * branch created on its own while the base created it too is refused.
 */
function openBranch(root: string, base: string): Branch | "off" {
  if (
    tryGit(root, ["rev-parse", "--verify", "-q", `${base}^{commit}`]) === null
  )
    throw new ChangelogError(
      `the branch cannot be compared with ${base} (no such revision): fetch it, or pass --base <ref>`,
    );
  const config = configured(() => configAtBase(root, base));
  if (config === null) return "off";
  refuseUnfinished(root);
  const name = tryGit(root, ["symbolic-ref", "--short", "-q", "HEAD"])?.trim();
  if (!name)
    throw new ChangelogError(
      "HEAD is detached: check out the branch to convert, since its note is named after it",
    );
  const mergeBase = tryGit(root, ["merge-base", "HEAD", base])?.trim();
  if (!mergeBase)
    throw new ChangelogError(`the branch has no merge base with ${base}`);
  const atBase: FileReader = (path) =>
    tryGit(root, ["show", `${mergeBase}:${path}`]);
  // The configuration is the base tip's, so a file it names may be newer
  // than the fork point: resolve it against the tip where the fork lacks it.
  const atTip: FileReader = (path) => tryGit(root, ["show", `${base}:${path}`]);
  const tip = configured(() =>
    resolveConfig(root, config, (path) => atBase(path) ?? atTip(path)),
  );
  const now = workingTree(root);
  const { absent, created } = newerThanFork(tip, atBase, now);
  if (created.length)
    throw new ChangelogError(
      `${created.join(", ")}: the branch created it on its own, while ${base} created it after the branch forked, so its edits cannot be told from the base's; move them into a note by hand`,
    );
  const resolved: Resolved = {
    ...tip,
    version: withoutFiles(tip.version, absent),
  };
  const noChangelog = absent.includes(resolved.changelog);
  const nowRaw = noChangelog ? "" : now(resolved.changelog);
  if (nowRaw === null)
    throw new ChangelogError(
      `${resolved.changelog}: the branch deletes the changelog; restore it first`,
    );
  const baseText = lf(atBase(resolved.changelog) ?? "");
  const nowText = lf(nowRaw);
  const { format } = resolved;
  const versionIn = (read: FileReader, changelog: string) =>
    currentVersion(resolved.version, {
      read,
      format,
      tagPrefix: resolved.tagPrefix,
      changelog,
      tags: () => tagsOf(root),
    });
  const baseLayout = layout(baseText);
  const nowLayout = layout(nowText);
  const known = new Set(releasedVersions(baseText, format));
  const kept = new Set(releasedVersions(nowText, format));
  const removed = [...known].filter((v) => !kept.has(v));
  if (removed.length)
    throw new ChangelogError(
      `${resolved.changelog}: the branch removes or renames the release section of ${removed.join(", ")}; put it back first, since a released version stays in the changelog`,
    );
  const added = nowLayout.sections.filter((s) => {
    const version = releaseVersion(s.title, format);
    return version !== null && !known.has(version);
  });
  return {
    base,
    name,
    mergeBase,
    config,
    resolved,
    atBase,
    now,
    baseText,
    nowText,
    nowRaw,
    baseVersion: versionIn(atBase, baseText),
    nowVersion: versionIn(now, nowText),
    baseLayout,
    nowLayout,
    added,
    addedVersions: added.flatMap((s) => {
      const v = releaseVersion(s.title, format);
      return v === null ? [] : [v];
    }),
  };
}

/** A list item of any kind at the start of a line: `-`, `*` or `+`, or numbered. */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]/m;

/**
 * The entries of a section's lines by change type, a change type that
 * appears twice holding both. Where `strict` (text the branch wrote), refuses
 * what the note cannot carry, which would be lost with the section: entries
 * outside a `###` section, and anything under one other than `- ` entries.
 */
function sectionItems(
  b: Branch,
  lines: string[],
  where: string,
  strict = true,
): { lead: string; items: Map<string, string[]> } {
  const { lead, parts } = blocks(lines.slice(1).join("\n"), 3);
  if (strict && LIST_ITEM.test(lead))
    throw new ChangelogError(
      `${b.resolved.changelog}: ${where} lists entries outside a ### section; put each under a change type (${b.resolved.format.sections.join(", ")}) first, so none is lost`,
    );
  const items = new Map<string, string[]>();
  for (const p of parts) {
    const found = entries(p.text);
    if (strict && found.stray)
      throw new ChangelogError(
        `${b.resolved.changelog}: ${where}, ### ${p.title} holds something other than "- " entries (a paragraph, a numbered list or "+ " items); make each a "- " entry first, so none is lost`,
      );
    items.set(p.title, [...(items.get(p.title) ?? []), ...found.items]);
  }
  return { lead, items };
}

const isUnreleasedSection = (s: Layout["sections"][number]): boolean =>
  isUnreleased(s.title);

/** The entries of an Unreleased section by change type; none where there is no section. */
const unreleasedItems = (
  b: Branch,
  section: Layout["sections"][number] | undefined,
  strict: boolean,
): Map<string, string[]> =>
  section
    ? sectionItems(b, section.lines, "Unreleased", strict).items
    : new Map<string, string[]>();

/**
 * What the branch did to Unreleased: the entries it added, and the merge
 * base's entries it no longer has (moved into a release section by hand, or
 * edited or removed; the base's text comes back with Unreleased). A branch
 * that removed the section holds none of its entries. Null where the format
 * has no Unreleased or neither side has one.
 */
function unreleasedChanges(b: Branch): {
  brought: Map<string, string[]>;
  gone: Map<string, number>;
} | null {
  const now = b.nowLayout.sections.find(isUnreleasedSection);
  const base = b.baseLayout.sections.find(isUnreleasedSection);
  if (!b.resolved.format.hasUnreleased || (!now && !base)) return null;
  const unchanged = trimmed(now?.lines ?? []) === trimmed(base?.lines ?? []);
  const mine = unreleasedItems(b, now, !unchanged);
  const before = unreleasedItems(b, base, false);
  const gone = new Map<string, number>();
  for (const [title, items] of before)
    for (const i of fresh(mine.get(title) ?? [], items)) {
      const key = movedKey(title, items[i] ?? "");
      gone.set(key, (gone.get(key) ?? 0) + 1);
    }
  const brought = new Map(
    [...mine].map(([title, items]) => [
      title,
      fresh(before.get(title) ?? [], items).flatMap((i) => items[i] ?? []),
    ]),
  );
  return { brought, gone };
}

/**
 * An entry of Unreleased the branch no longer has, by its change type and its
 * text: an entry moved into a release under another change type was
 * reclassified, not only moved, and the base's Unreleased brings back the old
 * type.
 */
const movedKey = (title: string, item: string) => `${title}\0${item}`;

/** `list`, under `title`, without the entries `gone` accounts for, each counted once. */
function withoutMoved(
  title: string,
  list: string[],
  gone: Map<string, number>,
): string[] {
  return list.filter((item) => {
    const key = movedKey(title, item);
    const n = gone.get(key) ?? 0;
    if (n > 0) gone.set(key, n - 1);
    return n === 0;
  });
}

/** What the branch wrote into the changelog, as the parts of a note. */
function collect(b: Branch): { collected: Collected; problems: string[] } {
  const { format } = b.resolved;
  const collected: Collected = { lead: [], sections: new Map(), authors: [] };
  const take = (title: string, items: string[]) => {
    for (const raw of items) {
      const { item, authors } = format.credits
        ? uncredited(raw)
        : { item: raw, authors: [] };
      collected.authors.push(...authors);
      addItems(collected, title, [item]);
    }
  };
  const unreleased = unreleasedChanges(b);
  const gone = unreleased?.gone ?? new Map<string, number>();
  for (const section of b.added) {
    const { lead, items } = sectionItems(b, section.lines, section.title);
    if (lead) collected.lead.push(lead);
    for (const [title, list] of items)
      take(title, withoutMoved(title, list, gone));
  }
  for (const [title, items] of unreleased?.brought ?? []) take(title, items);
  const problems = [...gone]
    .filter(([, n]) => n > 0)
    .map(([key]) => {
      const [title, item = ""] = key.split("\0");
      return `the branch edited or removed this entry of Unreleased's ${title}, or moved it under another change type, and the base's text comes back with Unreleased: ${item.split("\n")[0]}`;
    });
  return { collected, problems };
}

/**
 * The changelog with the merge base's open sections back and the branch's
 * release sections out, earlier releases as the branch has them; null when
 * that is the changelog as it is.
 */
function restoredChangelog(b: Branch): string | null {
  const baseUnreleased = b.baseLayout.sections.find(isUnreleasedSection);
  const nowUnreleased = b.nowLayout.sections.find(isUnreleasedSection);
  const kept: Layout = {
    head: b.nowLayout.head,
    sections: b.nowLayout.sections.filter((s) => !b.added.includes(s)),
    tail: b.nowLayout.tail.filter((line) => {
      const label = labelOf(line);
      return label === null || !b.addedVersions.includes(label);
    }),
  };
  const swap =
    b.resolved.format.hasUnreleased && baseUnreleased !== nowUnreleased;
  if (
    swap &&
    trimmed(baseUnreleased?.lines ?? []) !== trimmed(nowUnreleased?.lines ?? [])
  ) {
    const at = kept.sections.findIndex((s) => s === nowUnreleased);
    const replacement = baseUnreleased ? [baseUnreleased] : [];
    if (at !== -1) kept.sections.splice(at, 1, ...replacement);
    else kept.sections.unshift(...replacement);
  }
  const baseLink = b.baseLayout.tail.find((l) => /^\[Unreleased\]: /i.test(l));
  kept.tail = kept.tail.map((line) =>
    /^\[Unreleased\]: /i.test(line) ? (baseLink ?? line) : line,
  );
  return JSON.stringify(kept) === JSON.stringify(b.nowLayout)
    ? null
    : eolOf(render(kept), b.nowRaw);
}

/** The version files with the merge base's version back. */
function restoredVersions(b: Branch): Map<string, string> {
  const { version } = b.resolved;
  const out = new Map<string, string>();
  if (version.kind !== "files" || b.nowVersion === b.baseVersion) return out;
  for (const file of version.files)
    out.set(
      file.path,
      withVersion(file, b.now(file.path) ?? "", b.nowVersion, b.baseVersion),
    );
  return out;
}

/** How many times `part` occurs in `text`. */
const occurrences = (text: string, part: string): number =>
  text.split(part).length - 1;

/**
 * What one changed file needs: its text with filled placeholders put back,
 * and the lines that still name a version. A changed line does not show that
 * the branch filled the stamp on it (an edit around a stamp the base already
 * had keeps it), so a filled value goes back only where the file holds more
 * of it than the merge base did and every one on the branch's lines is
 * among those; otherwise its lines are left for a person, listed.
 */
function revertedFile(
  b: Branch,
  file: string,
  named: string[],
): { text: string | null; check: string[] } | null {
  const raw = b.now(file);
  if (raw === null || raw.includes("\0")) return null;
  const text = lf(raw);
  const baseText = lf(b.atBase(file) ?? "");
  const lines = text.split("\n");
  const baseLines = baseText.split("\n");
  const brought = fresh(baseLines, lines);
  // A brought line the base also has cannot be told from the base's own copy
  // by its text: which of the identical lines is the branch's needs their
  // positions, so such a value is listed rather than put back.
  const inherited = new Set(baseLines);
  let revised = lines;
  for (const { files, from, to } of b.config.placeholders) {
    if (!to.includes("{version}")) continue;
    if (!files.some((p) => new Bun.Glob(p).match(file))) continue;
    for (const version of named) {
      const value = to.replaceAll("{version}", version);
      const added = occurrences(text, value) - occurrences(baseText, value);
      const onBrought = brought.reduce(
        (n, i) => n + occurrences(revised[i] ?? "", value),
        0,
      );
      const ambiguous = brought.some(
        (i) => lines[i]?.includes(value) && inherited.has(lines[i] ?? ""),
      );
      if (added <= 0 || onBrought !== added || ambiguous) continue;
      revised = revised.map((line, i) =>
        brought.includes(i) ? line.replaceAll(value, from) : line,
      );
    }
  }
  const tokens = named.map(naming);
  return {
    text: revised.join("\n") === text ? null : eolOf(revised.join("\n"), raw),
    check: brought
      .filter((i) => tokens.some((token) => token.test(revised[i] ?? "")))
      .map(
        (i) => `${file}:${i + 1}: ${(revised[i] ?? "").trim().slice(0, 120)}`,
      ),
  };
}

/** The placeholders the branch filled, put back, and the lines that still name its versions. */
function placeholders(
  b: Branch,
  branchVersion: string,
): { writes: Map<string, string>; reverted: string[]; check: string[] } {
  const { resolved } = b;
  const own = new Set([
    resolved.changelog,
    ...(resolved.version.kind === "files"
      ? resolved.version.files.map((f) => f.path)
      : []),
  ]);
  const named = [...new Set([branchVersion, ...b.addedVersions])].filter((v) =>
    PLAIN.test(v),
  );
  const changed = (
    tryGit(b.resolved.root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      b.mergeBase,
      "HEAD",
    ]) ?? ""
  )
    .split("\0")
    .filter(Boolean)
    .filter(
      (f) =>
        !own.has(f) &&
        !isNoteFile(resolved.notes, f) &&
        !f.startsWith(".github/workflows/"),
    );
  const out = {
    writes: new Map<string, string>(),
    reverted: [] as string[],
    check: [] as string[],
  };
  for (const file of changed) {
    const result = revertedFile(b, file, named);
    if (result === null) continue;
    out.check.push(...result.check);
    if (result.text === null) continue;
    out.writes.set(join(resolved.root, file), result.text);
    out.reverted.push(file);
  }
  return out;
}

/** The note the branch carries once `converted` joins the note it already has. */
function withExisting(
  b: Branch,
  converted: ChangeNote,
  existing: string,
): ChangeNote {
  const parsed = parseNote(converted.file, existing, b.resolved.format);
  if (!parsed.note)
    throw new ChangelogError(
      `${converted.file} already exists and cannot be read, so the converted entries cannot be added to it:\n  ${parsed.errors.join("\n  ")}`,
    );
  const sections = new Map(parsed.note.sections);
  // An entry the note already holds (a conversion begun by hand) is not added twice.
  for (const [title, items] of converted.sections) {
    const had = sections.get(title) ?? [];
    const added = fresh(had, items).flatMap((i) => items[i] ?? []);
    sections.set(title, [...had, ...added]);
  }
  return {
    ...converted,
    release: larger(parsed.note.release, converted.release),
    authors: mergedAuthors(
      b,
      converted.file,
      parsed.note.authors,
      converted.authors,
    ),
    lead: [parsed.note.lead, converted.lead].filter(Boolean).join("\n\n"),
    sections,
  };
}

/**
 * The authors of a note joined from the one the branch had and the converted
 * entries. Named authors replace the history's, so where only one side names
 * them the other side's history comes in by name: the people whose commits
 * wrote the note, or the changelog's entries. Null where neither names any.
 */
function mergedAuthors(
  b: Branch,
  file: string,
  existing: string[] | null,
  converted: string[] | null,
): string[] | null {
  if (existing === null && converted === null) return null;
  // `authors: []` credits nobody, a decision the history does not override.
  if (!b.resolved.config.authors || (existing?.length === 0 && !converted))
    return existing ?? converted;
  const people = (path: string) =>
    authorsIn(b.resolved.root, `${b.mergeBase}..HEAD`, path).filter(
      (name) => !isBot(name),
    );
  return [
    ...new Set([
      ...(existing ?? people(file)),
      ...(converted ?? people(b.resolved.changelog)),
    ]),
  ];
}

/** The note for what the branch wrote in the changelog, as a path, its text and what is wrong with it; null when it wrote nothing. */
function noteFor(
  b: Branch,
  collected: Collected,
  release: Bump | null,
): { path: string; text: string; problems: string[] } | null {
  const { resolved } = b;
  const { format } = resolved;
  if (!collected.sections.size) return null;
  const fromChangelog: ChangeNote = {
    file: posix.join(resolved.notes, noteName(b.name)),
    release,
    authors:
      format.credits && resolved.config.authors && collected.authors.length
        ? [...new Set(collected.authors)]
        : null,
    lead: release ? collected.lead.join(format.credits ? " " : "\n\n") : "",
    sections: collected.sections,
  };
  let converted: ChangeNote;
  try {
    converted = rebaseLinks(
      fromChangelog,
      posix.dirname(resolved.changelog),
      resolved.notes,
    );
  } catch (error) {
    throw new ChangelogError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const existing = b.now(converted.file);
  const note =
    existing === null ? converted : withExisting(b, converted, existing);
  const text = renderNote(note, format);
  const problems = parseNote(note.file, text, format).errors;
  if (
    [note.lead, ...[...note.sections.values()].flat()].some((item) =>
      /\[[^\]]+\](?![(:])/.test(item),
    )
  )
    problems.push(
      `${note.file}: the summary or an entry looks like it uses a reference-style link, whose definition stays in the changelog: write the link inline`,
    );
  return { path: note.file, text, problems };
}

/** A conversion that changed nothing. */
const nothingConverted = (
  base: string,
  configured: boolean,
  problems: string[],
): ConvertResult => ({
  configured,
  base,
  note: null,
  release: null,
  restored: [],
  reverted: [],
  check: [],
  problems,
});

/** Schedules the changelog and the version files put back into `writes`; returns their paths. */
function restoredFiles(b: Branch, writes: Map<string, string>): string[] {
  const restored: string[] = [];
  const changelog = restoredChangelog(b);
  if (changelog !== null) {
    writes.set(join(b.resolved.root, b.resolved.changelog), changelog);
    restored.push(b.resolved.changelog);
  }
  for (const [path, text] of restoredVersions(b)) {
    writes.set(join(b.resolved.root, path), text);
    restored.push(path);
  }
  return restored;
}

/**
 * Convert the branch checked out in `root` against `base`. Writes the note
 * and puts the changelog, the version files and the filled placeholders back,
 * all computed before the first write; nothing is written on `dryRun`.
 */
export function convert(
  root: string,
  base: string,
  dryRun = false,
): ConvertResult {
  const b = openBranch(root, base);
  if (b === "off") return nothingConverted(base, false, []);
  const { collected, problems } = collect(b);
  const branchVersion =
    [b.nowVersion, ...b.addedVersions]
      .filter((v) => PLAIN.test(v))
      .sort(compareVersions)
      .at(-1) ?? b.nowVersion;
  const release = bumpBetween(b.baseVersion, branchVersion);
  if (!release && b.addedVersions.length)
    problems.push(
      `the branch adds a release section but the version does not rise from ${b.baseVersion}, so the note asks for no release and drops the section's summary`,
    );
  // The note first, so a write that fails leaves the branch's entries in the changelog.
  const note = noteFor(b, collected, release);
  const writes = new Map<string, string>();
  if (note) {
    writes.set(join(root, note.path), note.text);
    problems.push(...note.problems);
  } else if (release)
    problems.push(
      `the branch moves the version to ${branchVersion} but adds no entries to the changelog: write a note with \`release: ${release}\` by hand`,
    );
  const restored = restoredFiles(b, writes);
  const filled = release
    ? placeholders(b, branchVersion)
    : { writes: new Map<string, string>(), reverted: [], check: [] };
  for (const [path, text] of filled.writes) writes.set(path, text);
  if (!dryRun)
    for (const [path, text] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  return {
    configured: true,
    base,
    note: note?.path ?? null,
    release,
    restored,
    reverted: filled.reverted,
    check: filled.check,
    problems,
  };
}

/** What a conversion did (or would do), one line per change. */
function doneLines(result: ConvertResult, dryRun: boolean): string[] {
  const lines = [
    ...(result.note
      ? [
          `convert: ${dryRun ? "would write" : "wrote"} ${result.note}${result.release ? ` (release: ${result.release})` : ""}`,
        ]
      : []),
    ...result.restored.map(
      (file) =>
        `convert: ${dryRun ? "would put" : "put"} ${file} back to ${result.base}'s open sections and version`,
    ),
    ...result.reverted.map(
      (file) =>
        `convert: placeholder ${dryRun ? "would go" : "went"} back in ${file}`,
    ),
  ];
  if (!lines.length)
    return [`convert: nothing to convert against ${result.base}`];
  return dryRun
    ? lines
    : [...lines, "convert: the result is uncommitted: review it, then commit"];
}

/** The human report of a conversion. */
function report(result: ConvertResult, dryRun: boolean): void {
  console.log(banner("convert"));
  const lines = result.configured
    ? [
        ...doneLines(result, dryRun),
        ...result.check.map((l) => `check: still names the version: ${l}`),
        ...result.problems.map((p) => `attention: ${p}`),
      ]
    : [
        "convert: not configured (the base holds no changelog.file in .config/jig.yaml)",
      ];
  for (const line of lines) console.log(line);
}

/** Convert and report; the exit status for the command line. */
export function runConvert(
  root: string,
  explicitBase: string | null,
  dryRun: boolean,
  json: boolean,
  env: Env = process.env,
): number {
  let result: ConvertResult;
  try {
    const base = checkBase(root, explicitBase, env);
    if (base === null)
      throw new ChangelogError(
        "the branch to compare with is unknown: pass --base <ref>",
      );
    result = convert(root, base, dryRun);
  } catch (error) {
    if (errnoCode(error) !== undefined) throw error;
    console.error(error instanceof Error ? error.message : String(error));
    return error instanceof InvalidConfig ? 2 : 1;
  }
  if (json)
    console.log(JSON.stringify({ plugin: pluginVersion(), dryRun, ...result }));
  else report(result, dryRun);
  return 0;
}

if (import.meta.main)
  runMain("convert", async () => {
    try {
      const { values } = parseArgs({
        options: {
          root: { type: "string" },
          base: { type: "string" },
          "dry-run": { type: "boolean", default: false },
          json: { type: "boolean", default: false },
        },
      });
      return runConvert(
        values.root ? resolve(values.root) : consumerRoot(),
        values.base ?? null,
        values["dry-run"],
        values.json,
      );
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
