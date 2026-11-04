/**
 * The line: accounts and sessions as one surface. Each account is a row and each
 * held slot a box inside it, so which session holds which slot is a position
 * rather than a join.
 */
import type { ReactNode } from "react";
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { Evidence, Fold, Pips, Term } from "./fold.tsx";
import { Mark, StageChip } from "./marks.tsx";
import { ROLES } from "./status.ts";
import {
  accountView,
  asOfOf,
  type Clock,
  repoRow,
  repoSummary,
  slotSummary,
  slotView,
  type SlotView,
} from "./view.ts";

const TERMS: Array<{ word: string; meaning: ReactNode }> = [
  {
    word: "slot",
    meaning:
      "One of an account’s concurrent-session places, held by a launch record that is pending, alive or unknown. A takeover and the record it replaces count as one. A parked drive holds none.",
  },
  {
    word: "wall",
    meaning:
      "A subscription account’s usage limit, recorded once a session stops on it. The account is left out of every launch until the wall’s reset.",
  },
  {
    word: "rearm",
    meaning:
      "Restarting a stopped drive, the unattended review loop on a pull request. A takeover replaces a wedged driver’s slot with a new one.",
  },
  {
    word: "drifting",
    meaning:
      "A running stage outside its expectation: threads not falling, no pull request in time. Reported and notified, never acted on.",
  },
  {
    word: "nudge",
    meaning:
      "The one fixed prompt the dispatcher may send by itself: “continue”, to a session waiting after a usage limit that has since reset.",
  },
];

function Slot({ slot }: { slot: SlotView }) {
  return (
    <div className="slot">
      <div className="rowTop">
        <Mark role={slot.role} />
        {slot.url === null ? (
          <span className="tgt">{slot.target}</span>
        ) : (
          <a
            className="tgt"
            href={slot.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {slot.target}
          </a>
        )}
        <StageChip mark={slot.mark} stage={slot.stage} />
      </div>
      <div className="slotLow">
        <div className="slotFact">{slot.fact}</div>
        <Fold label="Evidence">
          <Evidence rows={slot.evidence} />
        </Fold>
      </div>
    </div>
  );
}

export function LinePanel({
  line,
  clock,
}: {
  line: LineSnapshot | null;
  clock: Clock;
}) {
  const slots =
    line === null ? [] : line.sessions.map((s) => slotView(s, clock, line));
  return (
    <section className="panel pLine" id="line" aria-labelledby="h-line">
      <div className="panelHead">
        <h2 id="h-line">The line</h2>
        {line === null ? null : (
          <span className="m sm">
            {slotSummary(line.accounts, clock.nowMs)}
          </span>
        )}
        <span className="asof m">{asOfOf(line, clock.timeZone)}</span>
      </div>
      <div className="terms sm mut">
        <span>Reading it:</span>
        {TERMS.map((t) => (
          <Term word={t.word} key={t.word}>
            {t.meaning}
          </Term>
        ))}
      </div>
      {line?.accounts.map((a) => {
        const account = accountView(a, clock);
        const mine = slots.filter((s) => s.account === a.name);
        return (
          <div className="acct" key={a.name}>
            <div className="acctHead">
              <span className="m acctName">{account.name}</span>
              <span className="chip">{account.vendor}</span>
              <span className="pips" aria-hidden="true">
                <Pips on={account.pips} />
              </span>
              <span className="m sm">{account.heldText}</span>
              {account.state === null ? null : (
                <span className="sm end">
                  <Mark role={ROLES.held} /> {account.state}
                </span>
              )}
            </div>
            {account.wall === null ? null : (
              <div className="wallLine m">{account.wall}</div>
            )}
            {mine.length === 0 ? null : (
              <div className="slots">
                {mine.map((slot) => (
                  <Slot slot={slot} key={slot.record} />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {line === null || line.repos.length === 0 ? null : (
        <Fold label={repoSummary(line.repos)}>
          <dl className="kv">
            {line.repos.map((r) => {
              const row = repoRow(r);
              return (
                <div key={r.path} style={{ display: "contents" }}>
                  <dt className="m">{row.slug}</dt>
                  <dd>{row.note}</dd>
                </div>
              );
            })}
          </dl>
        </Fold>
      )}
    </section>
  );
}
