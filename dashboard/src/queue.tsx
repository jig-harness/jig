import { GitBranch } from "lucide-react";
import { useState } from "react";
import { FollowupBadge } from "./followups.tsx";
import { RepoLink } from "./pr.tsx";
import { LinkedDetail, WorkLead } from "./work.tsx";
/**
 * What is coming, ordered by what will happen to each target rather than where
 * it came from, or grouped by repository or source on a person's choice. What
 * starts next always leads and never folds; every other group is a heading that
 * folds. The cap at the foot says items cannot be added here; it is never a
 * control.
 */
import type { LineSnapshot } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  DEFAULT_QUEUE_GROUPING,
  facetAttrs,
  type QueueGrouping,
} from "./facets.ts";
import { Evidence, PanelHelp, SourceHint } from "./fold.tsx";
import { GutterCard, GutterFold } from "./gutter.tsx";
import { queueCard } from "./cards.ts";
import { BareWord, Glyph } from "./icon-word.tsx";
import { GROUP_ICONS, type IconWord, iconOf, SOURCE_ICONS } from "./icons.ts";
import { cardAttrs } from "./keys.ts";
import { Mark } from "./marks.tsx";
import { MoreToggle, SHOWN_CLOSED, useShowAll } from "./more.tsx";
import {
  type QueueItemView,
  queueGroups,
  type QueueSectionView,
  queueSections,
} from "./queue-view.ts";
import type { Clock } from "./view.ts";

function QueueItem({
  item,
  rest,
  showHappens,
}: {
  item: QueueItemView;
  rest: boolean;
  /** Whether the card shows what will happen to it, where no heading does; the filter reads it either way. */
  showHappens: boolean;
}) {
  return (
    <GutterCard
      className={rest ? "qItem rest" : "qItem"}
      attrs={{
        ...cardAttrs(queueCard(item)),
        ...facetAttrs({
          repo: [item.repo],
          source: [item.source],
          kind: [item.kind],
          happens: [item.group],
        }),
        ...(item.refusal === null ? {} : { "data-group-why": item.refusal }),
      }}
      label={`The record for ${item.target}`}
      face={
        <>
          <div className="rowTop">
            <Mark role={item.role} />
            <WorkLead
              repo={item.repo}
              target={item.target}
              url={item.url}
              title={item.title}
              links={item.links}
            />
            {item.wait === null ? null : (
              <span className="m sm mut end nowrap">{item.wait}</span>
            )}
            <span className="br" />
            <RepoLink repo={item.repo} url={item.url} />
            <SourceHint source={item.source} />
            <BareWord
              of={iconOf(GROUP_ICONS, item.group)}
              className={showHappens ? "sm qHappens" : "sm qHappens vh"}
            >
              {item.happens}
            </BareWord>
            <FollowupBadge label={item.followup} />
          </div>
          {item.title === null ? null : <div className="sm">{item.title}</div>}
          {item.why === null ? null : (
            <div className="sm mut qWhy">{item.why}</div>
          )}
        </>
      }
      detail={
        <>
          <Evidence rows={item.evidence} />
          <LinkedDetail
            repo={item.repo}
            target={item.target}
            links={item.links}
          />
        </>
      }
    />
  );
}

/** What a section's heading draws beside its title. */
function sectionIcon(section: QueueSectionView): IconWord {
  switch (section.by) {
    case "source":
      return iconOf(SOURCE_ICONS, section.value);
    case "repo":
      return { icon: GitBranch, word: section.value };
    default:
      return iconOf(GROUP_ICONS, section.value);
  }
}

function SectionTitle({
  section,
  className,
}: {
  section: QueueSectionView;
  className?: string;
}) {
  return (
    <h3 className={`needGroupTitle${className ? ` ${className}` : ""}`}>
      <span className="headWord">
        <Glyph of={sectionIcon(section)} size={16} />
        {section.title}
      </span>{" "}
      <span className="m" data-group-count="">
        {section.items.length}
      </span>
      {section.reasons === null ? null : (
        <>
          {" "}
          <span className="sm mut" data-group-why="">
            {section.reasons}
          </span>
        </>
      )}
    </h3>
  );
}

function SectionCards({ section }: { section: QueueSectionView }) {
  return (
    <>
      {section.note === null ? null : (
        <p className={`sm mut gnote${section.keepNote ? " keep" : ""}`}>
          {section.note}
        </p>
      )}
      {section.items.map((item, i) => (
        <QueueItem
          item={item}
          rest={!section.startsFolded && i >= SHOWN_CLOSED}
          showHappens={section.by !== DEFAULT_QUEUE_GROUPING}
          key={item.rowKey}
        />
      ))}
    </>
  );
}

function QueueSection({
  section,
  filterActive,
  filterKey,
}: {
  section: QueueSectionView;
  filterActive: boolean;
  filterKey: string;
}) {
  // Only the first read folds a group: a later one must not close it on the person.
  const [startsFolded] = useState(section.startsFolded);
  if (section.title === null) return <SectionCards section={section} />;
  return (
    <div data-facet-group="">
      {section.fixed ? (
        <>
          <SectionTitle section={section} className="groupWord qFixed" />
          <SectionCards section={section} />
        </>
      ) : (
        <GutterFold
          className="qFold"
          label={`${section.title} group`}
          defaultOpen={filterActive || !startsFolded}
          resetKey={filterKey}
          keepMounted
          head={<SectionTitle section={section} />}
        >
          <SectionCards section={section} />
        </GutterFold>
      )}
    </div>
  );
}

export function QueuePanel({
  line,
  clock,
  grouping = DEFAULT_QUEUE_GROUPING,
  filterActive = false,
  filterKey = "",
}: {
  line: LineSnapshot | null;
  clock: Clock;
  grouping?: QueueGrouping;
  filterActive?: boolean;
  /** Changes whenever the card filter does, reopening matching groups. */
  filterKey?: string;
}) {
  const [all, setAll, panel] = useShowAll();
  const groups = line === null ? [] : queueGroups(line, clock);
  const sections = queueSections(groups, grouping);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  // On a phone a section shows its first cards, and one that starts folded shows all of them once opened.
  const limited = sections.filter((s) => !s.startsFolded);
  const more = limited.some((s) => s.items.length > SHOWN_CLOSED)
    ? limited.reduce((sum, s) => sum + s.items.length, 0)
    : 0;
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
          without starting, or never started. Open a source to see where an item
          came from.
        </PanelHelp>
        <MoreToggle count={more} all={all} setAll={setAll} where="head" />
      </div>
      {total > 0 ? null : (
        <p className="emptyLine">
          {line === null
            ? "Nothing queued: no tick has read the issues or the forge."
            : "Nothing queued. No item is assigned to the factory identity; no pull request is re-armable, labelled or held."}
        </p>
      )}
      <div className={all ? "qList all" : "qList"}>
        {sections.map((section) => (
          <QueueSection
            key={section.key}
            section={section}
            filterActive={filterActive}
            filterKey={filterKey}
          />
        ))}
        <MoreToggle count={more} all={all} setAll={setAll} where="foot" />
      </div>
      <div className="ghost">
        <span className="mk plan" aria-hidden="true" />
        <p>
          Added by hand: not available. Items enter when an issue is assigned to
          the factory identity, or from the <span className="m">drive</span>{" "}
          label; this page writes nothing.
        </p>
      </div>
    </section>
  );
}
