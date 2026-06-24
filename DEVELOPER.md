# Developer Guide

## 📁 Project structure

```
.
├── dataset/     # 📚 Local eval cases + taxonomy (synced with Braintrust)
├── dbseed/      # 🌱 MongoDB seed collections for case `input.db_seed`
├── schemas/     # 📐 JSON Schema for case YAML + row `input` / `expected`
├── scripts/     # 🛠️ Sync, validation, remote eval, MCP vendoring
└── output/      # 📤 Per-run trace dumps from `eval:remote` (gitignored)
```

The **eval task** itself lives in **mongodb-mcp-server** (`tests/eval/mongodb.eval.ts`), not in this repo. This repo owns the case dataset, schemas, db seeds, and tooling to sync/run them.

### 📚 `dataset/`

Taxonomy-guided tree of evaluation cases:

```
dataset/
  taxonomy.yaml                          # typed taxonomy (dataset=, category=, …, name: description)
  Team - Search/_meta.yaml               # Braintrust dataset envelope (id, project_id, …)
  Team - Search/Text Search Query Construction/Faceted Search/cases.yaml
```

- **dataset** (`Team - Search/`) → one Braintrust dataset; folder name = dataset name
- **category** / **subcategory** / **group** / **subgroup** → optional nested folders (any may be skipped)
- **cases.yaml** → row array at the deepest folder for that taxonomy path

Row **metadata** carries `category`, `subcategory`, `group`, `subgroup`, `name`, and `description` (dataset is implicit from the folder path). Braintrust sync uses metadata only — no path-based `tags` array.

Each row has:

- `input` — prompt + `db_seed` (see `schemas/input.schema.json`)
- `expected` — `llm_judge` / optional `example` (see `schemas/expected.schema.json`)
- optional `id`, `metadata`, `origin`

Judge criteria may reference `$conversation` and `$result` (resolved by the eval task).

**Baseline:** `dataset/.sync-state.json` — last-synced row hashes for `plan` / `apply`.

**Migration note:** Rows synced before this taxonomy refactor used path-based `tags` on Braintrust. Re-run `pnpm apply` after migrating local `cases.yaml` files so remote rows use metadata-only identity.

### 🌱 `dbseed/`

JSON seed files referenced by `input.db_seed`. Refresh from mongodb-mcp-server via `pnpm mcp-server:pull-data`.

### 📐 `schemas/`

| File | Validates |
|------|-----------|
| `case-file.schema.json` | `dataset/**/cases.yaml` |
| `dataset-meta.schema.json` | `dataset/*/_meta.yaml` |
| `input.schema.json` | row `input` (generated from MCP server types) |
| `expected.schema.json` | row `expected` (generated from MCP server types) |

Run `pnpm typecheck` to validate all mapped YAML under `dataset/`.

---

## 📜 NPM scripts

Run with `pnpm <script>`. Most Braintrust commands need `BRAINTRUST_API_KEY`.

