/**
 * The repository's clone, made where Orca runs when Orca does not have it.
 *
 * A machine that is meant to hold every repository of an organization
 * (an always-on Orca server, say) is rarely kept complete by hand: a new
 * repository, or one nobody opened there yet, is missing until someone
 * clones it and adds it to Orca. With a clone source, `open` does that
 * itself: when Orca has no repository by the name, it clones the source
 * into `<root>/<name>` on the clone's machine, adds that clone to Orca, and
 * goes on with the open.
 *
 * Several opens of one missing repository may run at once, so the clone is
 * made under a claim, as the create hook is run (hooks.ts): the open whose
 * `mkdir` creates `<root>/.<name>.jig-orca-clone` clones and adds it, and the
 * others wait until Orca has the repository. A directory already at the
 * clone's path is added only when it is the top of a clone of the same
 * source; anything else there stops the open, for a person to look at. A
 * clone that did not end on its own keeps its claim, since git may still be
 * writing on the clone's machine. Messages show the source with its
 * credentials hidden.
 */
import { posix } from "node:path";
import { budget, output, withLimit } from "../herdr/runner.ts";
import { onServer, orcaCall, orcaErrorText } from "./cli.ts";
import { failureReason, inspectPath, releaseClaim } from "./hooks.ts";
import { OrcaError, WAIT_POLL_MS, type Workspace } from "./runner.ts";

/** Where a missing repository is cloned from, and the directory its clone goes in. */
export interface CloneSource {
  /** What `git clone` clones, e.g. `git@github.com:acme/app.git`. */
  url: string;
  /** The directory on the clone's machine that holds the clone; absolute, or under `~/`. */
  root: string;
}

/** The time a clone may take: a large repository over a slow link. */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** The claim's name beside the clone: hidden, so a listing of the root shows clones only. */
export const cloneClaimName = (name: string): string =>
  `.${name}.jig-orca-clone`;

/** The shell script that prints the home directory of the clone's machine. */
export const HOME_SCRIPT = 'printf "%s" "$HOME"';

/** `root` as an absolute path on the clone's machine, `~/` read as its home directory. */
function absoluteRoot(ws: Workspace, root: string): string {
  if (posix.isAbsolute(root)) return posix.normalize(root);
  if (root !== "~" && !root.startsWith("~/"))
    throw new OrcaError(
      `the clone root ${root} must be an absolute path or start with ~/`,
    );
  const done = ws.host.run(["sh", "-c", HOME_SCRIPT]);
  const home = done.stdout;
  if (done.status !== 0 || !posix.isAbsolute(home))
    throw new OrcaError(
      `cannot read the home directory for the clone root ${root}: ${output(done)}`,
    );
  return posix.join(home, root.slice(1));
}

/** The repository Orca has by `name`, or null when it has none. */
function shown(ws: Workspace, name: string): unknown {
  const what = `orca repo show ${name}`;
  const envelope = orcaCall<{ repo?: unknown }>(
    ws,
    ["repo", "show", "--repo", `name:${name}`],
    what,
  );
  if (envelope.ok) return envelope.result?.repo;
  if (envelope.error.code === "repo_not_found") return null;
  throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
}

/**
 * The forms of clone source taken: `https://`, `ssh://` or `git://` with a
 * host and a path, an SSH `user@host:path`, or an absolute path on the
 * clone's machine. Anything else (another transport, an option, a bare word)
 * is refused before git sees it.
 */
const CLONE_URL_FORMS = [
  /^(https|ssh|git):\/\/([^/@\s]+@)?[A-Za-z0-9.-]+(:\d+)?\/[^\s]+$/,
  /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s/-][^\s]*$/,
  /^\/[^\s]+$/,
];

/** `url` with the credentials of a `scheme://user:secret@host` source hidden, for a message. */
export function redactUrl(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1***@");
}

/** Refuse a clone source that is not one of `CLONE_URL_FORMS`. */
function assertCloneUrl(url: string): void {
  if (!CLONE_URL_FORMS.some((form) => form.test(url)))
    throw new OrcaError(
      `the clone source ${redactUrl(url)} is not an https://, ssh:// or git:// URL, a user@host:path, or an absolute path`,
    );
}

/**
 * Whether `path` on the clone's machine is the top of a clone of `url`, read
 * from its `origin`. Git finds a repository in a parent directory too, so a
 * directory inside another clone of `url` is not taken for one.
 */
function isCloneOf(ws: Workspace, path: string, url: string): boolean {
  const prefix = ws.host.run(["git", "-C", path, "rev-parse", "--show-prefix"]);
  if (prefix.status !== 0 || prefix.stdout.trim() !== "") return false;
  const remote = ws.host.run([
    "git",
    "-C",
    path,
    "remote",
    "get-url",
    "origin",
  ]);
  return remote.status === 0 && remote.stdout.trim() === url;
}

/**
 * A clone that did not end on its own (its deadline, or a lost SSH session):
 * git may still be writing on the clone's machine, so its claim is kept.
 */
class CloneUnfinished extends OrcaError {}

