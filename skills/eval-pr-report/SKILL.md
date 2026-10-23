---
name: eval-pr-report
description: >-
  Measure eval accuracy and write the eval report into a PR description. Use
  when opening or updating a PR that changes eval cases or mongodb-mcp-server
  behavior, when re-measuring or comparing before/after eval runs, or when asked
  why scores changed or fluctuate.
---

# Eval PR report

A PR's **report** answers three questions with evidence: what the score is,
why it moved, and how much of it is noise. Every claim cites a Braintrust
experiment, trace, or judge explanation.

## 1. Define the comparison

- **Rows**: every row the PR adds or edits (`git diff main...HEAD -- dataset`),
  plus any existing row whose rubric it touches. Freeze the list as row `name`s;
  every run uses the same list.
- **Sides**: one variable per comparison.
  - Server or tool-description change: **before** = server commit without the
    change, **after** = with it; cases fixed at the PR head.
  - Case-only change: one side. Compare against the PR's previous report, on
    the same server commit.
- If anything else differs between sides (rebase base, harness prompt, judge
  model, reasoning effort), it goes in the report's caveats.

Done when the row list, both commits, and the single variable are written down.

## 2. Pin the environment

For each side:

1. **DB**: `docker ps` shows `mcp-eval-db` healthy, and `docker inspect` shows
   `VOYAGE_API_KEY` and `EMBEDDING_PROVIDER_ENDPOINT` set (names only; never
   print values).
2. **Server checkout**: `git status --short` in mongodb-mcp-server shows no
   tracked changes. Record commit and branch.
3. **Build**: start `pnpm eval:serve` with `.env` loaded (`set -a; . ./.env;
   set +a`). It runs `build:deps` first; if the server checkout's `eval:serve`
   lacks `build:deps`, run `pnpm build` in mongodb-mcp-server before starting.
   The eval imports compiled `dist/`, which git and Braintrust's `dirty` flag
   cannot see, so a stale build silently measures other code.
4. **Sentinel**: pick a phrase unique to the change (a new line of a tool
   description). After the first run, confirm it is present in every after
   trace and absent from every before trace (see
   [braintrust-scores.md](braintrust-scores.md)).

Done when the sentinel check passes for the side's first run. If it fails, the
run measured the wrong build: discard it and rebuild.

## 3. Run

```bash
set -a; . ./.env; set +a
for n in 1 2; do
  node_modules/.bin/tsx scripts/run-remote-eval.ts --skip-traces \
    --experiment "<label>-<side>-${n}_$(date +%Y-%m-%d_%H-%M-%S)" \
    --metadata-regex 'name=^(<Row A>|<Row B>|…)$' -- '<glob>' …
done
```

- At least **two runs per side**, run one after another on the same server
  process; parallel runs compete for embedding rate limits.
- Keep harness parameters identical across sides; set only what you must
  through `--params` and record it.
- `--skip-traces`: the local trace export currently writes zero files; read
  results through the SDK instead.

Done when every run reports scores for all rows and 0 errors.

## 4. Analyze

Pull per-row scores, judge explanations, tool calls, and `repo_info` for every
run with [braintrust-scores.md](braintrust-scores.md). Then:

- **Noise floor**: the spread of totals within a side. A before/after delta
  inside it is noise, not a finding.
- **Attribution**: the agent sees only `input.prompt`, the seeded DB, the
  system prompt, and tool descriptions; it never sees `reference_answer` or
  `llm_judge`. A rubric edit moves the score without changing behavior. Tie
  each changed row to the specific diff line that explains it, and back it with
  the before and after explanations. Count shifts in tool usage
  (e.g. `search-knowledge` calls) when facts move.
- **Classify every row below 1.0** in the after side:
  - **Ceiling**: capped by the tools, the deployment (Community vs Atlas), or
    the rubric. Name the cap and what would lift it.
  - **Behavior**: the agent consistently does the wrong thing. Quote the
    judge's reason.
- **Classify every row whose score differs across runs of one side**:
  - **Agent variance**: explanations describe different responses.
  - **Judge variance**: explanations describe the same gap scored
    differently.

Done when every row below 1.0 and every fluctuating row carries a class and
evidence.

## 5. Publish

1. Push the branch. If the active `gh` account lacks write access, run single
   commands with `GH_TOKEN=$(gh auth token --user <account>)`; keep the active
   account unchanged.
2. Save the current PR body to the session workspace as a backup.
3. Write the description from [pr-description.md](pr-description.md). The
   description is the single home of the current report; replace its
   Validation and Known Findings sections and keep the author's Summary.
4. `gh pr edit <n> --body-file …`, then read the body back and diff it against
   the file.

Done when the read-back body matches and every link in the table resolves to
the right experiment.

## Related

- Case YAML, judges, `eval:remote` flags: [eval-case-authoring](../eval-case-authoring/SKILL.md), `DEVELOPER.md`
