import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import {
  SYNC_STATE_FILENAME,
  type DatasetFile,
  type DatasetRow,
  type RemoteDataset,
} from "./datasets-lib.js";
import {
  applyLabelSuffix,
  pathToTagsPrefix,
  rowForBraintrust,
  rowTags,
  suffixFromRow,
  tagsToLocation,
  taxonomyFromTagPaths,
  TAXONOMY_FILENAME,
  type CaseRow,
  type TaxonomyRoot,
} from "./taxonomy-lib.js";

export const META_FILENAME = "_meta.yaml";

export interface AggregatedDataset {
  name: string;
  l1Dir: string;
  metaFile: string;
  rows: DatasetRow[];
  rowSources: Map<string, string>;
}

function isCaseFile(filePath: string, datasetDir: string): boolean {
  const rel = path.relative(datasetDir, filePath);
  const parts = rel.split(path.sep);
  if (parts.length !== 3) {
    return false;
  }
  const base = parts[2]!;
  return (
    base.endsWith(".yaml") &&
    base !== TAXONOMY_FILENAME &&
    base !== META_FILENAME &&
    base !== SYNC_STATE_FILENAME
  );
}

export async function findCaseFiles(datasetDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walkL1(l1Path: string): Promise<void> {
    let l1Entries;
    try {
      l1Entries = await readdir(l1Path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const l1Entry of l1Entries) {
      if (!l1Entry.isDirectory() || l1Entry.name.startsWith(".")) {
        continue;
      }
      const l2Path = path.join(l1Path, l1Entry.name);
      let l2Entries;
      try {
        l2Entries = await readdir(l2Path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const l2Entry of l2Entries) {
        if (!l2Entry.isDirectory()) {
          continue;
        }
        const l3Path = path.join(l2Path, l2Entry.name);
        let l3Entries;
        try {
          l3Entries = await readdir(l3Path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const l3Entry of l3Entries) {
          if (!l3Entry.isFile() || !l3Entry.name.endsWith(".yaml")) {
            continue;
          }
          if (l3Entry.name === META_FILENAME) {
            continue;
          }
          const full = path.join(l3Path, l3Entry.name);
          if (isCaseFile(full, datasetDir)) {
            results.push(full);
          }
        }
      }
    }
  }

  await walkL1(datasetDir);
  return results.sort();
}

export function groupCaseFilesByL1(
  caseFiles: string[],
  datasetDir: string,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const file of caseFiles) {
    const [l1] = pathToTagsPrefix(file, datasetDir);
    const list = groups.get(l1) ?? [];
    list.push(file);
    groups.set(l1, list);
  }
  return groups;
}

/** Parse L3 case YAML: root must be a sequence of rows (JSON/YAML array). Legacy `{ rows: [...] }` is still accepted. */
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
  throw new Error("Case file must be a YAML array of row objects (or legacy { rows: [...] })");
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
  l1Name: string,
  caseFiles: string[],
  datasetDir: string,
): Promise<AggregatedDataset> {
  const rows: DatasetRow[] = [];
  const rowSources = new Map<string, string>();
  const l1Dir = path.join(datasetDir, l1Name);

  for (const file of caseFiles) {
    const prefix = pathToTagsPrefix(file, datasetDir);
    const fileRows = await readCaseRowsFile(file);
    for (const row of fileRows) {
      const btRow = rowForBraintrust(prefix, row);
      rows.push(btRow);
      if (btRow.id) {
        rowSources.set(btRow.id, file);
      }
    }
  }

  return {
    name: l1Name,
    l1Dir,
    metaFile: path.join(l1Dir, META_FILENAME),
    rows,
    rowSources,
  };
}

export async function loadAllLocalDatasets(
  datasetDir: string,
): Promise<AggregatedDataset[]> {
  const caseFiles = await findCaseFiles(datasetDir);
  const groups = groupCaseFilesByL1(caseFiles, datasetDir);
  const datasets: AggregatedDataset[] = [];
  for (const [l1, files] of groups) {
    datasets.push(await loadAggregatedDataset(l1, files, datasetDir));
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
  l1Dir: string,
): Promise<DatasetFile["dataset"] | undefined> {
  try {
    const text = await readFile(path.join(l1Dir, META_FILENAME), "utf8");
    const data = parse(text) as { dataset?: DatasetFile["dataset"] };
    return data.dataset;
  } catch {
    return undefined;
  }
}

export async function writeDatasetMeta(
  l1Dir: string,
  remote: RemoteDataset,
): Promise<void> {
  await mkdir(l1Dir, { recursive: true });
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
    path.join(l1Dir, META_FILENAME),
    yaml.endsWith("\n") ? yaml : `${yaml}\n`,
    "utf8",
  );
}

function rowMatchKey(row: CaseRow): string {
  const tags = row.tags ?? [];
  if (tags.length >= 3) {
    return tags.join("\0");
  }
  return "";
}

export async function writeGroupedRows(
  rows: DatasetRow[],
  datasetDir: string,
): Promise<string[]> {
  const byFile = new Map<string, CaseRow[]>();
  const written: string[] = [];

  for (const row of rows) {
    const tags = row.tags ?? [];
    if (tags.length < 3) {
      continue;
    }
    const { filePath, labelSuffix } = tagsToLocation(tags, datasetDir);
    const localRow = applyLabelSuffix(
      {
        id: row.id,
        input: row.input,
        expected: row.expected,
        metadata: row.metadata,
        origin: row.origin,
      },
      labelSuffix,
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

    const merged = [...existing];
    for (const incoming of fileRows) {
      const incomingKey =
        incoming.id ??
        [...pathToTagsPrefix(filePath, datasetDir), ...suffixFromRow(incoming)].join(
          "\0",
        );
      const idx = merged.findIndex((row) => {
        if (incoming.id && row.id === incoming.id) {
          return true;
        }
        const prefix = pathToTagsPrefix(filePath, datasetDir);
        return rowTags(prefix, row).join("\0") === rowTags(prefix, incoming).join("\0");
      });
      if (idx >= 0) {
        merged[idx] = { ...merged[idx], ...incoming };
      } else {
        merged.push(incoming);
      }
      void incomingKey;
    }

    await writeCaseRowsFile(filePath, merged);
    written.push(filePath);
  }

  return written;
}

export function collectTagPathsFromAggregated(
  datasets: AggregatedDataset[],
): { tags: string[]; summary?: string }[] {
  const paths: { tags: string[]; summary?: string }[] = [];
  for (const dataset of datasets) {
    for (const row of dataset.rows) {
      const tags = row.tags ?? [];
      if (tags.length < 3) {
        continue;
      }
      const summary =
        row.metadata &&
        typeof row.metadata === "object" &&
        "summary" in row.metadata
          ? String((row.metadata as { summary?: string }).summary ?? "")
          : undefined;
      paths.push({ tags, summary });
    }
  }
  return paths;
}

export function collectTagPathsFromFilesystem(
  datasets: AggregatedDataset[],
): { tags: string[]; summary?: string }[] {
  return collectTagPathsFromAggregated(datasets);
}

export function buildTaxonomyFromLocal(
  datasets: AggregatedDataset[],
): TaxonomyRoot[] {
  return taxonomyFromTagPaths(collectTagPathsFromAggregated(datasets));
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

// re-export for tests
export { rowMatchKey };
