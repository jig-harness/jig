/**
 * `pause`, `resume <directive>`, `stop` and `hold-push`: a directive in the
 * mailbox of the working tree that holds the drive on this machine
 * (`skills/drive-pr/scripts/lib/state/mailbox.ts`), which the driver reads
 * where it reads directives today: `hold-push` before each push, `pause` and
 * `stop` at each round boundary.
 *
 * The tree, its mailbox and the driver generation come from the drive's own
 * listing in a checkout here (`drives.ts --json`), as `jig ask` reads them.
 * A `stop` is addressed to that generation, so it ends that driver alone,
 * as `drives.ts --stop` addresses its own. The mailbox's format lets only a
 * `stop` name a generation, and every driver holds its pushes on a
 * directive of any other shape, so `pause` and `hold-push` are the tree's,
 * for the pull request, until `resume` withdraws them; the plan names the
 * generation that holds the drive when it is sent.
 *
 * Refused: a drive another host holds (named), one no driver on this
 * machine holds (a `resume` needs only the tree), a mailbox that does not
 * read, a directive already in force, and a `resume` with nothing to
 * withdraw.
 */
import { failureText } from "../../dispatch/lib/text.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import {
  appendDirective,
  foldGateState,
  type GateName,
  type GateState,
  inboxPath,
} from "../../skills/drive-pr/scripts/lib/state/mailbox.ts";
import { driverMailboxDir } from "../../skills/drive-pr/scripts/lib/state/mailbox-stop.ts";
import type { Holder } from "../../ask/lib/answer.ts";
import { type DriveReading, readDrive } from "../../ask/lib/drive.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { type Planned, refused } from "./plan.ts";
import type { Request } from "./verbs.ts";

type MailboxRequest = Extract<
  Request,
  { verb: "pause" | "stop" | "hold-push" | "resume" }
>;

/** The working tree that holds the drive here, as the drive's listing names it. */
interface Tree {
  worktree: string;
  dir: string;
  generation: number | null;
  /** Whether a driver holds its lock now. */
  live: boolean;
}

/** The host a drive runs on when it is not this machine; `null` when it is this machine or nobody holds it. */
function elsewhere(
  holder: Holder | "none",
  ledger: DriveReading["ledger"],
): string | null {
  if (holder === "none" || holder.host === "this machine") return null;
  if (holder.host !== "unknown") return `host ${holder.host}`;
  const clone =
    typeof ledger === "object" && ledger !== null ? ledger.driver.clone : "";
  return clone === ""
    ? "a host this machine cannot name"
    : `the host its ledger's driver names (clone ${clone})`;
}

/** The tree that holds the drive on this machine: its driver's, else the tree a launch record here opened for it. */
function treeOf(d: DriveReading): Tree | null {
  const row = d.row;
  if (row?.worktree != null) {
    const dir = driverMailboxDir(row.worktree, row.mailbox ?? "");
    return {
      worktree: row.worktree,
      dir,
      generation: row.generation,
      live: row.lock === "live",
    };
  }
  const launched = [...d.records]
    .filter((r) => r.record.workspace !== null)
    .sort((a, b) => b.record.createdAt.localeCompare(a.record.createdAt))[0];
  const path = launched?.record.workspace?.path;
  return path === undefined
    ? null
    : {
        worktree: path,
        dir: driverMailboxDir(path),
        generation: null,
        live: false,
      };
}

/** Why the directive is already in force, or there is nothing to withdraw; `null` when it may be sent. */
function inForce(
  request: MailboxRequest,
  gate: GateState,
  generation: number | null,
): string | null {
  const since = (s: { since: string | null; by: string | null }) =>
    ` (since ${s.since ?? "an unrecorded time"}, from ${s.by ?? "an unrecorded sender"})`;
  switch (request.verb) {
    case "pause":
    case "hold-push": {
      const state = gate[request.verb];
      return state.active
        ? `a ${request.verb} directive is already in force${since(state)}`
        : null;
    }
    case "stop":
      return gate.addressed.some((s) => s.generation === generation)
        ? `a stop addressed to driver generation ${generation} is already in the mailbox`
        : null;
    case "resume": {
      const target: GateName = request.target;
      const active =
        target === "stop"
          ? gate.stop.active || gate.addressed.length > 0
          : gate[target].active;
      return active
        ? null
        : `no ${target} directive is in force: there is nothing to resume`;
    }
  }
}

