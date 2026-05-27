#!/usr/bin/env bash
#
# Sync Braintrust datasets to/from local YAML files. Local files are the source
# of truth. The dataset name is the file's path UNDER <dir> (minus .yaml) with
# path separators turned into spaces, so the tree is searched recursively:
#   "dataset/Search/Index Management.yaml" <-> dataset "Search Index Management"
#   "dataset/Foo.yaml"                      <-> dataset "Foo"
#
#   pull  remote -> local : writes each remote dataset to <dir>/<name>.yaml
#   push  local  -> remote: FULL MIRROR (remote ends up exactly matching local)
#                             - local file, no remote dataset -> create dataset
#                             - existing dataset, per row:
#                                 * row in local            -> replace (overwrite)
#                                 * remote row not in local -> delete (soft)
#                             - remote dataset, no local file -> delete dataset
#
# History safety: rows are REPLACED in place via the Braintrust insert API with
# `_is_merge:false`, and removed rows are soft-deleted via `_object_delete:true`.
# Braintrust is append-only, so every previous row version stays in history and
# experiment links are preserved. Existing datasets are never delete+recreated.
#
# `push` (mirror) needs the Braintrust insert API and therefore a BRAINTRUST_API_KEY
# (bt's OAuth login is not enough). Override the API base with BRAINTRUST_API_URL.
#
# Flags:
#   --merge     Legacy mode: deep-merge rows by id via `bt datasets update`
#               (no API key needed, but never replaces fields or deletes rows).
#   --dry-run   Print what would be sent to the insert API; do not POST.
#
# Usage:
#   scripts/datasets.sh pull [-p PROJECT] [-d DIR]
#   scripts/datasets.sh push [-p PROJECT] [-d DIR] [--merge] [--dry-run]
#
# Requires: bt, yq (mikefarah v4+), jq, curl

set -euo pipefail

PROJECT="mongodb-mcp-server-evals"
DIR="dataset"
MODE="mirror"   # mirror | merge
DRY_RUN=0
API_URL="${BRAINTRUST_API_URL:-https://api.braintrust.dev}"
API_URL="${API_URL%/}"

usage() {
  # Print the leading comment block (skip the shebang, stop at the first code line).
  sed -n '2,/^[^#]/{/^[^#]/!p;}' "$0"
  exit "${1:-0}"
}

# --- parse args -------------------------------------------------------------
[ $# -ge 1 ] || usage 1
CMD="$1"
shift

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--project) PROJECT="$2"; shift 2 ;;
    -d|--dir)     DIR="$2"; shift 2 ;;
    --merge)      MODE="merge"; shift ;;
    --dry-run)    DRY_RUN=1; shift ;;
    -h|--help)    usage 0 ;;
    *) echo "Unknown argument: $1" >&2; usage 1 ;;
  esac
done

for bin in bt yq jq curl; do
  command -v "$bin" >/dev/null 2>&1 || { echo "Missing required dependency: $bin" >&2; exit 1; }
done

require_api_key() {
  if [ -z "${BRAINTRUST_API_KEY:-}" ]; then
    echo "Error: full-mirror push uses the Braintrust insert API, which needs BRAINTRUST_API_KEY." >&2
    echo "       Export it (e.g. 'export BRAINTRUST_API_KEY=sk-...') or use '--merge' for the" >&2
    echo "       legacy upsert mode, or '--dry-run' to preview without sending." >&2
    exit 1
  fi
}

# Dataset name for a file: its path under $DIR, sans .yaml, with "/" -> " ".
rel_name() {
  local rel="${1#"$DIR"/}"
  rel="${rel%.yaml}"
  printf '%s' "${rel//\// }"
}

# Existing local file (searched recursively) whose derived name matches, or the
# default flat path "$DIR/<name>.yaml" if none exists yet.
file_for_name() {
  local name="$1" f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$(rel_name "$f")" = "$name" ]; then
      printf '%s' "$f"
      return 0
    fi
  done < <(find "$DIR" -type f -name '*.yaml' 2>/dev/null)
  printf '%s/%s.yaml' "$DIR" "$name"
}

# --- commands ---------------------------------------------------------------
pull_all() {
  echo "Pulling datasets from project '$PROJECT' into '$DIR/'..."
  mkdir -p "$DIR"

  local names
  names="$(bt datasets -p "$PROJECT" list --json --no-input | yq -p=json -o=tsv '.[].name')"

  if [ -z "$names" ]; then
    echo "No datasets found in project '$PROJECT'."
    return 0
  fi

  while IFS= read -r name; do
    [ -n "$name" ] || continue
    local out
    out="$(file_for_name "$name")"
    echo "  - $name -> $out"
    mkdir -p "$(dirname "$out")"
    bt datasets -p "$PROJECT" view "$name" \
      --json --full --all-rows --no-input | yq -P > "$out"
  done <<< "$names"

  echo "Done."
}

