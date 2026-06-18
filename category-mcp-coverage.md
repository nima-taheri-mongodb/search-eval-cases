## 1. Vector Index Management

**Product areas:** Vector Search, Text Search, Auto Embeddings  
**Coverage:** 🟢 Strong partial  
**Primary tools:** `create-index`, `collection-indexes`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | MCP path |
|--------|----------|----------|
| Multi-tenant SaaS — isolate queries per tenant | 🟡 | `create-index` filter fields + `search-knowledge` (tenant field in index + query filter) |
| Index 500M product image embeddings with high recall | 📚 | `search-knowledge` (scaling, quantization, numPartitions); not exercisable at eval scale |
| Migrate OpenAI embeddings → auto-embeddings | 📚 | `search-knowledge`; no migration/orchestration tool |

### Breakdown from `old-draft.md` — §2 Vector Search Index Creation

| Feature code | Topic | Coverage | Expected tool |
|--------------|-------|----------|---------------|
| `IDX_VEC_SIMILARITY` | cosine / euclidean / dotProduct | ✅ | `create-index` → `vectorSearch` field `similarity` |
| `IDX_VEC_QUANTIZATION` | scalar / binary quantization | ✅ | `create-index` → `quantization` |
| `IDX_VEC_FILTER_FIELDS` | pre-filter field declarations | ✅ | `create-index` → `type: "filter"` fields |
| `IDX_VEC_AUTO_EMBED` | auto-embed from text field | ✅ | `create-index` → `type: "autoEmbed"` (`voyage-4*`, `modality: text`) |

### Breakdown from `old-draft.md` — §3 Index Lifecycle (vector gap)

| Feature code | Topic | Coverage | Notes |
|--------------|-------|----------|-------|
| `IDX_DELETE` (search) | delete search index | ✅ | `drop-index` with `type: "search"` |
| Vector index deletion | drop vector index | ❌ | `drop-index` enum is `classic` \| `search` only — **no `vectorSearch`** |

### Gaps

- Cannot drop vector search indexes via MCP
- Multi-tenant / embedding-pipeline migration scenarios are advisory only
- `autoEmbed` schema supports text modality only (no multimodal index creation)

---

## 2. Vector Query Construction

**Product areas:** Vector Search  
**Coverage:** 🟢 Strong partial  
**Primary tools:** `aggregate`, `collection-schema`, `collection-indexes`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Sci-fi movies similar to "space exploration" with IMDB rating > 7.5 | ✅ | `VSEARCH_PRE_FILTER_EQ` + `VSEARCH_POST_FILTER` |
| Vector search with geo-filtering | 🟡 | `VSEARCH_PRE_FILTER_*` if geo is a filter field; else post-filter; geo in `$search` leg is separate |

### Breakdown from `old-draft.md` — §14 `$vectorSearch`

| Feature code | Topic | Coverage | Expected tool |
|--------------|-------|----------|---------------|
| `VSEARCH_ANN` | approximate NN (`numCandidates`) | ✅ | `aggregate` → `$vectorSearch` |
| `VSEARCH_ENN` | exact NN (`exact: true`) | ✅ | `aggregate` → `$vectorSearch` with `exact` |
| `VSEARCH_PRE_FILTER_EQ` | equality pre-filter | ✅ | `aggregate` → `$vectorSearch.filter` |
| `VSEARCH_PRE_FILTER_RANGE` | range pre-filter | ✅ | `aggregate` → `$vectorSearch.filter` |
| `VSEARCH_PRE_FILTER_IN` | `$in` / `$nin` pre-filter | ✅ | `aggregate` |
| `VSEARCH_PRE_FILTER_EXISTS` | `$exists` pre-filter | ✅ | `aggregate` |
| `VSEARCH_PRE_FILTER_COMPOUND` | `$and` / `$or` / `$not` | ✅ | `aggregate` |
| `VSEARCH_POST_FILTER` | `$match` after vector stage | ✅ | `aggregate` pipeline |
| `VSEARCH_SCORE` | `$meta: "vectorSearchScore"` | ✅ | `aggregate` → `$project` |
| `VSEARCH_SORT_EXTERNAL` | sort by non-vector field | ✅ | `aggregate` → inflated `limit` + `$sort` |

