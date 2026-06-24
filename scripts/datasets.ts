#!/usr/bin/env tsx
/**
 * Terraform-style sync for Braintrust datasets ↔ local YAML.
 *
 * Local layout: dataset/{dataset}/[{category}/…]/{cases.yaml}
 * Taxonomy: dataset/taxonomy.yaml guides folder scaffold; updated on pull/apply/scaffold.
 *
 *   scaffold  taxonomy → folder tree + row stubs
 *   plan      diff local vs remote using .sync-state.json baseline
 *   apply     execute plan (conservative by default; --prune for deletions)
 *   pull      remote → local YAML + refresh baseline + taxonomy
 *             (additive by default; --prune mirrors remote, removing local
 *             rows/files/datasets that no longer exist remotely)
 */

import {
  initDataset,
  login,
  type BraintrustState,
} from "braintrust";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import {
  aggregatedToLocalDatasetRef,
  buildTaxonomyFromLocal,
  findCaseFiles,
  findLocalRow,
  loadAllLocalDatasets,
  parseCaseRowsDocument,
  pruneLocalToRemote,
  readCaseRowsFile,
  readDatasetMeta,
  writeCaseRowsFile,
  writeDatasetMeta,
  writeGroupedRows,
  type AggregatedDataset,
} from "./datasets-layout.js";
import {
  buildSyncStateFromRemote,
  computePlan,
  formatPlan,
  parseRemoteDatasetList,
  planExitCode,
  SYNC_STATE_FILENAME,
  type DatasetRow,
  type DatasetSchemas,
  type LocalDatasetRef,
  type Plan,
  type PlanAction,
  type RemoteDataset,
  type SyncState,
} from "./datasets-lib.js";
import {
  mergeTaxonomy,
  readTaxonomyFile,
  scaffoldFromTaxonomy,
  writeTaxonomyFile,
} from "./taxonomy-lib.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const DEFAULT_PROJECT = "mongodb-mcp-server-evals";
const DEFAULT_DIR = "dataset";
const SCHEMAS_DIR = path.join(REPO_ROOT, "schemas");
const INPUT_SCHEMA_FILE = "input.schema.json";
const EXPECTED_SCHEMA_FILE = "expected.schema.json";

const ROW_INTERNAL_FIELDS = new Set(["_xact_id", "dataset_id"]);

type Command = "plan" | "apply" | "pull" | "scaffold";

interface CliOptions {
  command: Command;
  project: string;
  dir: string;
  prune: boolean;
  planOut?: string;
  planIn?: string;
}

type ApiConn = ReturnType<BraintrustState["apiConn"]>;

type InsertEvent = Record<string, unknown> & {
  id?: string;
  _is_merge?: boolean;
  _object_delete?: boolean;
};

const USAGE = `Sync Braintrust datasets ↔ local taxonomy-guided YAML tree.

Local layout (variable folder depth, rows in cases.yaml):
  dataset/Team - Search/cases.yaml
  dataset/Team - Search/Text Search Query Construction/Faceted Search/cases.yaml

All cases.yaml files under dataset/{dataset}/ merge into one Braintrust dataset named {dataset}.
Row metadata carries category, subcategory, group, subgroup, name, and description.

Baseline: <dir>/.sync-state.json

Commands:
  scaffold  Create folder tree + row stubs from dataset/taxonomy.yaml
  plan      Show pending changes. Exit 1 if changes, 2 if blocked (conflicts).
  apply     Apply local changes to remote (skips drift, remote-only, conflicts).
  pull      Overwrite local case files from remote + refresh taxonomy.
            With --prune, also delete local rows/files/datasets absent remotely.

Schema sync: plan/apply also diff schemas/{input,expected}.schema.json against
each dataset's remote metadata.__schemas and push updates (kept in _meta.yaml).

Flags:
  --prune          Allow deletions. For apply: rows/datasets missing locally are
                   removed remotely. For pull: rows/files/datasets missing
                   remotely are removed locally (true mirror).
  -out FILE        (plan) Write plan JSON to FILE.
  -f, --plan FILE  (apply) Apply a saved plan file instead of re-planning.

Requires BRAINTRUST_API_KEY.

Usage:
  scripts/datasets.ts scaffold [-d DIR]
  scripts/datasets.ts plan  [-p PROJECT] [-d DIR] [--prune] [-out plan.json]
  scripts/datasets.ts apply [-p PROJECT] [-d DIR] [--prune] [-f plan.json]
  scripts/datasets.ts pull  [-p PROJECT] [-d DIR] [--prune]`;

