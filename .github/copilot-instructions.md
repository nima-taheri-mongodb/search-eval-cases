# GitHub Copilot instructions

The canonical guidance for this repository — including verified low-selectivity
text / vector / hybrid search query examples for the seeded mflix dataset
(`sample_mflix.mcp_movies`) — lives in [`AGENTS.md`](../AGENTS.md).

Read `AGENTS.md` before writing or reviewing Atlas Search (`$search`), Vector
Search (`$vectorSearch`), or hybrid (`$rankFusion`) eval cases. When a query
needs to return a small fraction of the data (2-11 of 40 docs), reuse the
verified examples documented there.
