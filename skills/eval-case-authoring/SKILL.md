---
name: eval-case-authoring
description: >-
  Author, fill, validate, test, and fix MongoDB Search eval case YAML in
  mongodb-eval-cases. Use when scaffolding taxonomy stubs, writing input.prompt
  or expected.llm_judge, editing dataset/**/*.yaml, running pnpm typecheck or
  eval:remote, or fixing failed eval rows.
---

# Eval case authoring

## When to use

- Filling `input.prompt: ""` stubs after `pnpm scaffold`
- Writing or reviewing `expected.llm_judge` / `expected.example`
- Configuring `input.db_seed` and seed JSON changes
- Running `pnpm typecheck`, `pnpm eval:remote`, or debugging failed traces

## Scaffolding workflow

`pnpm scaffold` creates L3 YAML under `dataset/` with one row per taxonomy leaf:
`label`, `metadata.summary`, `input.prompt: ""`.

Fill stubs **per L3 file** using a **complete reference row** in that file (or an
adjacent filled file) as the template. Copy `input` / `expected` / `metadata`
shape; adapt prompt, `db_seed`, and judge per leaf.

**Do not** invent structure from `taxonomy.yaml` alone when a reference row exists.

## Assumptions

- **Dataset**: `movies` seed (`dbseed/mflix.movies.json`, 40 docs).
- **Eval harness**: **mongodb-mcp-server** `tests/eval/mongodb.eval.ts` — fresh
  temp DB per row, MCP agent (10 steps), LLM judge with MCP tools.
- **Seeds at eval time**: loaded from mcp-server `tests/eval/dbSeed/`. Keep this
  repo's `dbseed/` in sync (copy JSON + update `datasetHelpers.ts`; restart
  `pnpm eval:serve`).
- **Prompts**: natural language only — no pipelines, `createSearchIndexes` JSON,
  or stage syntax in `input.prompt`.
- **Ground truth**: reference aggregations and scoring in `expected.llm_judge`
  (optional `expected.example` for index creation).
- **Selectivity**: use verified plot terms from **mflix-search-queries**
  (2–11 of 40 docs).
- **Judge vars**: `$response` = final text; `$conversation` = tool transcript.

## Constraints

| Area | Rule |
|------|------|
| `db_seed` | Bare `movies` or `movies` + pre-built search indexes matching the prompt |
| Seed fields | Must exist in JSON; add to both movies seed files + mcp-server |
| Synonyms cases | `db_seed`: `[synonyms, movies]`; register `mflix.synonyms.json` |
| MCP `create-index` | Only `mappings`, top-level `analyzer`, `numPartitions` — not `storedSource`, `synonyms`, `typeSets`, `analyzers[]`, multi-field arrays, or facet types |
| Advanced index leaves | Judge: 1.0 if index exists OR full definition in `$response`; 0.5 if only `$response` |

## Row templates

**Query construction** (Faceted Search, Post-Search Aggregation):

```yaml
- label: <taxonomy leaf>
  input:
    db_seed:
      - movies:
          indexes: [{ name: default, type: search, definition: { … } }]
    prompt: |
      <natural-language task>
  expected:
    llm_judge: |
      ### Success criterion
      <one sentence>

      ### Reference query
      aggregate([ … ])

      ### Scoring
      - Score 1.0 when …
      - Reduce the score to 0 if `$response` is empty.
      - Multiply the score by 0.2x if no search index was used in `$conversation` …
  metadata:
    summary: <from taxonomy>
```

**Index creation**:

```yaml
- label: <taxonomy leaf>
  input:
    db_seed:
      - movies
    prompt: |
      <natural-language create-index task>
  expected:
    example: |
      createSearchIndexes({ type: "search", definition: { … } })
    llm_judge: |
      ### Success criterion
      …
      ### Scoring
      - Score 1.0 when …
      - Score 0.5 when …
      - Score 0 when …
  metadata:
    summary: <from taxonomy>
```

Use bullet points under `### Scoring`. Omit `id` / `origin` on new rows unless
syncing existing Braintrust records.

## Validate, test, fix

```bash
pnpm typecheck
pnpm eval:remote --dry-run -- "dataset/Team - Search/.../Faceted Search.yaml"
```

Full eval (Atlas Local on `:27017`, mcp-server `pnpm eval:serve`):

```bash
BRAINTRUST_API_KEY=… pnpm eval:remote "dataset/Team - Search/.../*.yaml"
```

Traces: `output/<experiment>/`.

| Symptom | Fix |
|---------|-----|
| Empty `$response` | Pick verified low-selectivity plot terms (mflix-search-queries) |
| Date facet 0 | Add `released` to seed + `date` mapping in `db_seed` |
| String facet mismatch | `genres` as `stringFacet` in case `db_seed` |
| Synonym case fails | Seed `synonyms`; list before `movies` in `db_seed` |
| Index creation 0 | MCP limits → 0.5 tier for correct definition in `$response` |
| Judge rate limit | Re-run case |
| Pipeline in prompt | Rewrite prompt; keep syntax in `llm_judge` only |

After `dbseed/` changes: sync to mcp-server `tests/eval/dbSeed/`, update
`datasetHelpers.ts`, restart `pnpm eval:serve`.

## Related

- Plot terms and query syntax: [mflix-search-queries](../mflix-search-queries/SKILL.md)
- Repo layout and scripts: `DEVELOPER.md`