function usage(exitCode = 0): never {
  console.log(USAGE);
  throw new ProcessExit(exitCode);
}

class ProcessExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0) {
    usage(1);
  }

  const command = argv[0]!;
  if (command === "-h" || command === "--help") {
    usage(0);
  }
  if (
    command !== "plan" &&
    command !== "apply" &&
    command !== "pull" &&
    command !== "scaffold"
  ) {
    console.error(`Unknown command: ${command}`);
    usage(1);
  }

  const options: CliOptions = {
    command,
    project: DEFAULT_PROJECT,
    dir: DEFAULT_DIR,
    prune: false,
  };

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "-p":
      case "--project":
        options.project = argv[++i] ?? usage(1);
        break;
      case "-d":
      case "--dir":
        options.dir = argv[++i] ?? usage(1);
        break;
      case "--prune":
        options.prune = true;
        break;
      case "-out":
        options.planOut = argv[++i] ?? usage(1);
        break;
      case "-f":
      case "--plan":
        options.planIn = argv[++i] ?? usage(1);
        break;
      case "-h":
      case "--help":
        usage(0);
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        usage(1);
    }
  }

  return options;
}

function resolveDir(dir: string): string {
  return path.isAbsolute(dir) ? dir : path.join(REPO_ROOT, dir);
}

function syncStatePath(dir: string): string {
  return path.join(dir, SYNC_STATE_FILENAME);
}

function requireApiKey(): void {
  if (!process.env.BRAINTRUST_API_KEY) {
    console.error("Error: BRAINTRUST_API_KEY is required.");
    process.exit(1);
  }
}

async function connect(): Promise<BraintrustState> {
  requireApiKey();
  return login({
    apiKey: process.env.BRAINTRUST_API_KEY,
    appUrl: process.env.BRAINTRUST_APP_URL,
  });
}

async function listRemoteDatasets(
  state: BraintrustState,
  project: string,
): Promise<RemoteDataset[]> {
  const response = await state.apiConn().get_json("v1/dataset", {
    project_name: project,
  });
  return parseRemoteDatasetList(response);
}

function sanitizeRow(row: Record<string, unknown>): DatasetRow {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!ROW_INTERNAL_FIELDS.has(key)) {
      copy[key] = value;
    }
  }
  return copy as DatasetRow;
}

function rawRow(row: Record<string, unknown>): DatasetRow {
  return row as DatasetRow;
}

async function fetchDatasetRows(
  state: BraintrustState,
  project: string,
  name: string,
  keepInternal = false,
): Promise<DatasetRow[]> {
  const dataset = initDataset({ project, dataset: name, state });
  const rows: DatasetRow[] = [];
  for await (const row of dataset.fetch()) {
    const record = row as unknown as Record<string, unknown>;
    rows.push(keepInternal ? rawRow(record) : sanitizeRow(record));
  }
  return rows;
}

async function writeYaml(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const yaml = stringify(data, { lineWidth: 0 });
  await writeFile(file, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
}

async function readSyncState(dir: string): Promise<SyncState | null> {
  try {
    const text = await readFile(syncStatePath(dir), "utf8");
    return JSON.parse(text) as SyncState;
  } catch {
    return null;
  }
}

async function writeSyncState(dir: string, state: SyncState): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    syncStatePath(dir),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8",
  );
}

async function loadLocalDatasetRefs(dir: string): Promise<LocalDatasetRef[]> {
  const aggregated = await loadAllLocalDatasets(dir);
  const refs: LocalDatasetRef[] = [];
  for (const dataset of aggregated) {
    const meta = await readDatasetMeta(dataset.datasetDir);
    refs.push(aggregatedToLocalDatasetRef(dataset, meta));
  }
  return refs;
}

async function loadRemoteSnapshot(
  state: BraintrustState,
  project: string,
): Promise<{
  remoteDatasets: RemoteDataset[];
  remoteRowsByDataset: Map<string, DatasetRow[]>;
}> {
  const remoteDatasets = await listRemoteDatasets(state, project);
  const remoteRowsByDataset = new Map<string, DatasetRow[]>();
  for (const dataset of remoteDatasets) {
    remoteRowsByDataset.set(
      dataset.name,
      await fetchDatasetRows(state, project, dataset.name, true),
    );
  }
  return { remoteDatasets, remoteRowsByDataset };
}

