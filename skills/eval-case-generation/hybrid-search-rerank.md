# Hybrid Search & Rerank Addendum

*Copy and paste this separate block into your agent specifically to generate hybrid search query evaluations using the prompt guidelines.*

---

## 1. CONCEPTUAL BACKGROUND
* **Hybrid Search ($rankFusion / $scoreFusion):** This technique combines two search methodologies: lexical text search (`$search`) for exact keyword precision and semantic vector search (`$vectorSearch`) for conceptual meaning—into a single, fused, and optimized stream of results.
* **Reranking ($rerank):** A multi-stage architecture where a high-recall hybrid search is executed first to gather a broad set of candidate documents, followed immediately by a specialized neural reranking stage to re-order those top candidates for maximum relevance.

---

## 2. CONSTRAINTS & PHRASING
* **PROHIBITED:** Never use explicit database stage syntax names like `"$rankFusion"`, `"$scoreFusion"`, or `"$rerank"` inside the generated user prompt field.
* **REQUIRED:** Leverage simple, natural developer trigger phrases to frame your inputs, avoiding conversational fluff or over-dense jargon.

---

## 3. DATA ARCHITECTURE STANDARDS
For all test cases generated under this profile, the 'movies' collection assumes the repo's fixed configurations (see `mflix-search-queries`):
* **Lexical Index Name:** `"default"` (Atlas Search, dynamic mappings) — query via `$search` with `text: { query, path: "plot" }`.
* **Vector Index (preferred for hybrid):** `"vector_auto_index"` (Atlas Vector Search, autoEmbed `voyage-4-lite` on `plot`, text modality) — query via `$vectorSearch` with `path: "plot"` and `query: { text: "..." }` (natural language; no raw vector).
* **Vector Index (raw vectors):** `"vector_index"` (Atlas Vector Search, 1024d cosine on `plot_embedding_voyage_4_lite`) — query via `$vectorSearch` with `queryVector: [...]`. Avoid unless raw vectors are the point; `vector_auto_index` keeps cases natural-language and dodges embedding rate limits.
* **Rerank Model:** `"rerank-2-lite"` — `$rerank` requires `query: { text: "..." }` and `model`.

---

## 4. TAXONOMY & INTENT SIGNAL GUIDANCE (EXAMPLES TO START WITH)
Your task is to scale out the taxonomy for Category: `"Hybrid Search"` (existing subcategories: `Index Prerequisites`, `Intent Recognition`, `Rank Fusion`, `Reranking`, `Result Shaping`, `Score Fusion`, `Sub-Pipeline Construction`). Do not treat subcategories as rigid, permanent limits. Use the following three core engineering intents and their historical live-test observation notes as foundational guiding examples to establish your generation path:

### A. Subcategory Example: `"Rank Fusion Default"`
* **Intent:** The developer simply requests a hybrid search combining keyword and semantic layers without custom tuning.
* **Expert Prompt Example:** *"Perform a hybrid search for..."* or *"Use hybrid search to find movies about..."*
* **Live-Test Observation Note:** This phrasing successfully triggers a native, root-level `$rankFusion` pipeline.

### B. Subcategory Example: `"Rank Fusion with Weights"`
* **Intent:** The developer commands a merge of separate capabilities while dictating explicit engineering balances or ratios.
* **Expert Prompt Example:** *"combine full-text + vector, merge results"*
* **Live-Test Observation Note:** Historically resulted in an inefficient fallback pipeline (`$search` -> `$unionWith($vectorSearch)` -> `$group` -> `$sort`) instead of native fusion. The evaluation criteria must strictly enforce building a native `$rankFusion` or `$scoreFusion` pipeline instead of a `$unionWith` workaround.

### C. Subcategory Example: `"Hybrid Search with Reranking"`
* **Intent:** The developer commands a high-recall query sequence followed up by a distinct stage utilizing a semantic reranker to optimize final relevance.
* **Expert Prompt Example:** *"Use a reranker to improve ordering..."* or *"Get high recall first, then apply a reranking layer..."*
* **Live-Test Observation Note:** Historically resulted in generic field sorting or single-modality pipelines. The evaluation criteria must ensure it smoothly transitions to the full `$rankFusion` -> `$limit` -> `$rerank` chain.

