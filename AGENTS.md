# Repository guidance for coding agents

This file is the cross-tool source of truth for AI coding assistants (Cursor,
GitHub Copilot, Claude, and any agent that reads `AGENTS.md`). Tool-specific
entry files (`CLAUDE.md`, `.github/copilot-instructions.md`) point here.

---

## mflix Search Query Examples

Curated, run-verified example queries for the seeded movies dataset. Use these
when an eval case (or any query) needs to return a **small fraction** of the
data — more than 1 doc and fewer than 30%, i.e. **2-11 of 40 docs**.

### Dataset

- **Namespace**: `sample_mflix.mcp_movies` (40 documents)
- **Seed files**: `dbseed/mflix.movies.json` and
  `dbseed/mflix.movies-with-plot-embedding.json` (same docs; the second adds the
  embedding field)
- **Searchable fields**: `plot` (text), `plot_embedding_voyage_4_large`
  (1024-dim, `voyage-4-large`), plus `title`, `genres`, `director`, `cast`,
  `release_year`, `runtime`, `rating`
- **Indexes**:
  - `default` — text `search` index, dynamic mappings
  - `vector_index` — `vectorSearch` on `plot_embedding_voyage_4_large` (cosine),
    filters on `genres`, `release_year`, `rating`; query with a raw `queryVector`
  - `vector_auto_index` — `vectorSearch` with `autoEmbed` (`voyage-4-large`) on
    `plot`; query with natural-language `query` text (no client-side embedding)

### Verified examples

| Type | Example query | Docs | % |
|------|---------------|------|---|
| Text (plot) | terrorists hostage kill navy | 5 | 12.5% |
| Text (plot) | father daughter family | 5 | 12.5% |
| Text (plot) | doctor scientist experiment | 3 | 7.5% |
| Text (plot) | revolution war world | 3 | 7.5% |
| Text (plot) | alien spaceship earth invasion | 3 | 7.5% |
| Text (plot) | marriage wedding sweetheart | 2 | 5% |
| Text (plot) | exorcism nun church demon | 2 | 5% |
| Text (plot) | island doctor epidemic undead | 2 | 5% |
| Text (plot) | vampire | 2 | 5% |
| Text (plot) | horror short stories directors | 2 | 5% |
| Vector (plot) | group survives a virus outbreak / apocalypse (limit 5) | 5 | 12.5% |
| Vector (plot) | dangerous experiment transforms person (limit 5) | 5 | 12.5% |
| Vector (plot) | reunites with childhood sweetheart (limit 5) | 5 | 12.5% |
| Vector (plot) | hitman/assassin contract (limit 5) | 5 | 12.5% |
| Vector (plot) | deadly threat aboard plane/ship (limit 5) | 5 | 12.5% |
| Vector (plot) | nearest neighbors of an alien plot, raw queryVector (limit 6) | 6 | 15% |
| Hybrid (plot) | aliens come to earth (limit 8) | 6 | 15% |
| Hybrid (plot) | vampire seduces/romances (limit 8) | 6 | 15% |
| Hybrid (plot) | contract killer, equal weights (limit 8) | 6 | 15% |
| Hybrid (plot) | undead outbreak, filtered to Horror (limit 8) | 6 | 15% |

### Text search — `$search` (index `default`)

On `plot`:

```javascript
[{ $search: { index: "default", text: { query: "terrorists hostage kill navy", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "father daughter family", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "doctor scientist experiment", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "revolution war world", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "alien spaceship earth invasion", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "marriage wedding sweetheart", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "exorcism nun church demon", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "island doctor epidemic undead", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "vampire", path: "plot" } } }]
[{ $search: { index: "default", text: { query: "horror short stories directors", path: "plot" } } }]
```

### Vector search — `$vectorSearch`

Natural-language via `vector_auto_index` (auto-embeds the query text):

```javascript
[{ $vectorSearch: { index: "vector_auto_index", path: "plot",
    query: "a group of people survive a deadly virus outbreak or apocalypse",
    numCandidates: 40, limit: 5 } }]

[{ $vectorSearch: { index: "vector_auto_index", path: "plot",
    query: "a scientist creates a dangerous experiment that transforms a person",
    numCandidates: 40, limit: 5 } }]

[{ $vectorSearch: { index: "vector_auto_index", path: "plot",
    query: "a couple reunites with a childhood sweetheart and falls in love",
    numCandidates: 40, limit: 5 } }]

[{ $vectorSearch: { index: "vector_auto_index", path: "plot",
    query: "a hitman or assassin reluctantly accepts a contract to kill a target",
    numCandidates: 40, limit: 5 } }]

[{ $vectorSearch: { index: "vector_auto_index", path: "plot",
    query: "a deadly threat is unleashed aboard a plane, ship, or ferry",
    numCandidates: 40, limit: 5 } }]
```

