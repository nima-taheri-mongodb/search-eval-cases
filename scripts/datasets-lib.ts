import { createHash } from "node:crypto";

export const SYNC_STATE_VERSION = 1;
export const SYNC_STATE_FILENAME = ".sync-state.json";

export const ROW_CONTENT_FIELDS = [
  "input",
  "expected",
  "metadata",
  "tags",
] as const;

export interface DatasetRow {
  id?: string | null;
  input?: unknown;
  expected?: unknown;
  metadata?: unknown;
  tags?: string[];
  origin?: unknown;
  _xact_id?: string | null;
}

export interface RemoteDataset {
  id: string;
  name: string;
  project_id?: string | null;
  description?: string | null;
  created?: string | null;
  created_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Normalize `GET v1/dataset` responses (array or `{ objects: [...] }`). */
export function parseRemoteDatasetList(response: unknown): RemoteDataset[] {
  if (Array.isArray(response)) {
    return response as RemoteDataset[];
  }
  if (
    response &&
    typeof response === "object" &&
    Array.isArray((response as { objects?: unknown }).objects)
  ) {
    return (response as { objects: RemoteDataset[] }).objects;
  }
  return [];
}

export interface DatasetFile {
  dataset?: RemoteDataset;
  rows?: DatasetRow[];
  preview_length?: number;
  row_limit?: number | null;
  rows_previewed?: boolean;
  rows_truncated?: boolean;
}

export interface RowSnapshot {
  xact_id?: string | null;
  content_hash: string;
}

export interface DatasetSyncState {
  dataset_id: string;
  rows: Record<string, RowSnapshot>;
  synced_at: string;
}

export interface SyncState {
  version: typeof SYNC_STATE_VERSION;
  project: string;
  datasets: Record<string, DatasetSyncState>;
}

export type PlanActionType =
  | "noop"
  | "create_dataset"
  | "delete_dataset"
  | "create_row"
  | "update_row"
  | "delete_row"
  | "conflict"
  | "drift"
  | "remote_only";

export interface PlanAction {
  type: PlanActionType;
  dataset: string;
  dataset_id?: string;
  row_id?: string;
  local_file?: string;
  reason?: string;
}

export interface PlanSummary {
  create: number;
  update: number;
  delete: number;
  conflict: number;
  drift: number;
  remote_only: number;
  noop: number;
}

export interface Plan {
  version: 1;
  project: string;
  dir: string;
  generated_at: string;
  prune: boolean;
  actions: PlanAction[];
  summary: PlanSummary;
  blocked: boolean;
}

export function rowContentForHash(row: DatasetRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ROW_CONTENT_FIELDS) {
    if (row[key] !== undefined) {
      out[key] = row[key];
    }
  }
  return out;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_, current) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        sorted[key] = current[key as keyof typeof current];
      }
      return sorted;
    }
    return current;
  });
}

export function hashRow(row: DatasetRow): string {
  return createHash("sha256")
    .update(stableStringify(rowContentForHash(row)))
    .digest("hex")
    .slice(0, 16);
}

export function emptySummary(): PlanSummary {
  return {
    create: 0,
    update: 0,
    delete: 0,
    conflict: 0,
    drift: 0,
    remote_only: 0,
    noop: 0,
  };
}

function bumpSummary(summary: PlanSummary, type: PlanActionType): void {
  switch (type) {
    case "create_dataset":
    case "create_row":
      summary.create += 1;
      break;
    case "update_row":
      summary.update += 1;
      break;
    case "delete_dataset":
    case "delete_row":
      summary.delete += 1;
      break;
    case "conflict":
      summary.conflict += 1;
      break;
    case "drift":
      summary.drift += 1;
      break;
    case "remote_only":
      summary.remote_only += 1;
      break;
    case "noop":
      summary.noop += 1;
      break;
  }
}

function rowsById(rows: DatasetRow[]): Map<string, DatasetRow> {
  const map = new Map<string, DatasetRow>();
  for (const row of rows) {
    if (row.id) {
      map.set(row.id, row);
    }
  }
  return map;
}

function baselineFromRemote(
  datasetId: string,
  remoteRows: DatasetRow[],
): DatasetSyncState {
  const rows: Record<string, RowSnapshot> = {};
  for (const row of remoteRows) {
    if (!row.id) {
      continue;
    }
    rows[row.id] = {
      xact_id: row._xact_id ?? null,
      content_hash: hashRow(row),
    };
  }
  return {
    dataset_id: datasetId,
    rows,
    synced_at: new Date().toISOString(),
  };
}

function remoteChanged(
  remoteRow: DatasetRow | undefined,
  baseline: RowSnapshot | undefined,
): boolean {
  if (!remoteRow) {
    return false;
  }
  if (!baseline) {
    return true;
  }
  const hash = hashRow(remoteRow);
  if (hash !== baseline.content_hash) {
    return true;
  }
  const xact = remoteRow._xact_id ?? null;
  const baselineXact = baseline.xact_id ?? null;
  return xact !== baselineXact;
}

