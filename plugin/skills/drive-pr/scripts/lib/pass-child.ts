/**
 * Is a driver's pass currently RUNNING, as opposed to merely holding a lock
 * that still refreshes?
 *
 * WHY THIS EXISTS. `--doctor`'s WEDGED verdict (`lib/doctor.ts`) needs a
 * second signal alongside stale `lastProgressAt`: a legitimate long round can
 * go a long time between progress stamps (merge a base, run the full
 * cumulative validation plan, wait on the machine-wide test mutex —
 * `passTimeoutSeconds`'s own header in `drive.ts` budgets NINETY MINUTES for
 * exactly this), so stale progress ALONE cannot distinguish "still working" from
 * "stuck". Whether the pass is still alive under the driver is the other half.
 *
 * WHAT COUNTS AS "A PASS". The pass command is ARBITRARY argv — `claude -p`,
 * `codex exec`, or "whatever else a caller puts after --" (`drive.ts`'s own
 * header, `lib/quota/types.ts`'s header) — so there is no closed set of
 * binaries to match FOR. There IS a closed set to match AGAINST: this skill's
 * own one-shot helper scripts (`drive-status.ts`, `drive-state.ts`,
 * `await-round.ts`, `guarded-push.ts`, `drives.ts`, `drive.ts` itself, every
 * sibling under `<skills>/drive-pr/scripts/` and
 * `<skills>/resolve-review-comments/scripts/`) are things drive.ts and
 * the pass BOTH invoke constantly as routine bookkeeping between and during
 * rounds — a `drive-status.ts` poller is "precisely the thing a wedged driver
 * still has". So the recognizer is an EXCLUSION, not
 * an inclusion: any descendant that is NOT one of this repository's own
 * skill-script invocations counts as evidence a pass (or something the pass
 * itself spawned — `git`, `gh`, `bun test`, the agent binary) is alive.
 *
 * This is deliberately matched on PATH SHAPE
 * (`…/skills/<skill>/scripts/<file>.ts`, no further nesting) rather than
 * an enumerated filename list: a list needs updating every time this skill or
 * `resolve-review-comments` gains a new top-level script, and a forgotten
 * update would silently start counting that script's OWN invocation as "a
 * pass is running" — the false-negative-on-WEDGED direction, which is the one
 * that matters here (see the precision note below). Matching the directory
 * shape instead means a new helper script is excluded automatically, with no
 * list to maintain. `scripts/lib/*.ts` and `scripts/__tests__/**` deliberately
 * do NOT match (no further-nesting is a two-part path, `scripts/<file>.ts`):
 * `lib/` modules are never invoked directly as a process's own argv[1], and a
 * test fixture living under `__tests__/` needs to be able to construct a
 * "this counts as a pass" descendant without fighting its own exclusion list.
 *
 * PRECISION, NOT RECALL, IS THE SAFE DIRECTION HERE. `classifyDrive`'s WEDGED
 * rule requires `passChild === false` SPECIFICALLY (never `null`) alongside
 * stale progress — so an over-eager "yes, a pass is running" verdict does not
 * merely nudge the outcome, it turns it DETERMINISTICALLY into `HEALTHY`
 * (`classifyDrive` returns `HEALTHY` the moment `passChild === true`,
 * whatever `progressAgeMs` says — see that function's own rule 6), while an
 * over-eager "no pass" verdict manufactures a FALSE WEDGED alarm on an
 * honestly long round. Given the arbitrary-argv constraint above, this
 * function is built to err toward the former: excluding a closed, known set
 * and treating everything else as "a pass" over-recognizes in the safe
 * direction, at the cost of occasionally missing a genuine wedge whose only
 * live descendant happens to be a `git status` drive.ts itself spawned for
 * its own bookkeeping (a sub-second, deadlined call — a narrow, self-
 * correcting race with the next `--doctor` invocation, not a standing gap).
 *
 * THE WALK IS PRUNED AT AN EXCLUDED HELPER, not merely skipped — a helper's
 * OWN children are never inspected at all. This was not always true, and the
 * gap it closes is measured: `drive-status.ts` and `ci-hold.ts` each make
 * roughly 7-8 `ghCall`s at up to 30s apiece, so a driver stuck in its
 * converged-CI wait loop (an unbounded `sleep(10); continue;` under `for
 * (;;)` that spawns no pass and stamps no progress — the canonical wedge) has
 * a live `gh` GRANDCHILD of one of its own helper calls a large fraction of
 * the time. A walk that followed helper children found that `gh` process,
 * read it as "not a skill script, therefore a pass", and reported the same
 * genuinely-stuck drive as `WEDGED` on one `--doctor` run and `HEALTHY` on
 * the next few seconds later. Pruning closes it because it can never hide a
 * REAL pass: the pass is always a DIRECT child of the driver (`drive.ts`
 * spawns the agent binary itself, never through an intermediate helper
 * script), so nothing a helper spawns — `gh`, `git`, a further helper it
 * shells out to — can ever BE the pass this probe exists to find.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. Argv can prove "a pass-shaped
 * process exists somewhere under this pid", never "the pass THIS driver
 * spawned, still doing the round it was spawned for" — the identical caveat
 * `drives.ts`'s own `DRIVER_CMD` carries for identifying a driver by argv
 * alone. A process that outlived its own logical round (an orphaned agent
 * retried elsewhere, a leaked subprocess) reads exactly like a healthy one.
 * That is why `hasPassChild` is one INPUT to `classifyDrive`, never a verdict
 * on its own — `DoctorInput.passChild` is combined with lock liveness and
 * progress age, and none of the three is trusted alone.
 */