# Mirror a single existing dataset's rows to match the local file exactly:
# replace local rows (_is_merge:false) + soft-delete remote rows missing locally.
mirror_rows() {
  local name="$1" dataset_id="$2" file="$3"

  local local_json local_events local_ids remote_ids delete_events events n_up n_del
  local_json="$(yq -o=json "$file")"

  if echo "$local_json" | jq -e '[.rows[] | select((.id // "") == "")] | length > 0' >/dev/null; then
    echo "    ! warning: some rows have no 'id'; they insert as new rows on every push" >&2
  fi

  local_events="$(echo "$local_json" | jq -c '[.rows[] | . + {_is_merge: false}]')"
  local_ids="$(echo "$local_json" | jq -c '[.rows[].id // empty]')"
  remote_ids="$(bt datasets -p "$PROJECT" view "$name" --json --full --all-rows --no-input \
    | jq -c '[.rows[].id // empty]')"

  delete_events="$(jq -nc --argjson r "$remote_ids" --argjson l "$local_ids" \
    '($r - $l) | map({id: ., _object_delete: true})')"
  events="$(jq -nc --argjson a "$local_events" --argjson d "$delete_events" '$a + $d')"

  n_up="$(echo "$local_events" | jq 'length')"
  n_del="$(echo "$delete_events" | jq 'length')"
  echo "    replace $n_up row(s), delete $n_del row(s)"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    [dry-run] POST $API_URL/v1/dataset/$dataset_id/insert"
    jq -nc --argjson e "$events" '{events: $e}'
    return 0
  fi

  require_api_key
  local resp code body
  resp="$(jq -nc --argjson e "$events" '{events: $e}' \
    | curl -sS -w $'\n%{http_code}' -X POST "$API_URL/v1/dataset/$dataset_id/insert" \
        -H "Authorization: Bearer $BRAINTRUST_API_KEY" \
        -H "Content-Type: application/json" \
        --data-binary @-)"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  if [ "$code" -ge 300 ] 2>/dev/null; then
    echo "    ERROR: insert API returned HTTP $code: $body" >&2
    return 1
  fi
}

push_all() {
  local dry_label=""
  [ "$DRY_RUN" -eq 1 ] && dry_label=", dry-run"
  echo "Pushing datasets from '$DIR/' to project '$PROJECT' (mode=$MODE$dry_label)..."

  # Discover local YAML files recursively under $DIR.
  local -a files=()
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    files+=("$f")
  done < <(find "$DIR" -type f -name '*.yaml' 2>/dev/null | sort)

  # Collect local dataset names (path under $DIR, minus .yaml, "/" -> " ").
  local -a local_names=()
  local file name
  if [ ${#files[@]} -gt 0 ]; then
    for file in "${files[@]}"; do
      local_names+=("$(rel_name "$file")")
    done
  fi

  # Collect remote datasets (need ids for the mirror insert calls).
  local remote_json remote_names
  remote_json="$(bt datasets -p "$PROJECT" list --json --no-input)"
  remote_names="$(echo "$remote_json" | jq -r '.[].name')"

  # 1) Create missing datasets / mirror (or merge) existing ones.
  if [ ${#files[@]} -eq 0 ]; then
    echo "  (no local '*.yaml' files to create/update)"
  else
    for file in "${files[@]}"; do
      name="$(rel_name "$file")"
      if printf '%s\n' "$remote_names" | grep -Fxq -- "$name"; then
        if [ "$MODE" = "merge" ]; then
          echo "  ~ merge '$name'"
          if [ "$DRY_RUN" -eq 1 ]; then
            echo "    [dry-run] bt datasets update --name='$name' (deep-merge rows from $file)"
          else
            bt datasets -p "$PROJECT" update \
              --name="$name" --no-input --file <(yq -o=json "$file") >/dev/null
          fi
        else
          local id
          id="$(echo "$remote_json" | jq -r --arg n "$name" '.[] | select(.name==$n) | .id')"
          echo "  ~ mirror '$name' (id=$id)"
          mirror_rows "$name" "$id" "$file"
        fi
      else
        echo "  + create '$name'"
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "    [dry-run] bt datasets create --name='$name' (seed from $file)"
        else
          bt datasets -p "$PROJECT" create \
            --name="$name" --no-input --file <(yq -o=json "$file") >/dev/null
        fi
      fi
    done
  fi

  # 2) Delete remote datasets that have no local file.
  if [ -n "$remote_names" ]; then
    local rname found
    while IFS= read -r rname; do
      [ -n "$rname" ] || continue
      found=0
      if [ ${#local_names[@]} -gt 0 ]; then
        for name in "${local_names[@]}"; do
          [ "$name" = "$rname" ] && { found=1; break; }
        done
      fi
      if [ "$found" -eq 0 ]; then
        echo "  - delete dataset '$rname' (no local file)"
        if [ "$DRY_RUN" -eq 1 ]; then
          echo "    [dry-run] bt datasets delete --name='$rname'"
        else
          bt datasets -p "$PROJECT" delete --name="$rname" --force --no-input >/dev/null
        fi
      fi
    done <<< "$remote_names"
  fi

  echo "Done."
}

case "$CMD" in
  pull) pull_all ;;
  push) push_all ;;
  -h|--help) usage 0 ;;
  *) echo "Unknown command: $CMD" >&2; usage 1 ;;
esac
