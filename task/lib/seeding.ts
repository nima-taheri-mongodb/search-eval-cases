import type { Document, MongoClient } from "mongodb";
import type { DbSeedEntry, SeedClassicIndex, SeedIndexSpec } from "./types.ts";
import movies from "../../dbseed/movies.json" with { type: "json" };

// Seed datasets are statically imported so the bundler (`braintrust push`)
// embeds them in the artifact—no filesystem reads or path resolution at
// runtime. To add a collection, drop dbseed/<name>.json and register it here.
const SEED_DOCUMENTS: Record<string, Document[]> = {
  movies: movies as Document[],
};

const DEFAULT_INDEX_READY_TIMEOUT_MS = 120_000;
const DEFAULT_INDEX_READY_INTERVAL_MS = 1_000;

type ParsedSeed = { collection: string; indexes: SeedIndexSpec[] };

function parseSeedEntry(entry: DbSeedEntry): ParsedSeed {
  if (typeof entry === "string") {
    return { collection: entry, indexes: [] };
  }

  const keys = Object.keys(entry);
  if (keys.length !== 1) {
    throw new Error(
      `Invalid db_seed entry, expected a single collection key but got: ${JSON.stringify(entry)}`,
    );
  }

  const collection = keys[0]!;
  return { collection, indexes: entry[collection]?.indexes ?? [] };
}

/** Collection names referenced by a db_seed list, in order. */
export function seedCollectionNames(dbSeed: DbSeedEntry[] = []): string[] {
  return dbSeed.map((entry) => parseSeedEntry(entry).collection);
}

function getSeedDocuments(collection: string): Document[] {
  const docs = SEED_DOCUMENTS[collection];
  if (!docs) {
    throw new Error(
      `No seed data bundled for collection '${collection}'. Add dbseed/${collection}.json and register it in seeding.ts.`,
    );
  }
  return docs;
}

// Search/vectorSearch indexes build asynchronously on Atlas; wait until each
// created index reports as queryable so the agent's queries hit a built index.
async function waitForIndexesQueryable(
  client: MongoClient,
  db: string,
  collection: string,
  indexNames: string[],
  timeoutMs = DEFAULT_INDEX_READY_TIMEOUT_MS,
  intervalMs = DEFAULT_INDEX_READY_INTERVAL_MS,
): Promise<void> {
  if (indexNames.length === 0) return;

  const coll = client.db(db).collection(collection);
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(indexNames);

  while (Date.now() < deadline) {
    const existing = (await coll.listSearchIndexes().toArray()) as Array<{
      name?: string;
      status?: string;
      queryable?: boolean;
    }>;

    for (const idx of existing) {
      if (
        idx.name &&
        pending.has(idx.name) &&
        (idx.queryable === true || idx.status === "READY")
      ) {
        pending.delete(idx.name);
      }
    }

    if (pending.size === 0) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(
    `Search index(es) [${[...pending].join(", ")}] on ${db}.${collection} not queryable after ${timeoutMs}ms`,
  );
}

export async function seedTempDb(
  client: MongoClient,
  db: string,
  dbSeed: DbSeedEntry[] = [],
): Promise<void> {
  for (const entry of dbSeed) {
    const { collection, indexes } = parseSeedEntry(entry);
    const coll = client.db(db).collection(collection);

    const docs = getSeedDocuments(collection);
    if (docs.length > 0) {
      await coll.insertMany(docs);
    }

    const searchIndexNames: string[] = [];
    for (const index of indexes) {
      if (index.type === "search" || index.type === "vectorSearch") {
        await coll.createSearchIndex({
          name: index.name,
          type: index.type,
          definition: index.definition,
        });
        searchIndexNames.push(index.name);
      } else {
        const { type: _type, name, key, ...options } = index as SeedClassicIndex;
        await coll.createIndex(key, { name, ...options });
      }
    }

    await waitForIndexesQueryable(client, db, collection, searchIndexNames);
  }
}

export async function dropTempDb(
  client: MongoClient,
  db: string,
): Promise<void> {
  await client.db(db).dropDatabase();
}
