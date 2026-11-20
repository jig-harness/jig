import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";

/** What a needs-person reason adds when the pull request conflicts with its base. */
export function conflictNote(mergeable: unknown): string {
  return mergeable === "CONFLICTING"
    ? "; its pull request also conflicts with its base"
    : "";
}

function stopTreeWhy(leftWork: boolean | undefined): string {
  return leftWork === true
    ? "in the tree it stopped in, which holds work it left"
    : "in the tree it stopped in, whose work was never measured";
}

export function rearmTree(
  tree: unknown,
  leftWork: boolean | undefined,
): string {
  return tree === null ? "on any account" : stopTreeWhy(leftWork);
}

export function probeEvidence(driver: Ledger["driver"]) {
  const probe = driver.probe;
  return probe === undefined
    ? {}
    : {
        probeState: probe.state,
        probeReason: probe.reason,
        probeFailure: probe.failure ?? null,
      };
}

export function withProbeReason<T extends { class: string; why: string }>(
  placed: T,
  driver: Ledger["driver"],
  exit: number,
  conflict: string,
): T {
  const probe = driver.probe;
  if (probe?.code !== exit) return placed;
  const detail = `${probe.state}: ${probe.reason}`;
  return {
    ...placed,
    why:
      placed.class === "needs-person"
        ? `stopped ${exit} (${detail})${conflict}`
        : `${placed.why}; status probe reported ${detail}`,
  };
}
