/**
 * Trusted automation (`pull_requests.trusted_automation`): the bots whose
 * converged pull requests count as the repository's own for the Ready
 * predicate's condition 8 (`merge-ready.ts`), under rules that keep the
 * class narrow (design/dispatch-board.md § Ready, exactly).
 *
 * A pull request by a listed bot meets condition 8 only when every rule
 * holds, each read from the forge and failing closed when it does not read:
 *
 * 1. its head is in the repository, not a fork;
 * 2. every commit's author, as the forge links it, is the bot (with a valid
 *    signature unless the entry says `signed: false`) or one of the entry's
 *    committers (by default the people `dispatch.adopt.authors` names, whose
 *    sessions push a drive's repairs);
 * 3. every changed file, and every renamed file's old path, is within the
 *    entry's `paths` (by default the JavaScript dependency manifests and
 *    lockfiles);
 * 4. where `update_types` is set, the update type the manifest diff shows is
 *    one of them.
 *
 * The list is read from the repository's configuration on its default
 * branch, never from the pull request's own copy: every caller passes the
 * default branch's values. The commits and files are read from the pull
 * request's own listings, pinned to the head (`trusted-automation-read.ts`), only for a pull request
 * whose author is listed.
 */
import { isRecord, isStringArray } from "../../../../shared/guards.ts";
import { globProblem, matchesGlob } from "../../../../shared/glob.ts";
import { failed, ok, type Outcome } from "../../../../shared/outcome.ts";
import { LOCKFILE_NAMES } from "../../../../shared/detect/lockfiles.ts";

/** The update types a manifest diff can show, from the smallest change to the largest. */
export const UPDATE_TYPES = [
  "lockfile",
  "pin",
  "patch",
  "minor",
  "major",
] as const;
export type UpdateType = (typeof UPDATE_TYPES)[number];

/** The manifests whose diff tells an update's type. */
const MANIFEST = "package.json";

/** The paths a listed bot may change when its entry names none: the dependency manifests and lockfiles. */
export const DEFAULT_TRUSTED_PATHS: readonly string[] = /* @__PURE__ */ [
  MANIFEST,
  ...LOCKFILE_NAMES,
].flatMap((name) => [name, `**/${name}`]);

/** One listed bot, its rules resolved. */
export interface TrustedAuthor {
  /** The bot's login as the forge links a commit to it, case folded: `renovate[bot]`. */
  login: string;
  paths: readonly string[];
  /** Whether `paths` is the default. */
  defaultPaths: boolean;
  /** The update types allowed; `null` when the entry sets none. */
  updateTypes: readonly UpdateType[] | null;
  /** Whether each of the bot's commits must carry a valid signature. */
  signed: boolean;
  /** The other logins whose commits are allowed, case folded. */
  committers: readonly string[];
}

/** The trusted list, or why it does not read; the list is empty where the setting is absent. */
export type TrustedList = Outcome<TrustedAuthor[], "invalid">;

const ENTRY_KEYS = /* @__PURE__ */ new Set([
  "login",
  "paths",
  "update_types",
  "signed",
  "committers",
]);

/** A login as the trusted list compares it: case folded, a GitHub App's `app/<name>` as `<name>[bot]`. */
export function trustedLogin(login: string): string {
  const folded = login.trim().toLowerCase();
  return folded.startsWith("app/") ? `${folded.slice(4)}[bot]` : folded;
}

/** A pull request's author as the board reads it: a bot's `login` as its commits name it, `<name>[bot]`. */
export function authorLogin(typename: string, login: string): string {
  if (login === "") return "";
  return typename === "Bot" && !login.endsWith("[bot]")
    ? `${login}[bot]`
    : login;
}

const isBotLogin = (login: string) => trustedLogin(login).endsWith("[bot]");

/** The people `dispatch.adopt.authors` names, the default committers. */
function adoptPeople(values: Record<string, unknown>): string[] {
  const dispatch = values.dispatch;
  const adopt = isRecord(dispatch) ? dispatch.adopt : undefined;
  const authors = isRecord(adopt) ? adopt.authors : undefined;
  return isStringArray(authors)
    ? authors.filter((a) => !isBotLogin(a)).map(trustedLogin)
    : [];
}

