# Repository guidance for coding agents

Cross-tool entry point for **mongodb-eval-cases**. Tool-specific files
(`CLAUDE.md`, `.github/copilot-instructions.md`) point here.

Detailed workflows live in **`skills/`** at the repo root (agent-agnostic).

---

## Skills

| Skill | Path | Use when |
|-------|------|----------|
| **eval-case-authoring** | `skills/eval-case-authoring/SKILL.md` | Scaffolding taxonomy stubs, filling `dataset/**/*.yaml`, writing `llm_judge`, `pnpm typecheck`, `pnpm eval:remote`, fixing failed rows |
| **mflix-search-queries** | `skills/mflix-search-queries/SKILL.md` | Choosing plot terms, reference aggregations, text/vector/hybrid syntax, selectivity (2–11 of 40 docs) |

Read the `SKILL.md` for the relevant skill before editing eval cases. Each skill
has YAML frontmatter (`name`, `description`) for tools that support skill discovery.

---

## Quick rules (all tools)

1. **Natural-language prompts only** in `input.prompt` — no aggregation or index JSON.
2. **Ground truth in `expected`** — reference queries and scoring in `llm_judge`.
3. **2–11 of 40 docs** for query cases — use verified terms from **mflix-search-queries**.
4. **Mirror reference rows** when filling scaffold stubs — do not invent YAML shape from taxonomy alone.
5. **Sync seeds** to mongodb-mcp-server `tests/eval/dbSeed/` after changing `dbseed/`.

---

## File map

```
skills/
  eval-case-authoring/SKILL.md    # assumptions, constraints, templates, validate/test/fix
  mflix-search-queries/
    SKILL.md                        # dataset, verified terms, selectivity
    reference.md                    # $search / $vectorSearch / $rankFusion pipelines
dataset/                            # eval case YAML (taxonomy → cases.yaml)
dbseed/                             # movies + synonyms JSON
DEVELOPER.md                        # repo layout, pnpm scripts, remote eval setup
AGENTS.md                           # this index
```

---

## Legacy note

Content previously inlined in this file now lives in `skills/`. Keep `AGENTS.md`
as the index; edit skills for substantive guidance changes.
