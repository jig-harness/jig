/**
 * Termination witness for a captured process set.
 *
 * A target is a process IDENTITY — pid plus start time — never a bare pid: a
 * pid is reused once its owner is reaped, so re-signalling a number would
 * eventually kill an unrelated same-user process. Each step signals only the
 * targets whose identity is still live, and returns those; a target seen dead
 * (absent, a zombie, or its pid now owned by a different start time) is never
 * signalled again.
 */

export interface Target {
  pid: number;
  /** `ps` lstart text; equality is the only comparison made on it. */
  start: string;
}

export interface PsRow extends Target {
  ppid: number;
  stat: string;
}

/** Targets whose identity is still a live (non-zombie) process in `rows`. */
export function liveTargets(targets: Target[], rows: PsRow[]): Target[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  return targets.filter((t) => {
    const row = byPid.get(t.pid);
    return (
      row !== undefined && row.start === t.start && !row.stat.startsWith("Z")
    );
  });
}

/**
 * One witness poll: SIGKILL each still-live target and return them. An empty
 * result is the witness that every captured process is dead. `rows` of `null`
 * (`ps` unavailable) cannot verify identity, so nothing is signalled and
 * liveness falls back to `alive`, failing toward "still running".
 */
export function witnessStep(
  targets: Target[],
  rows: PsRow[] | null,
  kill: (pid: number) => void,
  alive: (pid: number) => boolean,
): Target[] {
  if (rows === null) return targets.filter((t) => alive(t.pid));
  const live = liveTargets(targets, rows);
  for (const t of live) kill(t.pid);
  return live;
}

/**
 * `root` and every process beneath it as identities, leaves first, from one
 * `ps` snapshot. `null` when the snapshot is unavailable: an unreadable
 * process table is an UNRESOLVED capture, never an empty tree and never a
 * root with an invented identity — a caller retries it. A root absent from a
 * readable snapshot is already dead and contributes no target.
 */
export function captureTree(
  root: number,
  rows: PsRow[] | null,
): Target[] | null {
  if (rows === null) return null;
  const rootRow = rows.find((r) => r.pid === root);
  if (rootRow === undefined) return [];
  const order: Target[] = [];
  const seen = new Set<number>();
  const visit = (row: PsRow) => {
    if (seen.has(row.pid)) return;
    seen.add(row.pid);
    for (const r of rows) if (r.ppid === row.pid) visit(r);
    order.push({ pid: row.pid, start: row.start });
  };
  visit(rootRow);
  return order;
}

export type Recapture =
  | { kind: "unresolved" }
  | { kind: "unverifiable" }
  | { kind: "tree"; root: Target; targets: Target[] };

/**
 * Recapture the tree under `root` only while `root`'s ORIGINAL identity is
 * provably what owns that number. A pid proves nothing once its owner is
 * reaped, so a capture never adopts whichever row currently holds it:
 *
 * - `unresolved`: `ps` unreadable — retry; nothing is known.
 * - `unverifiable`: no identity was ever recorded and the root is reaped or
 *   absent, so a row under that pid (or none) says nothing about the command.
 *   Its descendants cannot be witnessed; the caller must say so, not claim
 *   termination.
 * - `tree`: `root` is the identity to remember; `targets` is the tree, or
 *   empty when the recorded root is gone or its pid now belongs to a stranger
 *   (never signalled).
 */
export function recaptureOwned(
  root: number,
  identity: Target | null,
  rootReaped: boolean,
  rows: PsRow[] | null,
): Recapture {
  if (rows === null) return { kind: "unresolved" };
  const row = rows.find((r) => r.pid === root);
  if (identity === null) {
    if (row === undefined || rootReaped) return { kind: "unverifiable" };
    return {
      kind: "tree",
      root: { pid: row.pid, start: row.start },
      targets: captureTree(root, rows) ?? [],
    };
  }
  if (row === undefined || row.start !== identity.start) {
    return { kind: "tree", root: identity, targets: [] };
  }
  return {
    kind: "tree",
    root: identity,
    targets: captureTree(root, rows) ?? [],
  };
}
