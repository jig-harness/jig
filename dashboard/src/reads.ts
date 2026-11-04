/**
 * How the page keeps its two reads current: every 60 s and on focus, whether or
 * not the browser believes it is online, keeping the last answer through
 * whatever fails. A refused token and a coded failure are not tried again early;
 * a connection that dropped is tried once more before the page says so.
 */
import { focusManager, QueryClient, useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import type {
  RowsAnswer,
  StateAnswer,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  answerOf,
  type ReadFailure,
  ReadRejected,
  readRows,
  readState,
} from "./api.ts";
import { type LogFilter, rowsQuery } from "./search.ts";

/** How often the page reads, which the footer and the banner say. */
const READ_EVERY_MS = 60_000;

/** The default focus check only hears a hidden tab coming back; a laptop's window taking focus counts too. */
focusManager.setEventListener((handleFocus) => {
  const listener = () => handleFocus();
  window.addEventListener("focus", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("focus", listener);
    document.removeEventListener("visibilitychange", listener);
  };
});

function failureOf(error: Error | null): ReadFailure | null {
  if (error === null) return null;
  return error instanceof ReadRejected
    ? error.failure
    : { kind: "failed", code: "defect", reason: error.message };
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "always",
      refetchInterval: READ_EVERY_MS,
      refetchOnWindowFocus: true,
      staleTime: 0,
      retry: (count, error) => failureOf(error)?.kind === "gone" && count < 1,
      retryDelay: 1000,
    },
  },
});

/** A read as the page uses it: its last answer, and what failed since. */
export interface Read<T> {
  data: T | null;
  failure: ReadFailure | null;
}

export interface StateRead {
  answer: StateAnswer;
  /** This device's running clock when the answer arrived. */
  readAtMono: number;
}

/** The newest tick's line and the server's facts. */
export function useStateRead(token: string): Read<StateRead> {
  const query = useQuery({
    queryKey: ["state"],
    queryFn: async (): Promise<StateRead> => ({
      answer: answerOf(await readState(token)),
      readAtMono: performance.now(),
    }),
  });
  return {
    data: query.data ?? null,
    failure: failureOf(query.error),
  };
}

/** The log under a filter. A change of filter keeps the last answer until the new one arrives or fails. */
export function useRowsRead(
  filter: LogFilter,
  token: string,
  timeZone: string | null,
): Read<RowsAnswer> {
  const query = rowsQuery(filter, timeZone);
  const read = useQuery({
    queryKey: ["rows", query],
    queryFn: async (): Promise<RowsAnswer> =>
      answerOf(await readRows(token, query)),
    // A range is a time on the host's clock, so it waits until the host's zone is known.
    enabled: filter.window !== "range" || timeZone !== null,
  });
  const last = useRef<RowsAnswer | null>(null);
  if (read.data !== undefined) last.current = read.data;
  return {
    data: last.current,
    failure: failureOf(read.error),
  };
}