function localChanged(
  localRow: DatasetRow | undefined,
  baseline: RowSnapshot | undefined,
): boolean {
  if (!localRow) {
    return false;
  }
  if (!baseline) {
    return true;
  }
  return hashRow(localRow) !== baseline.content_hash;
}

export function computeDatasetPlan(params: {
  name: string;
  localFile?: string;
  local?: DatasetFile;
  remote?: RemoteDataset;
  remoteRows: DatasetRow[];
  baseline?: DatasetSyncState;
  prune: boolean;
}): PlanAction[] {
  const {
    name,
    localFile,
    local,
    remote,
    remoteRows,
    prune,
  } = params;
  const baseline =
    params.baseline ??
    (remote ? baselineFromRemote(remote.id, remoteRows) : undefined);

  const actions: PlanAction[] = [];
  const localRows = local?.rows ?? [];
  const localMap = rowsById(localRows);
  const remoteMap = rowsById(remoteRows);
  const rowIds = new Set<string>([
    ...localMap.keys(),
    ...remoteMap.keys(),
    ...Object.keys(baseline?.rows ?? {}),
  ]);

  if (local && !remote) {
    actions.push({
      type: "create_dataset",
      dataset: name,
      local_file: localFile,
    });
    return actions;
  }

  if (!local && remote) {
    if (prune) {
      actions.push({
        type: "delete_dataset",
        dataset: name,
        dataset_id: remote.id,
        reason: "no local file",
      });
    } else {
      actions.push({
        type: "remote_only",
        dataset: name,
        dataset_id: remote.id,
        reason: "remote dataset has no local file (use --prune to delete)",
      });
    }
    return actions;
  }

  if (!local || !remote) {
    return actions;
  }

  for (const row of localRows) {
    if (!row.id) {
      actions.push({
        type: "create_row",
        dataset: name,
        dataset_id: remote.id,
        local_file: localFile,
        reason: "row has no id",
      });
    }
  }

  for (const rowId of rowIds) {
    const localRow = localMap.get(rowId);
    const remoteRow = remoteMap.get(rowId);
    const baselineSnap = baseline?.rows[rowId];
    const localDiff = localChanged(localRow, baselineSnap);
    const remoteDiff = remoteChanged(remoteRow, baselineSnap);

    if (localRow && remoteRow) {
      if (localDiff && remoteDiff) {
        actions.push({
          type: "conflict",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          local_file: localFile,
          reason: "local and remote both changed since last sync",
        });
      } else if (localDiff) {
        actions.push({
          type: "update_row",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          local_file: localFile,
        });
      } else if (remoteDiff) {
        actions.push({
          type: "drift",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          local_file: localFile,
          reason: "remote changed since last sync; run pull to accept",
        });
      } else {
        actions.push({
          type: "noop",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          local_file: localFile,
        });
      }
      continue;
    }

    if (localRow && !remoteRow) {
      if (baselineSnap) {
        if (prune) {
          actions.push({
            type: "delete_row",
            dataset: name,
            dataset_id: remote.id,
            row_id: rowId,
            local_file: localFile,
            reason: "removed locally",
          });
        } else {
          actions.push({
            type: "conflict",
            dataset: name,
            dataset_id: remote.id,
            row_id: rowId,
            local_file: localFile,
            reason: "row removed locally but existed at last sync (use --prune)",
          });
        }
      } else {
        actions.push({
          type: "create_row",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          local_file: localFile,
        });
      }
      continue;
    }

    if (!localRow && remoteRow) {
      if (prune) {
        actions.push({
          type: "delete_row",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          reason: baselineSnap ? "not in local file" : "remote-only (prune)",
        });
      } else if (baselineSnap) {
        actions.push({
          type: "remote_only",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          reason: "remote row not in local (use --prune to delete)",
        });
      } else {
        actions.push({
          type: "remote_only",
          dataset: name,
          dataset_id: remote.id,
          row_id: rowId,
          reason: "remote-only row (not in baseline)",
        });
      }
    }
  }

  return actions;
}

export interface LocalDatasetRef {
  name: string;
  file: string;
  data: DatasetFile;
}