import { run } from "./proc.ts";

/**
 * `true`/`false` are positive answers; `null` is "the probe could not run or
 * could not be parsed" — no `ps` on `PATH`, a non-zero exit, unparsable
 * output, or a platform (Windows) with no POSIX `ps` at all. `classifyDrive`
 * must never turn `null` into `HEALTHY`; it is `WEDGED`'s own fail-closed
 * requirement (`passChild === false`, never merely falsy) that makes this
 * distinction load-bearing rather than decorative.
 */
export type PassChildAnswer = true | false | null;

/**
 * Any argv naming a top-level script under `drive-pr`'s,
 * `resolve-review-comments`'s or `do-item`'s own `scripts/` directory —
 * `…/skills/(drive-pr|resolve-review-comments|do-item)/scripts/<file>.ts`,
 * whether the skills sit in the plugin install (`…/jig/<version>/skills/…`)
 * or in a consumer's own `.claude/skills/…` override, exactly two path
 * segments past `scripts`, so `scripts/lib/**` and
 * `scripts/__tests__/**` fixtures do not match. `tsArgv()` (`proc.ts`) always
 * produces an ABSOLUTE script path this way, so the substring survives
 * however the containing repository is checked out.
 *
 * The skill segment is DELIBERATELY NOT a wildcard:
 * `drive.ts` accepts an arbitrary pass argv — "whatever else a caller puts
 * after --" per the module header — so a caller may legitimately run another
 * skill's own top-level script as the pass command. A wildcard here would
 * match `…/skills/<any-skill>/scripts/<file>.ts`, prune that live pass
 * as if it were routine bookkeeping, and let `findPassChild` report `false`
 * on a driver that is actually healthy — the exact WEDGED-vs-HEALTHY flap
 * this recognizer's own precision rule (module header) exists to prevent.
 * The exclusion is scoped to the skill families this module's helper
 * scripts actually belong to, not to every skill in the repository.
 *
 * Matched only against the EXECUTABLE position of a command line — see
 * {@link isOwnHelperInvocation} — never searched across the whole string.
 */
