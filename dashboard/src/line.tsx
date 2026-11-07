import { FollowupBadge } from "./followups.tsx";
import { runningFollowup } from "./followup-view.ts";
import { Pr } from "./pr.tsx";
/**
 * What is running: accounts and sessions as one surface. Each account is a row
 * and each held slot a box inside it, so which session holds which slot is a
 * position rather than a join.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  Evidence,
  Fold,
  Hint,
  PanelHelp,
  Pips,
  StageHint,
  Term,
} from "./fold.tsx";
import { Mark } from "./marks.tsx";
import { ROLES, TERMS } from "./status.ts";
import {
  accountView,
  type Clock,
  repoRow,
  repoSummary,
  slotSummary,
  slotView,
  type SlotView,
} from "./view.ts";

function Slot({ slot }: { slot: SlotView }) {
  return (
    <div className="slot">
      <div className="rowTop">
        <Mark role={slot.role} />
        <Pr repo={slot.repo} target={slot.target} url={slot.url} />
        <StageHint mark={slot.mark} stage={slot.stage} />
        <FollowupBadge
          label={slot.stage === "followup" ? runningFollowup(slot.kind) : null}
        />
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
        <h2 id="h-line">What is running</h2>
        <PanelHelp panel="What is running">
          Each account the machine file lists, with its concurrent-session
          slots. A box is one slot and the session holding it; an account at its
          cap or behind a usage wall gets no new launch until a slot frees or
          the wall resets.
        </PanelHelp>
        {line === null ? null : (
          <span className="m sm">
            {slotSummary(line.accounts, clock.nowMs)}
          </span>
        )}
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
              <Hint
                className="pips pipsBtn"
                label={`${account.name} slots`}
                trigger={<Pips on={account.pips} />}
              >
                One square per concurrent-session slot on {account.name}; a
                filled one is held by a session: {account.heldText} held.
              </Hint>
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