function invalid(reason: string) {
  return failed("invalid", `pull_requests.trusted_automation ${reason}`);
}

/** One entry's list field: a nonempty list of nonempty strings, or absent. */
function listField(
  raw: Record<string, unknown>,
  key: string,
  at: string,
): Outcome<string[] | null, "invalid"> {
  const value = raw[key];
  if (value === undefined) return ok(null);
  if (
    !isStringArray(value) ||
    value.length === 0 ||
    value.some((v) => v.trim() === "")
  )
    return failed(
      "invalid",
      `pull_requests.trusted_automation${at}.${key} must be a nonempty list of nonempty strings`,
    );
  return ok(value);
}

function parsePaths(
  raw: Record<string, unknown>,
  at: string,
): Outcome<string[] | null, "invalid"> {
  const paths = listField(raw, "paths", at);
  if (!paths.ok) return paths;
  const badGlob = (paths.value ?? [])
    .map((p) => [p, globProblem(p)] as const)
    .find(([, problem]) => problem !== null);
  return badGlob === undefined
    ? paths
    : invalid(`${at}.paths: ${badGlob[0]}: ${badGlob[1]}`);
}

function parseUpdateTypes(
  raw: Record<string, unknown>,
  at: string,
): Outcome<UpdateType[] | null, "invalid"> {
  const types = listField(raw, "update_types", at);
  if (!types.ok) return types;
  const unknownType = (types.value ?? []).find(
    (t) => !(UPDATE_TYPES as readonly string[]).includes(t),
  );
  return unknownType === undefined
    ? ok(types.value as UpdateType[] | null)
    : invalid(
        `${at}.update_types: ${unknownType} is not one of ${UPDATE_TYPES.join(", ")}`,
      );
}

function entryMapping(
  value: unknown,
  at: string,
): Outcome<Record<string, unknown>, "invalid"> {
  if (typeof value === "string") return ok({ login: value });
  if (!isRecord(value)) return invalid(`${at} must be a login or a mapping`);
  const unknown = Object.keys(value).filter((k) => !ENTRY_KEYS.has(k));
  return unknown.length > 0
    ? invalid(`${at} has unknown keys: ${unknown.join(", ")}`)
    : ok(value);
}

function parseBotLogin(
  raw: Record<string, unknown>,
  at: string,
): Outcome<string, "invalid"> {
  const login = typeof raw.login === "string" ? trustedLogin(raw.login) : "";
  return /^[a-z0-9][a-z0-9._-]*\[bot\]$/.test(login)
    ? ok(login)
    : invalid(
        `${at}.login must be a bot's login, as <name>[bot] or app/<name>`,
      );
}

function parseSigned(
  raw: Record<string, unknown>,
  at: string,
): Outcome<boolean, "invalid"> {
  if (raw.signed === undefined) return ok(true);
  return typeof raw.signed === "boolean"
    ? ok(raw.signed)
    : invalid(`${at}.signed must be true or false`);
}

function entryOf(
  value: unknown,
  index: number,
  people: readonly string[],
): Outcome<TrustedAuthor, "invalid"> {
  const at = `[${index}]`;
  const mapped = entryMapping(value, at);
  if (!mapped.ok) return mapped;
  const raw = mapped.value;
  const login = parseBotLogin(raw, at);
  if (!login.ok) return login;
  const paths = parsePaths(raw, at);
  if (!paths.ok) return paths;
  const types = parseUpdateTypes(raw, at);
  if (!types.ok) return types;
  const signed = parseSigned(raw, at);
  if (!signed.ok) return signed;
  const committers = listField(raw, "committers", at);
  if (!committers.ok) return committers;
  return ok({
    login: login.value,
    paths: paths.value ?? DEFAULT_TRUSTED_PATHS,
    defaultPaths: paths.value === null,
    updateTypes: types.value,
    signed: signed.value,
    committers: committers.value?.map(trustedLogin) ?? people,
  });
}