const OWN_HELPER_SCRIPT =
  /[\\/]skills[\\/](?:drive-pr|resolve-review-comments|do-item)[\\/]scripts[\\/][^\\/]+\.ts(?=[\s'"]|$)/;

/**
 * Runtime interpreters `tsArgv()` (`proc.ts`) might invoke a helper script
 * through — bun or node are the only two toolchains this skill's scripts run
 * under (`SKILL.md` "Runtime"). Matched by basename only, at the end of the
 * token (bare `bun`/`node` off `PATH`, or an absolute interpreter install
 * path) — that install path is not expected to contain a space the way a
 * checkout directory can, which is exactly why this recognizer never needs
 * to tolerate embedded whitespace the way {@link OWN_HELPER_SCRIPT}'s own
 * path segments do.
 */
const RUNTIME_BASENAME = /(?:^|[\\/])(?:bun|node)(?:\.exe)?$/i;

/**
 * Whether `args` — one process's FULL command line — is a direct invocation
 * of one of this repository's own helper scripts, judged only by its
 * EXECUTABLE position: a direct shebang execution (`argv[0]` IS the script —
 * every fixture in `pass-child.test.ts` is shaped this way) or a runtime
 * binary followed by the script path, which is `tsArgv()`'s own shape:
 * `[process.execPath, scriptPath, ...args]`.
 *
 * Never the WHOLE command line, and never a naive whitespace split either.
 * `OWN_HELPER_SCRIPT.test(cur.args)` used to run unanchored across the
 * entire string, so a real, DIRECT pass whose own prompt or argument merely
 * MENTIONS a helper script path as DATA — not as the thing being executed —
 * was pruned and excluded from the walk exactly like a genuine helper
 * invocation, letting a live pass read as WEDGED. The fix
 * for that restricted the test to "the first two whitespace-delimited
 * tokens" — which broke the moment the checkout itself lives under a path
 * containing a space (`ps ... args=` is flattened display text with no
 * preserved argv boundaries): a script under
 * `/tmp/My Repo/.claude/skills/...` naively splits into `bun` and `/tmp/My`,
 * neither of which matches, so a genuine helper invocation misread as a live
 * pass and stale progress classified HEALTHY instead of WEDGED.
 *
 * Instead of tokenizing at all, the pattern is searched UNANCHORED (its own
 * `[^\\/]+` path segments already tolerate embedded spaces) and the match is
 * accepted only when everything BEFORE it — `prefix` — is a shape `tsArgv()`
 * can actually produce: nothing; a runtime interpreter followed by the start
 * of an absolute path (`tsArgv()`'s own guarantee: the script path it builds
 * is always absolute); or a single shebang path whose OWN leading segments
 * embed a space, with no runtime involved at all.
 *
 * THE SPLIT POINT BETWEEN "RUNTIME" AND "SCRIPT PATH" IS NOT ALWAYS THE
 * FIRST WHITESPACE — a prior revision assumed it was, which broke the
 * moment the RUNTIME's own install path embeds a space
 * (`/Users/John Doe/.bun/bin/bun /repo/.claude/...`): the
 * first whitespace lands inside "John Doe", `runtimeToken` becomes
 * `/Users/John`, `RUNTIME_BASENAME` never matches, and a genuine helper
 * invocation misreads as a live pass. Every whitespace run in `prefix` is
 * now tried as a candidate split, not just the first, so the boundary is
 * found wherever it actually falls.
 *
 * A SINGLE SHEBANG PATH WHOSE OWN CHECKOUT ROOT EMBEDS A SPACE, WITH NO
 * RUNTIME AT ALL, is the other shape the first-whitespace assumption missed
 * (`/tmp/My Repo/.claude/skills/...` executed directly, no interpreter):
 * `prefix` here is "/tmp/My Repo", no candidate split ends in a recognized
 * runtime basename, and the old code fell through to `false`. The
 * distinguishing signal against a GENUINELY different program's argv (`cat
 * /repo/.claude/...`, `/usr/bin/cat /repo/.claude/...`) is that in the
 * legitimate case no whitespace boundary in `prefix` is ever followed by a
 * FRESH absolute path start — "Repo" (continuing the same path) never
 * begins with `/`, where a genuinely separate token always would. A runtime
 * a boundary WOULD justify is still tried first (the loop above), so this
 * fallback only fires once every such candidate has failed.
 */
function isOwnHelperInvocation(args: string): boolean {
  const trimmed = args.trimStart();
  const match = OWN_HELPER_SCRIPT.exec(trimmed);
  if (match === null) return false;
  const prefix = trimmed.slice(0, match.index);
  if (prefix.search(/\s/) === -1) return true;

  // A CLI-FLAG-shaped token (a `-`/`--` immediately at the start, or right
  // after whitespace) anywhere in a candidate's own remainder is decisive
  // evidence that candidate is a DIFFERENT script's own path followed by
  // further flags/arguments that merely MENTION our helper further along,
  // not the executable's own continuing path: `node
  // /repo/pass.ts --prompt /repo/.claude/skills/drive-pr/scripts/drive-
  // state.ts` must not pass merely because its remainder starts with `/`.
  //
  // Deliberately NOT "does a `.` followed by word characters appear before
  // the match": that test fires on an ordinary checkout directory whose own
  // name embeds a period (`/tmp/My.Worktree Repo/.claude/...`), rejecting a
  // genuine own-helper invocation, a misclassification as harmful as the
  // flag-bearing one this guard catches. A `-`/`--` token is a POSIX argv
  // convention no ordinary absolute path segment produces at a word
  // boundary, so it does not share that false-positive class; an
  // adversarial directory literally named `-foo` right after a space is
  // the accepted residual (same class of risk `RUNTIME_BASENAME`'s own doc
  // comment already accepts for an interpreter path).
  const isFlagged = (s: string) => /(?:^|\s)-/.test(s);

  // NEITHER A FLAG NOR A FRESH ABSOLUTE PATH IS THE ONLY SHAPE A "DIFFERENT
  // PROGRAM'S OWN ARGV" CAN TAKE AFTER A RUNTIME-LOOKING TOKEN — a bare
  // RELATIVE positional path does too: `node
  // /repo/pass.ts repo/.claude/skills/drive-pr/scripts/drive-state.ts` has
  // `before` = `node` and `after` = `/repo/pass.ts repo` at the FIRST
  // boundary — `after` starts with `/` and contains no flag, and an
  // `after.startsWith('/')` restart test catches only an ABSOLUTE second
  // argument, not this relative continuation (`repo/.claude/...`).
  //
  // The general fact underlying all three shapes (flagged,
  // absolute-positional and relative-positional):
  // `before` (here, `/repo/pass.ts`) already ends in `.ts` — the exact
  // extension {@link OWN_HELPER_SCRIPT} itself requires — which means
  // `before` is ALREADY a complete, terminated script path in its own
  // right. Whatever follows a whitespace after such a token, flagged or
  // not, absolute or relative, is necessarily a SEPARATE trailing argument,
  // never a continuing fragment of the same embedded-space directory name
  // — no legitimate checkout root ends its own name in exactly `.ts`
  // (the residual for one that does is accepted below, same class as
  // `isFlagged`'s own `-foo`-directory residual).
  //
  // Deliberately NOT "does a `.` followed by word characters appear before
  // the match": that test fires on an ordinary checkout directory whose own
  // name embeds a period (`/tmp/My.Worktree Repo/.claude/...`), rejecting a
  // genuine own-helper invocation, a misclassification as harmful as the
  // flag-bearing one this guard catches. Restricting the extension check to
  // exactly `.ts` (not any `\.\w+$`) avoids reintroducing that same
  // collision: `My.Worktree` does not end in `.ts`, so it is not mistaken
  // for a complete script path the way `pass.ts` is.
  const isCompleteScriptPath = (s: string) => /\.ts$/.test(s);

  // A genuine continuing path may still embed whitespace of its own (the
  // checkout-root-space fixture above), so the test is not "no whitespace
  // in `after`" but: does any boundary WITHIN `after` restart with a FRESH
  // path (absolute, or past what is already a complete `.ts` path) before
  // reaching the match — a signal no single embedded-space path segment
  // ever trips, since neither shape occurs in the middle of one real,
  // continuing directory name.
  const hasFreshPathRestart = (s: string): boolean => {
    for (const ws of s.matchAll(/\s+/g)) {
      const before = s.slice(0, ws.index as number);
      const after = s.slice((ws.index as number) + ws[0].length);
      if (after.startsWith("/") || isCompleteScriptPath(before)) return true;
    }
    return false;
  };

  let freshPathRestart = false;
  for (const ws of prefix.matchAll(/\s+/g)) {
    const before = prefix.slice(0, ws.index as number);
    const after = prefix.slice((ws.index as number) + ws[0].length);
    if (
      RUNTIME_BASENAME.test(before) &&
      after.startsWith("/") &&
      !isFlagged(after) &&
      !hasFreshPathRestart(after)
    ) {
      return true;
    }
    if (after.startsWith("/") || isCompleteScriptPath(before)) {
      freshPathRestart = true;
    }
  }

  // No candidate reduced `prefix` to "a recognized runtime, then nothing but
  // our script's own path". If any boundary restarts a fresh path — absolute,
  // or past what is already a complete `.ts` path — with no runtime to
  // justify it, `prefix` is a DIFFERENT program's own argv merely mentioning
  // our helper further along (with or without a runtime interpreter of its
  // own) — never a single path with an embedded space, since neither shape
  // occurs in the middle of one real, continuing directory name. Otherwise
  // `prefix` is exactly that: one absolute shebang path whose checkout root
  // happens to embed a space, so accept it on `tsArgv()`'s own
  // absolute-path guarantee.
  return !freshPathRestart && prefix.startsWith("/") && !isFlagged(prefix);
}

/** Exported for `pass-child.test.ts` — synthetic fixtures for {@link findPassChild}. */
export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
}

/**
 * Parse `ps -A -o pid=,ppid=,args=` output. `args` is the LAST field and
 * consumes the remainder of the line (a command line legitimately contains
 * whitespace), so this anchors on the first two whitespace-separated tokens
 * rather than a blind `split(/\s+/)`, unlike `parsePsStatRows` above in
 * `proc.ts` — that parser's third field (`stat`) is a single token with
 * nothing after it, so a naive split is safe there and is not here.
 */
export function parsePassChildRows(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number.parseInt(m[1] as string, 10);
    const ppid = Number.parseInt(m[2] as string, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, args: m[3] as string });
  }
  return rows;
}