| Script | Command | What it does |
|--------|---------|--------------|
| **`scaffold`** | `tsx scripts/datasets.ts scaffold` | 🏗️ Build `dataset/{L1}/{L2}/` folders + empty row stubs from `taxonomy.yaml` |
| **`plan`** | `tsx scripts/datasets.ts plan` | 🔍 Diff local YAML vs Braintrust using `.sync-state.json` (+ `schemas/{input,expected}.schema.json` vs each dataset's `metadata.__schemas`). Exit **1** if changes pending, **2** if blocked (conflicts) |
| **`apply`** | `tsx scripts/datasets.ts apply` | ⬆️ Push local changes to Braintrust (creates/updates rows + syncs `metadata.__schemas` from `schemas/`; skips drift, conflicts, remote-only unless `--prune`) |
| **`pull`** | `tsx scripts/datasets.ts pull` | ⬇️ Overwrite local case files from remote + refresh `_meta.yaml`, `.sync-state.json`, and `taxonomy.yaml` |
| **`eval:remote`** | `tsx scripts/run-remote-eval.ts` | 🧪 Run selected `cases.yaml` rows against the MCP server’s Braintrust dev eval server (inline data, no dataset sync). See [Remote eval](#-remote-eval) |
| **`typecheck`** | `tsx scripts/typecheck.ts` | ✅ Validate `dataset/**/*.yaml` against JSON Schema |
| **`mcp-server:pull-data`** | `tsx scripts/mcp-server-pull-data.ts` | 🔄 Copy `dbseed/` + regenerate `schemas/input.schema.json` & `expected.schema.json` from **mongodb-mcp-server** |
| **`test`** | `tsx --test scripts/*.test.ts` | 🧪 Unit tests for sync, taxonomy, remote eval, typecheck |

### Dataset sync flags

Shared by `plan`, `apply`, `pull`, `scaffold`:

| Flag | Default | Meaning |
|------|---------|---------|
| `-p` / `--project` | `mongodb-mcp-server-evals` | Braintrust project name |
| `-d` / `--dir` | `dataset` | Local dataset root |
| `--prune` | off | Allow deleting remote rows/datasets absent locally |
| `-out FILE` | — | (`plan`) Write plan JSON |
| `-f` / `--plan FILE` | — | (`apply`) Apply a saved plan instead of re-planning |

**Typical flows**

```bash
# Start from taxonomy
pnpm scaffold

# Edit local YAML, preview remote diff
pnpm plan

# Push local → Braintrust (safe: no deletes)
pnpm apply

# Push with deletions
pnpm apply --prune

# Remote → local (clobber local case files)
pnpm pull
```

---

## 🧪 Remote eval

The eval task runs in **mongodb-mcp-server**. This repo submits case rows to its dev server.

1. **mongodb-mcp-server:** `pnpm eval:serve` → `http://localhost:8300`
2. **This repo:** dry-run (no API calls):

   ```bash
   pnpm eval:remote --dry-run -- "dataset/Search/**/*.yaml"
   ```

3. **Run for real** (needs `BRAINTRUST_API_KEY`):

   ```bash
   pnpm eval:remote "dataset/Search/**/Index*.yaml"
   ```

Resolves globs → `cases.yaml` files → merges rows → `GET /list` + streaming `POST /eval` with **inline** row data. Prints the experiment URL early; fetches full traces afterward into `output/<experiment-name>/` (one JSON per row + `_manifest.json`).

| Flag / env | Default | Meaning |
|------------|---------|---------|
| `--remote` / `EVAL_REMOTE_URL` | `http://localhost:8300` | Dev server URL |
| `--eval` | `mongodb-mcp-server-evals` | Evaluator name (`GET /list`) |
| `--dataset-dir` | `dataset` | Case YAML root |
| `--experiment` | timestamped `remote-eval_…` | Experiment name |
| `--project-id` | from `dataset/*/\_meta.yaml` if unambiguous | Braintrust project id for the run |
| `--params` / `BT_EVAL_PARAMS_JSON` | — | Task params (`connectionString`, `model`, …) |
| `--metadata-regex` / `METADATA_REGEX` | — | Only run rows whose `metadata[key]` matches the regex; format `key=<regex>` (e.g. `name=Facets`, `category=^Vector`) |
| `--output-dir` | `output` | Trace dump directory |
| `--skip-traces` | off | Skip post-run trace fetch |
| `--dry-run` | off | List matched files/rows only |
| `BRAINTRUST_APP_URL` | — | Optional custom Braintrust app URL |

---

## 🔄 `mcp-server:pull-data`

Vendors upstream eval assets from **mongodb-mcp-server**:

1. `tests/eval/dbSeed/` → `dbseed/`
2. Runs `pnpm eval:generate-schemas` there
3. Copies `input.schema.json` + `expected.schema.json` into `schemas/` (with eval-cases `$id` patches)

Set `MONGODB_MCP_SERVER_ROOT` if the repo is not at `~/mongodb-mcp-server`.

---

## ✅ `typecheck`

Validates YAML under `dataset/` (same mapping as `.vscode/settings.json`):

- `dataset/*/*/*.yaml` → `case-file.schema.json` (includes nested `input` / `expected` refs)
- `dataset/*/_meta.yaml` → `dataset-meta.schema.json`

`dataset/taxonomy.yaml` has no schema yet (reported as skipped). Exits **1** on validation errors.