/** `pull_requests.trusted_automation` of a repository's configuration values on its default branch. */
export function trustedAutomationOf(
  values: Record<string, unknown>,
): TrustedList {
  const section = values.pull_requests;
  if (section === undefined || section === null) return ok([]);
  if (!isRecord(section)) return ok([]);
  const list = section.trusted_automation;
  if (list === undefined || list === null) return ok([]);
  if (!Array.isArray(list)) return invalid("must be a list");
  const people = adoptPeople(values);
  const entries: TrustedAuthor[] = [];
  for (const [i, value] of list.entries()) {
    const entry = entryOf(value, i, people);
    if (!entry.ok) return entry;
    if (entries.some((e) => e.login === entry.value.login))
      return invalid(`[${i}] lists ${entry.value.login} a second time`);
    entries.push(entry.value);
  }
  return ok(entries);
}

/** One commit of a pull request's head, as the forge links its author. */
export interface AutomationCommit {
  sha: string;
  /** The author's login, `""` where the forge links none. */
  login: string;
  /** The committer's login, `""` where the forge links none. */
  committer: string;
  verified: boolean;
}

/** One changed file. */
export interface AutomationFile {
  path: string;
  /** A renamed file's old path. */
  previous: string | null;
  /** The diff, for a manifest only; `null` where the forge gives none. */
  patch: string | null;
}

/** A listed bot's pull request's commits and files, read at one head. */
export interface AutomationFacts {
  head: string;
  commits: AutomationCommit[];
  files: AutomationFile[];
}

/** What the rules read of one pull request. */
export interface TrustInput {
  head: string;
  /** Its author's login as `authorLogin` gives it. */
  author?: string;
  /** Whether its head is in a fork; `null` or absent when not read. */
  crossRepository?: boolean | null;
  /** Its commits and files, or why they did not read; absent when not read. */
  automation?: Outcome<AutomationFacts, "unreadable">;
}

/** A trusted bot's verdict: whether its pull request is the repository's own, with the fact behind it. */
export interface TrustVerdict {
  met: boolean;
  fact: string;
}

/** The listed entry for a pull request's author; `null` when the author is not listed. */
export function trustedEntryFor(
  author: string | undefined,
  list: readonly TrustedAuthor[],
): TrustedAuthor | null {
  if (author === undefined || author === "") return null;
  const login = trustedLogin(author);
  return list.find((e) => e.login === login) ?? null;
}

const short = (sha: string) => sha.slice(0, 7);

/**
 * The first commit no rule allows, in words; `null` when every commit is allowed.
 * A signature binds a commit to its account only when the forge also links the
 * committer to that account, so a signed commit counts for a login only when
 * it is verified and its committer is that login.
 */
function foreignCommit(
  commits: readonly AutomationCommit[],
  entry: TrustedAuthor,
): string | null {
  for (const c of commits) {
    const login = trustedLogin(c.login);
    if (login === "") return `commit ${short(c.sha)} has no linked author`;
    const own = login === entry.login;
    if (!own && !entry.committers.includes(login))
      return `commit ${short(c.sha)} is by ${c.login}`;
    if (!entry.signed) continue;
    if (!c.verified)
      return `commit ${short(c.sha)} by ${c.login} carries no valid signature`;
    if (trustedLogin(c.committer) !== login)
      return `commit ${short(c.sha)} by ${c.login} is signed for another committer (${c.committer === "" ? "none linked" : c.committer})`;
  }
  return null;
}

/** The first path outside the entry's paths; `null` when every path is within them. */
function outsidePath(
  files: readonly AutomationFile[],
  entry: TrustedAuthor,
): string | null {
  for (const f of files)
    for (const path of f.previous === null ? [f.path] : [f.path, f.previous])
      if (!entry.paths.some((glob) => matchesGlob(path, glob))) return path;
  return null;
}

/** Verified commits and files for `input`, or the reason the read does not pass. */
function factsFor(input: TrustInput): Outcome<AutomationFacts, "fail"> {
  if (input.crossRepository !== false)
    return failed(
      "fail",
      input.crossRepository === true
        ? "its head is in a fork"
        : "whether its head is in a fork did not read",
    );
  const read = input.automation;
  if (read === undefined)
    return failed("fail", "its commits and files were not read");
  if (!read.ok)
    return failed(
      "fail",
      `its commits and files did not read: ${read.failure.reason}`,
    );
  const facts = read.value;
  if (facts.head !== input.head)
    return failed(
      "fail",
      `its commits and files were read at ${short(facts.head)}, not at ${short(input.head)}`,
    );
  return facts.commits.length === 0
    ? failed("fail", "it has no commits")
    : ok(facts);
}