const READER: Record<MailboxRequest["verb"], (g: string) => string> = {
  pause: (g) =>
    `${g}, which waits at its next round boundary until a resume pause`,
  "hold-push": (g) =>
    `${g}'s guarded push, which holds every push until a resume hold-push`,
  stop: (g) =>
    `${g}, which stops at its next round boundary; a later driver ignores the stop`,
  resume: (g) => `${g}, at its next read of the mailbox`,
};

const UNDO: Record<
  MailboxRequest["verb"],
  (name: string, r: MailboxRequest) => string
> = {
  pause: (name) => `jig send ${name} resume pause`,
  "hold-push": (name) => `jig send ${name} resume hold-push`,
  stop: (name) =>
    `jig send ${name} resume stop, before the driver reaches its round boundary`,
  resume: (name, r) =>
    `jig send ${name} ${r.verb === "resume" ? r.target : "resume"}`,
};

/** The plan of a mailbox verb, or why the drive cannot take it here. */
export async function planMailbox(
  ctx: AskContext,
  request: MailboxRequest,
  login: string,
  writesAs: string,
): Promise<Planned> {
  const d = await readDrive(ctx);
  if (d.pull === null) return refused(d.answer.stateDetail);
  const host = elsewhere(d.answer.holder, d.ledger);
  if (host !== null)
    return refused(
      `${ctx.name} runs on ${host}, not on this machine: a mailbox directive reaches a driver on this machine only, so send it from that host`,
    );
  const tree = treeOf(d);
  const needsDriver = request.verb !== "resume";
  if (
    tree === null ||
    (needsDriver && (!tree.live || tree.generation === null))
  )
    return refused(
      `no driver on this machine holds ${ctx.name}${ctx.checkout === null ? " (no checkout of the repository here to read the drive's listing in)" : ""}: a ${request.verb} directive reaches a running driver`,
    );
  const gate = foldGateState(tree.dir, ctx.address.key);
  if (!gate.ok)
    return refused(
      `the mailbox ${inboxPath(tree.dir)} does not read: ${gate.why}`,
    );
  const busy = inForce(request, gate.state, tree.generation);
  if (busy !== null) return refused(busy);
  const g =
    tree.generation === null
      ? "the driver in that tree"
      : `driver generation ${tree.generation}`;
  const pr = ctx.address.key;
  const what =
    request.verb === "resume"
      ? `a resume of ${request.target}`
      : request.verb === "stop"
        ? `a stop addressed to ${g}`
        : `a ${request.verb}, for every driver of pull request ${pr} in that tree until it is resumed (${g} holds the drive now)`;
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: request.verb,
    writesAs,
    record: `${what}, a directive in the mailbox of ${tree.worktree}`,
    where: inboxPath(tree.dir),
    reader: READER[request.verb](g),
    undo: UNDO[request.verb](ctx.name, request),
    notice: null,
    write: () => writeDirective(tree, pr, login, request),
  });
}

async function writeDirective(
  tree: Tree,
  pr: string,
  from: string,
  request: MailboxRequest,
): Promise<Outcome<string, "refused">> {
  try {
    const msg = await appendDirective(
      tree.dir,
      pr,
      from,
      request.verb,
      request.verb === "resume"
        ? { target: request.target }
        : request.verb === "stop" && tree.generation !== null
          ? { generation: tree.generation }
          : {},
    );
    return ok(`${inboxPath(tree.dir)} (directive ${msg.id})`);
  } catch (error) {
    return refused(
      `the mailbox ${inboxPath(tree.dir)} did not take the directive: ${failureText(error)}`,
    );
  }
}
