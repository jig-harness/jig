Compared with the audit of 2026-07-19 (plugin 0.14.0): 4 still open within Solo/Lite; 78 beyond it, not needed for this profile; 36 unchanged and met.

### What changed (123)

| Module | Criterion | Before → after | Change |
|--------|-----------|----------------|--------|
| M1 Gates enforcement ladder | `gate-set-documented` | absent → convention | Fixed |
| M0 Instruction architecture | `instruction-file-stays-small` | not scored → absent | Added by Jig |
| M0 Instruction architecture | `load-model-recorded` | not scored → absent | Added by Jig |
| M0 Instruction architecture | `model-pins-are-family-aliases` | not scored → expected absent | Added by Jig |
| M0 Instruction architecture | `context-budget-gated` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `dependency-release-cooldown` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `install-scripts-allowlisted` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `supply-chain-policy-lockstep` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `updater-self-checked` | not scored → expected absent | Added by Jig |
| M1 Gates enforcement ladder | `secret-scan-blocks-in-ci` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `secret-scan-local-and-forge-layers` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `gate-outcomes-distinguish-could-not-check` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `stale-exceptions-fail` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `gate-self-tests-cover-empty-input` | not scored → absent | Added by Jig |
| M1 Gates enforcement ladder | `agent-runtime-hooks-self-tested` | not scored → expected absent | Added by Jig |
| M1 Gates enforcement ladder | `retries-classify-errors` | not scored → expected absent | Added by Jig |
| M2 Generated artifact freshness | `numbers-in-prose-rule-stated` | not scored → absent | Added by Jig |
| M2 Generated artifact freshness | `toolchain-pins-one-source` | not scored → absent | Added by Jig |
| M2 Generated artifact freshness | `regeneration-after-merge-via-pull-request` | not scored → expected absent | Added by Jig |
| M2 Generated artifact freshness | `generator-reaches-every-input` | not scored → expected absent | Added by Jig |
| M2 Generated artifact freshness | `derivation-one-way-compared-as-data` | not scored → expected absent | Added by Jig |
| M3 Change area catalog | `area-class-resolved` | not scored → expected absent | Added by Jig |
| M4 Docs governance | `frontmatter-subset-declared` | not scored → absent | Added by Jig |
| M4 Docs governance | `generators-stamp-sticky-utc` | not scored → expected absent | Added by Jig |
| M4 Docs governance | `orphan-report-generated` | not scored → absent | Added by Jig |
| M4 Docs governance | `path-rules-enforce-subtree-vocabulary` | not scored → expected absent | Added by Jig |
| M5 ADR practice | `skeleton-changes-need-recorded-authority` | not scored → absent | Added by Jig |
| M6 Feature delivery pipeline | `lifecycle-map-published` | not scored → absent | Added by Jig |
| M6 Feature delivery pipeline | `lifecycle-owners-resolve-gated` | not scored → absent | Added by Jig |
| M6 Feature delivery pipeline | `lifecycle-skills-on-the-map` | not scored → expected absent | Added by Jig |
| M7 PR lifecycle review | `post-merge-obligations-settled` | not scored → absent | Added by Jig |
| M8 Learning loop | `audit-catalog-maintained` | not scored → absent | Added by Jig |
| M9 Tasks memory | `gate-flags-scoped-to-shipping-item` | not scored → absent | Added by Jig |
| M9 Tasks memory | `epic-closure-requires-acceptance` | not scored → absent | Added by Jig |
| M9 Tasks memory | `issues-prioritized-at-creation` | not scored → absent | Added by Jig |
| M10 Environments deploy | `artifacts-built-once-promoted-by-digest` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `created-resources-have-reapers` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `promotion-gap-from-ancestry` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `environment-currency-checked` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `watchdog-decides-by-cause` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `promotions-serialized-from-trusted-ref` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `deploy-verifies-live-identity` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `release-state-off-source-line` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `pipeline-index-derived-or-gated` | not scored → expected absent | Added by Jig |
| M10 Environments deploy | `external-preconditions-live-checked` | not scored → absent | Added by Jig |
| M11 Process observability | `scheduled-jobs-staleness-watched` | not scored → expected absent | Added by Jig |
| M11 Process observability | `heartbeat-reports-to-external-monitor` | not scored → expected absent | Added by Jig |
| M11 Process observability | `external-preconditions-issue-reconciled` | not scored → absent | Added by Jig |
| M12 Parallel agent ergonomics | `change-records-one-file-per-change` | not scored → expected absent | Added by Jig |
| M12 Parallel agent ergonomics | `worktree-namespaces-keyed-and-reaped` | not scored → expected absent | Added by Jig |
| M12 Parallel agent ergonomics | `change-records-assembled-after-merge` | not scored → expected absent | Added by Jig |
| M12 Parallel agent ergonomics | `unattended-agent-control-channel` | not scored → expected absent | Added by Jig |
| M12 Parallel agent ergonomics | `gate-quiet-invocation-named` | not scored → absent | Added by Jig |
| M12 Parallel agent ergonomics | `gate-output-quiet-on-green` | not scored → absent | Added by Jig |
| M12 Parallel agent ergonomics | `quiet-wrapper-self-tested` | not scored → absent | Added by Jig |
| M12 Parallel agent ergonomics | `verdict-line-per-part` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `superseded-pr-runs-cancelled` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `every-job-has-timeout` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `no-required-pipeline-path-filtered` | not scored → convention | Added by Jig |
| M13 Pipeline economy | `resolver-drives-selection` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `aggregate-required-check` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `heavy-non-gating-suites-scheduled` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `workflow-conventions-linted` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `job-timeout-ceiling-linted` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `ci-cost-measured` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `queue-stall-watchdog` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `ci-hold-fails-held-heads` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `ci-hold-shape-linted` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `cache-keys-complete` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `cache-one-namespace` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `cache-hit-rate-reported` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `cache-retention-bounded` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `cache-wiring-checked` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `cache-trust-boundary` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `runner-class-follows-work` | not scored → absent | Added by Jig |
| M13 Pipeline economy | `one-authoritative-leg` | not scored → expected absent | Added by Jig |
| M13 Pipeline economy | `cost-decisions-reopenable` | not scored → absent | Added by Jig |
| M14 Testing strategy | `test-tiers-declared` | not scored → absent | Added by Jig |
| M14 Testing strategy | `testing-rules-written` | not scored → absent | Added by Jig |
| M14 Testing strategy | `stale-test-triage-written` | not scored → absent | Added by Jig |
| M14 Testing strategy | `tier-budgets-enforced` | not scored → absent | Added by Jig |
| M14 Testing strategy | `full-e2e-never-per-change` | not scored → expected absent | Added by Jig |
| M14 Testing strategy | `tests-type-checked` | not scored → absent | Added by Jig |
| M14 Testing strategy | `spawn-exit-assertions-print-output` | not scored → absent | Added by Jig |
| M14 Testing strategy | `tests-come-with-changes` | not scored → absent | Added by Jig |
| M14 Testing strategy | `fixed-sleeps-banned` | not scored → absent | Added by Jig |
| M14 Testing strategy | `provisioned-suites-executed` | not scored → absent | Added by Jig |
| M14 Testing strategy | `dependency-workarounds-pinned` | not scored → absent | Added by Jig |
| M14 Testing strategy | `clock-reads-linted` | not scored → absent | Added by Jig |
| M14 Testing strategy | `predicates-proven-against-engine` | not scored → expected absent | Added by Jig |
| M14 Testing strategy | `developer-state-isolated` | not scored → absent | Added by Jig |
| M14 Testing strategy | `doubles-and-builders-typed` | not scored → absent | Added by Jig |
| M14 Testing strategy | `coverage-trend-scheduled` | not scored → absent | Added by Jig |
| M14 Testing strategy | `next-release-canary` | not scored → absent | Added by Jig |
| M15 Contracts errors | `error-contract-written` | not scored → absent | Added by Jig |
| M15 Contracts errors | `typed-error-with-code` | not scored → absent | Added by Jig |
| M15 Contracts errors | `error-code-registry` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `swallowing-forms-linted` | not scored → absent | Added by Jig |
| M15 Contracts errors | `one-error-boundary` | not scored → absent | Added by Jig |
| M15 Contracts errors | `server-failures-hide-detail` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `detached-work-reported` | not scored → absent | Added by Jig |
| M15 Contracts errors | `error-code-copies-generated` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `no-inline-error-codes` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `native-throw-linted` | not scored → absent | Added by Jig |
| M15 Contracts errors | `message-branch-linted` | not scored → absent | Added by Jig |
| M15 Contracts errors | `error-code-orphans-audited` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `telemetry-keyed-on-code` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `migration-discipline-written` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `applied-migrations-immutable` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `migration-ledger-integrity` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `migrations-structure-only` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `interface-policy-written` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `published-contract-filtered` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `input-bounds-ratcheted` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `unbounded-inputs-zero` | not scored → expected absent | Added by Jig |
| M15 Contracts errors | `failure-statuses-declared` | not scored → expected absent | Added by Jig |
| M16 Releases versions | `released-artifacts-and-entry-rule-written` | not scored → absent | Added by Jig |
| M16 Releases versions | `each-release-tagged` | not scored → convention | Added by Jig |
| M16 Releases versions | `version-set-after-merge-by-one-run` | not scored → absent | Added by Jig |
| M16 Releases versions | `shipped-change-requires-release` | not scored → absent | Added by Jig |
| M16 Releases versions | `changelog-and-version-per-artifact` | not scored → expected absent | Added by Jig |
| M16 Releases versions | `release-tag-after-verification` | not scored → absent | Added by Jig |
| M16 Releases versions | `release-identity-narrowed` | not scored → absent | Added by Jig |

### Still open within the target (4)

| Module | Criterion | Before → after | Change |
|--------|-----------|----------------|--------|
| M0 Instruction architecture | `universal-instruction-file` | absent → absent | still open |
| M0 Instruction architecture | `gates-and-guardrails-listed` | absent → absent | still open |
| M0 Instruction architecture | `glossary-exists` | absent → absent | still open |
| M1 Gates enforcement ladder | `ci-runs-gates-on-pr` | advisory → advisory | still open |

The 78 still open beyond the target are in Module detail, marked not needed for this profile.
