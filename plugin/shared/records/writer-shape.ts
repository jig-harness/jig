/**
 * The `writer` field of the record envelope as data: its shape, and reading it
 * back from a record. No `node:` import, so the dispatch dashboard's page,
 * which writes a person's answer from the browser, bundles it; the writer a
 * process names for itself is `writer.ts`'s.
 */
import { type Infer, matches, s } from "../shapes.ts";

export const WRITER_SHAPE = s.object({
  /** The forge login the writer is signed in as, where it knows it. */
  login: s.optional(s.string({ minLength: 1 })),
  /** The host's name; a digest of it on the forge and the tracker. */
  host: s.string({ minLength: 1 }),
  /** Linux's boot id (a digest on the forge and the tracker); absent elsewhere. */
  bootId: s.optional(s.string()),
  /** The writing process's id. */
  pid: s.optional(s.integer({ minimum: 1 })),
  /** The writing process's start time, as the process table reports it. */
  start: s.optional(s.string()),
});
export type Writer = Infer<typeof WRITER_SHAPE>;

/**
 * The host a record names when a person's browser wrote it, through the
 * dispatch dashboard's page: a browser has no machine name to digest.
 */
export const BROWSER_HOST = "dashboard (browser)";

/**
 * A writer read from a record, or `null` when the value is not one. Fields
 * this version does not know are left out, so a newer writer's additions do
 * not make the record unreadable.
 */
export function readWriter(value: unknown): Writer | null {
  if (!matches(WRITER_SHAPE, value)) return null;
  const { login, bootId: boot, pid, start } = value;
  return {
    ...(login === undefined ? {} : { login }),
    host: value.host,
    ...(boot === undefined ? {} : { bootId: boot }),
    ...(pid === undefined ? {} : { pid: pid as number }),
    ...(start === undefined ? {} : { start }),
  };
}
