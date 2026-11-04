/**
 * The small shapes the page repeats: the status mark, the stage chip and the
 * logo. No hooks, so the page a refused request gets can use them with no script.
 */
import type { Role } from "./status.ts";

/** A role's key cap. The recorded word always stands beside it. */
export function Mark({ role }: { role: Role }) {
  return (
    <span className={`mk ${role.rc}`} aria-hidden="true">
      {role.glyph}
    </span>
  );
}

export function StageChip({ mark, stage }: { mark: string; stage: string }) {
  return (
    <span className="chip">
      <b>{mark}</b>
      {stage}
    </span>
  );
}

const PATHS = [
  "m18.67 26.33v4.99c0 0.23-0.19 0.41-0.42 0.41h-5.2c-0.6 0-1.07 0.42-1.07 0.99v5.21c0 0.29-0.22 0.51-0.51 0.51h-5.57c-0.25 0-0.43-0.18-0.43-0.43v-8.99c0-0.5 0.18-0.95 0.53-1.28l1.25-1.22c0.36-0.35 0.86-0.57 1.38-0.57h9.62c0.23 0 0.42 0.16 0.42 0.38z",
  "m21.03 26.33v4.99c0 0.23 0.19 0.41 0.42 0.41h5.16c0.6 0 1.09 0.42 1.09 0.99v5.15c0 0.32 0.23 0.57 0.55 0.57h5.55c0.24 0 0.41-0.15 0.41-0.39v-9.03c0-0.5-0.18-0.95-0.53-1.28l-1.25-1.22c-0.36-0.35-0.86-0.57-1.38-0.57h-9.6c-0.23 0-0.42 0.16-0.42 0.38z",
  "m18.67 53.29v-4.92c0-0.24-0.19-0.42-0.42-0.42h-5.17c-0.61 0-1.1-0.49-1.1-1.1v-5.07c0-0.26-0.2-0.44-0.45-0.44h-5.61c-0.25 0-0.45 0.18-0.45 0.44v8.76c0 0.52 0.21 1.02 0.58 1.39l1.2 1.18c0.38 0.37 0.93 0.6 1.48 0.6h9.52c0.23 0 0.42-0.19 0.42-0.42z",
  "m21.03 53.29v-4.92c0-0.24 0.19-0.42 0.42-0.42h5.16c0.62 0 1.11-0.46 1.11-1.07v-5.07c0-0.26 0.19-0.47 0.45-0.47h5.62c0.24 0 0.42 0.15 0.42 0.4v8.8c0 0.52-0.21 1.02-0.58 1.39l-1.2 1.21c-0.36 0.37-0.88 0.57-1.4 0.57h-9.58c-0.23 0-0.42-0.19-0.42-0.42z",
];

function Logo() {
  return (
    <svg viewBox="-3.15 16.8 46 46" role="img" aria-label="Jig">
      {PATHS.map((d) => (
        <path key={d} fill="var(--ink)" d={d} />
      ))}
      <rect
        fill="var(--accent)"
        x="14.16"
        y="34.07"
        width="11.42"
        height="11.52"
        rx=".6523"
      />
    </svg>
  );
}

/** The status strip: sticky on every viewport, carrying the newest tick's one fact. */
export function Strip({
  main,
  sub,
  alarm,
  version,
}: {
  main: string;
  sub: string;
  alarm: boolean;
  /** `plugin 0.0.0`; left out when nothing was read. */
  version: string | null;
}) {
  return (
    <header className={alarm ? "strip alarm" : "strip"}>
      <div className="stripIn">
        <div className="brand">
          <Logo />
          <span>Dispatch</span>
        </div>
        <div className="tick" aria-live="polite">
          <b className="m">{main}</b> <span className="mut">{sub}</span>
        </div>
        <div className="stripLinks">
          <span className="ver m">
            this host{version === null ? "" : ` · ${version}`}
          </span>
          <a href="#legend">Legend</a>
        </div>
      </div>
    </header>
  );
}