/** Clone `source` to `path` unless a clone of it is there; refuse anything else there. */
function ensureClone(
  ws: Workspace,
  source: CloneSource,
  path: string,
  claim: string,
): void {
  const shownUrl = redactUrl(source.url);
  const kind = inspectPath(ws, path);
  if (kind === "directory") {
    if (isCloneOf(ws, path, source.url)) return;
    throw new OrcaError(
      `${path} is there but is not a clone of ${shownUrl}; move it away, or add it to Orca with orca repo add --path ${path}`,
    );
  }
  if (kind !== "absent")
    throw new OrcaError(
      `${path} is there but is not a directory; move it away and open again`,
    );
  ws.host.log(`… cloning ${shownUrl} into ${path}`);
  const cloned = ws.host.run(["git", "clone", "--", source.url, path], {
    timeoutMs: budget(ws.host, CLONE_TIMEOUT_MS),
  });
  const said = output(cloned).replaceAll(source.url, () => shownUrl);
  if (cloned.status === -1)
    throw new CloneUnfinished(
      `git clone ${shownUrl} ${path} did not finish (${said || "stopped"}); it may still be running on the clone's machine, so the claim ${claim} stays. Once no git clone of it runs there, remove ${path} and ${claim} and open again`,
    );
  if (cloned.status !== 0)
    throw new OrcaError(
      `git clone ${shownUrl} ${path} failed: ${said}; check that the machine can reach it without a prompt (an SSH key, a credential helper)`,
    );
}

/** Add the clone at `path` to Orca under the name it reads from the directory. */
function addToOrca(ws: Workspace, path: string): void {
  const what = `orca repo add ${path}`;
  const envelope = orcaCall(ws, ["repo", "add", "--path", path], what);
  if (!envelope.ok)
    throw new OrcaError(`${what}: ${orcaErrorText(envelope.error)}`);
  ws.host.log(`✓ added ${path} to Orca${onServer(ws.target)}`);
}

/**
 * Make the repository `name` known to Orca from `source`, once however many
 * opens reach it: clone and add it under the claim, or wait for the open
 * that holds the claim until Orca has the repository. Returns Orca's answer
 * for it, as `orca repo show` gives it.
 */
export function cloneMissingRepo(
  ws: Workspace,
  name: string,
  source: CloneSource,
  now: () => number = Date.now,
): unknown {
  if (name === "" || name === "." || name === ".." || name.includes("/"))
    throw new OrcaError(
      `the repository name ${name} cannot name a directory under the clone root`,
    );
  assertCloneUrl(source.url);
  const root = absoluteRoot(ws, source.root);
  const path = posix.join(root, name);
  const claim = posix.join(root, cloneClaimName(name));
  const made = ws.host.run(["mkdir", "-p", root]);
  if (made.status !== 0)
    throw new OrcaError(
      `cannot create the clone root ${root}: ${output(made)}`,
    );
  const taken = ws.host.run(["mkdir", claim]);
  if (taken.status !== 0) {
    if (failureReason(taken.stderr) !== "File exists")
      throw new OrcaError(
        `could not take the clone's claim ${claim}: ${output(taken)}`,
      );
    return awaitClone(ws, name, claim, now);
  }
  let already: unknown;
  try {
    // Read again under the claim: an open that held it before may have
    // added the repository between this open's first look and its claim.
    already = shown(ws, name);
    if (already === null) {
      ensureClone(ws, source, path, claim);
      addToOrca(ws, path);
    }
  } catch (error) {
    if (!(error instanceof CloneUnfinished))
      releaseClaim(ws, claim, "the clone's");
    throw error;
  }
  releaseClaim(ws, claim, "the clone's");
  if (already !== null) return already;
  const added = shown(ws, name);
  if (added === null)
    throw new OrcaError(
      `Orca${onServer(ws.target)} added ${path} but has no repository named ${name}; name the repository as orca repo list does`,
    );
  return added;
}

/**
 * Wait for the open that holds the claim until Orca has the repository, for
 * the clone's time limit at most: every look and pause is cut to what is
 * left of it, so slow looks cannot stretch the wait past it.
 */
function awaitClone(
  ws: Workspace,
  name: string,
  claim: string,
  now: () => number,
): unknown {
  ws.host.log(`… another open is cloning ${name}; waiting for it`);
  const deadline = now() + CLONE_TIMEOUT_MS;
  const waiting: Workspace = {
    ...ws,
    orca: withLimit(ws.orca, CLONE_TIMEOUT_MS, now),
    host: withLimit(ws.host, CLONE_TIMEOUT_MS, now),
  };
  try {
    for (;;) {
      waiting.host.sleep(WAIT_POLL_MS);
      const repo = shown(waiting, name);
      if (repo !== null) return repo;
      if (inspectPath(waiting, claim) !== "absent") continue;
      // The holder adds the repository before it gives the claim back, so a
      // claim gone since the look above may still have left it in Orca.
      const late = shown(waiting, name);
      if (late !== null) return late;
      throw new OrcaError(
        `the open that was cloning ${name} ended without adding it to Orca${onServer(ws.target)}; its output says why. Open again to retry`,
      );
    }
  } catch (error) {
    if (now() < deadline) throw error;
  }
  throw new OrcaError(
    `${name} was still being cloned after ${CLONE_TIMEOUT_MS / 60_000} minutes; if no open is cloning it, remove ${claim} and open again`,
  );
}