### Breakdown from `old-draft.md` — §4 `SEARCH_VECTOR_IN_SEARCH`

| Feature code | Topic | Coverage | Notes |
|--------------|-------|----------|-------|
| `SEARCH_VECTOR_IN_SEARCH` | `vectorSearch` operator inside `$search` | 🟡 | Runnable via `aggregate` generic pipeline; less explicit in tool schema than standalone `$vectorSearch` |

### Auto-embed query variants (§14)

MCP `aggregate` schema supports `$vectorSearch` with `query: { text }` + `model` enum (`voyage-4`, `voyage-4-large`, `voyage-4-lite`, `voyage-code-3`) — covers text-query vector search without BYOE `queryVector`.

### Gaps

- Geo-filtering depends on index filter-field design and data shape
- `embeddingParameters` syntax in `old-draft.md` may differ from MCP's `query` + `model` shape

---

## 3. Hybrid Search

**Product areas:** Vector Search, Text Search  
**Coverage:** 🟡 Partial  
**Primary tools:** `aggregate`, `create-index` (both index types), `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Implement hybrid search for RAG | ✅ | `HYBRID_RRF_BASIC` |
| Debug worse results after switching to hybrid | 🟡 | `search-knowledge` + re-run fusion pipelines; no automated regression tooling |
| Combine semantic + keyword + recency boost | ✅ | `HYBRID_RRF_WEIGHTED`, `HYBRID_SCOREFUSION_*`, `HYBRID_SUB_SORT` |

### Breakdown from `old-draft.md` — §15 `$rankFusion` / `$scoreFusion`

| Feature code | Topic | Coverage | Notes |
|--------------|-------|----------|-------|
| `HYBRID_RRF_BASIC` | basic RRF vector + text | ✅ | `aggregate` |
| `HYBRID_RRF_WEIGHTED` | weighted pipelines | ✅ | `aggregate` |
| `HYBRID_RRF_SCORE_DETAILS` | fusion score breakdown | ✅ | `aggregate` |
| `HYBRID_SCOREFUSION_SIGMOID` | sigmoid normalization | 🟡 | Requires MongoDB **8.2+** for `$scoreFusion` |
| `HYBRID_SCOREFUSION_MINMAX` | minMax + expression | 🟡 | Requires MongoDB **8.2+** |
| `HYBRID_SCOREFUSION_AVG` | averaged scores | 🟡 | Requires MongoDB **8.2+** |
| `HYBRID_SCOREFUSION_NONE` | raw scores | 🟡 | Requires MongoDB **8.2+** |
| `HYBRID_MULTI_FIELD` | 3+ pipelines | ✅ | `aggregate` |
| `HYBRID_PRE_FILTER` | filters in sub-pipelines | ✅ | `aggregate` |
| `HYBRID_POST_FILTER` | `$match` after fusion | ✅ | `aggregate` |
| `HYBRID_SCOREFUSION_BOOST` | boosted text leg | ✅ | `aggregate` |
| `HYBRID_SUB_MATCH` | legacy `$text` sub-pipeline | 🟡 | Needs classic text index on collection |
| `HYBRID_SUB_SORT` | sort sub-pipeline | ✅ | `aggregate` |
| `HYBRID_SUB_GEONEAR` | `$geoNear` sub-pipeline | 🟡 | Needs geospatial index + location data |
| `HYBRID_SUB_SAMPLE` | `$sample` in `$rankFusion` | ✅ | `aggregate` (`$rankFusion` only) |
| `HYBRID_SUB_SCORE` | `$score` in sub-pipelines | 🟡 | Syntax may vary; cluster version dependent |

### Gaps

- `$rankFusion` needs MongoDB **8.0+**; `$scoreFusion` needs **8.2+**
- Debugging "worse results" is subjective — best scored with `llm_judge`, not `data_match`
- Requires both search and vector indexes seeded before eval

---

## 4. Vector Query Performance

**Product areas:** Vector Search  
**Coverage:** 🟡 Partial  
**Primary tools:** `explain`, `search-knowledge`, `mongodb-logs`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Bring p99 vector search latency below 100ms | 📚 | `search-knowledge` (Search Nodes, tuning); no latency telemetry API |
| Explain filtered-query latency and how to reduce it | 🟡 | `VSEARCH_EXPLAIN` + `search-knowledge` |

### Breakdown from `old-draft.md` — §14 explain features

| Feature code | Topic | Coverage | Expected tool |
|--------------|-------|----------|---------------|
| `VSEARCH_EXPLAIN` | execution stats | ✅ | `explain` with `aggregate` + `$vectorSearch`, `verbosity: executionStats` |
| `VSEARCH_EXPLAIN_TRACE` | trace document IDs | 🟡 | `explain` if cluster supports `explainOptions.traceDocumentIds` |

### Gaps

- No p99 / APM integration
- No Search Nodes sizing or cost APIs
- `mongodb-logs` is generic mongod logs, not vector-search-specific diagnostics

---

## 5. API Usage

**Product areas:** ERAS  
**Coverage:** 📚 Knowledge-only  
**Primary tools:** `search-knowledge` (`voyageai`, `voyageai-docs`, `voyageai-api-spec`)

### Sample prompts from `categories.md`

| Prompt | Type | Coverage |
|--------|------|----------|
| Handle Voyage API rate limits gracefully | Error handling | 📚 |
| Generate embeddings with voyage-4 and store in pgvector | Vector store agnostic | 📚 |
| Batch-embed 10k docs with Voyage → Turbopuffer | Code gen | 📚 |
| Count tokens with Python SDK | Education | 📚 |
| Write Voyage embeddings with TypeScript SDK | Code gen | 📚 |
| Free tokens for voyage-4 / pricing voyage-4-large | Education | 📚 |

### `old-draft.md` mapping

No dedicated ERAS API section. Closest overlap is auto-embed data paths (§16) which are **Automated Embedding**, not standalone ERAS API usage.

### Gaps

- No Voyage SDK invocation, rate-limit handling, or third-party vector store tools

---

## 6. Text Embeddings

**Product areas:** ERAS  
**Coverage:** 📚 Knowledge-only  
**Primary tools:** `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage |
|--------|----------|
| Switch voyage-4-lite → voyage-4-large — re-embed? | 📚 |
| Difference between voyage-4 / large / lite for RAG | 📚 |
| Unsigned binary 256-dim embeddings vs 2048 float storage | 📚 |