/**
 * Deadline for the one `ps` call this function makes — the same 5s bound
 * `hasLiveGroupMemberPs` (`proc.ts`) already uses for an equivalent
 * "enumerate every process on this host" probe, chosen there for the same
 * reason: this is a diagnostic sweep, not a step a round is waiting on, so a
 * generous-but-bounded deadline is the right trade — long enough that a
 * merely-busy host does not misreport `null`, short enough that a hung `ps`
 * cannot wedge `--doctor` itself.
 */
const PS_PROBE_TIMEOUT_SEC = 5;

/**
 * The pure tree-walk: given an ALREADY-PARSED process snapshot, does `pid`
 * have a descendant whose argv is not one of this repository's own
 * skill-script invocations? Split out from {@link hasPassChild} so the
 * exclusion-list-plus-tree-walk logic can be unit-tested against synthetic
 * `ProcRow[]` fixtures, never a real spawned `ps` — the whole point being
 * that a WEDGED fixture (a driver whose only descendant is a
 * `drive-status.ts` poller) and a HEALTHY one (a driver whose descendant is
 * an opaque agent binary) can be asserted side by side without depending on
 * what processes happen to be running on the machine the suite executes on.
 *
 * PRUNED AT AN EXCLUDED HELPER — its children are never pushed onto the
 * stack at all (see the module header for the measured WEDGED/HEALTHY flap
 * this fixes, and why pruning can never hide a real pass: the pass is
 * always a DIRECT child of the driver, never nested under one of the
 * driver's own helper calls). A non-excluded node returns immediately, so
 * there is never a reason to look past IT either — in practice this walk
 * only ever inspects `pid`'s direct children, and the stack/visited-set
 * machinery below is what makes that fall out of the general case rather
 * than a special-cased single-level filter, so a future, deliberate
 * widening of the exclusion rule has somewhere to hook a further level
 * without a rewrite.
 *
 * ONE snapshot for the WHOLE reachable set, not one `ps` per level: sharing
 * one ppid→children map, built once, means walking however many levels a
 * given snapshot's exclusion rule ends up inspecting costs one subprocess
 * regardless.
 */