/** Update-type suffix when `allowed` is set, or why the files fail it. */
function updateKind(
  files: readonly AutomationFile[],
  allowed: readonly UpdateType[] | null,
): Outcome<string, "fail"> {
  if (allowed === null) return ok("");
  const types = updateTypeSetOf(files);
  if (!types.ok)
    return failed(
      "fail",
      `its update type does not read: ${types.failure.reason}`,
    );
  const outside = UPDATE_TYPES.find(
    (t) => types.value.has(t) && !allowed.includes(t),
  );
  if (outside !== undefined)
    return failed(
      "fail",
      `it holds a ${outside} update, outside ${allowed.join(", ")}`,
    );
  const shown = UPDATE_TYPES.filter((t) => types.value.has(t));
  return ok(`, ${shown.join(" and ")} update${shown.length === 1 ? "" : "s"}`);
}

/** Whether a pull request by a listed bot is the repository's own (see the module comment). */
export function trustVerdict(
  input: TrustInput,
  entry: TrustedAuthor,
): TrustVerdict {
  const fail = (why: string): TrustVerdict => ({
    met: false,
    fact: `${entry.login} is trusted automation, but ${why}`,
  });
  const read = factsFor(input);
  if (!read.ok) return fail(read.failure.reason);
  const facts = read.value;
  const commit = foreignCommit(facts.commits, entry);
  if (commit !== null) return fail(commit);
  const path = outsidePath(facts.files, entry);
  if (path !== null) return fail(`${path} is outside its paths`);
  const kind = updateKind(facts.files, entry.updateTypes);
  if (!kind.ok) return fail(kind.failure.reason);
  const n = facts.commits.length;
  const m = facts.files.length;
  return {
    met: true,
    fact: `trusted automation ${entry.login}: same repository, ${n} commit${n === 1 ? "" : "s"} allowed, ${m} file${m === 1 ? "" : "s"} within its paths${kind.value}`,
  };
}

/** A version range's numbers: its operator, whether all three parts are written, and major, minor and patch. */
interface Version {
  op: string;
  full: boolean;
  parts: [number, number, number];
}

const VERSION =
  /^(\^|~|>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function versionOf(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (m === null) return null;
  const op = m[1] === "=" ? "" : (m[1] ?? "");
  return {
    op,
    full: m[3] !== undefined && m[4] !== undefined,
    parts: [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)],
  };
}

const compareParts = (a: Version, b: Version): number =>
  a.parts[0] - b.parts[0] || a.parts[1] - b.parts[1] || a.parts[2] - b.parts[2];

/**
 * One dependency's update type, from its range before and after: `null`
 * where the change is not one the policy can classify (a range operator that
 * changes with the numbers, a decrease, a pin to a partial version).
 */
function typeOfChange(before: string, after: string): UpdateType | null {
  const a = versionOf(before);
  const b = versionOf(after);
  if (a === null || b === null) return null;
  const order = compareParts(a, b);
  if (order > 0) return null;
  if (order === 0) return pinOf(a, b);
  if (a.op !== b.op) return null;
  if (a.parts[0] !== b.parts[0]) return "major";
  return a.parts[1] !== b.parts[1] ? "minor" : "patch";
}

/** A range made exact at the same numbers, with all three parts written. */
const pinOf = (a: Version, b: Version): UpdateType | null =>
  a.op !== "" && b.op === "" && b.full ? "pin" : null;

const PAIR = /^([-+])(\s*)"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;
const OPENER = /^[-+ ](\s*)"([^"]+)"\s*:\s*\{\s*$/;

