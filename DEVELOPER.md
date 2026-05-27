# Developer Guide

## 📁 Project Structure

```
.
├── task/        # 🤖 Evaluation task logic (registered as Braintrust remote evaluation functions)
├── dataset/     # 📚 Evaluation suites — sets of cases to run using an evaluation task
├── dbseed/      # 🌱 Seed collections used to initialize the database before each evaluation case
└── scripts/     # 🛠️ Build and utility scripts (e.g., bundling the mdb-mcp-server, smoke tests)
```

### 🤖 `task/`

Contains the evaluation **tasks** that are registered as remote evaluation functions in Braintrust.  
Each task encapsulates the logic to set up the database prior to LLM interactions (e.g., integrating the MongoDB MCP tools), manages any required cleanup afterward, and handles data plumbing and setup. This enables evaluation of data entries defined in the dataset.

### 📚 `dataset/`

Contains the **evaluation suites**: collections of evaluation cases that are executed sequentially by the task logic.  
Each entry specifies a **user prompt** for the LLM, the associated database seed required for execution, and the **criteria** to score the LLM's response or the resulting state of the database upon completion.

Suites may be organized into subdirectories (e.g. `dataset/Search/Index Management.yaml`); the sync scripts search `dataset/` **recursively**. A file's Braintrust dataset name is its path under `dataset/` (minus `.yaml`) with path separators turned into spaces — so `dataset/Search/Index Management.yaml` ↔ dataset `Search Index Management`.

Criteria can reference two placeholders, which the LLM judge resolves on demand via tools: `$conversation` (the assistant's full transcript) and `$result` (the assistant's final response).

### 🌱 `dbseed/`

Houses the collections referenced by evaluation cases in the dataset.  
We **initialize the database with these collections** prior to running each set of evaluation cases to ensure consistency and repeatability.

### 🛠️ `scripts/`

Contains build and utility scripts, such as those used for bundling `mongodb-mcp-server` for the Braintrust Lambda sandbox.

## 📜 NPM Scripts

Run scripts with `pnpm <script>`.


| Script              | Command                                                                               | Description                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle:mcp-server` | `node scripts/mongodb-mcp-server/bundler.mjs`                                         | 📦 Pre-bundles `mongodb-mcp-server` (stubbing native dependencies) as `task/lib/vendor/mongodb-mcp-server/bundle.cjs` so that Braintrust can package it in a single Lambda artifact. Some library dependencies require native modules or dynamic imports, making it incompatible with the default Braintrust bundler; we manually include and stub unused dependencies to avoid compatibility issues. |
| `push:sandbox`      | `pnpm exec braintrust push --if-exists replace task/mongodb_agent.ts`                 | 🚀 Pushes the evaluation task to Braintrust, replacing the existing function if present. The entrypoint validates `BRAINTRUST_API_KEY` and `OPENAI_BASE_URL` at import, so both must be set even just to push.                                                                                                                                                                                       |
| `eval:local`        | `pnpm exec bt eval task/mongodb_agent.ts`                                             | 🧪 Runs the evaluation task locally for development and testing. Needs `BRAINTRUST_API_KEY` and `OPENAI_BASE_URL`, plus run parameters (e.g. `connectionString`, `model`) supplied via `BT_EVAL_PARAMS_JSON`.                                                                                                                                                                                          |
| `pull:datasets`     | `bash scripts/datasets.sh pull`                                                       | ⬇️ Pulls every dataset from the Braintrust project into `dataset/`, searched **recursively**: each dataset is written back to its existing nested file if one matches (e.g. `dataset/Search/Index Management.yaml`), otherwise to a flat `dataset/<name>.yaml`.                                                                                                                                          |
| `push:datasets`     | `bash scripts/datasets.sh push`                                                       | ⬆️ **Full mirror** of local YAML (discovered **recursively** under `dataset/`) to Braintrust so remote matches local exactly: creates missing datasets, **replaces** each row in place (`_is_merge:false`), **soft-deletes** remote rows absent locally (`_object_delete:true`), and deletes remote datasets with no local file. A file's dataset name is its path under `dataset/` (minus `.yaml`) with `/`→space. History-safe (append-only; nothing is hard-deleted or recreated). Uses the Braintrust insert API, so it needs `BRAINTRUST_API_KEY`. Flags: `--merge` (legacy upsert, no key, never deletes), `--dry-run` (preview the API payload). |
| `typecheck`         | `tsc --noEmit`                                                                        | ✅ Performs a comprehensive type check of the project without generating any output files.                                                                                                                                                                                                                                                                                                             |


