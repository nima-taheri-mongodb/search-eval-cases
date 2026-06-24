import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import {
  SYNC_STATE_FILENAME,
  type DatasetFile,
  type DatasetRow,
  type RemoteDataset,
} from "./datasets-lib.js";
import {
  CASES_FILENAME,
  casesFilePathFromMetadata,
  enrichRowMetadata,
  getCaseMetadata,
  rowForBraintrust,
  rowMatchKey,
  taxonomyFromMetadataPaths,
  taxonomyPathFromCasesFile,
  TAXONOMY_FILENAME,
  type CaseMetadata,
  type CaseRow,
  type TaxonomyLeafRecord,
  type TaxonomyRoot,
} from "./taxonomy-lib.js";

export const META_FILENAME = "_meta.yaml";

export interface AggregatedDataset {
  name: string;
  datasetDir: string;
  metaFile: string;
  rows: DatasetRow[];
  rowSources: Map<string, string>;
}

export function isCasesFile(filePath: string, datasetDir: string): boolean {
  const rel = path.relative(datasetDir, filePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return false;
  }
  const parts = rel.split(path.sep);
  return (
    parts.length >= 2 &&
    parts[parts.length - 1] === CASES_FILENAME &&
    parts[0] !== TAXONOMY_FILENAME &&
    !parts[0]!.startsWith(".")
  );
}

export async function findCaseFiles(datasetDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (entry.isFile() && isCasesFile(full, datasetDir)) {
        results.push(full);
      }
    }
  }

  let topEntries;
  try {
    topEntries = await readdir(datasetDir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    if (
      entry.name === TAXONOMY_FILENAME.replace(/\.yaml$/, "") ||
      entry.name === SYNC_STATE_FILENAME.replace(/^\./, "").replace(/\.json$/, "")
    ) {
      continue;
    }
    await walk(path.join(datasetDir, entry.name));
  }

  return results.sort();
}

export function groupCaseFilesByDataset(
  caseFiles: string[],
  datasetDir: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of caseFiles) {
    const { dataset } = taxonomyPathFromCasesFile(file, datasetDir);
    const list = groups.get(dataset) ?? [];
    list.push(file);
    groups.set(dataset, list);
  }
  return groups;
}

/** @deprecated Use `groupCaseFilesByDataset`. */
export const groupCaseFilesByL1 = groupCaseFilesByDataset;

/** Parse cases YAML: root must be a sequence of rows (JSON/YAML array). Legacy `{ rows: [...] }` is still accepted. */
export function parseCaseRowsDocument(parsed: unknown): CaseRow[] {
  if (Array.isArray(parsed)) {
    return parsed as CaseRow[];
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { rows?: unknown }).rows)
  ) {
    return (parsed as { rows: CaseRow[] }).rows;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return [parsed as CaseRow];
  }
  throw new Error(
    "Case file must be a YAML array of row objects (or legacy { rows: [...] })",
  );
}

export async function readCaseRowsFile(filePath: string): Promise<CaseRow[]> {
  const text = await readFile(filePath, "utf8");
  return parseCaseRowsDocument(parse(text));
}

