import type { ReactNode } from "react";
import { Clock, GitBranch, UserRound } from "lucide-react";
import type { FilterResults, Oldest } from "./facet-results.ts";
import {
  type CardFilter,
  type Facet,
  type FacetCount,
  facetsFor,
  orderedOptions,
  QUEUE_GROUPINGS,
  type QueueGrouping,
} from "./facets.ts";
import { Glyph } from "./icon-word.tsx";
import {
  ACT_ICONS,
  GROUP_ICONS,
  type IconWord,
  QUEUE_KIND_ICONS,
  SOURCE_ICONS,
  STAGE_ICONS,
  iconOf,
} from "./icons.ts";
import type { AnswerView } from "./needs-view.ts";
import type { ViewId } from "./search.ts";

const LABEL: Record<Facet, string> = {
  act: "Act",
  repo: "Repository",
  person: "Waits on",
  stage: "Stage",
  age: "Age",
  source: "Source",
  kind: "Kind",
  happens: "Group",
};

function icon(facet: Facet, value: string): IconWord {
  switch (facet) {
    case "act":
      return iconOf(ACT_ICONS, value);
    case "stage":
      return iconOf(STAGE_ICONS, value);
    case "source":
      return iconOf(SOURCE_ICONS, value);
    case "kind":
      return iconOf(QUEUE_KIND_ICONS, value);
    case "happens":
      return iconOf(GROUP_ICONS, value);
    case "repo":
      return { icon: GitBranch, word: value };
    case "person":
      return { icon: UserRound, word: value };
    case "age":
      return { icon: Clock, word: value };
  }
}

function toggled(values: readonly string[], value: string): readonly string[] {
  return values.includes(value)
    ? values.filter((entry) => entry !== value)
    : [...values, value];
}

interface RowProps {
  facet: Facet;
  options: readonly FacetCount[];
  selected: readonly string[];
  setSelected: (values: readonly string[]) => void;
}

const CHIP_LIMIT = 6;

function FacetSelect({
  facet,
  options,
  selected,
  setSelected,
  phone = false,
}: RowProps & { phone?: boolean }) {
  const multiple = !phone || selected.length > 1;
  const value = multiple ? "" : (selected[0] ?? "");
  return (
    <label className={phone ? "facetSelect phoneRepo" : "facetSelect"}>
      <span className="sm mut">{LABEL[facet]}</span>
      <select
        value={value}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setSelected(
            next === "" ? [] : multiple ? toggled(selected, next) : [next],
          );
        }}
      >
        <option value="">
          {selected.length === 0 || !multiple ? "All" : "Change selection"}
        </option>
        {options.map(({ value, count }) => (
          <option key={value} value={value}>
            {multiple && selected.includes(value) ? "✓ " : ""}
            {icon(facet, value).word} ({count})
          </option>
        ))}
      </select>
      {!multiple || selected.length === 0 ? null : (
        <span className="sm">
          {selected.map((entry) => icon(facet, entry).word).join(", ")}
        </span>
      )}
    </label>
  );
}

function FacetRow(props: RowProps) {
  const { facet, options, selected, setSelected } = props;
  return (
    <div className={`facetRow facet-${facet}`} data-facet={facet}>
      <fieldset className="facetDesktop">
        <legend className="vh">{LABEL[facet]}</legend>
        {options.length > CHIP_LIMIT ? (
          <FacetSelect {...props} />
        ) : (
          <>
            <span className="facetLabel sm mut" aria-hidden="true">
              {LABEL[facet]}
            </span>
            {options.map(({ value, count }) => {
              const of = icon(facet, value);
              return (
                <button
                  className="facetChip"
                  key={value}
                  type="button"
                  aria-pressed={selected.includes(value)}
                  onClick={() => setSelected(toggled(selected, value))}
                >
                  <Glyph of={of} size={16} />
                  <span>{of.word}</span> <span className="m">{count}</span>
                </button>
              );
            })}
          </>
        )}
      </fieldset>
      {facet === "repo" ? <FacetSelect {...props} phone /> : null}
    </div>
  );
}

export interface GroupingControl {
  value: QueueGrouping;
  set: (grouping: QueueGrouping) => void;
}

