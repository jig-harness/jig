import { FollowupBadge } from "./followups.tsx";
import { runningFollowup } from "./followup-view.ts";
import { ItemTitle } from "./pr.tsx";
import { LinkedDetail, WorkLead } from "./work.tsx";
/**
 * What is running: accounts and sessions as one surface. Each account is a row
 * and each held slot a box inside it, so which session holds which slot is a
 * position rather than a join.
 */
import type {
  LineRepo,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { Evidence, Hint, PanelHelp, Pips, StageHint, Term } from "./fold.tsx";
import { slotCard } from "./cards.ts";
import { GutterCard, GutterFold } from "./gutter.tsx";
import { cardAttrs } from "./keys.ts";
import { BareWord } from "./icon-word.tsx";
import { ACCOUNT_ICONS } from "./icons.ts";
import { LoadGauge } from "./load.tsx";
import { Mark } from "./marks.tsx";
import { TERMS } from "./status.ts";
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
    <GutterCard
      className="slot"
      attrs={cardAttrs(slotCard(slot, "running"))}
      label={`Evidence for ${slot.target}`}
      face={
        <>
          <div className="rowTop">
            <Mark role={slot.role} />
            <WorkLead
              repo={slot.repo}
              target={slot.target}
              url={slot.url}
              title={slot.title}
              links={slot.links}
            />
            <StageHint stage={slot.stage} />
            <FollowupBadge
              label={
                slot.stage === "followup" ? runningFollowup(slot.kind) : null
              }
            />
          </div>
          <ItemTitle title={slot.title} />
          {slot.noLink === null ? null : (
            <span className="noLink">{slot.noLink}</span>
          )}
          <div className="slotFact">{slot.fact}</div>
        </>
      }
      detail={
        <>
          <Evidence rows={slot.evidence} />
          <LinkedDetail
            repo={slot.repo}
            target={slot.target}
            links={slot.links}
          />
        </>
      }
    />
  );
}

/** The repositories and how each was read; one whose tracker part is kept from an earlier reading carries a mark and that reading's time. */
export function RepoRows({
  repos,
  clock,
}: {
  repos: LineRepo[];
  clock: Clock;
}) {
  return (
    <dl className="kv">
      {repos.map((r) => {
        const row = repoRow(r, clock);
        return (
          <div key={r.path} style={{ display: "contents" }}>
            <dt className="m">{row.slug}</dt>
            <dd>
              {row.note}
              {row.kept === null ? null : (
                <div className="trackerKept">
                  <span className="chip">tracker kept</span>{" "}
                  <span className="sm">{row.kept}</span>
                </div>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
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
      <LoadGauge line={line} />
      <div className="terms sm mut">
        <span>Reading it:</span>
        {TERMS.map((t) => (
          <Term word={t.word} key={t.word}>
            {t.meaning}
          </Term>
        ))}
      </div>
      {line === null || line.accounts.length === 0 ? null : (
        <GutterFold
          className="acctList"
          label="Accounts and their slots"
          defaultOpen
          keepMounted
          head={<h3 className="sm">Accounts · {line.accounts.length}</h3>}
        >
          {line.accounts.map((a) => {
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
                    <BareWord
                      of={ACCOUNT_ICONS[account.state]}
                      className="sm end"
                    />
                  )}
                </div>
                <div className="m sm">{account.weightText}</div>
                {account.stagesText === null ? null : (
                  <div className="m sm">{account.stagesText}</div>
                )}
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
        </GutterFold>
      )}
      {line === null || line.repos.length === 0 ? null : (
        <GutterFold
          className="repoList"
          label="The repositories and how each was read"
          head={<span className="sm">{repoSummary(line.repos)}</span>}
        >
          <RepoRows repos={line.repos} clock={clock} />
        </GutterFold>
      )}
    </section>
  );
}
