/**
 * The fixture forge's REST pull document: the jq program that rewrites the
 * stub's `gh pr view --json` answer into the shape the pull request's REST
 * read returns, for the status evaluation's reads (callers `snapshot` and
 * `still-on-head`).
 */
export const PULL_DOCUMENT_JQ = `
      def present($k): has($k) and .[$k] != null;
      . as $v
      | {}
      | if ($v | present("state")) then
          .state = (if $v.state == "OPEN" then "open"
                    elif ($v.state == "CLOSED" or $v.state == "MERGED") then "closed"
                    else ($v.state | tostring | ascii_downcase) end)
          | .merged = ($v.state == "MERGED")
        else . end
      | if ($v | has("isDraft")) then .draft = $v.isDraft else . end
      | if ($v | present("headRefOid")) then .head.sha = $v.headRefOid else . end
      | if ($v | present("headRefName")) then .head.ref = $v.headRefName else . end
      | if ($v | present("baseRefOid")) then .base.sha = $v.baseRefOid else . end
      | if ($v | present("baseRefName")) then .base.ref = $v.baseRefName else . end
      | if ($v | present("mergeable")) then
          .mergeable = (($v.mergeable | tostring | ascii_upcase) as $m
            | if $m == "MERGEABLE" then true elif $m == "CONFLICTING" then false
              elif $m == "UNKNOWN" then null else $v.mergeable end)
        else . end
      | if ($v | present("mergeStateStatus")) then .mergeable_state = ($v.mergeStateStatus | tostring | ascii_downcase) else . end`;
