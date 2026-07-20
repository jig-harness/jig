#!/usr/bin/env bash
# Promote-safety lint: a production deploy path must be gated and verified.
#
# The problem it catches. "Deploy only verified artifacts, and only on a human's
# say-so" is a promise the deploy WORKFLOW has to keep. Two wiring mistakes break
# it silently:
#   (a) the production deploy fires automatically on a branch push, with no
#       manual gate or environment approval — so any merge ships to prod, and a
#       bad merge reaches users before anyone looks; and
#   (b) the production deploy ships a MUTABLE ref (a moving branch, HEAD, an
#       `:latest` image) instead of the pinned `verified` pointer/artifact — so
#       what reaches prod is whatever the branch happens to be, not the thing
#       that actually passed verification.
# This lint scans a workflows directory and fails a production-deploy workflow
# that commits either mistake, so the safe wiring can't quietly regress.
#
# Scoped to the DEPLOY JOB, not the file. A workflow has many jobs; the checks
# apply to the job that actually deploys to production, so a gate or a
# `verified` reference on some OTHER job (a preview deploy with its own
# environment, a build job that checks out the verified ref) can't mask an
# unsafe production job. The lint segments the workflow into jobs (GitHub
# Actions `jobs:` children; GitLab top-level jobs) and evaluates each
# production-deploy job — one that carries BOTH a deploy signal (`deploy`) and a
# production signal (`prod`/`production`) — on its own.
#
# What trips it — a production-deploy JOB where:
#   (a) it fires on `push` — a GitHub Actions `on: push` (bare or quoted scalar,
#       flow sequence [push], a block-sequence item `- push`, block `push:`, or
#       an inline `on: { push: ... }` mapping), or a GitLab push rule
#       (`$CI_PIPELINE_SOURCE == "push"`, or legacy `only: pushes`), including a
#       rule inside the job — AND that job has no gate on the push run: no
#       `environment:` key (where GitHub/GitLab environment protection lives) and
#       no GitLab `when: manual`. A `workflow_dispatch` trigger does NOT count:
#       it is an additional trigger, not an approval on the push run; OR
#   (b) that job selects a mutable ref (a `ref:` or `--ref` of
#       main/master/develop/HEAD, a `github.ref`/`github.ref_name`, or an
#       `@latest`/`:latest` tag) at all. A
#       line matcher cannot prove WHICH line is the deploy command, so a
#       `verified` reference elsewhere in the same job (a build download, a
#       tooling checkout) does NOT clear it — a mutable ref in the deploy job
#       stays unsafe. Deploy only the pinned `verified` pointer/artifact.
# Detection runs against a COMMENT-STRIPPED view, so a `#` comment can't fake a
# gate. See README for the exact heuristic and limits.
#
# Portable: bash + awk. Conventions (mirror ../pr-target-safety): exit 0 pass,
# 1 an unsafe workflow (per-file report), 2 a usage error; inputs via file args
# or WORKFLOWS_DIR so the self-test drives it with fixtures. A missing workflows
# dir passes (safe to wire early); an unreadable one fails closed.
#
# Usage:
#   check-promote-safety.sh                       # scan .github/workflows
#   check-promote-safety.sh path/to/deploy.yml    # explicit files
#   WORKFLOWS_DIR=path check-promote-safety.sh
set -u
WORKFLOWS_DIR="${WORKFLOWS_DIR:-.github/workflows}"

# Detectors run against a COMMENT-STRIPPED view of each file: a YAML `#` comment
# must not be able to hide a real violation (e.g. a comment mentioning
# `workflow_dispatch` faking a manual gate that isn't wired). We drop full-line
# comments and trailing ` #...` comments; a `#` glued to a token is left alone.
strip_comments() { # <file> -> stdout with YAML comments removed
  sed -E 's/[[:space:]]#.*$//; s/^[[:space:]]*#.*$//' "$1"
}

