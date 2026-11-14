/** Share native metadata in a dispatch tick while keeping issue and authority reads fresh. */
import { cancellableRequest } from "../cancellation.ts";
import { sharedDispatchRead } from "../dispatch-shared.ts";
import type { JiraTransport } from "./transport.ts";

export function dispatchTransport(send: JiraTransport): {
  transport: JiraTransport;
  shareReads(reads: Map<string, Promise<unknown>>): void;
} {
  let reads: Map<string, Promise<unknown>> | undefined;
  return {
    shareReads: (shared) => {
      reads = shared;
    },
    transport: (request, signal) =>
      cancellableRequest(signal, () =>
        request.method === "GET" &&
        /^(?:myself|field|priority(?:\/search)?|issueLinkType|issue\/createmeta\/[^/]+\/issuetypes(?:\/[^/]+)?)$/.test(
          request.path,
        )
          ? sharedDispatchRead(reads, request, () => send(request, signal))
          : send(request, signal),
      ),
  };
}