async function updateTaxonomyFromLocal(dir: string): Promise<void> {
  const aggregated = await loadAllLocalDatasets(dir);
  const discovered = buildTaxonomyFromLocal(aggregated);
  const existing = await readTaxonomyFile(dir);
  const merged = mergeTaxonomy(existing, discovered);
  await writeTaxonomyFile(dir, merged);
}

async function loadSchemas(): Promise<DatasetSchemas | null> {
  try {
    const [input, expected] = await Promise.all([
      readFile(path.join(SCHEMAS_DIR, INPUT_SCHEMA_FILE), "utf8"),
      readFile(path.join(SCHEMAS_DIR, EXPECTED_SCHEMA_FILE), "utf8"),
    ]);
    return {
      input: JSON.parse(input) as unknown,
      expected: JSON.parse(expected) as unknown,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `Warning: could not load schemas from ${SCHEMAS_DIR}; skipping schema sync. (${message})`,
    );
    return null;
  }
}

async function buildPlan(
  state: BraintrustState,
  project: string,
  dir: string,
  prune: boolean,
): Promise<Plan> {
  const syncState = await readSyncState(dir);
  if (!syncState) {
    console.log(
      "Note: no .sync-state.json yet; remote snapshot used as baseline for this plan.",
    );
  } else if (syncState.project !== project) {
    console.warn(
      `Warning: sync state project '${syncState.project}' differs from '-p ${project}'.`,
    );
  }

  const [localDatasets, remote, schemas] = await Promise.all([
    loadLocalDatasetRefs(dir),
    loadRemoteSnapshot(state, project),
    loadSchemas(),
  ]);

  return computePlan({
    project,
    dir,
    prune,
    localDatasets,
    remoteDatasets: remote.remoteDatasets,
    remoteRowsByDataset: remote.remoteRowsByDataset,
    syncState,
    schemas,
  });
}

async function insertDatasetEvents(
  conn: ApiConn,
  datasetId: string,
  events: InsertEvent[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  await conn.post_json(`v1/dataset/${datasetId}/insert`, { events });
}

async function deleteRemoteDataset(
  conn: ApiConn,
  datasetId: string,
): Promise<void> {
  await conn.get(`v1/dataset/${datasetId}`, undefined, { method: "DELETE" });
}

async function patchDatasetMetadata(
  conn: ApiConn,
  datasetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await conn.get(`v1/dataset/${datasetId}`, undefined, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ metadata }),
  });
}

function rowInsertPayload(row: DatasetRow): InsertEvent {
  const { _xact_id: _xact, tags: _tags, ...rest } = row;
  return {
    ...(rest as Record<string, unknown>),
    _is_merge: false,
  };
}

async function applyAction(
  state: BraintrustState,
  project: string,
  conn: ApiConn,
  action: PlanAction,
  aggregated: AggregatedDataset[],
  createdDatasetIds: Map<string, string>,
): Promise<void> {
  switch (action.type) {
    case "noop":
    case "drift":
    case "remote_only":
    case "conflict":
      return;
    case "create_dataset": {
      const local = aggregated.find((d) => d.name === action.dataset);
      if (!local) {
        return;
      }
      console.log(`  + create dataset '${action.dataset}'`);
      const dataset = initDataset({
        project,
        dataset: action.dataset,
        state,
      });
      const datasetId = await dataset.id;
      createdDatasetIds.set(action.dataset, datasetId);
      const events = local.rows.map((row) => rowInsertPayload(row));
      await insertDatasetEvents(conn, datasetId, events);
      return;
    }
    case "delete_dataset": {
      if (!action.dataset_id) {
        return;
      }
      console.log(`  - delete dataset '${action.dataset}'`);
      await deleteRemoteDataset(conn, action.dataset_id);
      return;
    }
    case "update_schemas": {
      const datasetId =
        action.dataset_id ?? createdDatasetIds.get(action.dataset);
      if (!datasetId || !action.metadata) {
        return;
      }
      console.log(`  ~ schemas for '${action.dataset}'`);
      await patchDatasetMetadata(conn, datasetId, action.metadata);
      return;
    }
    case "create_row":
    case "update_row": {
      const datasetId =
        action.dataset_id ?? createdDatasetIds.get(action.dataset);
      if (!datasetId) {
        return;
      }
      const row = findLocalRow(aggregated, action.dataset, action.row_id);
      if (!row) {
        return;
      }
      const label = action.type === "create_row" ? "+" : "~";
      const target = action.row_id ?? "(new)";
      console.log(`    ${label} row ${target} in '${action.dataset}'`);
      await insertDatasetEvents(conn, datasetId, [rowInsertPayload(row)]);
      return;
    }
    case "delete_row": {
      if (!action.dataset_id || !action.row_id) {
        return;
      }
      console.log(`    - row ${action.row_id} in '${action.dataset}'`);
      await insertDatasetEvents(conn, action.dataset_id, [
        { id: action.row_id, _object_delete: true },
      ]);
      return;
    }
  }
}

