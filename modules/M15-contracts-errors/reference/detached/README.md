# Detached work

Part of [M15 Contracts and error handling](../../README.md).

A helper for work nobody awaits: it starts the work and reports a failure
with its cause through the logger it is given, and the chain it starts can
never reject. It is the "never swallow, keep the cause" rule of the module
applied to the one place a failure has no caller to reach, plus the
process-level backstop for the work that did not go through it.

## Why a helper

[Detached work](../../../../GLOSSARY.md) (a promise started and not
awaited: a cache warmed in the background, a notification sent after the
response) has nowhere to propagate a failure to. Left alone, its rejection
becomes an unhandled rejection: the runtime prints it once and, by default,
the process fails (Node stops at once, Bun exits non-zero when it is done).
The usual fix, `.catch(() => {})`, keeps the process up by dropping the
failure, and the cause is gone. Rethrowing a bug from inside the
chain's own `.catch()` only makes a second unhandled rejection no handler
sees. The helper is the one place these mistakes cannot be made.

## Use

```ts
import { installUnhandledRejectionListener, runDetached } from "./detached.ts";

// Once per entry point, right after the logger exists.
const dispose = installUnhandledRejectionListener({
  report: (failure) => logger.error(failure, failure.label),
  isDefect: (error) => error instanceof DefectError,
});

// Work nobody awaits.
runDetached(() => cache.warm(workspaceId), {
  label: "warm the workspace cache",
  report: (failure) =>
    failure.defect
      ? logger.error(failure, failure.label)
      : logger.warn(failure, failure.label),
  isDefect: (error) => error instanceof DefectError,
  context: { workspaceId },
});
```

`work` is a promise or a function returning one; a function that throws
before it returns a promise is reported like a rejection. The report carries
the error, its name, its message, the messages along its `cause` chain
(nearest first, bounded against a cycle), whether `isDefect` classed it as a
bug, the stack, and the `context` given. `runDetached` returns nothing: the
caller cannot await the chain, and it never rejects.

## The rules it keeps

- **It never throws and never rejects.** When `report` throws, or
  returns a promise that rejects, one line goes to the fallback (standard
  error by default) naming the work and saying the details were withheld.
  Raw standard error bypasses a logger's redaction, so the error's own text,
  which may carry an address or a credential, never reaches it. When the
  fallback fails too, one direct write to standard error is the last
  attempt, and nothing is left behind to retrigger the process listener.
  `report` and `fallback` are typed to return nothing, so an async one does
  not type-check; one that slips through is still caught. A native promise
  is followed at any depth. A chain of hand-written thenables is followed
  eight steps and then counted as a failed report, since an endless chain
  would never end the walk; a rejection that only a ninth step would reach
  is never observed, so it can still surface as an unhandled rejection.
- **A reason that cannot be read is still reported.** Each field of the
  report is read on its own: a name, message, cause or stack whose getter
  throws, or a revoked proxy that throws on `instanceof`, is described as
  unreadable, and the reporter always gets the reason itself as `error`.
- **A defect is the repository's to define.** `isDefect` plugs in the
  repository's own defect type; the helper classes nothing itself. When
  `isDefect` throws on a reason (an `instanceof` walks the prototype chain,
  which a revoked proxy makes throw), the reason is classed as a failure and
  reported all the same.
- **The listener is a backstop, not a licence.** Under the runtime's
  default unhandled-rejection mode (Node's `throw`, which Bun follows), a
  process with an unhandled-rejection listener no longer stops on one.
  Under `--unhandled-rejections=strict` the rejection is raised as an
  uncaught exception first and the listener does not keep the process up,
  so an entry point that installs it sets no `strict` flag in its start
  command or `NODE_OPTIONS`. In the default mode the listener keeps
  every remaining instance visible at error level. The fix for a reported
  instance is to route that work through `runDetached`; removing the listener
  is not.

## Files

| File | Role |
|------|------|
| `detached.ts` | `runDetached`, `reportDetachedFailure`, `installUnhandledRejectionListener`, and the `causeChain`, `describeFailure` and `safeString` helpers they are built from |
| `detached.test.ts` | self-test: a rejection and a throwing thunk are reported with the cause chain; a reason that is not an error is described; a defect is classed; a throwing or rejecting reporter or fallback never escapes and withholds the error's text; a revoked proxy and an error with throwing getters are described field by field; a throwing `isDefect` classes the reason as a failure; a cause cycle is bounded; and, in a child process, that the process fails without the listener, goes on with it, falls back to standard error when the reporter throws, and fails again once the disposer has run |

Run the self-test with `bun test ./detached.test.ts`. The helper has no
imports, so it can be copied as it is; equivalents in other ecosystems are in
the module's [mappings](../../mappings.md#detached-work-and-unhandled-rejections).
