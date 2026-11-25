/**
 * `drive-state.ts record-paths`: file one round's finding anchors, and the
 * round's facts for the structural-churn brake, into the stored window.
 *
 * Three input forms: repeated `--path`, newline-delimited paths on stdin
 * (`--stdin`), or one JSON object on stdin (`--stdin-json`:
 * `{"paths": [...], "severe"?: bool, "blobs"?: {path: id}, "round"?: n}`,
 * `churn-facts.ts`). A `round` binds the write to that round: when a later
 * round was counted, the entry is kept and the judged round's facts are
 * stripped (exit 3) so evidence the recheck rejected cannot be judged later.
 * The first two record paths alone, as they always have; only the JSON form
 * records the facts.
 */
import { fail, readStdinAll } from "../cli.ts";
import { parseRoundInput, type RoundFacts } from "./churn-facts.ts";
import {
  foldRoundPaths,
  normalizeRoundPathsUncapped,
  ROUND_PATHS_MAX_PER_ROUND,
} from "./round-paths.ts";
import type { RoundPaths } from "./round-paths.ts";
import type { StateStore } from "./store.ts";

interface RecordPathsArgs {
  paths: string[];
  stdin: boolean;
  stdinJson: boolean;
}

async function readInput(a: RecordPathsArgs): Promise<{
  paths: string[];
  facts: RoundFacts;
  round?: number;
  judged?: RoundFacts;
}> {
  if (!a.stdinJson)
    return {
      paths: a.stdin ? (await readStdinAll()).split("\n") : a.paths,
      facts: {},
    };
  const read = parseRoundInput(await readStdinAll());
  if ("problem" in read) fail(2, `record-paths --stdin-json: ${read.problem}`);
  return read;
}

export async function recordPathsCommand(
  store: StateStore,
  pr: string,
  a: RecordPathsArgs,
): Promise<number> {
  // Keyed to the CURRENT round rather than to a `--round` argument, and
  // read inside the same locked update that writes it. A caller-supplied
  // round could name one that never happened, or straddle a concurrent
  // `bump-round` and file this round's anchors under the last one — which
  // would fabricate a same-file pair out of one round's findings read
  // twice, the single false positive this signal cannot afford.
  //
  // Replace-not-append for the same reason `bump-round` counts heads: a
  // second pass on an unmoved head re-enumerates the SAME threads, and an
  // appended second entry for one round would let a drive that pushed
  // nothing arm an escalation against itself.
  //
  // Reading stdin is behind an EXPLICIT `--stdin` or `--stdin-json`, never
  // inferred from "no `--path` was given". Inferring it makes two
  // indistinguishable cases ambiguous — a round that genuinely found nothing
  // on any file, and a caller that meant to pipe paths — and resolves them by
  // BLOCKING on whatever descriptor happens to be attached: an inherited pipe
  // that never closes hangs the command with no output to say why, and a
  // terminal hangs it forever. An empty `--path` list is a real answer here,
  // so it must not be the trigger for asking a different source.
  if ([a.stdin, a.stdinJson, a.paths.length > 0].filter(Boolean).length > 1) {
    fail(2, "record-paths takes one of --path, --stdin or --stdin-json");
  }
  // Round 0 is not a counted round — `freshState` starts there and
  // `bump-round`/`bump-attempt` is what advances past it. Recording anchors
  // under it would store a `{round: 0, ...}` entry that becomes adjacent to
  // round 1's real entry the moment counting begins, letting
  // `structuralEscalationArmed` treat a pre-counting call and the actual
  // first round as a false two-round recurrence on any shared path.
  // `drive-status.ts`'s own path here always bumps first, so this only ever
  // refuses a direct, out-of-order call.
  if (store.read().state.rounds < 1) {
    fail(
      2,
      `record-paths: #${pr} has not counted a round yet (rounds=0) — run drive-status.ts (which bumps first) or drive-state.ts bump-round/bump-attempt before recording anchors`,
    );
  }
  const {
    paths: raw,
    facts,
    round: expectedRound,
    judged,
  } = await readInput(a);
  // The cap `foldRoundPaths` applies is silent by construction — sort,
  // then slice — so a round with genuinely more distinct anchor paths
  // than the cap loses the overflow with nothing in the stored state
  // recording that it happened. Measured here, before the write, against
  // the SAME filtering `foldRoundPaths` itself applies (never a
  // hand-rolled trim/dedupe that could drift from it), so the warning is
  // never wrong about what the cap actually dropped.
  const distinct = normalizeRoundPathsUncapped(raw);
  if (distinct.length > ROUND_PATHS_MAX_PER_ROUND) {
    console.error(
      `record-paths: #${pr} round ${store.read().state.rounds} has ${distinct.length} distinct anchor path(s), exceeding the ${ROUND_PATHS_MAX_PER_ROUND}-path cap — ${distinct.length - ROUND_PATHS_MAX_PER_ROUND} dropped and will not feed structuralEscalationDue`,
    );
  }
  // A write bound to a judged round (`"round"` in the JSON form) is checked
  // under the same lock that writes it: when the drive has counted a later
  // round, the entry it meant to replace is already gone, and writing now
  // would overwrite the newer observation with the older one.
  let stale = false;
  // A write that names the facts it judged strips only an entry still
  // carrying exactly those: a replacement measurement of the same round
  // (a retry on the same head) is another gate's evidence and stays.
  const sameFacts = (e: RoundPaths): boolean =>
    judged === undefined ||
    (e.severe === judged.severe &&
      JSON.stringify(Object.entries(e.blobs ?? {}).sort()) ===
        JSON.stringify(Object.entries(judged.blobs ?? {}).sort()));
  const hasFacts = (s: { roundPaths: readonly RoundPaths[] }): boolean =>
    s.roundPaths.some(
      (e) =>
        e.round === expectedRound &&
        (e.severe !== undefined || e.blobs !== undefined) &&
        sameFacts(e),
    );
  if (
    expectedRound !== undefined &&
    store.read().state.rounds !== expectedRound &&
    !hasFacts(store.read().state)
  ) {
    console.error(
      `record-paths: #${pr} is at round ${store.read().state.rounds}, not the round ${expectedRound} this write was bound to — the judged round's facts were withdrawn`,
    );
    return 3;
  }
  await store.update((s) => {
    stale = expectedRound !== undefined && s.rounds !== expectedRound;
    // The same round, but another gate's measurement stands: keep it.
    if (
      judged !== undefined &&
      expectedRound !== undefined &&
      !stale &&
      s.roundPaths.some((e) => e.round === expectedRound && !sameFacts(e))
    )
      return s;
    // A later round was counted: keep its entry, and strip the judged
    // round's facts so a later gate cannot park on evidence the recheck
    // rejected.
    if (stale)
      return {
        ...s,
        roundPaths: s.roundPaths.map((e) => {
          if (e.round !== expectedRound || !sameFacts(e)) return e;
          const { severe: _s, blobs: _b, ...rest } = e;
          return rest;
        }),
      };
    return {
      ...s,
      roundPaths: foldRoundPaths(
        s.roundPaths,
        s.rounds,
        raw,
        s.lastEscalatedRound,
        facts,
      ),
    };
  });
  if (stale) {
    console.error(
      `record-paths: #${pr} is at round ${store.read().state.rounds}, not the round ${expectedRound} this write was bound to — the judged round's facts were withdrawn`,
    );
    return 3;
  }
  process.stdout.write(`${JSON.stringify(store.read().state.roundPaths)}\n`);
  return 0;
}
