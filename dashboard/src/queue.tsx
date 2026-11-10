import { FollowupBadge } from "./followups.tsx";
import { Pr, RepoLink } from "./pr.tsx";
/**
 * What is coming, ordered by what will happen to each target rather than where
 * it came from. The cap at the foot says items cannot be added here; it is never
 * a control.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { Evidence, Fold, PanelHelp, SourceHint } from "./fold.tsx";
import { queueCard } from "./cards.ts";
import { cardAttrs } from "./keys.ts";
import { Mark } from "./marks.tsx";
import { MoreToggle, SHOWN_CLOSED, useShowAll } from "./more.tsx";
import { type QueueItemView, queueGroups } from "./queue-view.ts";
import type { Clock } from "./view.ts";

function QueueItem({ item, rest }: { item: QueueItemView; rest: boolean }) {
  return (
    <div
      className={rest ? "qItem rest" : "qItem"}
      {...cardAttrs(queueCard(item))}
    >
      <div className="rowTop">
        <Mark role={item.role} />
        <Pr repo={item.repo} target={item.target} url={item.url} />
        <RepoLink repo={item.repo} url={item.url} />
        <SourceHint source={item.source} />
        <FollowupBadge label={item.followup} />
        {item.wait === null ? null : (
          <span className="m sm mut end nowrap">{item.wait}</span>
        )}
      </div>
      {item.title === null ? null : <div className="sm">{item.title}</div>}
      {item.why === null ? null : <div className="sm mut qWhy">{item.why}</div>}
      <div className="goto">
        <Fold label={`The record for ${item.target}`}>
          <Evidence rows={item.evidence} />
        </Fold>
      </div>
    </div>
  );
}

export function QueuePanel({
  line,
  clock,
}: {
  line: LineSnapshot | null;
  clock: Clock;
}) {
  const [all, setAll, panel] = useShowAll();
  const groups = line === null ? [] : queueGroups(line, clock);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  let seen = 0;
  return (
    <section
      className="panel pQueue"
      id="queue"
      aria-labelledby="h-queue"
      ref={panel}
    >
      <div className="panelHead">
        <h2 id="h-queue">What is coming</h2>
        <PanelHelp panel="What is coming">
          What the next ticks will do with each target, in the order it will
          happen: started when an account has a free slot, held, reported
          without starting, or never started. Hover a source to see where an
          item came from.
        </PanelHelp>
        <MoreToggle count={total} all={all} setAll={setAll} where="head" />
      </div>
      {total > 0 ? null : (
        <p className="emptyLine">
          {line === null
            ? "Nothing queued: no tick has read the tracker or the forge."
            : "Nothing queued. No item is assigned to the factory identity; no pull request is re-armable, labelled or held."}
        </p>
      )}
      <div className={all ? "qList all" : "qList"}>
        {groups.map((g, i) => (
          <div className={i === 0 ? "qGroup first" : "qGroup"} key={g.group}>
            <h3>{g.title}</h3>
            {g.note === null ? null : (
              <p className={`sm mut gnote${g.keepNote ? " keep" : ""}`}>
                {g.note}
              </p>
            )}
            {g.items.map((item) => {
              const rest = seen >= SHOWN_CLOSED;
              seen++;
              return <QueueItem item={item} rest={rest} key={item.rowKey} />;
            })}
          </div>
        ))}
        <MoreToggle count={total} all={all} setAll={setAll} where="foot" />
      </div>
      <div className="ghost">
        <span className="mk plan" aria-hidden="true" />
        <p>
          Added by hand: not available. Items enter from a tracker assignment or
          the <span className="m">drive</span> label; this page writes nothing.
        </p>
      </div>
    </section>
  );
}