/** The manifest sections that hold dependency ranges. */
const DEPENDENCY_SECTIONS: ReadonlySet<string> = /* @__PURE__ */ new Set([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/** The indentation at which a key sits inside a section: deeper than the top level's two spaces or one tab. */
const NESTED = /^( {3,}|\t{2,}| +\t|\t+ )/;

function isDiffChangeLine(line: string): boolean {
  return (
    (line.startsWith("-") || line.startsWith("+")) &&
    !line.startsWith("---") &&
    !line.startsWith("+++")
  );
}

type Pairs = Map<string, string>;

/** One changed line as a dependency's key and version, or why it is not one. */
function changedPair(
  line: string,
  section: string | null,
): Outcome<{ side: string; name: string; version: string }, "unread"> {
  const m = PAIR.exec(line);
  if (m === null)
    return failed("unread", "a changed line is not a key and its version");
  const name = m[3] ?? "";
  if (!NESTED.test(m[2] ?? ""))
    return failed("unread", `${name} is not inside a dependency section`);
  if (section !== null && !DEPENDENCY_SECTIONS.has(section))
    return failed(
      "unread",
      `${name} is in ${section}, not a dependency section`,
    );
  return ok({ side: m[1] ?? "", name, version: m[4] ?? "" });
}

/**
 * Removed and added key-version maps from a manifest patch. A key counts only
 * as a dependency: nested below the manifest's top level, and, where the
 * patch shows the section it sits in, in one of the dependency sections.
 * Keys are kept apart by that section, and a key the patch changes twice in
 * one section, or twice with the section unseen, is ambiguous.
 */
function diffPairs(
  patch: string,
): Outcome<{ removed: Pairs; added: Pairs }, "unread"> {
  const removed: Pairs = new Map();
  const added: Pairs = new Map();
  let section: string | null = null;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) section = null;
    else section = OPENER.exec(line)?.[2] ?? section;
    if (!isDiffChangeLine(line)) continue;
    const pair = changedPair(line, section);
    if (!pair.ok) return pair;
    const { side, name, version } = pair.value;
    const target = side === "-" ? removed : added;
    const key = `${section ?? ""}\u0000${name}`;
    if (target.has(key))
      return failed(
        "unread",
        `${name} changes more than once and is ambiguous`,
      );
    target.set(key, version);
  }
  return ok({ removed, added });
}

/** The dependency changes one manifest diff shows: each key's value before and after. */
function changesOf(
  patch: string,
): Outcome<Array<[string, string, string]>, "unread"> {
  const parsed = diffPairs(patch);
  if (!parsed.ok) return parsed;
  const { removed, added } = parsed.value;
  const changes: Array<[string, string, string]> = [];
  for (const key of new Set([...removed.keys(), ...added.keys()])) {
    const name = key.split("\u0000")[1] ?? key;
    const before = removed.get(key);
    const after = added.get(key);
    if (before === undefined || after === undefined)
      return failed("unread", `${name} is added or removed, not updated`);
    if (before !== after) changes.push([name, before, after]);
  }
  return ok(changes);
}

/** One manifest file's update types, or `null` for a lockfile. */
function fileUpdateTypes(
  f: AutomationFile,
  lockfiles: ReadonlySet<string>,
): Outcome<Set<UpdateType> | null, "unread"> {
  const name = f.path.split("/").at(-1) ?? "";
  if (lockfiles.has(name)) return ok(null);
  if (name !== MANIFEST)
    return failed("unread", `${f.path} is not a manifest whose diff it reads`);
  if (f.patch === null)
    return failed("unread", `the forge gives no diff of ${f.path}`);
  const changes = changesOf(f.patch);
  if (!changes.ok)
    return failed("unread", `${f.path}: ${changes.failure.reason}`);
  if (changes.value.length === 0)
    return failed("unread", `${f.path} changes no dependency's version`);
  const types = new Set<UpdateType>();
  for (const [key, before, after] of changes.value) {
    const type = typeOfChange(before, after);
    if (type === null)
      return failed(
        "unread",
        `${f.path}: ${key} goes from ${before} to ${after}, which is not a version update the policy can classify`,
      );
    types.add(type);
  }
  return ok(types);
}

/**
 * Every update type a change shows: each dependency's, from the manifest
 * diffs, or `lockfile` when only lockfiles changed. Anything else (another
 * manifest, a range that is not a version, a dependency added or removed, a
 * manifest with no diff) does not read.
 */
