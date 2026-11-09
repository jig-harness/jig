/** What the Running view's load gauge shows, from the tick's load report (`LineLoad`). */
import type {
  LineLoad,
  LoadGauge,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";

const NAMES: Record<LoadGauge, string> = {
  memory: "Memory",
  processors: "Processors",
  "test-lock": "Test lock",
  disk: "Disk",
  forge: "Forge budget",
  accounts: "Accounts",
};

const GIB = 1024 ** 3;

export interface LoadView {
  /** "82%", or "–" when no gauge read. */
  percent: string;
  /** The bar's width, 0 to 100. */
  width: number;
  /** Whether the fullest gauge is at or past its line. */
  over: boolean;
  /** "memory binds", or that no gauge read. */
  binds: string;
  /** What the load factor did with the launches: held them, or would have. */
  summary: string;
  gauges: Array<{ name: string; fill: string; reads: string; line: string }>;
  reservations: Array<{ kind: string; text: string }>;
  holds: Array<{ key: string; target: string; text: string }>;
}

const percentOf = (fill: number) => `${Math.round(fill * 100)}%`;

function summaryOf(load: LineLoad): string {
  const n = load.holds.length;
  const launches = n === 1 ? "1 launch" : `${n} launches`;
  if (load.enforce)
    return n === 0
      ? "Enforced: no launch held this tick."
      : `Enforced: ${launches} held this tick.`;
  return n === 0
    ? "Reporting only: no launch would have been held this tick."
    : `Reporting only: ${launches} would have been held this tick.`;
}

export function loadView(load: LineLoad): LoadView {
  const factor = load.factor;
  return {
    percent: factor === null ? "–" : percentOf(factor),
    width: factor === null ? 0 : Math.max(0, Math.min(100, factor * 100)),
    over: factor !== null && factor >= 1,
    binds:
      load.binds === null
        ? "no gauge read"
        : `${NAMES[load.binds].toLowerCase()} binds`,
    summary: summaryOf(load),
    gauges: load.gauges.map((g) => ({
      name: NAMES[g.gauge],
      fill: g.fill === null ? "not read" : percentOf(g.fill),
      reads: g.reads,
      line: g.line,
    })),
    reservations: load.reservations.map((r) => ({
      kind: r.kind,
      text: `${(r.bytes / GIB).toFixed(1)} GiB, ${r.measured ? `measured over ${r.samples} samples` : `default (${r.samples} of 5 samples)`}`,
    })),
    holds: load.holds.map((h) => ({
      key: `${h.repo} ${h.target} ${h.kind}`,
      target: `${h.repo} ${h.target}`,
      text: `${h.held ? "held" : "would hold"} the ${h.kind}: ${h.detail}`,
    })),
  };
}
