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
 * default branch's values. The commits and files are read in one request
 * pinned to the head (`trusted-automation-read.ts`), only for a pull request
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
  if (value === undefined || value === null) return ok(null);
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

/** The first commit no rule allows, in words; `null` when every commit is allowed. */
function foreignCommit(
  commits: readonly AutomationCommit[],
  entry: TrustedAuthor,
): string | null {
  for (const c of commits) {
    const login = trustedLogin(c.login);
    if (login === "") return `commit ${short(c.sha)} has no linked author`;
    if (login === entry.login) {
      if (entry.signed && !c.verified)
        return `commit ${short(c.sha)} by ${entry.login} carries no valid signature`;
      continue;
    }
    if (!entry.committers.includes(login))
      return `commit ${short(c.sha)} is by ${c.login}`;
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
  const type = updateTypeOf(files);
  if (!type.ok)
    return failed(
      "fail",
      `its update type does not read: ${type.failure.reason}`,
    );
  if (!allowed.includes(type.value))
    return failed(
      "fail",
      `its update type is ${type.value}, outside ${allowed.join(", ")}`,
    );
  return ok(`, a ${type.value} update`);
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

/** A version range's numbers: an operator, and major, minor and patch. */
interface Version {
  ranged: boolean;
  parts: [number, number, number];
}

const VERSION =
  /^(\^|~|>=|>|<=|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function versionOf(text: string): Version | null {
  const m = VERSION.exec(text.trim());
  if (m === null) return null;
  const op = m[1] ?? "";
  return {
    ranged: op !== "" && op !== "=",
    parts: [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)],
  };
}

/** One dependency's update type, from its range before and after. */
function typeOfChange(before: string, after: string): UpdateType | null {
  const a = versionOf(before);
  const b = versionOf(after);
  if (a === null || b === null) return null;
  const [a1, a2, a3] = a.parts;
  const [b1, b2, b3] = b.parts;
  if (a1 !== b1) return "major";
  if (a2 !== b2) return "minor";
  if (a3 !== b3) return "patch";
  return a.ranged && !b.ranged ? "pin" : null;
}

const PAIR = /^([-+])\s*"([^"]+)"\s*:\s*"([^"]*)"\s*,?\s*$/;

function isDiffChangeLine(line: string): boolean {
  return (
    (line.startsWith("-") || line.startsWith("+")) &&
    !line.startsWith("---") &&
    !line.startsWith("+++")
  );
}

/** Removed and added key-version maps from a manifest patch. */
function diffPairs(
  patch: string,
): Outcome<
  { removed: Map<string, string>; added: Map<string, string> },
  "unread"
> {
  const removed = new Map<string, string>();
  const added = new Map<string, string>();
  for (const line of patch.split("\n")) {
    if (!isDiffChangeLine(line)) continue;
    const m = PAIR.exec(line);
    if (m === null)
      return failed("unread", "a changed line is not a key and its version");
    (m[1] === "-" ? removed : added).set(m[2] ?? "", m[3] ?? "");
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
    const before = removed.get(key);
    const after = added.get(key);
    if (before === undefined || after === undefined)
      return failed("unread", `${key} is added or removed, not updated`);
    if (before !== after) changes.push([key, before, after]);
  }
  return ok(changes);
}

function largerType(a: UpdateType, b: UpdateType): UpdateType {
  return UPDATE_TYPES.indexOf(b) > UPDATE_TYPES.indexOf(a) ? b : a;
}

/** One manifest file's largest update type, or `null` for a lockfile. */
function fileUpdateType(
  f: AutomationFile,
  lockfiles: ReadonlySet<string>,
): Outcome<UpdateType | null, "unread"> {
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
  let largest: UpdateType = "lockfile";
  for (const [key, before, after] of changes.value) {
    const type = typeOfChange(before, after);
    if (type === null)
      return failed(
        "unread",
        `${f.path}: ${key} goes from ${before} to ${after}, which is not a version update`,
      );
    largest = largerType(largest, type);
  }
  return ok(largest);
}

/**
 * The largest update type a change shows: from each manifest diff's
 * dependency ranges, or `lockfile` when only lockfiles changed. Anything
 * else (another manifest, a range that is not a version, a dependency added
 * or removed, a manifest with no diff) does not read.
 */
export function updateTypeOf(
  files: readonly AutomationFile[],
): Outcome<UpdateType, "unread"> {
  const lockfiles = new Set(LOCKFILE_NAMES);
  let largest: UpdateType = "lockfile";
  for (const f of files) {
    const type = fileUpdateType(f, lockfiles);
    if (!type.ok) return type;
    if (type.value !== null) largest = largerType(largest, type.value);
  }
  return ok(largest);
}

/** The most commits and files one compare answer lists; a longer pull request does not read whole. */
const COMPARE_COMMITS = 250;
const COMPARE_FILES = 300;

function parseCommit(c: unknown): Outcome<AutomationCommit, "unreadable"> {
  if (!isRecord(c) || typeof c.sha !== "string")
    return failed("unreadable", "a commit of the compare answer has no sha");
  const author = isRecord(c.author) ? c.author.login : undefined;
  const commit = isRecord(c.commit) ? c.commit : {};
  const verification = isRecord(commit.verification) ? commit.verification : {};
  return ok({
    sha: c.sha,
    login: typeof author === "string" ? author : "",
    verified: verification.verified === true,
  });
}

function parseFile(f: unknown): Outcome<AutomationFile, "unreadable"> {
  if (!isRecord(f) || typeof f.filename !== "string")
    return failed("unreadable", "a file of the compare answer has no name");
  const manifest = f.filename.split("/").at(-1) === MANIFEST;
  return ok({
    path: f.filename,
    previous:
      typeof f.previous_filename === "string" ? f.previous_filename : null,
    patch: manifest && typeof f.patch === "string" ? f.patch : null,
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

/** The compare answer's commits and files, or why they do not read whole. */
export function parseCompare(
  answer: unknown,
  head: string,
): Outcome<AutomationFacts, "unreadable"> {
  if (!isRecord(answer) || !Array.isArray(answer.commits))
    return failed("unreadable", "the compare answer holds no commits");
  if (!Array.isArray(answer.files))
    return failed("unreadable", "the compare answer holds no files");
  const total = answer.total_commits;
  if (
    typeof total !== "number" ||
    total !== answer.commits.length ||
    total >= COMPARE_COMMITS
  )
    return failed("unreadable", "more commits than one read holds");
  if (answer.files.length >= COMPARE_FILES)
    return failed("unreadable", "more files than one read holds");
  const commits = parseList(answer.commits, parseCommit);
  if (!commits.ok) return commits;
  if (commits.value.at(-1)?.sha !== head)
    return failed("unreadable", "the compare answer does not end at the head");
  const files = parseList(answer.files, parseFile);
  if (!files.ok) return files;
  return ok({ head, commits: commits.value, files: files.value });
}
