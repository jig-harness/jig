# Resolution decisions: worked examples

One example per decision in [SKILL.md § Step 4](../SKILL.md#step-4-record-each-decision).
The code is invented for illustration. In every example the branch
`feature` merges `main` in, so `ours` is `feature` and `theirs` is `main`.
Decision commands use the installed skill's script path:
`bun "<skill-dir>/scripts/record.ts" …`.

## `combined`: both changes still apply

`main` raised a limit; `feature` added an option on the next line.

```text
<<<<<<< HEAD
  retries: 3,
  timeoutOverride: true,
||||||| base
  retries: 3,
=======
  retries: 5,
>>>>>>> main
```

Both intents hold, so the result keeps both:

```text
  retries: 5,
  timeoutOverride: true,
```

```bash
bun "<skill-dir>/scripts/record.ts" src/config.ts combined --reason "kept the retry limit from main and this branch's timeout override"
```

## `ours` or `theirs`: one side already contains the other

`feature` fixed a typo in a function's message; `main` replaced the function
with a new one whose message is already correct. The typo fix has nothing
left to apply to.

```bash
bun "<skill-dir>/scripts/record.ts" src/report.ts theirs --reason "main replaced formatTotal with renderTotal, whose message is already correct; this branch's typo fix is no longer needed"
```

The check then reports the dropped `feature` line as a note, not a failure.

## `rewritten`: neither side works verbatim

`feature` made a lookup case-insensitive; `main` made the same lookup return
a default instead of throwing. Neither version has both behaviours, so the
result is new code:

```text
  const key = name.toLowerCase();
  return table.get(key) ?? fallback;
```

```bash
bun "<skill-dir>/scripts/record.ts" src/lookup.ts rewritten --reason "combined this branch's case-insensitive lookup with main's fallback instead of throwing"
```

## `regenerated`: a derived file

Both sides added a dependency, so the lockfile conflicts. Take the
integration side, resolve `package.json` first (keep both dependencies), then
rebuild and stage the lockfile:

```bash
bun "<skill-dir>/../../shared/command.ts" -- git checkout --theirs -- bun.lock
bun install
bun "<skill-dir>/../../shared/command.ts" -- git add package.json bun.lock
bun "<skill-dir>/scripts/record.ts" package.json combined --reason "kept both new dependencies"
bun "<skill-dir>/scripts/record.ts" bun.lock regenerated
```

## `deleted`: the deletion wins

`main` moved `src/legacy/parse.ts` to `src/parse/index.ts`; `feature` fixed a
bug in the old file. The map shows `renamedTo: src/parse/index.ts` on the
`theirs` side. Apply the fix to the new file, then remove the old path:

```bash
bun "<skill-dir>/../../shared/command.ts" -- git rm src/legacy/parse.ts
bun "<skill-dir>/scripts/record.ts" src/legacy/parse.ts deleted --reason "main moved the parser to src/parse/index.ts; this branch's fix for empty input is applied there"
```

## `escalate`: a product decision

`feature` lets guests export reports; `main` restricted exports to account
owners. The code cannot say which policy is intended.

```bash
bun "<skill-dir>/scripts/record.ts" src/export/policy.ts escalate --reason "Should guests still be able to export reports now that main restricts exports to account owners?"
```

## Acknowledging a dropped line under `combined`

Sometimes a combined resolution leaves out a single line on purpose: both
sides added a log statement at the same place, and one is enough. After
resolving and staging:

```bash
bun "<skill-dir>/scripts/record.ts" src/sync.ts combined --reason "kept both changes to the sync loop" --dropped "both sides added the same progress log; one copy is kept"
```

`--dropped` records exactly the lines missing at that moment; a line that goes
missing later fails the check again.