export async function writeCaseRowsFile(
  filePath: string,
  rows: CaseRow[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const yaml = stringify(rows, { lineWidth: 0 });
  await writeFile(filePath, yaml.endsWith("\n") ? yaml : `${yaml}\n`, "utf8");
}

export async function loadAggregatedDataset(
  datasetName: string,
  caseFiles: string[],
  datasetDir: string,
): Promise<AggregatedDataset> {
  const rows: DatasetRow[] = [];
  const rowSources = new Map<string, string>();
  const datasetRoot = path.join(datasetDir, datasetName);

  for (const file of caseFiles) {
    const { path: taxonomyPath } = taxonomyPathFromCasesFile(file, datasetDir);
    const fileRows = await readCaseRowsFile(file);
    for (const row of fileRows) {
      const enriched = enrichRowMetadata(row, taxonomyPath);
      const btRow = rowForBraintrust(enriched);
      rows.push(btRow);
      const meta = getCaseMetadata(enriched);
      if (btRow.id) {
        rowSources.set(btRow.id, file);
      } else if (meta) {
        rowSources.set(rowMatchKey(datasetName, meta), file);
      }
    }
  }

  return {
    name: datasetName,
    datasetDir: datasetRoot,
    metaFile: path.join(datasetRoot, META_FILENAME),
    rows,
    rowSources,
  };
}

export async function loadAllLocalDatasets(
  datasetDir: string,
): Promise<AggregatedDataset[]> {
  const caseFiles = await findCaseFiles(datasetDir);
  const groups = groupCaseFilesByDataset(caseFiles, datasetDir);
  const datasets: AggregatedDataset[] = [];
  for (const [datasetName, files] of groups) {
    datasets.push(
      await loadAggregatedDataset(datasetName, files, datasetDir),
    );
  }
  return datasets;
}

export function aggregatedToLocalDatasetRef(
  aggregated: AggregatedDataset,
  meta?: DatasetFile["dataset"],
): {
  name: string;
  file: string;
  data: DatasetFile;
} {
  return {
    name: aggregated.name,
    file: aggregated.metaFile,
    data: {
      dataset: meta ?? { id: "", name: aggregated.name },
      rows: aggregated.rows,
      preview_length: -1,
      row_limit: null,
      rows_previewed: false,
      rows_truncated: false,
    },
  };
}

export async function readDatasetMeta(
  datasetRoot: string,
): Promise<DatasetFile["dataset"] | undefined> {
  try {
    const text = await readFile(path.join(datasetRoot, META_FILENAME), "utf8");
    const data = parse(text) as { dataset?: DatasetFile["dataset"] };
    return data.dataset;
  } catch {
    return undefined;
  }
}

export async function writeDatasetMeta(
  datasetRoot: string,
  remote: RemoteDataset,
): Promise<void> {
  await mkdir(datasetRoot, { recursive: true });
  const yaml = stringify(
    {
      dataset: {
        id: remote.id,
        name: remote.name,
        project_id: remote.project_id ?? null,
        description: remote.description ?? "",
        created: remote.created ?? null,
        created_at: remote.created_at ?? null,
        metadata: remote.metadata ?? null,
      },
    },
    { lineWidth: 0 },
  );
  await writeFile(
    path.join(datasetRoot, META_FILENAME),
    yaml.endsWith("\n") ? yaml : `${yaml}\n`,
    "utf8",
  );
}

function localRowFromRemote(
  row: DatasetRow,
  dataset: string,
): CaseRow | null {
  const metadata = getCaseMetadata(row as CaseRow);
  if (!metadata) {
    return null;
  }
  return {
    id: row.id,
    input: row.input,
    expected: row.expected,
    metadata,
    origin: row.origin,
  };
}

export async function writeGroupedRows(
  rows: DatasetRow[],
  datasetDir: string,
  datasetName: string,
): Promise<string[]> {
  const byFile = new Map<string, CaseRow[]>();
  const written: string[] = [];

  for (const row of rows) {
    const localRow = localRowFromRemote(row, datasetName);
    if (!localRow) {
      continue;
    }
    const metadata = getCaseMetadata(localRow);
    if (!metadata) {
      continue;
    }
    const filePath = casesFilePathFromMetadata(
      datasetDir,
      datasetName,
      metadata,
    );
    const list = byFile.get(filePath) ?? [];
    list.push(localRow);
    byFile.set(filePath, list);
  }

  for (const [filePath, fileRows] of byFile) {
    let existing: CaseRow[] = [];
    try {
      existing = await readCaseRowsFile(filePath);
    } catch {
      // new file
    }

    const { path: taxonomyPath } = taxonomyPathFromCasesFile(
      filePath,
      datasetDir,
    );
    const merged = [...existing];
    for (const incoming of fileRows) {
      const enriched = enrichRowMetadata(incoming, taxonomyPath);
      const incomingMeta = getCaseMetadata(enriched);
      if (!incomingMeta) {
        continue;
      }
      const incomingKey = incoming.id ?? rowMatchKey(datasetName, incomingMeta);
      const idx = merged.findIndex((row) => {
        if (incoming.id && row.id === incoming.id) {
          return true;
        }
        const meta = getCaseMetadata(row);
        return meta ? meta.name === incomingMeta.name : false;
      });
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...enriched };
      } else {
        merged.push(enriched);
      }
      void incomingKey;
    }

    await writeCaseRowsFile(filePath, merged);
    written.push(filePath);
  }

  return written;
}

/**
 * Identity sets for the rows of a single remote dataset. Mirrors the matching
 * used by `writeGroupedRows`: a local row corresponds to a remote row when their
 * `id`s match, or when their case `metadata.name`s match.
 */
export interface RemoteRowKeys {
  ids: Set<string>;
  names: Set<string>;
}

export function buildRemoteRowKeys(rows: DatasetRow[]): RemoteRowKeys {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.id === "string" && row.id) {
      ids.add(row.id);
    }
    const meta = getCaseMetadata(row as CaseRow);
    if (meta) {
      names.add(meta.name);
    }
  }
  return { ids, names };
}

