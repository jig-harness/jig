/** What the Running view's load shows, from the tick's load report (`LineLoad`). */
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

/** The fill a gauge's bar runs to: half again past its line. */
const BAR_TOP = 1.5;

/** Where a gauge's line sits along its bar, in percent of the bar. */
export const LINE_AT = 100 / BAR_TOP;

/** The sentence under the headline, said once: what the figure is. */
export const NOT_A_SUM = "The fullest gauge against its own line, not a sum.";

export interface GaugeRow {
  gauge: LoadGauge;
  name: string;
  /** "150%", or "not read". */
  fill: string;
  /** Whether the host read it; an unread gauge's `reads` is the reason. */
  read: boolean;
  /** Whether it is at or past its line. */
  over: boolean;
  /** Whether its fill is the load factor. */
  binds: boolean;
  /** What it read and its line, or why it read nothing and its line. */
  reads: string;
  /** The bar's fill up to the line, in percent of the bar. */
  under: number;
  /** The bar's fill past the line, in percent of the bar, starting at `LINE_AT`. */
  past: number;
  /** What the bar says to a screen reader. */
  label: string;
}

export interface LoadView {
  /** The headline's figure: "Load 150%", or "Load –" when no gauge read. */
  figure: string;
  /** What follows the figure: "processors binds", or that no gauge read. */
  binds: string;
  gauges: GaugeRow[];
  /** The disclosure under the gauges, titled with its count of launches: "Would have held 2 launches · reservations". */
  title: string;
  reservations: Array<{ kind: string; text: string }>;
  holds: Array<{ key: string; target: string; text: string }>;
}

/** A fill as a percent; one under its line never rounds up to "100%", which reads as at the line. */
const percentOf = (fill: number) =>
  `${fill < 1 ? Math.min(99, Math.round(fill * 100)) : Math.round(fill * 100)}%`;

/** A share of the bar, rounded to a tenth of a percent. */
const ofBar = (fill: number) =>
  Math.round((Math.max(0, fill) / BAR_TOP) * 1000) / 10;

function titleOf(load: LineLoad): string {
  const n = load.holds.length;
  const launches =
    n === 0 ? "no launch" : n === 1 ? "1 launch" : `${n} launches`;
  return `${load.enforce ? "Held" : "Would have held"} ${launches} · reservations`;
}

function rowOf(
  g: LineLoad["gauges"][number],
  binds: LoadGauge | null,
): GaugeRow {
  const name = NAMES[g.gauge];
  const line = `line: ${g.line}`;
  if (g.fill === null)
    return {
      gauge: g.gauge,
      name,
      fill: "not read",
      read: false,
      over: false,
      binds: false,
      reads: `${g.reads} · ${line}`,
      under: 0,
      past: 0,
      label: `${name} not read`,
    };
  const over = g.fill >= 1;
  return {
    gauge: g.gauge,
    name,
    fill: percentOf(g.fill),
    read: true,
    over,
    binds: g.gauge === binds,
    reads: `${g.reads} · ${line}`,
    under: ofBar(Math.min(g.fill, 1)),
    past: over ? ofBar(Math.min(g.fill, BAR_TOP) - 1) : 0,
    label: `${name} at ${percentOf(g.fill)} of its line${over ? ", over it" : ""}`,
  };
}

export function loadView(load: LineLoad): LoadView {
  return {
    figure: `Load ${load.factor === null ? "–" : percentOf(load.factor)}`,
    binds:
      load.binds === null
        ? "no gauge read"
        : `${NAMES[load.binds].toLowerCase()} binds`,
    gauges: load.gauges.map((g) => rowOf(g, load.binds)),
    title: titleOf(load),
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