export function computePlan(params: {
  project: string;
  dir: string;
  prune: boolean;
  localDatasets: LocalDatasetRef[];
  remoteDatasets: RemoteDataset[];
  remoteRowsByDataset: Map<string, DatasetRow[]>;
  syncState: SyncState | null;
}): Plan {
  const {
    project,
    dir,
    prune,
    localDatasets,
    remoteDatasets,
    remoteRowsByDataset,
    syncState,
  } = params;

  const localByName = new Map(localDatasets.map((d) => [d.name, d]));
  const remoteByName = new Map(remoteDatasets.map((d) => [d.name, d]));
  const names = new Set([
    ...localByName.keys(),
    ...remoteByName.keys(),
    ...Object.keys(syncState?.datasets ?? {}),
  ]);

  const actions: PlanAction[] = [];
  for (const name of [...names].sort()) {
    const local = localByName.get(name);
    const remote = remoteByName.get(name);
    const baseline = syncState?.datasets[name];
    actions.push(
      ...computeDatasetPlan({
        name,
        localFile: local?.file,
        local: local?.data,
        remote,
        remoteRows: remoteRowsByDataset.get(name) ?? [],
        baseline,
        prune,
      }),
    );
  }

  const summary = emptySummary();
  for (const action of actions) {
    bumpSummary(summary, action.type);
  }

  const blocked =
    summary.conflict > 0 ||
    (!prune && summary.delete > 0 && actions.some((a) => a.type === "conflict"));

  return {
    version: 1,
    project,
    dir,
    generated_at: new Date().toISOString(),
    prune,
    actions,
    summary,
    blocked: summary.conflict > 0,
  };
}

export function buildSyncStateFromRemote(params: {
  project: string;
  previous: SyncState | null;
  remoteDatasets: RemoteDataset[];
  remoteRowsByDataset: Map<string, DatasetRow[]>;
}): SyncState {
  const datasets: Record<string, DatasetSyncState> = {};
  for (const remote of params.remoteDatasets) {
    const rows = params.remoteRowsByDataset.get(remote.name) ?? [];
    datasets[remote.name] = baselineFromRemote(remote.id, rows);
  }
  return {
    version: SYNC_STATE_VERSION,
    project: params.project,
    datasets,
  };
}

export function buildSyncStateFromLocal(params: {
  project: string;
  previous: SyncState | null;
  remoteDatasets: RemoteDataset[];
  remoteRowsByDataset: Map<string, DatasetRow[]>;
  localDatasets: LocalDatasetRef[];
}): SyncState {
  const remoteByName = new Map(
    params.remoteDatasets.map((dataset) => [dataset.name, dataset]),
  );
  const datasets: Record<string, DatasetSyncState> = {
    ...(params.previous?.datasets ?? {}),
  };

  for (const local of params.localDatasets) {
    const remote = remoteByName.get(local.name);
    if (!remote) {
      continue;
    }
    const remoteRows = params.remoteRowsByDataset.get(local.name) ?? [];
    const remoteMap = rowsById(remoteRows);
    const rows: Record<string, RowSnapshot> = {};

    for (const row of local.data.rows ?? []) {
      if (!row.id) {
        continue;
      }
      const remoteRow = remoteMap.get(row.id);
      rows[row.id] = {
        xact_id: remoteRow?._xact_id ?? null,
        content_hash: hashRow(row),
      };
    }

    datasets[local.name] = {
      dataset_id: remote.id,
      rows,
      synced_at: new Date().toISOString(),
    };
  }

  return {
    version: SYNC_STATE_VERSION,
    project: params.project,
    datasets,
  };
}

const ACTION_SYMBOL: Record<PlanActionType, string> = {
  noop: " ",
  create_dataset: "+",
  delete_dataset: "-",
  create_row: "+",
  update_row: "~",
  delete_row: "-",
  conflict: "!",
  drift: "?",
  remote_only: "?",
};

export function formatPlan(plan: Plan): string {
  const lines: string[] = [];
  const { summary } = plan;
  const applicable = summary.create + summary.update + summary.delete;
  lines.push(
    `Plan: ${summary.create} to add, ${summary.update} to change, ${summary.delete} to destroy` +
      (summary.conflict > 0 ? `, ${summary.conflict} conflict(s)` : "") +
      (summary.drift > 0 ? `, ${summary.drift} drift(s)` : "") +
      (summary.remote_only > 0 ? `, ${summary.remote_only} remote-only` : "") +
      (summary.noop > 0 ? ` (${summary.noop} unchanged)` : ""),
  );

  if (plan.blocked) {
    lines.push("Apply blocked: resolve conflicts or run pull before apply.");
  } else if (applicable === 0 && summary.drift === 0 && summary.remote_only === 0) {
    lines.push("No changes.");
  }

  lines.push("");

  let currentDataset = "";
  for (const action of plan.actions) {
    if (action.type === "noop") {
      continue;
    }
    if (action.dataset !== currentDataset) {
      currentDataset = action.dataset;
      lines.push(`  dataset "${action.dataset}"`);
    }
    const symbol = ACTION_SYMBOL[action.type];
    const target =
      action.row_id != null
        ? `row ${action.row_id}`
        : action.type.replace(/_/g, " ");
    const reason = action.reason ? `  (${action.reason})` : "";
    lines.push(`    ${symbol} ${target}${reason}`);
  }

  return lines.join("\n");
}

export function planExitCode(plan: Plan): number {
  if (plan.blocked) {
    return 2;
  }
  const pending =
    plan.summary.create +
    plan.summary.update +
    plan.summary.delete +
    plan.summary.drift +
    plan.summary.remote_only;
  return pending > 0 ? 1 : 0;
}
