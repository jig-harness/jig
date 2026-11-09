/** Resolve update next from the repository's converged pull requests, as the board does. */
import { carriesSet } from "../../dispatch/lib/labels.ts";
import { oneUpdateNext, type BoardCard } from "../../dispatch/lib/board.ts";
import {
  snapshotFrom,
  type Ledger,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { readMergeFacts } from "../../skills/drive-pr/scripts/lib/merge-facts.ts";
import {
  readiness,
  type ForgeFacts,
  type ReadyRules,
  type Readiness,
} from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { commentFields, readComments, readOpenPulls } from "./forge.ts";
import type { AskContext } from "./station.ts";
import type { WaitsOn } from "./answer.ts";

/** Read the converged peers from their trusted drive ledgers. */
async function peerLedgers(
  ctx: AskContext,
  number: number,
  ledger: Ledger,
): Promise<Outcome<Map<number, Ledger>, "unreadable">> {
  const open = await readOpenPulls(ctx.reading, ctx.address.repo);
  if (!open.ok) return failed("unreadable", open.failure.reason);
  const ledgers = new Map<number, Ledger>([[number, ledger]]);
  for (const n of open.value) {
    if (n === number) continue;
    const comments = await readComments(ctx.reading, ctx.address.repo, n);
    if (!comments.ok) return failed("unreadable", comments.failure.reason);
    const snapshot = snapshotFrom(
      comments.value.flatMap((c) => {
        const f = commentFields(c);
        return f === null ? [] : [f];
      }),
      ctx.login,
    );
    if (snapshot.malformed.length > 0)
      return failed("unreadable", `PR #${n}'s ledger is malformed`);
    const parsed = snapshot.canonical?.parsed;
    if (parsed !== undefined && parsed.kind !== "ledger")
      return failed("unreadable", `PR #${n}'s ledger did not read`);
    if (
      parsed?.kind === "ledger" &&
      parsed.ledger.driver.state === "stopped" &&
      parsed.ledger.driver.exit === DRIVE_EXIT.CONVERGED
    )
      ledgers.set(n, parsed.ledger);
  }
  return ok(ledgers);
}

/** Place peers on the same live facts before selecting the repository's one update lane. */
function peerCards(
  ctx: AskContext,
  ledgers: Map<number, Ledger>,
  pulls: Map<number, ForgeFacts>,
  rules: ReadyRules,
  prefix: string | null,
  onlyLabeled: boolean,
): Outcome<BoardCard[], "unreadable"> {
  const cards: BoardCard[] = [];
  for (const [n, l] of ledgers) {
    const f = pulls.get(n);
    if (f === undefined)
      return failed("unreadable", `PR #${n}'s facts did not read`);
    if (f.partial !== null)
      return failed("unreadable", `PR #${n}'s facts are partial: ${f.partial}`);
    if (
      onlyLabeled &&
      prefix !== null &&
      !carriesSet({ enabled: true, prefix, onlyLabeled: true }, f.labels)
    )
      continue;
    const r = readiness(
      {
        ...f,
        slug: ctx.address.repo,
        converged: true,
        verifiedSha: l.verifiedSha,
        held: prefix !== null && f.labels.includes(`${prefix}hold`),
      },
      rules,
    );
    // This reader has no serialized-area listing: the board's same ordering
    // can only be certified when no card needs that tie-break.
    cards.push({
      ...r,
      number: n,
      url: "",
      title: "",
      head: f.head,
      unblocks: [],
      since: l.driver.heartbeat,
    });
  }
  return ok(cards);
}

/** A behind head is updated only when it leads the repository's update lane. An unread peer leaves the order unknown. */
export async function updateQueueWait(
  ctx: AskContext,
  ledger: Ledger,
  facts: ForgeFacts,
  rules: ReadyRules,
  prefix: string | null,
  answer: Readiness,
  catalogConfigured: boolean,
  onlyLabeled = false,
): Promise<WaitsOn> {
  const unknown = (why: string): WaitsOn => {
    ctx.reading.note({ record: "update next order", read: false, detail: why });
    return {
      waiting: `the repository's update next order did not read: ${why}`,
    };
  };
  const peers = await peerLedgers(ctx, facts.number, ledger);
  if (!peers.ok) return unknown(peers.failure.reason);
  const ledgers = peers.value;
  const sec = ctx.reading.sourceSec();
  if (sec <= 0) return unknown("the answer deadline expired");
  ctx.reading.forgeCall();
  const read = await readMergeFacts(ctx.address.repo, [...ledgers.keys()], sec);
  if (!read.ok) return unknown(read.failure.reason);
  const placedPeers = peerCards(
    ctx,
    ledgers,
    read.value.pulls,
    rules,
    prefix,
    onlyLabeled,
  );
  if (!placedPeers.ok) return unknown(placedPeers.failure.reason);
  const cards = placedPeers.value;
  // A configured catalog may put a card that unblocks other work first.
  // Without that read this answer cannot certify the repository-wide order.
  if (
    cards.filter((c) => c.lane === "update-next").length > 1 &&
    catalogConfigured
  ) {
    return unknown(
      "the serialized-area order was not read; consult the dispatch board",
    );
  }
  const placed = oneUpdateNext(cards).find((c) => c.number === facts.number);
  if (placed === undefined)
    return unknown("the pull request disappeared from the order");
  ctx.reading.note({ record: "update next order", read: true });
  if (placed.waitsOn.kind === "waiting") return { waiting: placed.says };
  if (placed.lane !== "update-next")
    return unknown("its lane changed while reading the order");
  return { person: "update the branch", why: `update-next: ${answer.says}` };
}
