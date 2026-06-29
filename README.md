# mongodb-eval-cases 🍃🧪

Eval **cases**, schemas, db seeds, and sync/run tooling for the
`mongodb-mcp-server` Braintrust suite. The eval **task** itself lives in
`mongodb-mcp-server` (`tests/eval/`) — this repo owns the dataset.

## 📦 What's here

```
dataset/   📚 eval cases (YAML) + taxonomy, synced with Braintrust
dbseed/    🌱 MongoDB seed collections for case input.db_seed
schemas/   📐 JSON Schema for case YAML
scripts/   🛠️ sync, validation, remote eval, MCP vendoring
skills/    🧠 agent skills for authoring + generating cases
output/    📤 per-run trace dumps (gitignored)
```

## 🚀 Quick start

```bash
pnpm install
pnpm typecheck                       # ✅ validate dataset YAML
pnpm plan                            # 🔍 diff local vs Braintrust
pnpm apply                           # ⬆️ push local → Braintrust
pnpm eval:remote --help              # 🧪 run cases against the dev eval server
```

Most Braintrust commands need `BRAINTRUST_API_KEY` (see `.env.example`).

## 📖 Docs

- **[AGENTS.md](AGENTS.md)** — entry point for coding agents + skill index
- **[DEVELOPER.md](DEVELOPER.md)** — project layout, all pnpm scripts, remote eval
- **[skills/](skills/)** — authoring, query reference, and case generation guides