export function updateTypeSetOf(
  files: readonly AutomationFile[],
): Outcome<Set<UpdateType>, "unread"> {
  const lockfiles = new Set(LOCKFILE_NAMES);
  const types = new Set<UpdateType>();
  for (const f of files) {
    const own = fileUpdateTypes(f, lockfiles);
    if (!own.ok) return own;
    for (const t of own.value ?? []) types.add(t);
  }
  return ok(types.size === 0 ? new Set<UpdateType>(["lockfile"]) : types);
}

/** The largest update type a change shows (`updateTypeSetOf`). */
export function updateTypeOf(
  files: readonly AutomationFile[],
): Outcome<UpdateType, "unread"> {
  const types = updateTypeSetOf(files);
  if (!types.ok) return types;
  return ok(
    UPDATE_TYPES.filter((t) => types.value.has(t)).at(-1) ?? "lockfile",
  );
}

/** The entries one listing page holds; a pull request with as many does not read whole. */
export const LISTING_PAGE = 100;

function parseCommit(c: unknown): Outcome<AutomationCommit, "unreadable"> {
  if (!isRecord(c) || typeof c.sha !== "string")
    return failed("unreadable", "a commit of the listing has no sha");
  const author = isRecord(c.author) ? c.author.login : undefined;
  const committer = isRecord(c.committer) ? c.committer.login : undefined;
  const commit = isRecord(c.commit) ? c.commit : {};
  const verification = isRecord(commit.verification) ? commit.verification : {};
  return ok({
    sha: c.sha,
    login: typeof author === "string" ? author : "",
    committer: typeof committer === "string" ? committer : "",
    verified: verification.verified === true,
  });
}

/**
 * A manifest patch reduced to what the rules read: hunk markers, changed
 * lines and the lines that open an object, so the raw diff is not kept.
 */
function compactPatch(patch: string): string {
  return patch
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("@@") || isDiffChangeLine(line) || OPENER.test(line),
    )
    .join("\n");
}

/** Why a file record's status and previous name do not read; `null` when they do. */
function statusProblem(
  name: string,
  f: Record<string, unknown>,
): string | null {
  if (typeof f.status !== "string") return `${name} has no status`;
  const moved = f.status === "renamed" || f.status === "copied";
  return moved &&
    (typeof f.previous_filename !== "string" || f.previous_filename === "")
    ? `${name} is ${f.status} with no previous name`
    : null;
}

function parseFile(f: unknown): Outcome<AutomationFile, "unreadable"> {
  if (!isRecord(f) || typeof f.filename !== "string")
    return failed("unreadable", "a file of the listing has no name");
  const problem = statusProblem(f.filename, f);
  if (problem !== null) return failed("unreadable", problem);
  const manifest = f.filename.split("/").at(-1) === MANIFEST;
  return ok({
    path: f.filename,
    previous:
      typeof f.previous_filename === "string" ? f.previous_filename : null,
    patch:
      manifest && typeof f.patch === "string" ? compactPatch(f.patch) : null,
  });
}

function parseList<T>(
  items: readonly unknown[],
  parse: (item: unknown) => Outcome<T, "unreadable">,
): Outcome<T[], "unreadable"> {
  const out: T[] = [];
  for (const item of items) {
    const parsed = parse(item);
    if (!parsed.ok) return parsed;
    out.push(parsed.value);
  }
  return ok(out);
}

/** The pull request's commit and file listings, or why they do not read whole. */
export function parseListings(
  commitList: unknown,
  fileList: unknown,
  head: string,
): Outcome<AutomationFacts, "unreadable"> {
  if (!Array.isArray(commitList))
    return failed("unreadable", "the commit listing holds no commits");
  if (!Array.isArray(fileList))
    return failed("unreadable", "the file listing holds no files");
  if (commitList.length >= LISTING_PAGE)
    return failed("unreadable", "more commits than one read holds");
  if (fileList.length >= LISTING_PAGE)
    return failed("unreadable", "more files than one read holds");
  if (fileList.length === 0)
    return failed("unreadable", "the file listing lists no changed file");
  const commits = parseList(commitList, parseCommit);
  if (!commits.ok) return commits;
  if (commits.value.at(-1)?.sha !== head)
    return failed("unreadable", "the commit listing does not end at the head");
  const files = parseList(fileList, parseFile);
  if (!files.ok) return files;
  return ok({ head, commits: commits.value, files: files.value });
}