### `old-draft.md` mapping

| Related feature | Coverage | Notes |
|-----------------|----------|-------|
| `IDX_VEC_QUANTIZATION` (binary) | ✅ index only | MCP can **create** binary-quantized indexes; cannot **generate** binary embeddings via API |
| Embedding model choice in queries | 🟡 | `aggregate` model enum is create/query-time only, not standalone embedding API |

---

## 7. Contextualized Chunk Embeddings

**Product areas:** ERAS  
**Coverage:** 📚 Knowledge-only  
**Primary tools:** `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage |
|--------|----------|
| How voyage-context-3 improves chunked retrieval | 📚 |
| Max batch size for voyage-context-3 | 📚 |
| Python code for 200 docs × 5 chunks contextualized embeddings | 📚 |

### `old-draft.md` mapping

No `voyage-context-3` features documented.

---

## 8. Multimodal Embeddings

**Product areas:** ERAS  
**Coverage:** 📚 Knowledge-only  
**Primary tools:** `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage |
|--------|----------|
| Embed PDF with mixed text/images (voyage-multimodal-3.5) | 📚 |
| E2E catalog images + descriptions indexed, text query retrieval | 📚 |
| Token consumption for 30s video clip | 📚 |
| RAG over PowerPoint slides in Atlas | 📚 |
| voyage-multimodal-3.5 vs CLIP comparison | 📚 |

