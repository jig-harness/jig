---
id: jig.swallowed-failure
version: 1
rules:
  # Piece 1: never swallow, keep the cause.
  - https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md#core-pieces
  # Piece 3: branch on type or code, never on message text.
  - https://github.com/jig-harness/jig/blob/main/modules/M15-contracts-errors/README.md#core-pieces
lever: ~
trigger:
  paths: ["**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rb,rs,java,kt,sh,bash,ps1}"]
  exclude: ["**/__tests__/**", "**/*.test.*", "**/*_test.*", "**/test_*", "**/fixtures/**"]
  added_lines:
    - '\bcatch\b'
    - '\bexcept\b'
    - '\brescue\b'
    - '\brecover\(\)'
    - '\berr\s*!=\s*nil'
    - '\.unwrap_or'
    - '\.ok\(\)'
    - '\blet _ ='
    - '\.nothrow\('
    - '2>\s*/dev/null'
    - '\|\|\s*true\b'
    - '\bset \+e\b'
    - 'SilentlyContinue'
    - 'stderr\s*=\s*subprocess\.'
    - '["'']ignore["'']'
    - '\bvoid\s+[\w.]+\('
    - '\.then\('
    - '\bcreate_task\('
    - '\bgo\s+func\b'
    - '\.message\b'
    - '\.Error\(\)'
    - '\bstr\(e(rr|xc)?\)'
    - '\.(error|warn)\('
    - '[Rr]etr(y|ies)'
    - '\bcause\b'
  removed_lines:
    - '\bthrow\b'
    - '\braise\b'
    - 'return err\b'
    - '\bErr\('
    - '\?;'
    - '\bpanic\('
    - '\bexit\s+[1-9]'
    - '\bexitCode\b'
    - '\bset -e\b'
    - '\binvariant\('
    - '\bassert'
    - '\bcause\b'
    - '\breject\('
    - '\.(error|warn)\('
    - '\bawait\b'
evidence: absorbed-failures
---

# Swallowed failure

A failure must reach someone. Either the code passes it on to its caller,
or it reports it with the original cause attached. This lens finds the
places in a change where a failure stops travelling: it becomes a default
value, an empty result, a success or nothing at all, or it loses the cause
that says what went wrong. It also finds code that decides what to do
about an error by reading the error's message text.

A gate already catches the plainest shapes of this (a `catch` that returns
a default, error output thrown away, a cast of parsed input). What no gate
can tell is whether a fallback is one the caller expects or one that hides
a fault. That judgment is this lens's.

Read the repository's instruction files before you start. They name its
own conventions: the function that reports a failure, the helper that runs
work nobody waits for, the error types and codes callers branch on. Judge
the change against those, not against conventions from elsewhere.

## Look for

Each of these, where this change adds it or makes it possible:

1. **A failure turned into a value.** A handler that returns a default, an
   empty list, `null`, `false` or a success when the work failed, so the
   caller cannot tell "failed" from "nothing there".
2. **A fallback that hides the fault.** The code carries on in a reduced
   way (a cached value, a guess, a skipped step) and neither the caller nor
   whoever operates the system can learn that the failure happened or why.
3. **A handler broader than its purpose.** It was written for one expected
   failure (a missing file, a timeout) but catches every failure of the
   block, so a bug or an unrelated outage takes the same quiet path.
4. **A wrapper that drops the cause.** A new error is raised or returned in
   place of the original without carrying the original as its cause, so
   the message of the wrapper ("query failed") hides the fault the original
   named.
5. **Retries that end in silence.** A loop that retries a failing call and,
   when it gives up, returns or carries on without reporting the last
   failure.
6. **Work nobody waits for.** A promise, task, goroutine or background job
   started and not awaited, outside the repository's helper for such work,
   so its failure happens where nothing is listening.
7. **Error output thrown away.** A child process or command run with its
   error output discarded or its exit status ignored, so the reason it
   printed when it failed is gone.
8. **A removed check.** The change deletes a `throw`, a `raise`, an error
   return, an assertion or an exit status that used to stop a failure, and
   nothing takes its place.
9. **A branch on message text.** Code that decides what to do by testing
   an error's message (`includes`, `startsWith`, equality, a regular
   expression) instead of its type, code or tag. The message is for people;
   it changes when someone rewords or translates it.

## Not a finding

Do not report these:

- **A shape a gate already reported** at the same line in this run. You
  are given the earlier tiers' findings; leave those lines to them.
- **A fallback the code states as intended that still reports the
  failure with its cause.** A comment or a name says the fallback is
  deliberate (a cache miss falls back to the source), and the failure is
  logged or recorded with the original error attached.
- **A wrapper that keeps the cause.** A new, more specific error that
  carries the original as its cause is the rule followed, not broken.
- **A test that asserts the failure.** A test that expects an error, checks
  its type or code, or catches it to assert on it.
- **Code the change neither adds nor alters**, unless the change now relies
  on it to swallow a failure it introduces.
- **A branch on type, code or tag**, including a check of a code field
  that happens to be a string.

## Evidence

Fill `absorbed-failures` for every finding. Name the call whose failures
the handler absorbs, by file and line, and where each failure ends up: a
returned value (say which), a log line without its cause (quote it), or
nothing. For a branch on message text, quote the test of the message and
name the error it reads. For a removed check, quote the removed line and
say which failure now passes through. A reader must be able to confirm or
refute the finding by reading the lines you name, without redoing the
review.