const APPLY_ORDER: PlanAction["type"][] = [
  "create_dataset",
  "update_schemas",
  "create_row",
  "update_row",
  "delete_row",
  "delete_dataset",
];

async function applyPlan(
  state: BraintrustState,
  project: string,
  dir: string,
  plan: Plan,
): Promise<void> {
  if (plan.blocked) {
    console.error("Apply blocked: plan has conflicts. Resolve or run pull first.");
    throw new ProcessExit(2);
  }

  const applicable = plan.actions.filter((action) =>
    APPLY_ORDER.includes(action.type),
  );
  if (applicable.length === 0) {
    console.log("Nothing to apply.");
    return;
  }

  console.log(
    `Applying ${plan.summary.create} add, ${plan.summary.update} change, ${plan.summary.delete} destroy...`,
  );

  const conn = state.apiConn();
  const aggregated = await loadAllLocalDatasets(dir);
  const createdDatasetIds = new Map<string, string>();

  for (const type of APPLY_ORDER) {
    for (const action of plan.actions) {
      if (action.type === type) {
        await applyAction(
          state,
          project,
          conn,
          action,
          aggregated,
          createdDatasetIds,
        );
      }
    }
  }

  const remote = await loadRemoteSnapshot(state, project);

  const schemaUpdated = new Set(
    plan.actions
      .filter((action) => action.type === "update_schemas")
      .map((action) => action.dataset),
  );
  for (const dataset of remote.remoteDatasets) {
    if (schemaUpdated.has(dataset.name)) {
      await writeDatasetMeta(path.join(dir, dataset.name), dataset);
      console.log(`  ~ updated _meta.yaml for '${dataset.name}'`);
    }
  }

  const syncState = buildSyncStateFromRemote({
    project,
    previous: await readSyncState(dir),
    remoteDatasets: remote.remoteDatasets,
    remoteRowsByDataset: remote.remoteRowsByDataset,
  });
  await writeSyncState(dir, syncState);
  await updateTaxonomyFromLocal(dir);
  console.log(`Updated ${syncStatePath(dir)}`);
  console.log("Done.");
}

