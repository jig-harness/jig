import { statfsSync, type StatsFs } from "node:fs";
import { dirname } from "node:path";
import { failureFields } from "./errors.ts";
import {
  fixtureRegistryUsage,
  testFixtureRegistryRoot,
} from "./fixture-registry-index.ts";
import { log } from "./log.ts";
import { failed, type Failure } from "./outcome.ts";

const FREE_INODE_THRESHOLD = 10;

/** The shape of the runtime's doctor check, kept here so shared code needs no runtime import. */
interface DoctorCheck {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
  fix?: string;
}

function stateFilesystem(): StatsFs {
  let path = dirname(testFixtureRegistryRoot());
  for (;;) {
    try {
      return statfsSync(path);
    } catch (error) {
      const parent = dirname(path);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === path)
        throw error;
      path = parent;
    }
  }
}

export function stateInodeCheck(
  read: () => Pick<StatsFs, "files" | "ffree"> = stateFilesystem,
): DoctorCheck {
  const id = "gc:state-inodes";
  try {
    const { files, ffree } = read();
    if (files <= 0 || ffree < 0)
      return {
        id,
        status: "skip",
        detail: "the state filesystem does not report free inodes",
      };
    const percent = (100 * ffree) / files;
    const detail = `${percent.toFixed(2)}% free inodes on the Jig state filesystem (${ffree} of ${files})`;
    if (percent >= FREE_INODE_THRESHOLD) return { id, status: "pass", detail };
    return {
      id,
      status: "fail",
      detail: `${detail}, below the ${FREE_INODE_THRESHOLD}% warning threshold`,
      fix: "Free inodes on the filesystem that holds ~/.local/state/jig",
    };
  } catch (error) {
    log.debug(
      "Cannot read the Jig state filesystem's free inodes",
      failureFields(error),
    );
    return {
      id,
      status: "fail",
      detail: `Cannot read free inodes on the Jig state filesystem: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function fixtureRegistryCheck(): DoctorCheck {
  const id = "gc:fixture-registry";
  const usage = fixtureRegistryUsage();
  if (!usage.ok) {
    log.debug(usage.failure.reason, failureFields(usage.failure.cause));
    return { id, status: "fail", detail: usage.failure.reason };
  }
  const { count, limit } = usage.value;
  const detail = `fixture registry holds ${count} of ${limit} registrations`;
  return count <= limit
    ? { id, status: "pass", detail }
    : {
        id,
        status: "fail",
        detail: `${detail} and exceeds its limit, so the scratch kind of jig gc fails each scheduled run`,
        fix: "Run jig gc --kind scratch --collect and inspect the receipt for retained registrations",
      };
}

export function fixtureCapacityFailure(reason: string): Failure | null {
  const usage = fixtureRegistryUsage();
  if (!usage.ok) return usage.failure;
  const { count, limit } = usage.value;
  return count > limit
    ? failed(
        "fixture-registry-over-limit",
        `${count} registrations exceed the limit of ${limit}. ${reason} Run jig gc --kind scratch --collect and inspect the receipt.`,
      ).failure
    : null;
}
