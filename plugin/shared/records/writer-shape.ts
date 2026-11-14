/**
 * The `writer` field of the record envelope as data: its shape, and reading it
 * back from a record. No `node:` import, so the dispatch dashboard's page,
 * which writes a person's answer from the browser, bundles it; the writer a
 * process names for itself is `writer.ts`'s.
 */
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

/**
 * The host a record names when a person's browser wrote it, through the
 * dispatch dashboard's page: a browser has no machine name to digest.
 */
export const BROWSER_HOST = "dashboard (browser)";

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
