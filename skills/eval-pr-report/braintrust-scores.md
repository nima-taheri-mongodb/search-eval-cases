# Reading eval results from Braintrust

Run from the repo root with `.env` loaded (`set -a; . ./.env; set +a`). The
`braintrust` SDK is already a dependency.

## Record layout

- One **root** span per row: `is_root: true`, `metadata.name` = case name,
  `input.prompt`.
- One **scorer** span per row: `span_attributes.name === "llmJudgeScore"`,
  score in `scores.llm_judge`, reason in `metadata.explanation`.
- **Tool** spans: `span_attributes.type === "tool"`, tool name in
  `span_attributes.name`. Each call appears twice; halve the count.
- Tool descriptions the agent saw are inside `generateText` spans. Search the
  whole record (`JSON.stringify(row)`), not only `llm` spans, for a sentinel.
- Server checkout at experiment creation: `repo_info` (`commit`, `branch`,
  `dirty`) from `api/experiment/get`. `dirty` ignores untracked files and
  compiled `dist/`.

## Links

- Experiment: `https://www.braintrust.dev/app/<org>/p/<project>/experiments/<name>`
- Trace: `<experiment>?r=<root_span_id>`
- Judge explanation: `<experiment>?r=<root_span_id>&s=<scorer span_id>`
  (write `&amp;` inside HTML).

## Fetch per-row results

```js
// node --input-type=module -e '…' (or save as /tmp/scores.mjs)
import { login, initExperiment } from "braintrust";
const state = await login({ apiKey: process.env.BRAINTRUST_API_KEY });
const projectId = "025be6d9-cc52-4d9e-a413-d8a9a48a8f6b"; // dataset/Search/_meta.yaml
const SENTINEL = /<phrase unique to the change>/;
for (const name of ["<experiment-1>", "<experiment-2>"]) {
  const info = (await state.appConn().post_json("api/experiment/get",
    { project_id: projectId, org_name: state.orgName, experiment_name: name }))[0];
  const exp = initExperiment({ projectId, experiment: name, open: true, state, setCurrent: false });
  const rows = []; for await (const r of exp.fetch()) rows.push(r);
  const roots = new Map(rows.filter(r => r.is_root).map(r => [r.root_span_id, r]));
  const sentinel = new Set(rows.filter(r => SENTINEL.test(JSON.stringify(r))).map(r => r.root_span_id));
  console.log(name, info.repo_info, "errors:", rows.filter(r => r.error).length,
    "sentinel:", `${sentinel.size}/${roots.size}`);
  for (const s of rows.filter(r => r.span_attributes?.name === "llmJudgeScore")) {
    const root = roots.get(s.root_span_id);
    const tools = rows.filter(t => t.root_span_id === s.root_span_id && t.span_attributes?.type === "tool")
      .map(t => t.span_attributes.name);
    console.log(JSON.stringify({ case: root.metadata.name, score: s.scores.llm_judge,
      root: s.root_span_id, scorer: s.span_id, tools, explanation: s.metadata?.explanation }));
  }
}
state.disable();
```
