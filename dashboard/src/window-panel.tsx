/**
 * The Window panel: the presets and the class counts, which are the class filter.
 */
import { Toggle } from "@base-ui/react/toggle";
import { ToggleGroup } from "@base-ui/react/toggle-group";
import type { RowsAnswer } from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { classChips, type RowClock, windowText } from "./log-view.ts";
import { PanelHelp } from "./fold.tsx";
import { Mark } from "./marks.tsx";
import { type LogFilter, PRESETS, type Preset } from "./search.ts";

export function WindowPanel({
  answer,
  filter,
  setFilter,
  offline,
  rowClock,
}: {
  answer: RowsAnswer;
  filter: LogFilter;
  setFilter: (patch: Partial<LogFilter>) => void;
  offline: boolean;
  rowClock: RowClock;
}) {
  return (
    <section className="panel pWindow" aria-labelledby="h-window">
      <div className="panelHead">
        <h2 id="h-window">Window</h2>
        <PanelHelp panel="Window">
          The time the log below covers, and how many launches ended in each
          outcome class over it. Pick a class to show only its rows; pick it
          again to show all.
        </PanelHelp>
        <span className="sm mut">{windowText(answer, rowClock)}</span>
        <ToggleGroup
          className="seg winSeg"
          aria-label="Time window"
          disabled={offline}
          value={filter.window === "range" ? [] : [filter.window]}
          onValueChange={(value) => {
            const picked = PRESETS.find((p) => p.id === value[0]);
            if (picked !== undefined)
              setFilter({ window: picked.id as Preset });
          }}
        >
          {PRESETS.map((p) => (
            <Toggle className="fbtn" value={p.id} key={p.id}>
              {p.label}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <ToggleGroup
        className="seg segClasses"
        aria-label="Filter by class"
        disabled={offline}
        value={filter.class === "" ? [] : [filter.class]}
        onValueChange={(value) => setFilter({ class: value[0] ?? "" })}
      >
        {classChips(answer, filter.class).map((chip) => (
          <Toggle className="fbtn" value={chip.name} key={chip.name}>
            <Mark role={chip.role} />
            {chip.name} <span className="ct">{chip.count}</span>
          </Toggle>
        ))}
      </ToggleGroup>
    </section>
  );
}