/** How What is coming is grouped: a desktop control, since a phone keeps the default. */
function GroupingRow({ value, set }: GroupingControl) {
  return (
    <div className="facetRow facet-grouping">
      <fieldset className="facetDesktop">
        <legend className="vh">Group by</legend>
        <span className="facetLabel sm mut" aria-hidden="true">
          Group by
        </span>
        {QUEUE_GROUPINGS.map(({ id, word }) => (
          <button
            className="facetChip"
            key={id}
            type="button"
            aria-pressed={value === id}
            onClick={() => set(id)}
          >
            {word}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

function namedValues(facet: Facet, values: readonly string[]): string {
  return `${LABEL[facet].toLowerCase()}: ${values.map((value) => icon(facet, value).word).join(", ")}`;
}

interface NeedsSummary {
  fallback: AnswerView;
  unread: string | null;
  at: string | null;
  more: ReactNode;
}

function NeedsHeading({
  summary,
  results,
}: {
  summary: NeedsSummary;
  results: FilterResults;
}) {
  if (results.total === 0)
    return (
      <>
        <h1>{summary.fallback.title}</h1>
        <p className="sm">{summary.fallback.sub}</p>
      </>
    );
  const shown = results.shown;
  const title =
    summary.at === null
      ? `${shown} ${shown === 1 ? "needs" : "need"} a person`
      : `${shown} needed a person at the ${summary.at} tick.`;
  return (
    <>
      <h1 className="needCount">{title}</h1>
      {summary.unread === null ? null : <p className="sm">{summary.unread}</p>}
    </>
  );
}

function OldestWait({ oldest }: { oldest: Oldest | null }) {
  if (oldest === null) return null;
  return (
    <p className="sm mut facetOldest">
      Oldest {oldest.age},{" "}
      {oldest.url === null ? (
        oldest.target
      ) : (
        <a href={oldest.url}>{oldest.target}</a>
      )}
    </p>
  );
}

function OtherFilters({ view, filter }: { view: ViewId; filter: CardFilter }) {
  const readonly = facetsFor(view).filter(
    (facet) => facet !== "repo" && Boolean(filter.values[facet]?.length),
  );
  const query = filter.query.trim();
  const labels = readonly.map((facet) =>
    namedValues(facet, filter.values[facet] ?? []),
  );
  if (query !== "") labels.push(`text: ${query}`);
  if (labels.length === 0) return null;
  return (
    <div className="phoneFilters">Also filtered by {labels.join("; ")}</div>
  );
}

function FilterStatus({
  view,
  filter,
  results,
  clear,
}: {
  view: ViewId;
  filter: CardFilter;
  results: FilterResults;
  clear: () => void;
}) {
  if (!results.active) return null;
  return (
    <div className="facetStatus sm">
      <div className="facetShowing" aria-live="polite">
        Showing {results.shown} of {results.total}
      </div>
      <OtherFilters view={view} filter={filter} />
      <span className="filterSeparator" aria-hidden="true">
        ·
      </span>
      <button type="button" className="clearFilter" onClick={clear}>
        Clear
      </button>
    </div>
  );
}

export function FacetControls({
  view,
  filter,
  results,
  replace,
  clear,
  needs,
  grouping,
}: {
  view: ViewId;
  filter: CardFilter;
  results: FilterResults;
  replace: (filter: CardFilter) => void;
  clear: () => void;
  needs?: NeedsSummary | undefined;
  grouping?: GroupingControl | undefined;
}) {
  return (
    <section
      className={needs === undefined ? "facetControls" : "facetControls answer"}
      aria-label={
        needs === undefined ? undefined : "Does anything need a person"
      }
    >
      {needs === undefined ? null : (
        <NeedsHeading summary={needs} results={results} />
      )}
      {facetsFor(view).map((facet) => {
        const options = orderedOptions(
          view,
          facet,
          results.counts[facet] ?? [],
        );
        const selected = filter.values[facet] ?? [];
        if (options.length < 2 && selected.length === 0) return null;
        return (
          <FacetRow
            key={facet}
            facet={facet}
            options={options}
            selected={selected}
            setSelected={(values) =>
              replace({
                ...filter,
                values: { ...filter.values, [facet]: values },
              })
            }
          />
        );
      })}
      {view !== "queue" ||
      grouping === undefined ||
      results.total === 0 ? null : (
        <GroupingRow {...grouping} />
      )}
      <OldestWait oldest={results.oldest} />
      {needs?.more}
      <FilterStatus
        view={view}
        filter={filter}
        results={results}
        clear={clear}
      />
    </section>
  );
}
