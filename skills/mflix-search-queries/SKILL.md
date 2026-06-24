---
name: mflix-search-queries
description: >-
  Run-verified low-selectivity text, vector, and hybrid search queries for the
  mflix movies eval seed (40 docs). Use when writing eval prompts, choosing plot
  search terms, building llm_judge reference aggregations, or authoring Atlas
  Search / Vector Search / hybrid eval cases.
---

# mflix search queries

Use for eval `input.prompt` terms and `expected.llm_judge` reference pipelines.
Target **2–11 of 40 docs** (never empty, never near-full collection).

## Dataset

| Item | Value |
|------|-------|
| Namespace (live cluster) | `sample_mflix.mcp_movies` |
| Eval seed collection | `movies` (`dbseed/mflix.movies.json`) |
| Docs | 40 |
| Text field | `plot` |
| Vector field | `plot_embedding_voyage_4_large` (1024-dim) |
| Filters / facets | `title`, `genres`, `director`, `cast`, `release_year`, `released`, `runtime`, `rating` |
| Aux collection | `synonyms` (`dbseed/mflix.synonyms.json`) |

## Indexes

| Name | Type | Notes |
|------|------|-------|
| `default` | search | dynamic text mappings |
| `vector_index` | vectorSearch | cosine on embedding; raw `queryVector` |
| `vector_auto_index` | vectorSearch | autoEmbed `voyage-4-large` on `plot`; natural-language `query` |

## Verified plot terms (text on `plot`)

| Query terms | Docs | % |
|-------------|------|---|
| terrorists hostage kill navy | 5 | 12.5% |
| father daughter family | 5 | 12.5% |
| doctor scientist experiment | 3 | 7.5% |
| revolution war world | 3 | 7.5% |
| alien spaceship earth invasion | 3 | 7.5% |
| marriage wedding sweetheart | 2 | 5% |
| exorcism nun church demon | 2 | 5% |
| island doctor epidemic undead | 2 | 5% |
| vampire | 2 | 5% |
| horror short stories directors | 2 | 5% |

## Vector / hybrid (summary)

| Theme | ~Docs | Limit |
|-------|-------|-------|
| virus outbreak / apocalypse | 5 | 5 |
| dangerous experiment transforms person | 5 | 5 |
| childhood sweetheart reunion | 5 | 5 |
| hitman / assassin contract | 5 | 5 |
| deadly threat on plane/ship | 5 | 5 |
| alien plot neighbors (`queryVector`) | 6 | 6 |
| aliens come to earth (hybrid) | 6 | 8 |
| vampire seduces/romances (hybrid) | 6 | 8 |
| contract killer (hybrid) | 6 | 8 |
| undead outbreak + Horror filter (hybrid) | 6 | 8 |

## Selectivity tips

- **Text**: terms are OR'd — common words inflate hits. Prefer table terms above.
- **Vector**: kNN returns up to `limit`; control fraction with `limit` (2–11) + `filter`.
- **Hybrid**: deduplicated union of sub-pipelines; cap with trailing `$limit`.
- **Auto-embed**: `vector_auto_index` hits Voyage rate limits (~3/min free tier);
  use `vector_index` + `queryVector` to avoid.

## Full pipeline syntax

See [reference.md](reference.md) for copy-paste `$search`, `$vectorSearch`, and
`$rankFusion` examples.

## Related

- Case authoring workflow: [eval-case-authoring](../eval-case-authoring/SKILL.md)
