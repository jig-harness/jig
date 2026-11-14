/** Workflow-run reads and retries for the drive fixture forge. */
export const RUN_FORGE_FIXTURE = `# \`gh run view <id> --log-failed\` answers from \`run-<id>.log\`, failing
# without one, as for a run whose log cannot be read. \`gh run rerun <id>\`
# records the id in \`reruns.log\`; with \`rerun-refused\` it is refused the
# way the forge refuses a run it does not re-run, and otherwise the re-run
# passes: every failed check on the head reads successful.
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "view" ]; then
  if [[ " $* " == *" --json "* ]]; then
    if [ -f "$F/retry-witness-sequence" ] && [ -f "$F/reruns.log" ]; then
      count=$(cat "$F/retry-witness-count" 2>/dev/null || echo 0)
      count=$((count + 1)); printf '%s' "$count" > "$F/retry-witness-count"
      if [ "$count" -eq 1 ]; then
        jq '{headSha: .headRefOid, status: "completed", attempt: 1}' "$F/pr-view.json"
      elif [ "$count" -eq 2 ]; then
        jq '{headSha: .headRefOid, status: "in_progress", attempt: 2}' "$F/pr-view.json"
      else
        jq '{headSha: .headRefOid, status: "completed", attempt: 2}' "$F/pr-view.json"
      fi
      exit 0
    fi
    if [ -f "$F/run-\${3:-}.json" ]; then cat "$F/run-\${3:-}.json"; else
      jq '{headSha: .headRefOid, status: "completed", attempt: 1}' "$F/pr-view.json"
    fi
    exit 0
  fi
  log="$F/run-\${3:-}.log"
  [ -f "$log" ] || { echo "gh-stub: no log for run \${3:-}" >&2; exit 1; }
  cat "$log"; exit 0
fi
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "rerun" ]; then
  printf '%s\\n' "\${3:-}" >> "$F/reruns.log"
  if [ -f "$F/rerun-refused" ]; then
    echo "run \${3:-} cannot be rerun; This workflow run cannot be retried" >&2
    exit 1
  fi
  jq '{headSha: .headRefOid, status: "completed", attempt: 2}' "$F/pr-view.json" > "$F/run-\${3:-}.json"
  [ ! -f "$F/rerun-still-failing" ] || exit 0
  jq '(.check_runs[] | select(.conclusion == "failure")) |= (.conclusion = "success")' "$F/check-runs.json" > "$F/check-runs.json.tmp"
  mv "$F/check-runs.json.tmp" "$F/check-runs.json"
  exit 0
fi

`;