export function findPassChild(pid: number, rows: readonly ProcRow[]): boolean {
  const byPpid = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const children = byPpid.get(row.ppid) ?? [];
    children.push(row);
    byPpid.set(row.ppid, children);
  }

  const stack: ProcRow[] = [...(byPpid.get(pid) ?? [])];
  // Guards a corrupt/cyclic reparent snapshot (a race in the `ps` read
  // itself) from looping forever — real process trees are acyclic, so this
  // never trims a legitimate branch. Vestigial in the common case now that
  // pruning stops the walk at one level for the reason above, but a
  // snapshot naming `pid` itself as its own descendant (a parse-level
  // corruption, not a real reparent) would otherwise still be possible to
  // construct by hand, and this is what refuses to loop on it.
  const visited = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop() as ProcRow;
    if (visited.has(cur.pid)) continue;
    visited.add(cur.pid);
    if (!isOwnHelperInvocation(cur.args)) return true;
    // PRUNED HERE: `cur` is one of this repository's own helper scripts, so
    // its children are never pushed — everything a helper spawns (`gh`,
    // `git`, a further helper) is helper work, never the pass itself.
  }
  return false;
}

/**
 * One `ps -A` read of the whole process table, parsed — or `null` when the
 * probe could not run or could not be parsed (no `ps` on `PATH`, a non-zero
 * exit, an output shape this parser does not recognise, Windows).
 *
 * SEPARATE FROM {@link hasPassChild} so a caller with SEVERAL pids to ask
 * about takes ONE snapshot rather than one per pid. `drives.ts` is exactly
 * that caller: it classifies every drive in the state universe on every
 * invocation — including the plain listing and the `--json` one
 * a status board polls — and `ps -A` on a host running
 * dozens of managed worktrees is the most expensive thing in that sweep. A
 * per-row probe made the sweep's cost linear in the fleet for an answer that
 * is identical across all of them, having been read from one process table
 * moments apart either way.
 *
 * The snapshot is exactly that — a snapshot, not a transaction — so a
 * process that exits between this read and a caller acting on the answer is a
 * race this function does not close, the same residual every liveness check
 * in this skill already accepts (`claimLive`, `pidAlive`). Sharing one
 * snapshot across a sweep does not widen that race in kind: it makes every
 * row's answer consistent with the same instant, rather than each row's
 * answer racing its own separate instant.
 */