Precomputed embedding via `vector_index` (raw `queryVector`, no Voyage call) —
e.g. find a document's nearest neighbors by passing its own
`plot_embedding_voyage_4_large` array:

```javascript
[{ $vectorSearch: { index: "vector_index", path: "plot_embedding_voyage_4_large",
    queryVector: [ /* 1024-dim embedding of a seed plot */ ],
    numCandidates: 40, limit: 6 } }]
```

### Hybrid search — `$rankFusion` (lexical + vector)

```javascript
// aliens come to earth → 6 docs (equal weights)
[
  { $rankFusion: {
      input: { pipelines: {
        vector:  [{ $vectorSearch: { index: "vector_auto_index", path: "plot",
                     query: "aliens from outer space come to earth",
                     numCandidates: 40, limit: 6 } }],
        lexical: [{ $search: { index: "default", text: { query: "alien earth", path: "plot" } } },
                  { $limit: 6 }]
      } },
      combination: { weights: { vector: 1, lexical: 1 } }
  } },
  { $limit: 8 },
  { $project: { _id: 0, title: 1, genres: 1, plot: 1 } }
]

// vampire seduces/romances → 6 docs (lexical weighted higher)
[
  { $rankFusion: {
      input: { pipelines: {
        vector:  [{ $vectorSearch: { index: "vector_auto_index", path: "plot",
                     query: "a vampire seduces and romances a young woman",
                     numCandidates: 40, limit: 6 } }],
        lexical: [{ $search: { index: "default", text: { query: "vampire seduce romance", path: "plot" } } },
                  { $limit: 6 }]
      } },
      combination: { weights: { vector: 1, lexical: 1.5 } }
  } },
  { $limit: 8 },
  { $project: { _id: 0, title: 1, genres: 1, plot: 1 } }
]

// contract killer, equal weights → 6 docs
[
  { $rankFusion: {
      input: { pipelines: {
        vector:  [{ $vectorSearch: { index: "vector_auto_index", path: "plot",
                     query: "a contract killer reluctantly takes a job to kill someone",
                     numCandidates: 40, limit: 6 } }],
        lexical: [{ $search: { index: "default", text: { query: "hitman killing witness mob", path: "plot" } } },
                  { $limit: 6 }]
      } },
      combination: { weights: { vector: 1, lexical: 1 } }
  } },
  { $limit: 8 },
  { $project: { _id: 0, title: 1, genres: 1, plot: 1 } }
]

// undead outbreak, both pipelines filtered to genre "Horror" → 6 docs
[
  { $rankFusion: {
      input: { pipelines: {
        vector:  [{ $vectorSearch: { index: "vector_auto_index", path: "plot",
                     query: "survivors trying to escape the undead after a deadly outbreak",
                     filter: { genres: "Horror" }, numCandidates: 40, limit: 6 } }],
        lexical: [{ $search: { index: "default", compound: {
                     must:   [{ text: { query: "undead epidemic zombie", path: "plot" } }],
                     filter: [{ text: { query: "Horror", path: "genres" } }] } } },
                  { $limit: 6 }]
      } },
      combination: { weights: { vector: 1, lexical: 1 } }
  } },
  { $limit: 8 },
  { $project: { _id: 0, title: 1, genres: 1, plot: 1 } }
]
```

### Selectivity tips

- **Text (`$search`)**: terms are OR'd, so common words inflate results (e.g.
  "into a creature at night" matched 38/40). Prefer rare/specific terms, or use
  a `phrase` operator (e.g. `phrase: { query: "group of", path: "plot" }` → 3).
- **Vector (`$vectorSearch`)**: kNN returns up to `limit` docs regardless of the
  query, so control the fraction with `limit` (2-11) and optional `filter`.
- **Hybrid (`$rankFusion`)**: the result set is the deduplicated union of the
  sub-pipelines; cap it with a trailing `$limit`. Tune relative influence via
  `combination.weights`.
- **Auto-embed rate limit**: `vector_auto_index` calls Voyage at query time; on
  the free tier this is ~3 requests/min. Space out auto-embed queries, or use
  `vector_index` with a precomputed `queryVector` to avoid Voyage entirely.
