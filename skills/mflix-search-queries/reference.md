# mflix search query reference

Copy-paste pipelines for `expected.llm_judge` reference queries. **Do not** put
these in `input.prompt` — prompts stay natural language.

## Text search — `$search` (index `default`)

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

## Vector search — `$vectorSearch`

Natural-language via `vector_auto_index`:

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

Precomputed embedding via `vector_index`:

```javascript
[{ $vectorSearch: { index: "vector_index", path: "plot_embedding_voyage_4_large",
    queryVector: [ /* 1024-dim embedding of a seed plot */ ],
    numCandidates: 40, limit: 6 } }]
```

## Hybrid search — `$rankFusion`

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

## Anti-patterns

- `"into a creature at night"` on plot → 38/40 (too broad)
- Common OR terms without `phrase` → near-full collection
- `vector_auto_index` burst queries → Voyage rate limits
