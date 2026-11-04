/**
 * Who wrote a record: the `writer` field of the record envelope
 * (`envelope.ts`). It names the forge login where the writer knows it, the
 * host, and the process identity the dispatcher's launch claim captures
 * (`dispatch/lib/launches.ts`): the boot, the process id and the process's
 * start time. A boot id and a start time tell a reused process id apart.
 *
 * A record on the forge or the tracker is read by everyone who can read the
 * repository, so there the host and the boot id are written as digests
 * (`sha256:` and the first 16 hexadecimal characters of the SHA-256 of the
 * value): a public comment names no machine, and a host that reads it back
 * can still recognise its own.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";

export interface Writer {
  /** The forge login the writer is signed in as, where it knows it. */
  login?: string;
  /** The host's name; a digest of it on the forge and the tracker. */
  host: string;
  /** Linux's boot id (a digest on the forge and the tracker); absent elsewhere. */
  bootId?: string;
  /** The writing process's id. */
  pid?: number;
  /** The writing process's start time, as the process table reports it. */
  start?: string;
}

/** Where a record is kept: on the machine, in the working tree, on the forge, on the tracker. */
export type Medium = "machine" | "tree" | "forge" | "tracker";

/** Whether everyone who can read the repository can read a record kept on `medium`. */
function isPublic(medium: Medium): boolean {
  return medium === "forge" || medium === "tracker";
}

/** This boot's id: Linux's `boot_id`; elsewhere, empty (the start time still tells a reused pid apart). */
export function bootId(): string {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch (error) {
    swallow(error, "no boot id on this platform");
    return "";
  }
}

/** `value` as the digest a public record carries in its place. */
export function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

/**
 * This process as the writer of a record kept on `medium`: its login when
 * the caller knows it, the host and boot id (digests on the forge and the
 * tracker), and the process id. The start time needs a read of the process
 * table, so a caller that holds one adds it.
 */
export function localWriter(
  medium: Medium,
  login: string | null = null,
): Writer {
  const shown = isPublic(medium) ? digest : (value: string) => value;
  const boot = bootId();
  return {
    ...(login === null || login === "" ? {} : { login }),
    host: shown(hostname()),
    ...(boot === "" ? {} : { bootId: shown(boot) }),
    pid: process.pid,
  };
}

const isText = (v: unknown): v is string => typeof v === "string";

/**
 * A writer read from a record, or `null` when the value is not one. Fields
 * this version does not know are left out, so a newer writer's additions do
 * not make the record unreadable.
 */
export function readWriter(value: unknown): Writer | null {
  if (!isRecord(value) || !isText(value.host) || value.host === "") return null;
  const { login, bootId: boot, pid, start } = value;
  if (login !== undefined && (!isText(login) || login === "")) return null;
  if (boot !== undefined && !isText(boot)) return null;
  if (pid !== undefined && !(Number.isSafeInteger(pid) && Number(pid) > 0))
    return null;
  if (start !== undefined && !isText(start)) return null;
  return {
    ...(login === undefined ? {} : { login }),
    host: value.host,
    ...(boot === undefined ? {} : { bootId: boot }),
    ...(pid === undefined ? {} : { pid: pid as number }),
    ...(start === undefined ? {} : { start }),
  };
}
