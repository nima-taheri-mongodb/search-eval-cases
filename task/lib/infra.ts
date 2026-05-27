import { MongoClient } from "mongodb";
import { createLazyMcpEvalClient, type McpEvalClient } from "./mcpEvalClient.ts";
import { dropTempDb } from "./seeding.ts";

// Shared, lazily-initialized infrastructure for a single eval run. The task and
// the scorers run as separate Braintrust functions but operate on the same
// cluster, so we capture the connection string once and reuse the clients.

let connectionString: string | null = null;

let mongoClient: MongoClient | null = null;
let mongoPending: Promise<MongoClient> | null = null;

let mcpGetClient: (() => Promise<McpEvalClient>) | null = null;
let mcpClose: (() => Promise<void>) | null = null;

const tempDbs = new Set<string>();

export function captureConnectionString(cs: string): void {
  if (!connectionString) {
    connectionString = cs;
  }
}

function requireConnectionString(): string {
  if (!connectionString) {
    throw new Error(
      "connectionString has not been captured yet; the task must call captureConnectionString() first.",
    );
  }
  return connectionString;
}

export async function getMongoClient(): Promise<MongoClient> {
  if (mongoClient) return mongoClient;
  if (!mongoPending) {
    const client = new MongoClient(requireConnectionString());
    mongoPending = client.connect().then((connected) => {
      mongoClient = connected;
      return connected;
    });
  }
  return mongoPending;
}

export async function getMcpClient(): Promise<McpEvalClient> {
  if (!mcpGetClient) {
    const [getClient, closeClient] = createLazyMcpEvalClient(
      requireConnectionString(),
    );
    mcpGetClient = getClient;
    mcpClose = closeClient;
  }
  return mcpGetClient();
}

export function registerTempDb(name: string): void {
  tempDbs.add(name);
}

// Drop a single eval case's temp DB and stop tracking it. The scorer calls this
// in a finally block so each case releases its resources—most importantly its
// search indexes, which count against a scarce, cluster-wide Atlas quota—as
// soon as scoring finishes, rather than waiting for the global teardown. This
// keeps the live DB/index count bounded by maxConcurrency.
//
// Note: Atlas search-index deletion is asynchronous, so the quota may not free
// the instant this resolves. If the quota is tighter than
// maxConcurrency * indexes-per-case, also lower maxConcurrency or poll
// listSearchIndexes until empty before reusing the slot.
export async function dropCaseDb(name: string): Promise<void> {
  if (!tempDbs.has(name)) return;
  try {
    const client = await getMongoClient();
    await dropTempDb(client, name);
  } catch (error) {
    console.error(`Failed to drop temp database '${name}':`, error);
  } finally {
    tempDbs.delete(name);
  }
}

// Drop every temp DB created during the run, then close all clients. Called
// once after the Eval resolves.
export async function teardown(): Promise<void> {
  if (mongoClient) {
    for (const db of tempDbs) {
      try {
        await dropTempDb(mongoClient, db);
      } catch (error) {
        console.error(`Failed to drop temp database '${db}':`, error);
      }
    }
  }
  tempDbs.clear();

  await Promise.allSettled([mongoClient?.close(), mcpClose?.()]);

  mongoClient = null;
  mongoPending = null;
  mcpGetClient = null;
  mcpClose = null;
}
