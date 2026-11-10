#!/usr/bin/env bun
/** Read and submit one owner-local steward run under its launch token. */
import { timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { runMain, ExitError } from "../../../shared/cli.ts";
import { readRecord, readEnded } from "../../../dispatch/lib/launches.ts";
import {
  readStewardDigest,
  submitStewardRecords,
} from "../../../dispatch/lib/steward.ts";

function stop(message: string, cause?: unknown): never {
  console.error(message);
  throw new ExitError(2, message, { cause });
}

function argumentsOf() {
  const [command, id, token, flag, file, ...rest] = process.argv.slice(2);
  if (
    !id ||
    !token ||
    !["read", "submit"].includes(command ?? "") ||
    rest.length
  )
    stop(
      "usage: steward.ts read <launch-id> <token> | submit <launch-id> <token> --input <json-file>",
    );
  return { command, id, token, flag, file };
}

function authorize(id: string, token: string): void {
  const record = readRecord(id);
  const given = Buffer.from(token);
  const expected = Buffer.from(record?.token ?? "");
  if (
    record?.action !== "steward" ||
    given.length !== expected.length ||
    !timingSafeEqual(given, expected) ||
    readEnded(id) !== null
  )
    stop("the steward launch or its live token could not be verified");
}

function readSubmission(file: string): unknown {
  try {
    return JSON.parse(boundedText(file));
  } catch (cause) {
    if (cause instanceof ExitError) throw cause;
    stop("the steward submission is not a readable JSON file", cause);
  }
}

function boundedText(file: string): string {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) stop("the steward submission must be a regular file");
    if (stat.size > 500_000) stop("the steward submission is too large");
    const bytes = Buffer.alloc(500_001);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    if (offset > 500_000) stop("the steward submission is too large");
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  const { command, id, token, flag, file } = argumentsOf();
  authorize(id, token);
  if (command === "read") {
    if (flag !== undefined) stop("read takes no extra arguments");
    const digest = readStewardDigest(id);
    if (!digest.ok) stop(digest.failure.reason);
    console.log(JSON.stringify(digest.value, null, 2));
  } else {
    if (flag !== "--input" || !file)
      stop("submit requires --input <json-file>");
    const value = readSubmission(file);
    const kept = submitStewardRecords(id, value);
    if (!kept.ok) stop(kept.failure.reason);
    if (kept.value !== "submitted")
      stop(
        kept.value === "already-submitted"
          ? "the steward submission was already accepted"
          : "the steward launch no longer exists",
      );
    console.log(JSON.stringify({ submitted: true }));
  }

  return 0;
}
runMain("jig-steward", main);