Use these patterns and observation notes as a launchpad to extrapolate other creative, developer-voiced scenarios involving score fusion, custom normalizations, or complex limit steps.

---

## 5. THE GRADING RULE (STRUCTURAL COMPLIANCE INSPECTION)
Fusion result sets are inherently unstable: `$rankFusion` / `$scoreFusion` ordering is
highly sensitive to per-sub-pipeline `numCandidates` / `limit`, which natural-language
prompts never specify, and `$rerank` is often version-gated. Two structurally-identical,
on-topic fusion queries can therefore return different document tails. **Grade the query
the assistant submitted in `$conversation`, never the returned documents.**

> **The Rule:** Treat `$reference_answer` as the canonical *structure*, not an exact
> result set to reproduce. Do **NOT** score on result-set overlap or document ordering
> against the reference (fusion tails legitimately vary with the unspecified
> `numCandidates`/`limit`). Instead inspect the submitted pipeline: is the correct
> fusion / `$rerank` stage the root/retrieval stage, are sub-pipelines a named map, are
> `$match`/`$sort`/`$skip`/`$limit` placed inside sub-pipelines where required and
> `$project`/`$unset` applied only *after* fusion, and does the search query text match
> the requested topic? Mere mention of a stage name in prose does not count.

---

## 6. BRAINTRUST JUDGE RESULTANT SCORING MATRIX
Write each `llm_judge` rubric as an explicit decision tree using `set score = X` tokens.
Grade structure + topic, **never** result-set overlap. Standard tiers:

* **Correct construction (`set score = 1.0`):** A single native fusion stage
  (`$rankFusion` / `$scoreFusion`) — or the required retrieve → fuse → `$rerank` chain — is
  the root/retrieval stage, combines both modalities, applies the case's specific feature
  correctly (weights / normalization / combination expression / in-sub-pipeline
  `$match`/`$sort`/`$skip`+`$limit` / post-fusion `$project`/`$unset` / `scoreDetails`), and
  searches the requested topic.
* **Wrong topic or empty (`set score = 0.7`):** Structure and feature are correct, but the
  search query text is unrelated to the requested topic, or `$response` is empty —
  regardless of result-set overlap with the reference.
* **Wrong method detail (`set score = 0.5`):** A native fusion stage is used but the case's
  required feature is missing or misplaced — e.g. `$scoreFusion` without the required
  `input.normalization`, equal weights when a skew was requested, a `$project`/`$unset`
  placed *inside* a sub-pipeline ("Sub-Pipeline Pollution"), or — for rerank cases — a plain
  `$sort` on a score/metadata field instead of a native `$rerank` ("Lazy Sort Fallback").
* **Inefficient / non-fusion fallback (`set score = 0.2`):** Results were reached WITHOUT a
  native fusion stage combining both modalities — e.g. a `$unionWith` + `$group` workaround,
  manual score math, or a single-modality `$search` / `$vectorSearch`.
* **Absolute failure (`set score = 0`):** `$response` is empty, hallucinated, or no valid
  pipeline was constructed.
* **Efficiency penalty (`subtract 0.1`, floor 0):** After choosing a non-zero score above,
  if `$conversation` shows more than one `aggregate` call where an earlier attempt was
  incorrect (errored from a malformed pipeline, or a structurally wrong query later
  revised), subtract 0.1. Do **NOT** penalize a single clean attempt, retries caused only by
  version-gating / transient cluster errors, or the judge's own reference execution of
  `$reference_answer`.

---

## 7. TARGET FORMAT
Generate your test cases using the standard Braintrust JSON structure, embedding the
ground-truth syntax (including the proper `$rankFusion` / `$scoreFusion` / `$rerank`
operators) directly inside the `reference_answer` block. Ensure the prompt fields remain
simple developer-style commands, and write the scoring rubric as the structure-first
decision tree from §6 (with the efficiency penalty as the final clause).
