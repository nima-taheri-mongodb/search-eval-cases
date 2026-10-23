# PR description template

The report lives in the PR description, in this order. Keep the author's
`## Summary` verbatim; replace everything from `## Validation` down.

## `## Validation`

1. One sentence: which rows (count and why those), how many runs per side, and
   the single variable being compared.
2. Experiments table, one row per run:

   ```markdown
   | | Experiment | Server commit | Score |
   |---|---|---|---:|
   | Before | [`<name>`](<experiment URL>) | `<sha8>` | 9.3 / 16 (58.13%) |
   | After  | [`<name>`](<experiment URL>) | `<sha8>` | 14.3 / 16 (89.38%) |
   ```

3. Headline bullet: **Before X% → After Y% (+Z points)**, how many rows
   improved and how many regressed, and the delta compared with the noise
   floor.
4. Setup bullet: agent and judge models with reasoning effort, DB image and
   embedding provider, execution errors, `dirty` flag, build step, sentinel
   result (present in N/N after traces, 0/N before), cases commit.
5. Change bullet: what the compared change does, in one or two sentences.

## `## Known Findings`

### `### Eval Report`

An HTML table, one row per case, then a total row. Each score links to its
judge explanation; each case name links to a representative after trace.

```html
<tr id="eval-case-07"><td align="right">7</td>
<td><a href="<exp>?r=<root_span_id>">Case Name</a><br><sub><i>"<input.prompt>"</i></sub></td>
<td align="right"><a href="<exp>?r=<root>&amp;s=<scorer_span>">0.0</a> / …</td>
<td align="right"><a href="…">1.0</a> / …</td>
<td align="right"><b>+1.00</b></td>
<td><sub><b>Before:</b> what the agent did. <br><b>After:</b> what changed and which diff line caused it.</sub></td></tr>
```

Columns: `#`, Case, Before (per run), After (per run), Δ avg (`—` when zero),
What changed. Order rows from stable full-credit through improved to capped
and failing.

### `### Why The Score Changed`

Group the improved and regressed rows by cause. Each cause names the diff line
(or rubric edit) and cites the before and after evidence. Mark rubric-only
changes as such.

### `### Why Some Cases Are Not 100%`

One bullet per row below 1.0, labeled **Ceiling** or **Behavior**, with the
cap or the judge's reason and the fix that would lift it. End with the maximum
achievable score under current tools and deployment.

### `### Which Cases Fluctuate And Why`

Per side: the rows whose scores differ across runs, labeled **agent variance**
or **judge variance** with the evidence. End with the noise floor.

### `### Caveats And Follow-Up`

Everything that differs between sides besides the compared variable,
generalization risks (e.g. tool text mirroring rubric checklists), cost (e.g.
tokens added to every request), then concrete next steps.

## Style

- Every number links to, or is derivable from, an experiment in the table.
- Judge explanations are summarized, not pasted; say they are unverified
  against product docs.
- Use the anchor form `[Case Name](#user-content-eval-case-07)` to cross-link
  rows from prose.
