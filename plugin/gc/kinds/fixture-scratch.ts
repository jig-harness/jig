/** Registered test scopes have a stronger proof than legacy scratch owners. */
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  attempt,
  failed,
  ok,
  type Failure,
  type Outcome,
} from "../../shared/outcome.ts";
import { failureFields } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import {
  proveFixtureScope,
  retireFixtureScope,
  type FixtureScope,
} from "../../shared/test-fixture-registry.ts";
import type { Proof } from "../types.ts";

/** Keep platform diagnostics before converting an outcome to a receipt's reason. */
export function recordFixtureFailure(failure: Failure): string {
  if (failure.cause !== undefined)
    log.warn(
      "registered fixture collection could not complete",
      failureFields(failure.cause),
    );
  return failure.reason;
}

/** Walk without following links, bounded even for a very large leaked scope. */
function newestEntry(
  root: string,
  createdAt: number,
  deadline: number,
): Outcome<number> {
  const scanned = attempt(
    "fixture-idle",
    "Cannot inspect registered scratch idleness",
    () => {
      if (!existsSync(root)) return ok(createdAt);
      const directories = [root];
      let newest = createdAt;
      for (const directory of directories) {
        if (Date.now() > deadline)
          return failed("timed-out", "Scratch idle scan exceeded its deadline");
        const stat = lstatSync(directory);
        newest = Math.max(newest, stat.mtimeMs);
        if (!stat.isDirectory()) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (Date.now() > deadline)
            return failed(
              "timed-out",
              "Scratch idle scan exceeded its deadline",
            );
          const path = join(directory, entry.name);
          newest = Math.max(newest, lstatSync(path).mtimeMs);
          if (entry.isDirectory()) directories.push(path);
        }
      }
      return ok(newest);
    },
  );
  return scanned.ok ? scanned.value : scanned;
}

export async function fixtureScratchProof(
  root: string,
  scopes: FixtureScope[],
  idleDays: number,
): Promise<Proof> {
  const rootType = attempt(
    "fixture-root",
    "Cannot inspect registered scratch root",
    () => {
      return (
        lstatSync(root, { throwIfNoEntry: false })?.isSymbolicLink() ?? false
      );
    },
  );
  if (!rootType.ok)
    return {
      state: "unverified",
      reason: recordFixtureFailure(rootType.failure),
    };
  if (rootType.value)
    return { state: "finding", reason: "scratch root is a symbolic link" };
  for (const scope of scopes) {
    const proof = await proveFixtureScope(scope.root, scope.registry);
    if (proof.state !== "dead") return proof;
  }
  const age = newestEntry(
    root,
    Math.max(...scopes.map((scope) => Date.parse(scope.createdAt))),
    Date.now() + 30_000,
  );
  if (!age.ok)
    return { state: "unverified", reason: recordFixtureFailure(age.failure) };
  if (Date.now() - age.value < idleDays * 86_400_000)
    return { state: "live", reason: "scratch idle guard has not elapsed" };
  return {
    state: "dead",
    reason:
      "closed fixture registration proves every holder exited; idle guard elapsed",
  };
}

/** Called only under scratch's exclusive admission, after another full proof. */
export function collectFixtureScratch(
  root: string,
  scopes: FixtureScope[],
): { outcome: "collected" | "failed"; reason: string } {
  const removed = attempt(
    "fixture-remove",
    "Cannot remove registered scratch",
    () => rmSync(root, { recursive: true, force: true }),
  );
  if (!removed.ok)
    return { outcome: "failed", reason: recordFixtureFailure(removed.failure) };
  for (const scope of scopes) {
    const retired = retireFixtureScope(scope.root, scope.registry);
    if (!retired.ok)
      return {
        outcome: "failed",
        reason: recordFixtureFailure(retired.failure),
      };
  }
  return {
    outcome: "collected",
    reason: "removed scratch with a closed fixture registration",
  };
}
