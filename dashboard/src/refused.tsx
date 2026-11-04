/**
 * What a wrong token sees: nothing was read, so nothing is shown but the refusal
 * and what to do. `Refused` also renders with no props at build time, into the
 * page the server sends a bad token, which has no script: it holds no hooks, its
 * folds are native, and it has no Copy buttons, since those need a script.
 */
import type { ReactNode } from "react";
import { type FoldComponent, Legend } from "./legend.tsx";
import { Strip } from "./marks.tsx";

const NativeFold: FoldComponent = ({ label, children }) => (
  <details className="fold">
    <summary>{label}</summary>
    {children}
  </details>
);

export function Refused({
  scheme = "light dark",
  copyCommand,
  Fold = NativeFold,
  children,
}: {
  scheme?: string;
  /** The Copy button beside the command, on the live page. */
  copyCommand?: ReactNode;
  Fold?: FoldComponent;
  /** What the live page keeps beside the refusal. */
  children?: ReactNode;
}) {
  return (
    <div className="dd" style={{ colorScheme: scheme }}>
      <Strip
        main="Newest tick not known"
        sub="the server refused this request"
        alarm
        version={null}
      />
      <main className="main">
        <section className="panel" aria-labelledby="h-ref">
          <h2 id="h-ref">
            The server refused this request: the token does not match.
          </h2>
          <p className="refusalBody">
            Every request needs the token minted when the server started. A
            restart mints a new one, so an older link stops working. Open the
            URL the command printed, or start it on the host:
          </p>
          <div className="quote path">jig dispatch dashboard</div>
          {copyCommand === undefined ? null : (
            <div className="copyRow">{copyCommand}</div>
          )}
          <p className="sm mut">Nothing was read, so nothing is shown.</p>
        </section>
      </main>
      <footer className="foot">
        <Legend Fold={Fold} />
        <div className="colophon m">
          <span>this host</span>
          <span>not read</span>
          <span>
            read-only: this page sends GET requests and writes nothing; Copy
            touches only your clipboard
          </span>
        </div>
      </footer>
      {children}
    </div>
  );
}
