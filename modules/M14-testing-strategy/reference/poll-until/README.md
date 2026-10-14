# Poll until

A small helper for waiting on external state: it checks repeatedly, returns
the moment the state is there, and fails at a hard deadline with a message
that names what it waited for. It is the "poll, don't sleep" rule of
[M14](../../README.md) as code, and an example of the injected-clock rule.

## Why not sleep

A fixed sleep before checking ("wait five seconds, then read the queue") is
wrong in both directions. When the system is healthy, the state usually
arrives in milliseconds and the rest of the delay is wasted, on every run.
When the system is broken, the sleep ends on time anyway and the test carries
on with stale or empty state, so the failure appears later as a confusing
assertion about something else. Polling fixes both: it is as fast as the
system allows, and when the state never comes it fails at the deadline with
the reason.

## Use

```ts
import { pollUntil } from "./poll-until.ts";

const invoice = await pollUntil({
  check: async (signal) => (await api.getInvoice(id, { signal })) ?? null,
  waitingFor: `invoice ${id} to be issued`,
  deadlineMs: 30_000,
  intervalMs: 500,
});
```

`check` returns the awaited value, or `null`/`undefined` while it is not
there yet; any other value (including `0`, `false` or `""`) ends the wait. An
error thrown by `check` ends the wait with that error. On the deadline the
helper throws
`timed out after <ms>ms waiting for <waitingFor> (<n> checks)`. Both
durations must be positive and finite.

The deadline is hard. No check starts once it is reached, a value that
arrives after it is refused, and the last pause is shortened so the wait never
runs past it. A check or pause still running at the deadline (a request that
hangs) is cut off with the same message.

Cutting off is cooperative. `check` and `sleep` receive an `AbortSignal` that
fires at the deadline, when the wait ends, or when the caller cancels through
the optional `signal` option (the wait then rejects with that signal's
reason). The wait stops waiting either way, but only a check that hands the
signal on, to `fetch` or its client library, actually stops the request and
frees its connection.

## Time is injected

`clock` (anything with `now()` in milliseconds), `sleep` and `timer` (which
schedules the deadline cut-off) are optional parameters. Production code uses the defaults; a test passes a fake clock that
advances only when the fake `sleep` is called, so a thirty-second deadline is
tested in microseconds and the test cannot be flaky about timing. The defaults
(`systemClock`, `systemSleep` and `systemTimer`) are the only places in the
file that touch real time, and each real delay carries the `fixed-delay:` token
the module's sleep ban accepts.

## Files

| File | Role |
|------|------|
| `poll-until.ts` | the helper, with `Clock`, `Timer`, `systemClock`, `systemSleep` and `systemTimer` |
| `poll-until.test.ts` | self-test with a fake clock and a manual deadline timer: early return, deadline message, shortened last pause, a late value refused, a hanging check or pause cut off at the requested deadline, cancellation, errors from the check, bad arguments; and a hanging check cut off in real time |

Run the self-test with `bun test ./poll-until.test.ts`. The helper has no
imports, so it can be copied as it is. Equivalent helpers in other ecosystems
are in the module's [mappings](../../mappings.md#poll-dont-sleep).