export async function snapshotProcesses(): Promise<ProcRow[] | null> {
  const r = await run(["ps", "-A", "-o", "pid=,ppid=,args="], {
    stderr: "ignore",
    timeoutSec: PS_PROBE_TIMEOUT_SEC,
  });
  if (r.spawnFailed || r.code !== 0) return null;
  const rows = parsePassChildRows(r.stdout);
  // `ps -A` always lists at least itself; zero PARSED rows from a
  // successful, non-empty invocation means the output shape did not match
  // what this parser expects (a `ps` variant this skill has not seen) rather
  // than a genuinely process-less host — fail closed rather than read it as
  // "no descendants".
  if (rows.length === 0) return null;
  return rows;
}

/**
 * Does driver `pid` currently have a live descendant that is NOT one of this
 * repository's own skill-script invocations? See the module header for the
 * full recognizer rationale, and {@link findPassChild} for the walk itself.
 *
 * The single-pid convenience form: takes its own snapshot. A caller asking
 * about more than one pid should take one {@link snapshotProcesses} and walk
 * it with {@link findPassChild} instead.
 */
export async function hasPassChild(pid: number): Promise<PassChildAnswer> {
  const rows = await snapshotProcesses();
  if (rows === null) return null;
  return findPassChild(pid, rows);
}
