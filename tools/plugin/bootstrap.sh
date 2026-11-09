#!/usr/bin/env bash
# Run only from a reviewed checkout. Bun's archive is pinned by version and digest.
set -euo pipefail
# Verification and the installer must refer to this checkout, including in hooks.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS
for name in ${!GIT_CONFIG_KEY_@} ${!GIT_CONFIG_VALUE_@}; do unset "$name"; done
provision=0
trust_local=0
source_arg=''
channel_arg=''
only_arg=''
revision=''
bun_version=''
bun_sha=''
setup_args=()
while (($#)); do
  case "$1" in
    --provision) provision=1 ;;
    --trust-local-source) trust_local=1 ;;
    --apply) setup_args+=("$1") ;;
    --claude|--codex)
      [[ -z "$only_arg" || "$only_arg" == "$1" ]] || { echo 'Choose one agent or neither' >&2; exit 2; }
      only_arg=$1
      setup_args+=("$1") ;;
    --source|--channel)
      (($# >= 2)) && [[ -n "$2" && "$2" != --* ]] || { echo "$1 needs a value" >&2; exit 2; }
      if [[ "$1" == --channel ]]; then
        [[ "$2" == stable || "$2" == latest ]] || { echo 'Unknown channel' >&2; exit 2; }
        channel_arg=$2
      else source_arg=$2; fi
      setup_args+=("$1" "$2")
      shift ;;
    --revision|--bun-version|--bun-sha256)
      (($# >= 2)) || { echo "$1 needs a value" >&2; exit 2; }
      case "$1" in
        --revision) revision=$2 ;;
        --bun-version) bun_version=$2 ;;
        --bun-sha256) bun_sha=$2 ;;
      esac
      shift ;;
    *) echo "Unknown bootstrap argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Pass --revision with the full reviewed source commit.' >&2; exit 2; }
root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
verify_source() {
  local head dirty flags entry
  head=$(git -C "$root" rev-parse HEAD) || return 1
  [[ "$head" == "$revision" ]] || { echo 'Checkout does not match reviewed revision' >&2; return 1; }
  flags=$(git -C "$root" ls-files -v) || return 1
  while IFS= read -r entry; do
    case "$entry" in
      [a-zS]' '*) echo 'Index flags hide possible source changes; clear assume-unchanged and skip-worktree first' >&2; return 1 ;;
    esac
  done <<< "$flags"
  dirty=$(git -C "$root" --work-tree="$root" status --porcelain --untracked-files=no) || return 1
  [[ -z "$dirty" ]] || { echo 'Tracked source has local changes; review a clean checkout first' >&2; return 1; }
  git -C "$root" ls-files --error-unmatch -- tools/plugin/bootstrap.sh tools/plugin/bootstrap.ts >/dev/null
}
[[ -z "$channel_arg" || "$source_arg" != *'#'* ]] || { echo 'Source ref and channel contradict each other' >&2; exit 2; }
os=$(uname -s)
arch=$(uname -m)
case "$os/$arch" in
  Darwin/x86_64) platform=darwin-x64 ;;
  Darwin/arm64) platform=darwin-aarch64 ;;
  Linux/x86_64) platform=linux-x64 ;;
  Linux/aarch64|Linux/arm64) platform=linux-aarch64 ;;
  *) echo "Unsupported bootstrap platform: $os/$arch" >&2; exit 2 ;;
esac
missing=()
for tool in bun git gh; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "$tool: $(command -v "$tool")"
  else
    missing+=("$tool")
  fi
done
echo "Platform: $platform; shell: ${SHELL:-unknown}; missing: ${missing[*]:-none}"
echo 'Plan: prepare missing prerequisites only with --provision; agent installation requires --apply. No automatic login or scheduled jobs.'
agent_found=0
for agent in claude codex; do
  [[ -z "$only_arg" || "$only_arg" == "--$agent" ]] || continue
  if command -v "$agent" >/dev/null 2>&1; then
    echo "$agent: $(command -v "$agent")"
    agent_found=1
  else echo "$agent: missing"; fi
done
((agent_found)) || { echo 'Install a supported agent CLI explicitly, then rerun bootstrap.' >&2; exit 1; }
if command -v git >/dev/null 2>&1; then
  verify_source || exit 1
elif ((trust_local == 0)); then
  echo 'Git is missing: cannot verify the source checkout. Review the local source yourself and pass --trust-local-source to allow prerequisite provisioning, or install git first.' >&2
  exit 1
fi

