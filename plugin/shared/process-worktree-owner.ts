/** Durable ownership of a checkout opened under shared collection admission. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { jigHome, isMapping } from "./config-layers.ts";
import { decodeIdentity, type ProcessIdentity } from "./liveness.ts";
import { errnoCode } from "./errors.ts";
import { attempt, failed, ok, type Outcome } from "./outcome.ts";

const PROCESS_WORKTREE_OWNER = "jig-process-owner.json";
export interface ProcessWorktreeOwner {
  version: 1;
  runtime: "process";
  repository: string;
  branch: string;
  launches: string[];
  processes: ProcessIdentity[];
}

/** Every clone has its own root, even when another clone has the same name. */
export function processWorktreeRoot(
  repository: string,
  home = jigHome(),
): string {
  const path = resolve(repository);
  const digest = createHash("sha256").update(path).digest("hex").slice(0, 12);
  const name = basename(path).replace(/[^a-zA-Z0-9._-]/g, "-");
  return join(home, "worktrees", `${name}-${digest}`);
}

export function decodeWorktreeOwner(text: string): ProcessWorktreeOwner | null {
  const parsed = attempt(
    "owner-json",
    "invalid owner JSON",
    () => JSON.parse(text) as unknown,
  );
  if (!parsed.ok) return null;
  const value = parsed.value;
  if (
    !isMapping(value) ||
    value.version !== 1 ||
    value.runtime !== "process" ||
    typeof value.repository !== "string" ||
    !isAbsolute(value.repository) ||
    typeof value.branch !== "string" ||
    value.branch === "" ||
    !Array.isArray(value.launches) ||
    value.launches.length === 0 ||
    !value.launches.every(
      (id) =>
        typeof id === "string" && /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/.test(id),
    ) ||
    !Array.isArray(value.processes)
  )
    return null;
  const processes = value.processes.map(decodeIdentity);
  if (processes.some((identity) => identity === null)) return null;
  return {
    version: 1,
    runtime: "process",
    repository: value.repository,
    branch: value.branch,
    launches: value.launches,
    processes: processes as ProcessIdentity[],
  };
}

/** Missing means unowned; unreadable or malformed never means unowned. */
export function readWorktreeOwner(
  admin: string,
): Outcome<ProcessWorktreeOwner | null> {
  const path = join(admin, PROCESS_WORKTREE_OWNER);
  try {
    if (!lstatSync(path).isFile())
      return failed(
        "owner-unreadable",
        `${path} is not a regular owner record`,
      );
    const owner = decodeWorktreeOwner(readFileSync(path, "utf8"));
    return owner === null
      ? failed("owner-unreadable", `${path} is malformed`)
      : ok(owner);
  } catch (error) {
    return errnoCode(error) === "ENOENT"
      ? ok(null)
      : failed("owner-unreadable", `cannot read ${path}`, error);
  }
}

/** Caller holds both shared admission and the checkout's owner publication lock. */
export function writeWorktreeOwner(
  admin: string,
  owner: ProcessWorktreeOwner,
): Outcome<void> {
  if (decodeWorktreeOwner(JSON.stringify(owner)) === null)
    return failed(
      "owner-invalid",
      "the owner must name a repository, branch and valid launches and process identities",
    );
  return attempt("owner-write", "cannot publish the worktree's owner", () => {
    const path = join(admin, PROCESS_WORKTREE_OWNER);
    const staged = `${path}.${randomUUID()}.tmp`;
    writeFileSync(staged, `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(staged, path);
  });
}
