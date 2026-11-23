/**
 * Settled recently: below What needs you, what left the line in the last day,
 * folded to one line with its count. Each entry says what it was, when it
 * left, who settled it and how; an answer that was held or refused shows
 * with its reason, its card still open above. One answer that settled several
 * needs is one entry listing their targets.
 */
import { useId, useState } from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { parseMs } from "../../plugin/shared/time.ts";
import { ago } from "./format.ts";
import {
  byWords,
  historyQuery,
  outcomeWords,
  settledIn,
  settledToggle,
} from "./settled-view.ts";
import type { Clock } from "./view.ts";

/** The page's address, which the History link keeps the other parameters of (its token among them); empty where there is no page. */
function here(): { path: string; search: string } {
  return typeof location === "undefined"
    ? { path: "", search: "" }
    : { path: location.pathname, search: location.search };
}

export function SettledRecently({
  line,
  clock,
  open: opened = false,
}: {
  line: Pick<LineSnapshot, "settled">;
  clock: Clock;
  /** Starts open, for a page that renders the list in full. */
  open?: boolean;
}) {
  const [open, setOpen] = useState(opened);
  const id = useId();
  const entries = settledIn(line.settled, clock);
  if (entries.length === 0) return null;
  return (
    <div className="settled">
      <button
        className="heldToggle"
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        {settledToggle(entries.length, open)}
      </button>
      <ul id={id} hidden={!open}>
        {entries.map((e) => (
          <li
            className={`settledEntry sm ${e.outcome}`}
            key={`${e.repo} ${e.targets.join(" ")} ${e.cause} ${e.at} ${e.outcome}`}
          >
            <p>
              <b>{outcomeWords(e)}</b>{" "}
              <span className="m">
                {e.repo} {e.targets.join(", ")}
              </span>
              {e.title === null ? null : <> — {e.title}</>}
              {e.url === null ? null : (
                <>
                  {" "}
                  <a href={e.url} target="_blank" rel="noreferrer">
                    open
                  </a>
                </>
              )}
            </p>
            {e.question === null ? null : <p className="mut">{e.question}</p>}
            <p>
              {ago(parseMs(e.at), clock.nowMs)} ago · by {byWords(e)}
              {e.option === null ? null : <> · chose {e.option}</>}
              {e.recommended === true ? " (the recommended option)" : null}
            </p>
            <p>{e.how}</p>
            <p>
              <a href={`${here().path}${historyQuery(here().search, e)}`}>
                History rows
              </a>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
