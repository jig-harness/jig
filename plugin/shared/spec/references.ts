/**
 * Where an issue body names its spec, and whether a named path may be read.
 *
 * The body is written by anyone who can write an issue, and what the
 * resolver reads reaches the implementing agent's and the reviewer's
 * prompts. So a path is read only when it resolves, through every symbolic
 * link, to a file or folder inside the repository root that Git does not
 * ignore and an enabled adapter's patterns claim. Each check runs before any
 * read; a web link is never fetched.
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { swallow } from "../errors.ts";
import { spawnSync, withoutLeakyGitEnv } from "../guarded-git-spawn.ts";
import type { BodySectionKind, SpecAdapter } from "./adapter.ts";
import {
  headingKey,
  INLINE_HEADINGS,
  markdownLines,
  trimEndOf,
} from "./markdown.ts";

/** One recognised section of the body, every occurrence joined. */
export interface BodySection {
  kind: BodySectionKind;
  /** The heading as the configuration or the resolver names it. */
  heading: string;
  text: string;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t](.*))?$/;

/** The heading `line` is, its closing run of `#` dropped, or `null`. */
function headingOf(line: string): { level: number; title: string } | null {
  const match = HEADING.exec(line);
  if (!match) return null;
  let title = (match[2] ?? "").trim();
  const bare = trimEndOf(title, "#");
  if (bare === "" || bare.endsWith(" ")) title = bare.trim();
  return { level: (match[1] ?? "").length, title };
}

/**
 * The recognised sections of `body`. A heading of any level opens one and the
 * next heading of the same or a higher level closes it; a line belongs to the
 * innermost recognised section around it, so an `### Acceptance criteria`
 * inside `## Spec` is its own section, not part of the Spec section.
 */
export function bodySections(body: string, specHeading: string): BodySection[] {
  const names = new Map<BodySectionKind, BodySection>();
  const want = new Map<string, [BodySectionKind, string]>([
    [
      headingKey(INLINE_HEADINGS.requirements),
      ["requirements", INLINE_HEADINGS.requirements],
    ],
    [
      headingKey(INLINE_HEADINGS.acceptance),
      ["acceptance", INLINE_HEADINGS.acceptance],
    ],
    [headingKey(specHeading), ["spec", specHeading]],
  ]);
  const section = (title: string): BodySection | null => {
    const known = want.get(headingKey(title));
    if (!known) return null;
    const [kind, heading] = known;
    const found = names.get(kind) ?? { kind, heading, text: "" };
    names.set(kind, found);
    return found;
  };
  const stack: { level: number; section: BodySection | null }[] = [];
  for (const { line, heading } of headedLines(body)) {
    if (heading) {
      while ((stack.at(-1)?.level ?? 0) >= heading.level) stack.pop();
      stack.push({ level: heading.level, section: section(heading.title) });
      continue;
    }
    const owner = stack.findLast((s) => s.section !== null)?.section;
    if (owner) owner.text += `${line}\n`;
  }
  return [...names.values()];
}

/** Each line of `body`, with its heading when it is one outside code. */
function* headedLines(body: string): Generator<{
  line: string;
  heading: { level: number; title: string } | null;
}> {
  for (const { line, kind } of markdownLines(body))
    yield { line, heading: kind === "text" ? headingOf(line) : null };
}

const MARKDOWN_LINK =
  /\[[^\]]*\]\([ \t]*<?([^)\s>]+)>?[ \t]*(?:"[^"]*"[ \t]*)?\)/g;
