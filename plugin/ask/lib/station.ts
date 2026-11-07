/**
 * What every station's reader is handed and gives back, and the readings
 * they share: a launch record as a holder, an outcome row as the last
 * launch, and the notes on the dispatcher's records.
 */
import type { Address } from "../../shared/address.ts";
import type { EndedRow, LogRow } from "../../dispatch/lib/log.ts";
import { holds, type ReadRecord } from "../../dispatch/lib/launches.ts";
import type { Holder, Last, ThreadEntry, WaitsOn } from "./answer.ts";
import { type PullDoc, readLabelEvents, readPull } from "./forge.ts";
import { launchesWhere, outcomeRows } from "./local.ts";
import type { Reading } from "./reading.ts";
import { labelRequests, type ThreadWindow } from "./thread.ts";

/** What a station's reader reads with. */
export interface AskContext {
  reading: Reading;
  address: Address;
  /** The address as answers print it. */
  name: string;
  /** Whether the thread's own reads (the timeline, the mailbox, the assigner) are made. */
  thread: boolean;
  window: ThreadWindow;
  /** The login the forge client is signed in as, whose records it trusts. */
  login: string | null;
  /** The dispatcher's state directory; `null` on a machine that never dispatched. */
  dispatcher: string | null;
  /** This host as its launch claims name it; `null` when it is not known. */
  host: string | null;
  /** A checkout of the repository on this machine; `null` when there is none. */
  checkout: string | null;
  /** Whether this machine's dispatch file lists the repository. */
  dispatches: boolean;
  /** The dispatch labels' prefix (`dispatch.labels.prefix`); `null` when no checkout's configuration here says. */
  labelPrefix: string | null;
}

/** What a station's reader answers. */
export interface StationAnswer {
  /** False when the key names nothing: no such pull request or item. */
  found: boolean;
  title: string | null;
  url: string | null;
  holder: Holder | "none";
  state: string;
  stateDetail: string;
  waitsOn: WaitsOn;
  last: Last | null;
  /** The thread's entries, unwindowed. */
  entries: ThreadEntry[];
}

/** The answer for a key that names nothing. */
export function nothing(state: string, detail: string): StationAnswer {
  return {
    found: false,
    title: null,
    url: null,
    holder: "none",
    state,
    stateDetail: detail,
    waitsOn: "none",
    last: null,
    entries: [],
  };
}

/** The newest of this machine's records that holds its stage: pending, alive, or unknown. */
export function holdingRecord(
  records: readonly ReadRecord[],
): ReadRecord | null {
  const holding = records.filter((r) => holds(r.state));
  return (
    holding.sort((a, b) =>
      b.record.createdAt.localeCompare(a.record.createdAt),
    )[0] ?? null
  );
}

/** A launch record of this machine that holds its stage, as the holder. */
export function recordHolder(r: ReadRecord, generation: number | null): Holder {
  const s = r.state;
  const process =
    s.kind === "alive" ? "alive" : s.kind === "died" ? "dead" : "unknown";
  const why =
    s.kind === "alive"
      ? `its wrapper runs as process ${s.process.pid} on ${s.process.host}`
      : s.kind === "pending"
        ? "its wrapper has not claimed the record yet"
        : s.kind === "unknown"
          ? s.reason
          : s.kind;
  const { record } = r;
  return {
    stage: record.action,
    host: "this machine",
    generation,
    process,
    why,
    local: {
      account: record.account,
      record: record.id,
      ...(record.sessionId == null ? {} : { session: record.sessionId }),
      ...(record.workspace === null
        ? {}
        : { workspace: record.workspace.path }),
    },
  };
}

/** An outcome row as the last launch. */
export function lastOfRow(row: EndedRow): Last {
  return {
    class: row.class,
    at: row.at,
    reason: row.reason,
    from: "outcome log",
  };
}

/** Why the launch records were not read on a machine that never dispatched. */
const NO_DISPATCHER =
  "this machine keeps no dispatcher state: the launch records, the account, the session and whether its process runs are the dispatching machine's to know";

/** This machine's launch records of the station that `keep` accepts, and the piece of work's outcome rows (`target` as they name it), noted in the sources; none on a machine that never dispatched. */
export async function dispatcherReads(
  ctx: AskContext,
  keep: (r: ReadRecord) => boolean,
  target: string,
): Promise<{ records: ReadRecord[]; rows: LogRow[] }> {
  const { reading, dispatcher, address } = ctx;
  if (dispatcher === null) {
    for (const record of ["dispatch-launch", "dispatch-outcome"])
      reading.note({ record, read: false, local: true, detail: NO_DISPATCHER });
    return { records: [], rows: [] };
  }
  const read = await launchesWhere(
    dispatcher,
    (r) => r.record.repo === address.repo && keep(r),
  );
  const skipped = read.ok ? read.value.unreadable : [];
  reading.note({
    record: "dispatch-launch",
    read: read.ok && skipped.length === 0,
    local: true,
    ...(read.ok
      ? skipped.length === 0
        ? {}
        : {
            detail: `${skipped.length} launch record(s) do not read and are left out: ${skipped.join("; ")}`,
          }
      : { detail: read.failure.reason }),
  });
  return {
    records: read.ok ? read.value.records : [],
    rows: outcomeRows(reading, dispatcher, address.repo, target),
  };
}

/** The pull request a station's key names, as read: absent (with the answer for a key that names nothing), or its document, a stand-in when it did not read. */
export type PullRead =
  | { absent: true; answer: StationAnswer }
  | { absent: false; doc: PullDoc; read: boolean };

/** The pull request of a pull-request station's address, noted in the sources. */
export async function pullFor(ctx: AskContext): Promise<PullRead> {
  const { reading, address } = ctx;
  const pr = Number(address.key);
  const pull = await readPull(reading, address.repo, pr);
  if (!pull.ok && pull.failure.code === "absent") {
    reading.note({
      record: "pull-request",
      read: true,
      detail: "no such pull request",
    });
    return {
      absent: true,
      answer: nothing(
        "no such pull request",
        `${address.repo} has no pull request ${pr}`,
      ),
    };
  }
  reading.note({
    record: "pull-request",
    read: pull.ok,
    ...(pull.ok ? {} : { detail: pull.failure.reason }),
  });
  return {
    absent: false,
    read: pull.ok,
    doc: pull.ok
      ? pull.value
      : {
          number: pr,
          title: "",
          url: `https://github.com/${address.repo}/pull/${pr}`,
          state: "OPEN",
          head: "",
          baseRef: "",
          author: "",
          labels: [],
          mergeable: "UNKNOWN",
          mergedAt: null,
        },
  };
}

/** With `--thread`: the `drive` and `hold` label requests on a pull request's timeline, noted in the sources; none when the prefix or the timeline is not known. */
export async function labelThread(
  ctx: AskContext,
  number: number,
  url: string,
): Promise<ThreadEntry[]> {
  const { reading, address, labelPrefix } = ctx;
  if (labelPrefix === null) {
    reading.note({
      record: "label-event",
      read: false,
      detail:
        "the dispatch label prefix is the repository's configuration to name, and no checkout of it is on this machine",
    });
    return [];
  }
  const events = await readLabelEvents(reading, address.repo, number);
  reading.note({
    record: "label-event",
    read: events.ok,
    ...(events.ok ? {} : { detail: events.failure.reason }),
  });
  if (!events.ok) return [];
  return labelRequests(
    events.value,
    [`${labelPrefix}drive`, `${labelPrefix}hold`],
    ctx.name,
    url,
  );
}
