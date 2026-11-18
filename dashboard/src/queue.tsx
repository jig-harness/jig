import { GitBranch } from "lucide-react";
import { useRef, useState } from "react";
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
import {
  type QueueItemView,
  queueGroups,
  type QueueSectionView,
  queueSections,
} from "./queue-view.ts";
import type { Clock } from "./view.ts";

/** Cards a group shows on a phone before its Show all. */
const SHOWN_CLOSED = 2;

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
      className={rest ? "qItem groupRest" : "qItem"}
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

function SectionCards({
  section,
  startsFolded,
  all,
  setAll,
}: {
  section: QueueSectionView;
  startsFolded: boolean;
  all: boolean;
  setAll: (all: boolean) => void;
}) {
  // A group that starts folded shows all its cards once a person opens it.
  const limited = !startsFolded && section.items.length > SHOWN_CLOSED;
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
          rest={limited && i >= SHOWN_CLOSED}
          showHappens={section.by !== DEFAULT_QUEUE_GROUPING}
          key={item.rowKey}
        />
      ))}
      {limited ? (
        <button
          className="moreBtn"
          type="button"
          data-group-more=""
          aria-expanded={all}
          onClick={(event) => {
            setAll(!all);
            // Closing from the group's foot brings its heading out from above the view or under the sticky strip.
            const group = event.currentTarget.closest("[data-facet-group]");
            if (!all || group === null) return;
            const clear = Number.parseFloat(
              getComputedStyle(group).scrollMarginTop,
            );
            if (group.getBoundingClientRect().top < clear)
              group.scrollIntoView({ block: "start" });
          }}
        >
          {all ? "Show fewer" : `Show all ${section.items.length}`}
        </button>
      ) : null}
    </>
  );
}

function QueueSection({
  section,
  startsFolded,
  filterActive,
  filterKey,
}: {
  section: QueueSectionView;
  startsFolded: boolean;
  filterActive: boolean;
  filterKey: string;
}) {
  const [all, setAll] = useState(false);
  const cards = (
    <SectionCards
      section={section}
      startsFolded={startsFolded}
      all={all}
      setAll={setAll}
    />
  );
  return (
    <div className={all ? "qSection all" : "qSection"} data-facet-group="">
      {section.title === null ? (
        cards
      ) : section.fixed ? (
        <>
          <SectionTitle section={section} className="groupWord qFixed" />
          {cards}
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
          {cards}
        </GutterFold>
      )}
    </div>
  );
}

/** Whether each section starts folded, settled when the view first shows it, so a later refresh rearranges nothing under the person. */
function useStartsFolded(): (section: QueueSectionView) => boolean {
  const settled = useRef(new Map<string, boolean>());
  return (section) => {
    const known = settled.current.get(section.key);
    if (known !== undefined) return known;
    settled.current.set(section.key, section.startsFolded);
    return section.startsFolded;
  };
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
  const startsFolded = useStartsFolded();
  const groups = line === null ? [] : queueGroups(line, clock);
  const sections = queueSections(groups, grouping);
  return (
    <section className="panel pQueue" id="queue" aria-labelledby="h-queue">
      <div className="panelHead">
        <h2 id="h-queue">What is coming</h2>
        <PanelHelp panel="What is coming">
          What the next ticks will do with each target, in the order it will
          happen: started when an account has a free slot, held, reported
          without starting, or never started. Open a source to see where an item
          came from.
        </PanelHelp>
      </div>
      {sections.length > 0 ? null : (
        <p className="emptyLine">
          {line === null
            ? "Nothing queued: no tick has read the issues or the forge."
            : "Nothing queued. No item is assigned to the factory identity; no pull request is re-armable, labelled or held."}
        </p>
      )}
      <div className="qList">
        {sections.map((section) => (
          <QueueSection
            key={section.key}
            section={section}
            startsFolded={startsFolded(section)}
            filterActive={filterActive}
            filterKey={filterKey}
          />
        ))}
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
