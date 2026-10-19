/** Bounded waits for Windows sharing handles to release filesystem entries. */
import { lstatSync, mkdirSync, readdirSync, renameSync } from "node:fs";

interface RetryOptions {
  /** Tighten the retry window to the caller's absolute monotonic deadline. */
  deadlineMs?: number;
  platform?: NodeJS.Platform;
  sleep?: (milliseconds: number) => void;
  now?: () => number;
  random?: () => number;
}

const SHARING_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);
const RETRY_WINDOW_MS = 2_000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function retryableEntryError(
  error: unknown,
  retryMissingEntry: boolean,
): boolean {
  const code = errorCode(error) ?? "";
  if (SHARING_ERRORS.has(code)) return true;
  return retryMissingEntry && code === "EEXIST";
}

function retryTiming(options: RetryOptions) {
  return {
    sleep: options.sleep ?? Bun.sleepSync,
    now: options.now ?? performance.now.bind(performance),
    random: options.random ?? Math.random,
  };
}

function retrySharingViolation(
  operation: () => void,
  options: RetryOptions,
  occupied: (error: unknown) => boolean,
  retryMissingEntry = false,
): void {
  const windows = (options.platform ?? process.platform) === "win32";
  const { sleep, now, random } = retryTiming(options);
  const deadline = Math.min(
    now() + RETRY_WINDOW_MS,
    options.deadlineMs ?? Infinity,
  );
  for (;;) {
    try {
      operation();
      return;
    } catch (error) {
      if (!windows) throw error;
      const retryable = retryableEntryError(error, retryMissingEntry);
      if (!retryable || occupied(error)) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      // Frequent attempts can catch the gap between a reader closing and
      // reopening its handle. Jitter avoids synchronizing with that reader.
      sleep(Math.min(5 + Math.floor(random() * 6), remaining));
    }
  }
}

/** Replace atomically, allowing at most two seconds for Windows sharing handles.
 * Never unlink the destination: every attempt preserves rename's atomicity. */
export function renameWithRetry(
  source: string,
  destination: string,
  options: RetryOptions & {
    rename?: (source: string, destination: string) => void;
    lstat?: (path: string) => { isDirectory(): boolean };
    readdir?: (path: string) => string[];
  } = {},
): void {
  const rename = options.rename ?? renameSync;
  const lstat = options.lstat ?? lstatSync;
  const readdir = options.readdir ?? readdirSync;
  retrySharingViolation(
    () => rename(source, destination),
    options,
    () => {
      try {
        return (
          lstat(destination).isDirectory() && readdir(destination).length > 0
        );
      } catch {
        // An ambiguous destination may be held open; retain the bounded retry.
        return false;
      }
    },
  );
}

/** Acquire a directory exclusively; a confirmed occupant fails immediately.
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
    (failure) => {
      try {
        lstat(path);
        return true;
      } catch (error) {
        // EEXIST needs confirmed absence. A sharing failure with an unreadable
        // name can itself be pending deletion, so keep its bounded retry.
        return errorCode(failure) === "EEXIST" && errorCode(error) !== "ENOENT";
      }
    },
    true,
  );
}
