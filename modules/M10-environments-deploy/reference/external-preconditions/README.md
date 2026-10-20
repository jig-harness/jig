# External preconditions

A build can pass while a bot cannot write its protected branch or a workflow
cannot read its secret. This registry declares what delivery needs from the
live system and checks it again on a schedule. It never changes the system it
inspects. The doctrine is [M10](../../README.md#external-preconditions);
[M11](../../../M11-process-observability/README.md#one-current-issue-for-external-preconditions)
defines how its findings maintain one current issue.

Run from a pinned Jig checkout with Bun installed. To vendor the reference,
include `lib/`, `plugin/shared/` and `plugin/skills/changelog/` alongside this
directory: the YAML reader, bounded GitHub reader and bot-access evaluator
are shared implementations, not independent copies here. No package install
is needed at runtime.

## Registry and checks

Start with the [registry template](../../templates/external-preconditions.yaml).
Each entry has a stable `id`, `kind`, `owner`, `state`, `target`, `expected`
and `remediation`; `description` is optional. An empty, malformed or duplicate
registry fails. `state: pending` always fails, even with a checker or waiver.
An unknown kind is unknown and fails. Check kinds are passed to `runRegistry`
as a map from kind name to a function taking an entry and optional fixture
input, returning `{status: pass|fail|unknown, reasons: string[]}`. The runner
catches a failed check and continues with the remaining entries. A check must
bound its external calls and return diagnostic facts without secret values.

The `branch-protection` kind reads classic protection and every applicable
ruleset with the same GitHub identity as the consumer. Its token needs
Contents read and Administration read for classic protection. GitHub withholds
ruleset bypass actors without write access to the ruleset, so a complete bot
check needs an Administration-write token even though it only sends read
requests. A read-scoped token reports withheld bypass lists as unknown. A local
administrator's result tests policy but does not establish the consumer's
access. Required check names accumulate across rulesets. Expected fields are
optional, with at least one required; unmentioned fields are left free:

| Expected field | Meaning |
|----------------|---------|
| `required_checks` | Nonempty list of required status-check names |
| `conversation_resolution` | Whether all review threads must be resolved |
| `force_pushes`, `deletions` | Whether each operation is allowed |
| `pull_requests` | Whether changes require a pull request |
| `writer` | `{app_id, slug?}` of a GitHub App that writes directly |

When a writer is named, each effective rule must permit its direct write.
A `pull_request` bypass mode admits merging a pull request, not a direct
push; only `always` or `exempt` bypasses do that. When force pushes or deletion
are forbidden, the rules that block them must bind the writer too. Missing
or withheld protection is unknown and fails; absent protection is reported
as missing controls. A malformed successful API response fails as unreadable.

An optional `waiver` has nonempty `reason`, `approved_by` and a quoted
`expires: "YYYY-MM-DD"`. It covers a known failure only. It does not cover
unknown or pending state, remains visible in the report and expires at UTC
midnight at the start of that date. An expired waiver fails even if the
condition passes; remove the stale waiver through review.

## Run and test

With `GH_TOKEN` set to a scoped token of the consuming identity, run from
its repository with the registry path supplied explicitly:

```sh
bun modules/M10-environments-deploy/reference/external-preconditions/check-external-preconditions.ts --registry .config/external-preconditions.yaml --json
bun test modules/M10-environments-deploy/reference/external-preconditions/
```

From a pinned Jig checkout, the bundled offline example needs no token:

```sh
bun modules/M10-environments-deploy/reference/external-preconditions/check-external-preconditions.ts --registry modules/M10-environments-deploy/reference/external-preconditions/fixtures/registry.yaml --input modules/M10-environments-deploy/reference/external-preconditions/fixtures/protection.json --json
```

Fixture JSON maps each entry id to the document the kind reads. Branch
protection uses `{classic, rules, rulesets}` from the shared GitHub reader.
Every entry needs fixture data; missing data fails and never falls back to
live access. `--now` is accepted only with offline input, as a canonical UTC
timestamp such as `2026-10-20T00:00:00.000Z`. Exit 0 means every entry passes or is
visibly waived; exit 1 means unresolved state; exit 2 means invalid input.

## Maintain the issue

`reconcilePreconditions` takes a tracker port and a stable registry key,
rendered title/body, and `healthy`, set only from a complete runner report.
It finds an exact marker line, creates or updates on failure, and closes on
recovery. Duplicate markers or incomplete listings fail without writing.
Callers must serialize writers for the key. The GitHub adapter uses bounded
API calls and reads every page of open issues before deciding.

Jig's wrapper is `scripts/check-external-preconditions.ts`; its scheduled
workflow uses the release App's read token for observations and the workflow
token for issue writes. Invalid registries and unavailable reader tokens
maintain a red issue. The existing `release` environment restricts credentials
to main; manual dispatches from other refs fail. Minting a reader token that
fails does not bypass reconciliation: the final step records unavailable
access and fails the run. The scheduled workflow must be merged before its
App identity and issue permissions can be exercised end to end.

Provider-specific identity, secret, storage and certificate checkers remain
[mappings](../../mappings.md#external-preconditions) until an operated checker
and its tests move into this reference.
