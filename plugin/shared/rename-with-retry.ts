/** Bounded waits for Windows sharing handles to release filesystem entries. */
import { lstatSync, mkdirSync, renameSync } from "node:fs";

interface RetryOptions {
  platform?: NodeJS.Platform;
  sleep?: (milliseconds: number) => void;
}

const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

function retryableEntryError(
  error: unknown,
  retryAbsentEntry?: () => boolean,
): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "EEXIST") return retryAbsentEntry?.() ?? false;
  return SHARING_ERRORS.has(code ?? "");
}

function retrySharingViolation(
  operation: () => void,
  options: RetryOptions,
  retryAbsentEntry?: () => boolean,
): void {
  const retries = (options.platform ?? process.platform) === "win32" ? 4 : 0;
  const sleep = options.sleep ?? Bun.sleepSync;
  for (let attempt = 0; ; attempt++) {
    try {
      operation();
      return;
    } catch (error) {
      if (attempt >= retries) throw error;
      if (!retryableEntryError(error, retryAbsentEntry)) throw error;
      sleep(10 * 2 ** attempt);
    }
  }
}

/** Replace atomically, allowing at most 150ms for Windows sharing handles.
 * Never unlink the destination: every attempt preserves rename's atomicity. */
export function renameWithRetry(
  source: string,
  destination: string,
  options: RetryOptions & {
    rename?: (source: string, destination: string) => void;
  } = {},
): void {
  const rename = options.rename ?? renameSync;
  retrySharingViolation(() => rename(source, destination), options);
}

/** Acquire a directory exclusively; an occupied directory fails immediately.
 * Windows can briefly refuse creation while a removed directory is still open. */
export function mkdirWithRetry(
  path: string,
  options: RetryOptions & {
    mkdir?: (path: string) => unknown;
    lstat?: (path: string) => unknown;
  } = {},
): void {
  const mkdir = options.mkdir ?? mkdirSync;
  const lstat = options.lstat ?? lstatSync;
  retrySharingViolation(
    () => {
      mkdir(path);
    },
    options,
    () => {
      try {
        lstat(path);
        return false;
      } catch (error) {
        // Only a confirmed absence identifies a pending deletion. An unreadable
        // entry might still belong to a live holder and must remain occupied.
        return (error as NodeJS.ErrnoException)?.code === "ENOENT";
      }
    },
  );
}
