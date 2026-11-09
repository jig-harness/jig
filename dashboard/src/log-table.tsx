import { ChevronRight } from "lucide-react";
import { Pr, RepoLink } from "./pr.tsx";
/**
 * The log's rows. TanStack Table holds the columns and which rows are open;
 * TanStack Virtual keeps only what is near the window in the document, measuring
 * each row, so thousands of rows stay smooth.
 */
import {
  createColumnHelper,
  type Row,
  rowExpandingFeature,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LogRow } from "../../plugin/dispatch/lib/log.ts";
import { askLineOf } from "./cards.ts";
import { CopyButton } from "./copy.tsx";
import { Evidence, StageHint } from "./fold.tsx";
import { cardAttrs } from "./keys.ts";
import {
  type Forges,
  type RowClock,
  rowView,
  type RowView,
} from "./log-view.ts";
import { Mark, StageChip } from "./marks.tsx";
import { stageMeaning } from "./status.ts";

const PAGE = 25;

/** A row's height before it is measured: below this width its cells wrap onto more lines. */
const WIDE_FROM_PX = 900;
const WIDE_ROW_PX = 54;
const NARROW_ROW_PX = 127;

const features = tableFeatures({ rowExpandingFeature });
const helper = createColumnHelper<typeof features, RowView>();

const columns = helper.columns([
  helper.display({
    id: "time",
    cell: ({ row }) => <span className="cell-time m">{row.original.time}</span>,
  }),
  helper.display({
    id: "class",
    cell: ({ row }) => (
      <span className="cell-cls">
        <Mark role={row.original.role} /> {row.original.label}
      </span>
    ),
  }),
  helper.display({
    id: "target",
    cell: ({ row }) => (
      <span className="cell-tgt">
        <Pr
          repo={row.original.repo}
          target={row.original.target}
          url={row.original.url}
        />
        <RepoLink repo={row.original.repo} url={row.original.url} />
        <StageChip
          mark={row.original.mark}
          stage={row.original.stage}
          title={stageMeaning(row.original.stage)}
        />
      </span>
    ),
  }),
  helper.display({
    id: "account",
    cell: ({ row }) => (
      <span className="cell-acct m">{row.original.account}</span>
    ),
  }),
  helper.display({
    id: "length",
    cell: ({ row }) => (
      <span className="cell-len m">{row.original.length}</span>
    ),
  }),
  helper.display({
    id: "reason",
    cell: ({ row }) => <span className="cell-why">{row.original.reason}</span>,
  }),
]);

function RowBody({ view }: { view: RowView }) {
  return (
    <div className="rowBody">
      <StageHint mark={view.mark} stage={view.stage} />
      <div className="quote">{view.reason}</div>
      <div className="copyRow">
        <CopyButton
          text={view.reason}
          idle="Copy reason"
          aria={`Copy the reason for ${view.target}`}
        />
      </div>
      <Evidence rows={view.evidence} />
      <div className="goto">
        {view.url === null ? null : (
          <a href={view.url} target="_blank" rel="noreferrer noopener">
            Open the pull request
          </a>
        )}
        {view.noLink === null ? null : (
          <span className="noLink">{view.noLink}</span>
        )}
      </div>
    </div>
  );
}

/** Where the list starts in the document, kept current as what stands above it changes height. */
function useListTop(): [React.RefObject<HTMLDivElement | null>, number] {
  const list = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  useEffect(() => {
    const measure = () => {
      const element = list.current;
      if (element !== null)
        setTop(element.getBoundingClientRect().top + window.scrollY);
    };
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(document.body);
    return () => watcher.disconnect();
  }, []);
  return [list, top];
}

export function LogTable({
  rows,
  rowClock,
  forges,
}: {
  rows: LogRow[];
  rowClock: RowClock;
  forges: Forges;
}) {
  const [limit, setLimit] = useState(PAGE);
  const data = useMemo(
    () => rows.map((r) => rowView(r, rowClock, forges)),
    [rows, rowClock, forges],
  );
  const table = useTable({
    features,
    columns,
    data,
    getRowId: (row) => row.key,
    getRowCanExpand: () => true,
    autoResetExpanded: false,
  });
  const all = table.getRowModel().rows;
  const shown = all.slice(0, limit);
  const [list, top] = useListTop();
  const virtual = useWindowVirtualizer({
    count: shown.length,
    estimateSize: () =>
      document.documentElement.clientWidth >= WIDE_FROM_PX
        ? WIDE_ROW_PX
        : NARROW_ROW_PX,
    overscan: 6,
    scrollMargin: top,
    getItemKey: (index) => shown[index]?.id ?? index,
    // A row's real height, not rounded: rounded heights would drift down a long list.
    measureElement: (element) => element.getBoundingClientRect().height,
  });
  const renderRow = (
    row: Row<typeof features, RowView>,
    index: number,
    start: number,
  ) => (
    <div
      className="row"
      key={row.id}
      {...cardAttrs({
        key: `log ${row.id}`,
        url: row.original.url,
        command:
          row.original.target === ""
            ? null
            : askLineOf(
                row.original.stage,
                row.original.repo,
                row.original.target,
              ),
      })}
      data-index={index}
      ref={virtual.measureElement}
      style={{ transform: `translateY(${Math.round(start - top)}px)` }}
    >
      <div className="rowSum">
        {row.getAllCells().map((cell) => (
          <table.FlexRender cell={cell} key={cell.id} />
        ))}
        <button
          type="button"
          className="foldBtn disclosure rowExpand"
          data-card-toggle=""
          aria-label={`Details for ${row.original.target}`}
          aria-expanded={row.getIsExpanded()}
          onClick={row.getToggleExpandedHandler()}
        >
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      </div>
      {row.getIsExpanded() ? <RowBody view={row.original} /> : null}
    </div>
  );
  return (
    <>
      <div
        className="rows"
        ref={list}
        style={{ height: virtual.getTotalSize() }}
      >
        {virtual.getVirtualItems().map((item) => {
          const row = shown[item.index];
          return row === undefined
            ? null
            : renderRow(row, item.index, item.start);
        })}
      </div>
      {all.length > shown.length ? (
        <div className="moreRow">
          <button
            className="moreBtn deskToo"
            type="button"
            onClick={() => setLimit(limit + PAGE)}
          >
            Show 25 more
          </button>
          <button
            className="moreBtn deskToo"
            type="button"
            onClick={() => setLimit(all.length)}
          >
            Show all {all.length}
          </button>
        </div>
      ) : null}
    </>
  );
}
