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
 * can still recognise its own. The field's shape and its reader are
 * `writer-shape.ts`, which the dashboard's page bundles.
 */
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { bootId } from "../liveness.ts";
import type { Writer } from "./writer-shape.ts";

export { readWriter, type Writer } from "./writer-shape.ts";

/** Where a record is kept: on the machine, in the working tree, on the forge, on the tracker. */
export type Medium = "machine" | "tree" | "forge" | "tracker";

/** Whether everyone who can read the repository can read a record kept on `medium`. */
function isPublic(medium: Medium): boolean {
  return medium === "forge" || medium === "tracker";
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