### `old-draft.md` mapping

`create-index` `autoEmbed` supports `modality: "text"` only — **no multimodal index creation**.

---

## 9. Reranking

**Product areas:** ERAS  
**Coverage:** 📚 Knowledge-only  
**Primary tools:** `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage |
|--------|----------|
| Two-stage: Voyage embeddings + rerank-2.5 | 📚 |
| Custom instructions to rerank-2.5 for recency | 📚 |
| Optimize reranking throughput (400ms latency) | 📚 |
| Multilingual reranking EN + ES | 📚 |

### `old-draft.md` mapping

No rerank API features. Hybrid fusion (§15) is rank fusion, not ERAS rerank-2.5.

---

## 10. Native Reranking

**Product areas:** Native Reranking  
**Coverage:** 🟡 Partial  
**Primary tools:** `aggregate`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage |
|--------|----------|
| What values are passed to reranking model via `$rerank.path`? | 📚 |
| Best practices for `$rerank` | 📚 |
| Expected latency of `$rerank` | 📚 |

### `old-draft.md` mapping

No `$rerank` stage documented. Likely runnable as a generic `aggregate` pipeline stage, but **not validated** in eval dataset or tool schema.

### Gaps

- No first-class `$rerank` in MCP tool schemas
- Latency/behavior hard to score without production cluster

---

## 11. Model API and Vector Search

**Product areas:** ERAS, Vector Search  
**Coverage:** 🟡 Partial  
**Primary tools:** `create-index`, `aggregate`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Add rerank-2.5 after `$vectorSearch` | 📚 | No ERAS rerank tool; native `$rerank` is 🟡 |
| Python: Voyage embeddings + `$vectorSearch` | 🟡 | BYOE path needs external embedding; auto-embed path is ✅ |
| Create vector index with voyage-4 embeddings | ✅ | `IDX_VEC_AUTO_EMBED` or BYOE `IDX_VEC_SIMILARITY` |

### Executable subset from `old-draft.md`

| Feature | Coverage |
|---------|----------|
| `IDX_VEC_*` index creation | ✅ |
| `VSEARCH_ANN` / pre-filters | ✅ |
| ERAS rerank as second stage | ❌ |

---

## 12. Automated Embedding

**Product areas:** Automated Embedding  
**Coverage:** 🟢 Strong partial  
**Primary tools:** `create-index`, `aggregate`, `insert-many`, `update-many`, `collection-indexes`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Perform semantic / AI search on MongoDB documents | ✅ | `IDX_VEC_AUTO_EMBED` + `VSEARCH_ANN` |
| English query over French/Spanish docs | ✅ | auto-embed query with text |
| Millions of docs without rate-limit errors | 📚 | `search-knowledge` (Atlas-managed embedding) |
| Keep embeddings in sync with updates | 🟡 | `update-many` + `search-knowledge`; embedding regen behavior TBD |
| High-throughput writes without embedding infra | ✅ | `insert-many` + auto-embed index |
| Transform text search index → hybrid | 🟡 | `create-index` (add vector) + `HYBRID_RRF_BASIC` |
| Free tokens / cost / monitor token usage | 📚 | `search-knowledge` only |
| Retrieve auto-generated embedding vector | 🟡 | `find` / `aggregate` projection if stored; not guaranteed exposed |
| Reduce vector search index cost | 📚 | `IDX_VEC_QUANTIZATION` index creation + docs |
| Create index with scalar quantized 512-dim vectors | ✅ | `create-index` quantization + dimensions |
| High query volume — cheap semantic search (Python) | ✅ | `aggregate` with auto-embed query |
| E2E semantic search pipeline (Python/JS) | ✅ | `create-index` + `aggregate` |
| Debug poor vector search results | 🟡 | `aggregate` + `explain` + `collection-indexes` |
| Auto-embeddings not updating on insert | 🟡 | `insert-many` + `collection-indexes`; error-handling scenario |
| Single embedding for multiple fields | 📚 | `search-knowledge`; MCP `autoEmbed` is single `path` |

### Breakdown from `old-draft.md` — §16 Data Operations

| Feature code | Topic | Coverage | Expected tool |
|--------------|-------|----------|---------------|
| `DATA_INSERT_SINGLE` | insert with auto-embedding | 🟡 | `insert-many` (+ `embeddingParameters` if supported by MCP version) |
| `DATA_INSERT_BULK` | bulk insert with embeddings | 🟡 | `insert-many` |
| `DATA_INSERT_FILTER_FIELDS` | insert with filter fields | ✅ | `insert-many` |
| `DATA_UPDATE` | update documents | ✅ | `update-many` (embedding regen: TBD) |
| `DATA_DELETE` | delete documents | ✅ | `delete-many` |

### Gaps

- Billing, token monitoring, multi-field single embedding — docs only
- `embeddingParameters` on `insert-many` may not match all `old-draft.md` syntax

---

## 13. Model API, Search, and Vector Search

**Product areas:** ERAS, Search, Vector Search  
**Coverage:** 🟡 Partial  
**Primary tools:** `aggregate`, `create-index`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Retrieve generated embeddings (troubleshooting) | 🟡 | `find` / `aggregate`; BYOE always stored, auto-embed may not expose |
| Hybrid pipeline: Atlas full-text + Voyage vector | ✅ | §15 all `HYBRID_*` features |

### Executable cross-product features

| Area | `old-draft.md` sections | Coverage |
|------|----------------------|----------|
| Text search leg | §4–13 | ✅ |
| Vector leg | §14 | ✅ |
| Fusion | §15 | 🟡 (version-dependent) |
| ERAS API (standalone) | — | ❌ |

---

## 14. Search Index Management

**Product areas:** Text Search  
**Coverage:** ✅ Full  
**Primary tools:** `create-index`, `drop-index`, `collection-indexes`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Dynamic fields when tenants add new fields | ✅ | `IDX_TEXT_DYNAMIC` |
| Search-as-you-type experience | ✅ | `IDX_TEXT_FIELD_TYPES` (autocomplete) + `SEARCH_AUTOCOMPLETE` |
| Specify filter fields | ✅ | `IDX_VEC_FILTER_FIELDS` (vector) / explicit field mappings (search) |
| Index subset of collection | ✅ | `IDX_TEXT_STATIC` (`dynamic: false`) |

### Breakdown from `old-draft.md` — §1 Text Search Index Creation

| Feature code | Topic | Coverage | Notes |
|--------------|-------|----------|-------|
| `IDX_TEXT_DYNAMIC` | `dynamic: true` | ✅ | Covered by existing eval case |
| `IDX_TEXT_STATIC` | explicit field mappings | ✅ | |
| `IDX_TEXT_TYPESETS` | configurable dynamic typeSets | 🟡 | `create-index` schema may not expose `typeSets` — verify at runtime |
| `IDX_TEXT_FIELD_TYPES` | string, number, date, token, autocomplete, … | ✅ | Enum in `create-index` schema |
| `IDX_TEXT_ANALYZER_INDEX` | index-time analyzer | 🟡 | `analyzer` on field mapping — schema supports index-level `analyzer` |
| `IDX_TEXT_ANALYZER_SEARCH` | search-time analyzer | 🟡 | `searchAnalyzer` — may need generic definition passthrough |
| `IDX_TEXT_ANALYZER_BUILTIN` | lucene.* analyzers | ✅ | |
| `IDX_TEXT_ANALYZER_CUSTOM` | custom tokenizer + filters | 🟡 | `analyzers` array — not in strict schema |
| `IDX_TEXT_MULTI_ANALYZER` | `multi` analyzers on field | 🟡 | |
| `IDX_TEXT_TOKEN_NORMALIZER` | token normalizer | 🟡 | |
| `IDX_TEXT_SYNONYM_SOURCE` | synonym mappings | 🟡 | Requires synonym collection seed |
| `IDX_TEXT_FACET_MAPPING` | stringFacet / numberFacet | 🟡 | Facet types not in strict field-type enum |
| `IDX_TEXT_MULTI_FIELD` | multiple fields in one index | ✅ | |
| `IDX_TEXT_STORED_SOURCE` | storedSource config | 🟡 | Not in strict schema |
| `IDX_TEXT_NUM_PARTITIONS` | numPartitions 1/2/4 | ✅ | In `create-index` schema |

### Breakdown from `old-draft.md` — §3 Lifecycle

| Feature code | Topic | Coverage |
|--------------|-------|----------|
| `IDX_DELETE` | delete search index | ✅ — existing eval case |

---

## 15. Search Query Construction

**Product areas:** Text Search  
**Coverage:** ✅ Full  
**Primary tools:** `aggregate`, `collection-schema`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Email ends with @mongodb.com | ✅ | `SEARCH_WILDCARD` or `SEARCH_REGEX` |
| Relevance by which path matched | ✅ | `SCORE_BOOST_VALUE` / `COMPOUND_SHOULD` |
| Sort on non-score field | ✅ | `SORT_NATIVE` or `SORT_POST_SEARCH` |
| Consistent paginated results | ✅ | `PAGE_CURSOR` (preferred) or `PAGE_OFFSET` |

### Breakdown from `old-draft.md` — §4 Operators

| Feature code | Topic | Coverage |
|--------------|-------|----------|
| `SEARCH_TEXT` | basic text search | ✅ |
| `SEARCH_PHRASE` | phrase + slop | ✅ |
| `SEARCH_FUZZY` | fuzzy matching | ✅ |
| `SEARCH_AUTOCOMPLETE` | typeahead | ✅ (needs autocomplete mapping) |
| `SEARCH_WILDCARD` | wildcard patterns | ✅ |
| `SEARCH_REGEX` | regex patterns | ✅ |
| `SEARCH_EQUALS` | exact value match | ✅ |
| `SEARCH_IN` | match any in array | ✅ |
| `SEARCH_RANGE` | numeric/date ranges | ✅ |
| `SEARCH_NEAR` | proximity-scored | ✅ |
| `SEARCH_EXISTS` | field existence | ✅ |
| `SEARCH_MORE_LIKE_THIS` | similar documents | ✅ |
| `SEARCH_QUERY_STRING` | Lucene query string | ✅ |
| `SEARCH_GEO_WITHIN` | geoWithin filter | 🟡 (needs geo field + mapping) |
| `SEARCH_GEO_SHAPE` | geoShape relations | 🟡 |
| `SEARCH_EMBEDDED_DOC` | embedded document search | 🟡 (needs `embeddedDocuments` mapping) |
| `SEARCH_VECTOR_IN_SEARCH` | vector inside `$search` | 🟡 |

### Breakdown — §5 Compound, §6 Scoring, §7 Highlight/Synonyms, §8 Facets, §9 Count, §10 Pagination, §11 Sort, §12 Options, §13 Post-search agg

| Section | Features | Coverage |
|---------|----------|----------|
| §5 Compound | `COMPOUND_MUST/SHOULD/FILTER/MUST_NOT` | ✅ |
| §6 Scoring | `SCORE_BOOST_*`, `SCORE_CONSTANT/FUNCTION/EMBEDDED/DETAILS` | ✅ |
| §7 Highlight/Synonyms | `HIGHLIGHT`, `SYNONYMS` | 🟡 (synonyms need index config) |
| §8 Facets | `FACET_STRING/NUMBER/DATE` | ✅ — `$searchMeta` eval case exists |
| §9 Count | `COUNT_TOTAL/LOWER_BOUND/THRESHOLD/INLINE` | ✅ |
| §10 Pagination | `PAGE_OFFSET`, `PAGE_CURSOR` | ✅ |
| §11 Sort | `SORT_NATIVE`, `SORT_POST_SEARCH` | ✅ |
| §12 Options | `OPT_CONCURRENT`, `OPT_RETURN_STORED_SOURCE`, `OPT_RETURN_SCOPE` | 🟡 (concurrent needs dedicated search nodes) |
| §13 Post-search agg | `AGG_FACET/GROUP/UNWIND/BUCKET/SORT_BY_COUNT/LOOKUP/REPLACE_ROOT/OUT_MERGE/SAMPLE` | ✅ |

---

## 16. Search Query Performance

**Product areas:** Text Search  
**Coverage:** 🟡 Partial  
**Primary tools:** `explain`, `search-knowledge`

### Sample prompts from `categories.md`

| Prompt | Coverage | Maps to `old-draft.md` |
|--------|----------|------------------------|
| Bottleneck in this `$search` query | 🟡 | `VSEARCH_EXPLAIN` pattern applies to vector; `$search` explain support limited |
| Optimize `$search` for sub-second latency | 🟡 | `search-knowledge` + `OPT_CONCURRENT`, index tuning from §1 |

### Breakdown from `old-draft.md` — performance-related features

| Feature code | Topic | Coverage | Notes |
|--------------|-------|----------|-------|
| `VSEARCH_EXPLAIN` | vector explain | ✅ | `explain` tool |
| `OPT_CONCURRENT` | concurrent search execution | 🟡 | Query option only; needs dedicated search nodes |
| `OPT_RETURN_STORED_SOURCE` | faster retrieval | 🟡 | Needs `IDX_TEXT_STORED_SOURCE` index |
| `PAGE_CURSOR` vs `PAGE_OFFSET` | pagination perf | ✅ | Executable; performance is advisory |
| `COUNT_TOTAL` via `$searchMeta` | efficient counting | ✅ | |

### Gaps

- No first-class `$search` explain in MCP `explain` schema (vector-biased)
- No Search Nodes / cost APIs

---

## Appendix A — `old-draft.md` section → category map

| `old-draft.md` section | Primary category | Secondary |
|---------------------|------------------|-----------|
| §1 Text Search Index Creation | Search Index Management | — |
| §2 Vector Search Index Creation | Vector Index Management | Automated Embedding |
| §3 Index Lifecycle | Search Index Management | Vector Index Management (gap) |
| §4–13 Text Search queries | Search Query Construction | Search Query Performance (§12 options) |
| §14 Vector Search queries | Vector Query Construction | Vector Query Performance (explain) |
| §15 Hybrid Search | Hybrid Search | Model API, Search, and Vector Search |
| §16 Data Operations | Automated Embedding | — |
| Appendix alternatives | All query categories | Reference for eval design |

---

## Appendix B — recommended eval priorities

| Priority | Categories | Rationale |
|----------|------------|-----------|
| **Now** | Search Index Management, Search Query Construction | ✅ full tool support; `dataset/Search.yaml` already exists |
| **Next** | Automated Embedding, Vector Query Construction | `autoEmbed` + `$vectorSearch` are first-class in MCP |
| **Then** | Hybrid Search, Vector Index Management | Executable but need dual indexes + MongoDB 8.x |
| **Docs-only** | API Usage, Text Embeddings, Contextualized/Multimodal, Reranking | Score with `llm_judge` against `search-knowledge` ground truth |
| **Tool gap** | Vector Index Management | Add `vectorSearch` to `drop-index` for lifecycle parity |

---

## Appendix C — feature coverage counts (`old-draft.md`)

| Category | ✅ | 🟡 | 📚 | ❌ |
|----------|----|----|----|----|
| Search Index Management | 6 | 9 | 0 | 0 |
| Vector Index Management | 4 | 0 | 2 | 1 |
| Search Query Construction | 38 | 6 | 0 | 0 |
| Vector Query Construction | 10 | 2 | 0 | 0 |
| Hybrid Search | 9 | 6 | 1 | 0 |
| Vector Query Performance | 1 | 2 | 2 | 0 |
| Automated Embedding | 8 | 6 | 5 | 0 |
| ERAS-only categories (5–9) | 0 | 1 | 20+ | 0 |

*Counts are approximate — some features span multiple categories.*