const AUTOLINK = /<([a-z][a-z0-9+.-]*:[^>\s]+)>/gi;
const BARE_URL = /\bhttps?:\/\/[^\s)>\]]+/gi;
const DEFINITION = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/;
const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const CODE_SPAN = /`([^`\s]+)`/g;

/** A token that reads as a path: no space, and a slash, a leading dot or tilde, or an extension. */
function pathLike(token: string): boolean {
  return (
    !/\s/.test(token) &&
    (/[\\/]/.test(token) ||
      /^[.~]/.test(token) ||
      /\.[A-Za-z][A-Za-z0-9]*$/.test(token))
  );
}

function linkTargets(line: string): string[] {
  const found: string[] = [];
  for (const m of line.matchAll(MARKDOWN_LINK)) found.push(m[1] ?? "");
  for (const m of line.matchAll(AUTOLINK)) found.push(m[1] ?? "");
  const withoutLinks = line.replace(MARKDOWN_LINK, " ").replace(AUTOLINK, " ");
  for (const m of withoutLinks.matchAll(BARE_URL)) found.push(m[0]);
  const definition = DEFINITION.exec(line);
  if (definition) found.push(definition[1] ?? "");
  return found.filter((t) => t !== "" && !t.startsWith("#"));
}

/**
 * The references the spec section names: every link target, web address and
 * link definition, and every line or list item whose whole text is one path
 * (bare or as code). A path mentioned inside a sentence is not a reference.
 */
export function sectionReferences(text: string): string[] {
  const found: string[] = [];
  for (const { line, kind } of markdownLines(text)) {
    if (kind !== "text") continue;
    const targets = linkTargets(line);
    found.push(...targets);
    if (targets.length > 0) continue;
    const whole = line
      .replace(LIST_MARKER, "")
      .trim()
      .replace(/^`(.*)`$/, "$1");
    if (whole !== "" && pathLike(whole)) found.push(whole);
  }
  return [...new Set(found)];
}

/** Every link target and path-like code span anywhere in the body. */
export function bodyMentions(body: string): string[] {
  const found: string[] = [];
  for (const { line, kind } of markdownLines(body)) {
    if (kind !== "text") continue;
    found.push(...linkTargets(line));
    for (const m of line.matchAll(CODE_SPAN))
      if (pathLike(m[1] ?? "")) found.push(m[1] ?? "");
  }
  return [...new Set(found)];
}

/** A reference written as a repository path: separators made `/`, anchor and query dropped. */
function asPath(reference: string): string {
  let path = reference.replace(/\\/g, "/");
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  try {
    path = decodeURI(path);
  } catch (err) {
    swallow(err, "a malformed percent escape is read as written");
  }
  return path;
}

function isWebLink(reference: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)
  );
}

function isAbsolutePath(path: string): boolean {
  return (
    path.startsWith("/") || path.startsWith("~") || /^[a-z]:\//i.test(path)
  );
}

function matches(adapter: SpecAdapter, path: string): boolean {
  const bare = path.replace(/\/$/, "");
  return adapter.patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern.replace(/\/$/, ""));
    return glob.match(bare);
  });
}

/** The first adapter, in order, whose patterns claim `path` as written. */
export function claimant(
  adapters: readonly SpecAdapter[],
  reference: string,
): SpecAdapter | null {
  if (isWebLink(reference)) return null;
  const path = posix.normalize(asPath(reference)).replace(/^\.\//, "");
  return adapters.find((a) => matches(a, path)) ?? null;
}

/** A path that passed every check but the adapter claim. */
export interface CheckedPath {
  ok: true;
  /** Relative to the root, `/`-separated; a folder ends in `/`. */
  ref: string;
  /** The real, absolute location. */
  path: string;
  directory: boolean;
}

export type Refused = { ok: false; reason: string };

export type Checked = (CheckedPath & { adapter: SpecAdapter }) | Refused;

function refused(reason: string): Refused {
  return { ok: false, reason };
}

function inside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return null;
  return rel.split(sep).join("/");
}

/** Whether Git ignores `rel` in `root`; `null` when Git could not say. */
function ignored(root: string, rel: string): boolean | null {
  const run = spawnSync("git", ["check-ignore", "-q", "--", rel], {
    cwd: root,
    env: withoutLeakyGitEnv(),
    timeout: 10_000,
  });
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  return null;
}

/**
 * Check one path before anything reads it, in this order: a web link, an
 * absolute path, a path whose `..` leaves the root, a path that does not
 * exist, a real path (symbolic links followed) outside the root or at the
 * root itself, a path Git ignores. The first that applies refuses it with
 * that reason.
 */
export function checkPath(
  reference: string,
  root: string,
): CheckedPath | Refused {
  if (isWebLink(reference)) return refused("web link, not fetched");
  const path = asPath(reference);
  if (isAbsolutePath(path)) return refused("absolute path");
  const normal = posix.normalize(path).replace(/^\.\//, "");
  if (normal === ".." || normal.startsWith("../"))
    return refused("leaves the repository");
  const realRoot = realpathSync.native(root);
  const candidate = join(realRoot, normal);
  try {
    lstatSync(candidate);
  } catch (err) {
    swallow(
      err,
      "a reference that cannot be inspected is reported as not found",
    );
    return refused("not found");
  }
  let real: string;
  try {
    real = realpathSync.native(candidate);
  } catch (err) {
    swallow(err, "a link whose target is missing is reported as not found");
    return refused("not found");
  }
  const rel = inside(realRoot, real);
  if (rel === null) return refused("symbolic link out of the repository");
  if (rel === "") return refused("no adapter claims it");
  const verdict = ignored(realRoot, rel);
  if (verdict === null)
    return refused("Git could not say whether it is ignored");
  if (verdict) return refused("ignored by Git");
  const directory = statSync(real).isDirectory();
  return { ok: true, ref: directory ? `${rel}/` : rel, path: real, directory };
}

/**
 * Check one reference: every check of `checkPath`, then whether an enabled
 * adapter's patterns claim it.
 */
export function checkReference(
  reference: string,
  root: string,
  adapters: readonly SpecAdapter[],
): Checked {
  const checked = checkPath(reference, root);
  if (!checked.ok) return checked;
  const adapter = adapters.find((a) => matches(a, checked.ref));
  if (!adapter) return refused("no adapter claims it");
  return { ...checked, adapter };
}