/** True when a local row matches some remote row by id or by metadata name. */
export function rowExistsRemotely(row: CaseRow, keys: RemoteRowKeys): boolean {
  if (typeof row.id === "string" && row.id && keys.ids.has(row.id)) {
    return true;
  }
  const meta = getCaseMetadata(row);
  return meta ? keys.names.has(meta.name) : false;
}

export interface PruneResult {
  removedRows: number;
  deletedFiles: string[];
  deletedDatasets: string[];
}

/** Remove empty directories from `startDir` upward, stopping before `stopAt`. */
async function removeEmptyDirsUpward(
  startDir: string,
  stopAt: string,
): Promise<void> {
  const top = path.resolve(stopAt);
  let current = path.resolve(startDir);
  while (current !== top && current.startsWith(`${top}${path.sep}`)) {
    let entries: string[];
    try {
      entries = await readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) {
      return;
    }
    await rm(current, { recursive: true, force: true });
    current = path.dirname(current);
  }
}

/**
 * Make the local case tree mirror the remote snapshot by deleting local rows,
 * files, and datasets that have no remote counterpart. Datasets present locally
 * but absent remotely have their whole directory removed; otherwise each
 * cases.yaml is filtered to rows that still exist remotely (empty files are
 * deleted and now-empty folders cleaned up).
 */
export async function pruneLocalToRemote(
  datasetDir: string,
  remoteDatasetNames: Set<string>,
  remoteRowsByDataset: Map<string, DatasetRow[]>,
): Promise<PruneResult> {
  const result: PruneResult = {
    removedRows: 0,
    deletedFiles: [],
    deletedDatasets: [],
  };
  const caseFiles = await findCaseFiles(datasetDir);
  const groups = groupCaseFilesByDataset(caseFiles, datasetDir);

  for (const [datasetName, files] of groups) {
    if (!remoteDatasetNames.has(datasetName)) {
      for (const file of files) {
        try {
          result.removedRows += (await readCaseRowsFile(file)).length;
        } catch {
          // unreadable file: still removed with the dataset directory
        }
      }
      await rm(path.join(datasetDir, datasetName), {
        recursive: true,
        force: true,
      });
      result.deletedDatasets.push(datasetName);
      continue;
    }

    const keys = buildRemoteRowKeys(remoteRowsByDataset.get(datasetName) ?? []);
    for (const file of files) {
      let rows: CaseRow[];
      try {
        rows = await readCaseRowsFile(file);
      } catch {
        continue;
      }
      const kept = rows.filter((row) => rowExistsRemotely(row, keys));
      const removed = rows.length - kept.length;
      if (removed === 0) {
        continue;
      }
      result.removedRows += removed;
      if (kept.length === 0) {
        await rm(file, { force: true });
        result.deletedFiles.push(file);
        await removeEmptyDirsUpward(path.dirname(file), datasetDir);
      } else {
        await writeCaseRowsFile(file, kept);
      }
    }
  }

  return result;
}

export function collectMetadataPathsFromAggregated(
  datasets: AggregatedDataset[],
): TaxonomyLeafRecord[] {
  const records: TaxonomyLeafRecord[] = [];
  for (const dataset of datasets) {
    for (const row of dataset.rows) {
      const metadata = getCaseMetadata(row as CaseRow);
      if (!metadata) {
        continue;
      }
      records.push({
        dataset: dataset.name,
        path: {
          category: metadata.category,
          subcategory: metadata.subcategory,
          group: metadata.group,
          subgroup: metadata.subgroup,
        },
        name: metadata.name,
        description: metadata.description,
      });
    }
  }
  return records;
}

export function collectMetadataPathsFromFilesystem(
  datasets: AggregatedDataset[],
): TaxonomyLeafRecord[] {
  return collectMetadataPathsFromAggregated(datasets);
}

export function buildTaxonomyFromLocal(
  datasets: AggregatedDataset[],
): TaxonomyRoot[] {
  return taxonomyFromMetadataPaths(
    collectMetadataPathsFromAggregated(datasets),
  );
}

export function findLocalRow(
  datasets: AggregatedDataset[],
  datasetName: string,
  rowId?: string,
): DatasetRow | undefined {
  const dataset = datasets.find((d) => d.name === datasetName);
  if (!dataset) {
    return undefined;
  }
  if (!rowId) {
    return dataset.rows.find((row) => !row.id);
  }
  return dataset.rows.find((row) => row.id === rowId);
}

export function rowMetadataMatchKey(
  dataset: string,
  metadata: CaseMetadata,
): string {
  return rowMatchKey(dataset, metadata);
}

// re-export for tests
export { rowMatchKey };
