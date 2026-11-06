/**
 * How it went: the filters over the outcome log, the recurring classes, and the
 * rows, newest first.
 */
import { Select } from "@base-ui/react/select";
import { useDebouncedCallback } from "@tanstack/react-pacer/debouncer";
import { useContext, useEffect, useState } from "react";
import type { RowsAnswer } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { CopyButton } from "./copy.tsx";
import { PanelHelp, Pips, PopupRoot } from "./fold.tsx";
import { inputOf } from "./format.ts";
import { LogTable } from "./log-table.tsx";
import {
  activeFilters,
  type Forges,
  metaLine,
  optionsWith,
  recurringView,
  type RowClock,
} from "./log-view.ts";
import { Mark } from "./marks.tsx";
import { type LogFilter, pageQuery, viewQuery } from "./search.ts";
import { type Theme, themeSearch } from "./theme.ts";

const REASON_WAIT_MS = 300;

function FilterSelect({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const root = useContext(PopupRoot);
  const items = [
    { value: null, label: "all" },
    ...optionsWith(options, value).map((o) => ({ value: o, label: o })),
  ];
  return (
    <Select.Root
      items={items}
      value={value === "" ? null : value}
      disabled={disabled}
      modal={false}
      onValueChange={(next: string | null) => onChange(next ?? "")}
    >
      <div className="field">
        <Select.Label>{label}</Select.Label>
        <Select.Trigger className="selBtn">
          <Select.Value className="selVal" />
          <Select.Icon className="selIcon">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 4.5 6 8 9.5 4.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
            </svg>
          </Select.Icon>
        </Select.Trigger>
      </div>
      <Select.Portal container={root}>
        <Select.Positioner
          className="selPos"
          sideOffset={4}
          alignItemWithTrigger={false}
          collisionPadding={8}
        >
          <Select.Popup className="selPop">
            <Select.List className="selList">
              {items.map((item) => (
                <Select.Item
                  className="selItem"
                  value={item.value}
                  key={item.label}
                >
                  <Select.ItemText>{item.label}</Select.ItemText>
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** The reason filter: what is typed shows at once, and the log asks once typing pauses. */
function ReasonField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  const send = useDebouncedCallback(onChange, { wait: REASON_WAIT_MS });
  return (
    <label className="field">
      Reason contains
      <input
        type="search"
        value={typed}
        disabled={disabled}
        onChange={(event) => {
          setTyped(event.target.value);
          send(event.target.value);
        }}
      />
    </label>
  );
}

/**
 * One end of a range: a time on the host's clock. What is being typed stays in
 * the control until it is a whole time, and the answer's window shows back in it.
 */
function TimeField({
  label,
  shown,
  disabled,
  onChange,
}: {
  label: string;
  shown: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [typed, setTyped] = useState(shown);
  useEffect(() => setTyped(shown), [shown]);
  return (
    <label className="field">
      {label}
      <input
        type="datetime-local"
        value={typed}
        disabled={disabled}
        onChange={(event) => {
          setTyped(event.target.value);
          if (event.target.value !== "") onChange(event.target.value);
        }}
      />
    </label>
  );
}

function Recurring({
  answer,
  setFilter,
  offline,
}: {
  answer: RowsAnswer;
  setFilter: (patch: Partial<LogFilter>) => void;
  offline: boolean;
}) {
  if (answer.recurring.length === 0) return null;
  return (
    <div className="recur">
      <h3>Recurring over the last 7 nights</h3>
      {answer.recurring.map(recurringView).map((r) => (
        <div className="recurRow" key={r.rowKey}>
          <span className="pips" role="img" aria-label={r.label}>
            <Pips on={r.nights} />
          </span>
          <button
            className="fbtn"
            type="button"
            disabled={offline}
            onClick={() => setFilter(r.filter)}
          >
            <Mark role={r.role} />
            {r.title}
          </button>
          <span className="sm mut">{r.note}</span>
          <CopyButton
            text={r.finding}
            idle="Copy finding"
            aria={`Copy finding for ${r.title}`}
          />
        </div>
      ))}
      <p className="sm mut">
        A class that recurs is a finding about the scaffolding. Where reflection
        is on, the tick records it once a week for{" "}
        <span className="m">review-reflections</span>; nothing here adjusts
        anything.
      </p>
    </div>
  );
}

export function LogPanel({
  theme,
  answer,
  filter,
  setFilter,
  offline,
  rowClock,
  forges,
}: {
  theme: Theme;
  answer: RowsAnswer | null;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  offline: boolean;
  rowClock: RowClock;
  forges: Forges;
}) {
  const hasLog = answer?.logHasRows === true;
  const fromShown =
    answer === null ? "" : inputOf(Date.parse(answer.from), rowClock.timeZone);
  const toShown =
    answer === null ? "" : inputOf(Date.parse(answer.to), rowClock.timeZone);
  const active = activeFilters(filter);
  return (
    <section className="panel" id="history" aria-labelledby="h-log">
      <div className="panelHead">
        <h2 id="h-log">How it went</h2>
        <PanelHelp panel="How it went">
          The outcome log: one row per ended launch, with its class and the
          reason it gave. Filter by time, repository, stage, account, class and
          reason; the filters are the page's address, so Copy link shares this
          view. A class that recurs on a stage of a repository, on three of the
          last seven days, is listed above the rows.
        </PanelHelp>
        <span className="sm mut">
          The outcome log, newest first. Tap a row for its whole reason.
        </span>
      </div>
      {answer === null ? null : !hasLog ? (
        <p className="emptyLine">
          The outcome log has no rows. Nothing has ended and no cause has been
          observed on this host.
        </p>
      ) : (
        <>
          <div className="fields">
            <FilterSelect
              label="Repository"
              value={filter.repo}
              options={answer.options.repo}
              disabled={offline}
              onChange={(repo) => setFilter({ repo })}
            />
            <FilterSelect
              label="Stage"
              value={filter.stage}
              options={answer.options.stage}
              disabled={offline}
              onChange={(stage) => setFilter({ stage })}
            />
            <FilterSelect
              label="Account"
              value={filter.account}
              options={answer.options.account}
              disabled={offline}
              onChange={(account) => setFilter({ account })}
            />
            <ReasonField
              value={filter.reason}
              disabled={offline}
              onChange={(reason) => setFilter({ reason })}
            />
            <TimeField
              label="From"
              shown={fromShown}
              disabled={offline}
              onChange={(from) => setFilter({ from, to: toShown })}
            />
            <TimeField
              label="To"
              shown={toShown}
              disabled={offline}
              onChange={(to) => setFilter({ from: fromShown, to })}
            />
          </div>
          {active.length === 0 ? null : (
            <div className="active">
              <span className="mut">Filtered by</span>
              {active.map((a) => (
                <button
                  className="fbtn"
                  type="button"
                  aria-label={`Remove filter ${a.label}`}
                  disabled={offline}
                  onClick={() => setFilter(a.clear)}
                  key={a.label}
                >
                  <span>{a.label}</span>
                  <span aria-hidden="true">×</span>
                </button>
              ))}
              <button
                className="fbtn"
                type="button"
                disabled={offline}
                onClick={() =>
                  setFilter({
                    repo: "",
                    stage: "",
                    account: "",
                    class: "",
                    reason: "",
                  })
                }
              >
                Clear all
              </button>
            </div>
          )}
          <div className="linkLine copyRow">
            <span>
              Link to this view:{" "}
              <span className="m path">{viewQuery(filter)}</span>
            </span>
            <CopyButton
              text={`${location.origin}${location.pathname}${pageQuery(filter, themeSearch(location.search, theme))}`}
              idle="Copy link"
              aria="Copy the link to this view"
            />
            <span>The copied link carries this server’s token.</span>
          </div>
          <Recurring answer={answer} setFilter={setFilter} offline={offline} />
          <p className="meta m">{metaLine(answer, rowClock)}</p>
          {answer.total > 0 ? null : (
            <p className="emptyLine">
              No rows match this filter in this window.
            </p>
          )}
          <LogTable
            key={viewQuery(filter)}
            rows={answer.rows}
            rowClock={rowClock}
            forges={forges}
          />
        </>
      )}
    </section>
  );
}