async function runPlan(options: CliOptions, dir: string): Promise<void> {
  const state = await connect();
  const plan = await buildPlan(state, options.project, dir, options.prune);
  console.log(formatPlan(plan));

  if (options.planOut) {
    const outPath = path.isAbsolute(options.planOut)
      ? options.planOut
      : path.join(REPO_ROOT, options.planOut);
    await writeFile(outPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    console.log(`\nWrote plan to ${outPath}`);
  }

  throw new ProcessExit(planExitCode(plan));
}

/**
 * Assign a stable UUID to every local row missing an `id` and persist it to its
 * cases.yaml. Run before planning so each row is identified individually (no
 * "first id-less row" collisions) and the id is inserted/written back.
 */
async function assignMissingIds(dir: string): Promise<number> {
  const files = await findCaseFiles(dir);
  let assigned = 0;
  for (const file of files) {
    let rows;
    try {
      rows = await readCaseRowsFile(file);
    } catch {
      continue;
    }
    let changed = false;
    const updated = rows.map((row) => {
      if (row && typeof row === "object" && !row.id) {
        changed = true;
        assigned += 1;
        return { id: randomUUID(), ...row };
      }
      return row;
    });
    if (changed) {
      await writeCaseRowsFile(file, updated);
      console.log(`  id+ ${path.relative(REPO_ROOT, file)}`);
    }
  }
  if (assigned > 0) {
    console.log(`Assigned ${assigned} new row id(s) before apply.`);
  }
  return assigned;
}

async function runApply(options: CliOptions, dir: string): Promise<void> {
  const state = await connect();
  let plan: Plan;

  if (options.planIn) {
    const inPath = path.isAbsolute(options.planIn)
      ? options.planIn
      : path.join(REPO_ROOT, options.planIn);
    plan = JSON.parse(await readFile(inPath, "utf8")) as Plan;
    console.log(`Applying saved plan from ${inPath}`);
    console.log(formatPlan(plan));
  } else {
    await assignMissingIds(dir);
    plan = await buildPlan(state, options.project, dir, options.prune);
    console.log(formatPlan(plan));
  }

  await applyPlan(state, options.project, dir, plan);
}

async function pullAll(
  state: BraintrustState,
  project: string,
  dir: string,
  prune: boolean,
): Promise<void> {
  console.log(`Pulling datasets from project '${project}' into '${dir}/'...`);
  await mkdir(dir, { recursive: true });

  const remote = await loadRemoteSnapshot(state, project);
  const localL1 = new Set((await loadAllLocalDatasets(dir)).map((d) => d.name));

  if (remote.remoteDatasets.length === 0 && localL1.size === 0) {
    console.log(`No datasets found in project '${project}'.`);
    return;
  }

  for (const dataset of remote.remoteDatasets) {
    const rows = (remote.remoteRowsByDataset.get(dataset.name) ?? []).map(
      (row) => sanitizeRow(row as Record<string, unknown>),
    );
    console.log(`  - ${dataset.name} (${rows.length} row(s))`);
    const datasetDir = path.join(dir, dataset.name);
    await writeDatasetMeta(datasetDir, dataset);
    const written = await writeGroupedRows(rows, dir, dataset.name);
    for (const file of written) {
      console.log(`      -> ${file}`);
    }
  }

  if (prune) {
    const remoteNames = new Set(remote.remoteDatasets.map((d) => d.name));
    const pruned = await pruneLocalToRemote(
      dir,
      remoteNames,
      remote.remoteRowsByDataset,
    );
    if (
      pruned.removedRows === 0 &&
      pruned.deletedFiles.length === 0 &&
      pruned.deletedDatasets.length === 0
    ) {
      console.log("Prune: nothing to remove (local already matches remote).");
    } else {
      console.log(
        `Prune: removed ${pruned.removedRows} local row(s), ${pruned.deletedFiles.length} file(s), ${pruned.deletedDatasets.length} dataset(s).`,
      );
      for (const dataset of pruned.deletedDatasets) {
        console.log(`      - dataset ${dataset}`);
      }
      for (const file of pruned.deletedFiles) {
        console.log(`      - ${file}`);
      }
    }
  }

  const syncState = buildSyncStateFromRemote({
    project,
    previous: await readSyncState(dir),
    remoteDatasets: remote.remoteDatasets,
    remoteRowsByDataset: remote.remoteRowsByDataset,
  });
  await writeSyncState(dir, syncState);
  await updateTaxonomyFromLocal(dir);
  console.log(`Updated ${syncStatePath(dir)} and taxonomy`);
  console.log("Done.");
}

async function runScaffold(dir: string): Promise<void> {
  const taxonomy = await readTaxonomyFile(dir);
  if (taxonomy.length === 0) {
    console.error(`No taxonomy found at ${path.join(dir, "taxonomy.yaml")}`);
    throw new ProcessExit(1);
  }

  console.log(`Scaffolding from taxonomy into '${dir}/'...`);
  const result = await scaffoldFromTaxonomy(
    taxonomy,
    dir,
    writeYaml,
    async (file) => {
      try {
        const text = await readFile(file, "utf8");
        return parseCaseRowsDocument(parse(text));
      } catch {
        return null;
      }
    },
  );

  for (const file of result.created) {
    console.log(`  + ${file}`);
  }
  for (const file of result.updated) {
    console.log(`  ~ ${file}`);
  }

  await writeTaxonomyFile(dir, taxonomy);
  console.log("Done.");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolveDir(options.dir);

  switch (options.command) {
    case "scaffold":
      await runScaffold(dir);
      break;
    case "plan":
      await runPlan(options, dir);
      break;
    case "apply":
      await runApply(options, dir);
      break;
    case "pull":
      await pullAll(await connect(), options.project, dir, options.prune);
      break;
  }
}

main().catch((error: unknown) => {
  if (error instanceof ProcessExit) {
    process.exit(error.code);
  }
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