check_file() { # <file> -> prints findings, returns 0 if UNSAFE, 1 if safe
  local f="$1" scan mode
  scan=$(mktemp) || { echo "ERROR: mktemp failed" >&2; exit 2; }
  strip_comments "$f" > "$scan"
  # GitHub Actions (a `jobs:` container) vs GitLab-style (jobs are top-level
  # keys). Disambiguates workflow-level keys like `on:`/`name:` that would
  # otherwise look like GitLab jobs before `jobs:` is reached.
  if grep -qE '^[[:space:]]*jobs[[:space:]]*:[[:space:]]*$' "$scan"; then mode=gha; else mode=flat; fi

  awk -v mode="$mode" -v file="$f" '
    function indent(s,   n){ n=0; while (substr(s,n+1,1)==" ") n++; return n }
    # word-boundary contains (no \< / \> — not portable across awks)
    function has_word(s,w){ return (s ~ ("(^|[^a-z])" w "([^a-z]|$)")) }
    # a GitLab push trigger on a (lowercased) line: a CI_PIPELINE_SOURCE == push
    # rule, or the legacy only: pushes / `- pushes`. Q (an optional quote) is a
    # BEGIN global, resolved at call time.
    function gitlab_push(s){
      return (s ~ ("ci_pipeline_source[[:space:]]*==[[:space:]]*" Q "push") ||
              s ~ /^[[:space:]]*only[[:space:]]*:.*push/ ||
              s ~ /^[[:space:]]*-[[:space:]]*pushes([^a-z]|$)/)
    }
    BEGIN{
      Q="[\047\042]?"                       # an optional YAML quote (octal 047, 042)
      sawjobs=0; jobsind=-1; L=-1; cur=""; fires=0; njobs=0
      # GitLab reserved top-level keys that are NOT jobs
      split("stages variables default workflow include image services cache " \
            "before_script after_script pages", rw, " ")
      for (i in rw) reserved[rw[i]]=1
    }
    {
      raw=$0
      if (raw ~ /^[[:space:]]*$/) next
      lc=tolower(raw)
      ind=indent(raw)

      # --- the GHA jobs: container -------------------------------------------
      if (mode=="gha" && raw ~ /^[[:space:]]*jobs[[:space:]]*:[[:space:]]*$/) {
        sawjobs=1; jobsind=ind; L=-1; cur=""; next
      }

      # --- is this line a JOB HEADER? ----------------------------------------
      isheader=0; name=""
      if (mode=="gha") {
        if (sawjobs) {
          if (ind<=jobsind) { cur="" }                       # left the jobs block
          else {
            if (L==-1 && raw ~ /^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*:/) L=ind
            if (L>=0 && ind==L && raw ~ /^[[:space:]]*[A-Za-z0-9_.-]+[[:space:]]*:/) isheader=1
          }
        }
      } else {  # flat / GitLab: a job is a top-level (ind 0) mapping key
        if (ind==0 && raw ~ /^[A-Za-z0-9_.-]+[[:space:]]*:/) {
          name=raw; sub(/[[:space:]]*:.*/,"",name)
          if (name in reserved) { cur=""; next }             # not a job
          isheader=1
        }
      }
      if (isheader) {
        name=raw; sub(/[[:space:]]*:.*/,"",name); sub(/^[[:space:]]+/,"",name)
        cur=name; if (!(cur in seen)) { seen[cur]=1; order[++njobs]=cur; jbind[cur]=-1 }
        # fall through: the header line itself can carry a deploy/prod signal
      }

      # --- push detection (workflow level, OUTSIDE any job) ------------------
      if (cur=="") {
        # GitHub Actions on: push — bare or quoted scalar (on: push / on: "push"),
        # sequence [push,...], a block sequence item (`- push`), block push:, or
        # an inline flow mapping on:{push:}.
        if (raw ~ ("^[[:space:]]*on:[[:space:]]*" Q "push([\047\042[:space:]]|$)")) fires=1
        else if (raw ~ /^[[:space:]]*on:[[:space:]]*\[[^]]*push/)    fires=1
        else if (raw ~ /^[[:space:]]*on:[[:space:]]*\{.*push/)       fires=1
        else if (raw ~ ("^[[:space:]]*-[[:space:]]*" Q "push" Q "[[:space:]]*$")) fires=1
        else if (raw ~ /^[[:space:]]*push[[:space:]]*:/)             fires=1
        # GitLab workflow-level push rule (CI_PIPELINE_SOURCE, or legacy only:)
        if (gitlab_push(lc))                                        fires=1
        next
      }
      # The first non-header line inside a job sets the job-body indent, so we
      # can tell a job-level `environment:` from a step *input* named environment.
      if (!isheader && jbind[cur]==-1) jbind[cur]=ind

      # --- record this line as signals for the current job ------------------
      if (lc ~ /deploy/)                                   hasdeploy[cur]=1
      if (has_word(lc,"prod") || has_word(lc,"production")) hasprod[cur]=1
      # a JOB-LEVEL environment: (at the job-body indent) is the GitHub Actions
      # protected-environment property; a deeper `environment:` is a step input
      # (`with: environment:`) that grants no protection, so it does not count.
      if (ind==jbind[cur] && raw ~ /^[[:space:]]*environment[[:space:]]*:/) hasenv[cur]=1
      if (lc ~ /when[[:space:]]*:[[:space:]]*manual/)      hasmanual[cur]=1
      # GitLab: a push rule INSIDE this job means the job fires on push
      if (gitlab_push(lc))                                 jobpush[cur]=1
      # a mutable ref selected ANYWHERE in the production-deploy job. A line
      # matcher cannot prove which line is THE deploy command, so a `verified`
      # reference elsewhere in the job (a build download, a tooling checkout)
      # must NOT suppress this — a mutable ref in the deploy job stays unsafe.
      if (lc ~ ("(^|[^a-z])ref[[:space:]]*:[[:space:]]*" Q "(refs/heads/)?(main|master|develop|trunk|head)([^a-z]|$)") ||
          lc ~ ("--ref[[:space:]=]+" Q "(refs/heads/)?(main|master|develop|trunk|head)([^a-z]|$)") ||
          lc ~ /github\.ref(_name)?([^a-z]|$)/ ||
          lc ~ /[:@]latest([^a-z]|$)/)                     hasmutable[cur]=1
    }
    END{
      unsafe=0
      for (i=1;i<=njobs;i++) {
        j=order[i]
        if (!(hasdeploy[j] && hasprod[j])) continue        # not a production-deploy job
        if ((fires || jobpush[j]) && !(hasenv[j] || hasmanual[j])) {
          printf "UNSAFE %s\n", file
          printf "  (a) job \047%s\047 deploys to production and fires automatically on push with\n", j
          print  "      nothing gating the push run (no environment: protection, no when: manual)."
          print  "      A workflow_dispatch trigger does not count. Fix: gate this job behind a"
          print  "      protected environment (or trigger the workflow only manually)."
          print  ""
          unsafe=1
        }
        if (hasmutable[j]) {
          printf "UNSAFE %s\n", file
          printf "  (b) job \047%s\047 selects a mutable ref (a moving branch / HEAD / :latest).\n", j
          print  "      A production deploy must ship ONLY the verified pointer/artifact; a"
          print  "      mutable ref means what reaches prod is whatever the branch is, not what"
          print  "      passed verification. A verified reference elsewhere in the job does not"
          print  "      clear this (the lint cannot prove the deploy uses it)."
          print  "      Fix: remove the mutable ref; deploy refs/tags/verified (or the verified artifact)."
          print  ""
          unsafe=1
        }
      }
      exit (unsafe ? 0 : 1)      # 0 = found unsafe (caller sets bad), 1 = safe
    }
  ' "$scan"
  local rc=$?
  rm -f "$scan"
  return "$rc"
}

# ---- collect files ---------------------------------------------------------
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  if [ ! -d "$WORKFLOWS_DIR" ]; then
    echo "OK — $WORKFLOWS_DIR does not exist (no workflows to check)"
    exit 0
  fi
  # The dir exists: a find that FAILS (e.g. unreadable) must not masquerade as
  # "no workflows found". Capture its status and fail closed on any error.
  if ! found=$(find "$WORKFLOWS_DIR" -maxdepth 1 \( -name '*.yml' -o -name '*.yaml' \) 2>&1); then
    echo "ERROR: cannot scan $WORKFLOWS_DIR: $found" >&2
    exit 2
  fi
  files=()
  while IFS= read -r line; do
    [ -n "$line" ] && files+=("$line")
  done <<< "$found"
fi

bad=0
for f in "${files[@]:-}"; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || { echo "ERROR: not a file: $f" >&2; exit 2; }
  if check_file "$f"; then bad=1; fi
done

if [ "$bad" -ne 0 ]; then
  echo "Promote-safety lint FAILED — an unsafe production-deploy path was found."
  exit 1
fi
echo "OK — no unsafe production-deploy workflows"