if ((${#missing[@]})); then
  if ! command -v bun >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || { echo 'Install curl 8.4.0 or later explicitly before provisioning Bun.' >&2; exit 1; }
    curl_info=$(curl --version) || { echo 'Cannot inspect curl; install curl 8.4.0 or later explicitly.' >&2; exit 1; }
    if [[ "$curl_info" =~ ^curl[[:space:]]+([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
      curl_major=$((10#${BASH_REMATCH[1]}))
      curl_minor=$((10#${BASH_REMATCH[2]}))
      echo "Bun download prerequisite: curl ${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
      ((curl_major > 8 || (curl_major == 8 && curl_minor >= 4))) || { echo 'Upgrade curl explicitly to curl 8.4.0 or later before provisioning Bun; older curl cannot bound unknown-length downloads.' >&2; exit 1; }
    else
      echo 'Cannot read curl version; install curl 8.4.0 or later explicitly.' >&2
      exit 1
    fi
  fi
  if ((provision == 0)); then
    echo 'Preview only. Install missing tools yourself or rerun with --provision. Bun provisioning also requires --bun-version and --bun-sha256 from its reviewed release asset.'
    exit 1
  fi
  if ! command -v bun >/dev/null 2>&1; then
    [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$bun_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'Bun provisioning requires --bun-version X.Y.Z and --bun-sha256 with the reviewed release asset digest.' >&2; exit 2; }
  fi
  packages=()
  for tool in "${missing[@]}"; do
    [[ "$tool" == bun ]] || packages+=("$tool")
  done
  if ((${#packages[@]})); then
    timer=$(command -v timeout || command -v gtimeout || true)
    [[ -n "$timer" ]] || { echo 'Install GNU timeout (coreutils on macOS) explicitly, or install git and gh yourself; provisioning requires bounded execution.' >&2; exit 1; }
    provision_timeout=${JIG_SETUP_TIMEOUT_SECONDS:-300}
    [[ "$provision_timeout" =~ ^[0-9]+([.][0-9]+)?$ && "$provision_timeout" =~ [1-9] ]] || { echo 'JIG_SETUP_TIMEOUT_SECONDS must be positive seconds' >&2; exit 2; }
    provision_run() {
      local code=0
      # sudo relays termination to its command and needs the caller's terminal.
      if [[ "$1" == sudo ]]; then
        "$timer" --foreground --kill-after=5s "${provision_timeout}s" "$@" || code=$?
      else
        "$timer" --kill-after=5s "${provision_timeout}s" "$@" || code=$?
      fi
      if ((code == 124 || code == 137)); then
        echo "Provisioning timed out after ${provision_timeout}s (JIG_SETUP_TIMEOUT_SECONDS)" >&2
      fi
      return "$code"
    }
    if command -v brew >/dev/null 2>&1; then
      echo "Provision: Homebrew/core ${packages[*]}, trusting this existing Homebrew installation and its verified bottle metadata."
      provision_run brew install "${packages[@]/#/homebrew/core/}"
    elif [[ "$os" == Linux ]] && command -v apt-get >/dev/null 2>&1; then
      echo "Provision: APT ${packages[*]}, trusting this machine's configured signed repositories; may request sudo."
      provision_run sudo apt-get -o APT::Get::AllowUnauthenticated=false -o Acquire::AllowInsecureRepositories=false install -- "${packages[@]}"
    else
      echo 'No supported existing package manager. Install git and gh explicitly, then rerun.' >&2
      exit 1
    fi
  fi
  if ! command -v bun >/dev/null 2>&1; then
    [[ "$bun_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && "$bun_sha" =~ ^[0-9a-f]{64}$ ]] || { echo 'Bun requires --bun-version X.Y.Z and --bun-sha256 with the reviewed GitHub release asset digest.' >&2; exit 2; }
    for tool in curl unzip; do command -v "$tool" >/dev/null || { echo "Install $tool explicitly first" >&2; exit 1; }; done
    scratch=$(mktemp -d)
    trap 'rm -rf -- "$scratch"' EXIT
    archive="$scratch/bun.zip"
    url="https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/bun-${platform}.zip"
    echo "Provision: Bun $bun_version ($platform), SHA-256 $bun_sha; write $HOME/.bun/bin/bun. No shell profile edits."
    for ((hop=0; hop<4; hop++)); do
      case "$url" in
        https://github.com/oven-sh/bun/releases/download/*|https://release-assets.githubusercontent.com/*) ;;
        *) echo 'Refusing unexpected download destination' >&2; exit 1 ;;
      esac
      response=$(curl -q --proto '=https' --proto-redir '=https' --connect-timeout 15 --max-time 120 --max-filesize 104857600 --silent --show-error --output "$archive" --write-out '%{http_code} %{redirect_url}' "$url")
      status=${response%% *}
      if [[ "$status" == 200 ]]; then break; fi
      [[ "$status" == 301 || "$status" == 302 || "$status" == 303 || "$status" == 307 || "$status" == 308 ]] || { echo "Download failed: HTTP $status" >&2; exit 1; }
      url=${response#* }
    done
    [[ "$status" == 200 ]] || { echo 'Too many download redirects' >&2; exit 1; }
    if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$archive"); else actual=$(shasum -a 256 "$archive"); fi
    [[ "${actual%% *}" == "$bun_sha" ]] || { echo 'Bun checksum mismatch; no downloaded code executed' >&2; exit 1; }
    unzip -p "$archive" "bun-${platform}/bun" > "$scratch/bun"
    [[ -s "$scratch/bun" ]] || { echo 'Invalid Bun archive' >&2; exit 1; }
    [[ ! -e "$HOME/.bun/bin/bun" ]] || { echo 'Bun already exists outside PATH; inspect it instead of overwriting' >&2; exit 1; }
    mkdir -p -- "$HOME/.bun/bin"
    install -m 755 "$scratch/bun" "$HOME/.bun/bin/bun"
    rm -rf -- "$scratch"
    trap - EXIT
    export PATH="$HOME/.bun/bin:$PATH"
  fi
fi
verify_source || exit 1
exec bun --no-env-file --config "$root/plugin/gc/bunfig.toml" "$root/tools/plugin/bootstrap.ts" ${setup_args[@]+"${setup_args[@]}"}
