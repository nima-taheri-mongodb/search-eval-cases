import { initExperiment, type BraintrustState } from "braintrust";
import { glob, mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import path from "node:path";
import { SYNC_STATE_FILENAME } from "./datasets-lib.js";
import type { DatasetRow } from "./datasets-lib.js";
import {
  META_FILENAME,
  readCaseRowsFile,
  readDatasetMeta,
} from "./datasets-layout.js";
import {
  pathToTagsPrefix,
  rowForBraintrust,
  suffixFromRow,
  TAXONOMY_FILENAME,
  type CaseRow,
} from "./taxonomy-lib.js";

/** Same rules as `findCaseFiles` in datasets-layout: L1/L2/L3.yaml under dataset root. */
export function isL3CaseFile(filePath: string, datasetDir: string): boolean {
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

/**
 * Expand glob patterns (relative to `cwd`), keep only L3 case files under `datasetDir`.
 */
export async function resolveCaseFilesFromGlobs(
  patterns: string[],
  datasetDir: string,
  cwd: string,
): Promise<string[]> {
  if (patterns.length === 0) {
    throw new Error("At least one glob pattern is required");
  }
  const absDatasetDir = path.resolve(cwd, datasetDir);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const pattern of patterns) {
    const iter = glob(pattern, { cwd });
    for await (const entry of iter) {
      const abs = path.resolve(cwd, entry);
      if (!isL3CaseFile(abs, absDatasetDir)) {
        continue;
      }
      const key = path.normalize(abs);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(abs);
    }
  }

  if (out.length === 0) {
    throw new Error(
      `No L3 case files matched patterns under ${absDatasetDir}: ${patterns.join(", ")}`,
    );
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export interface LoadedCaseRows {
  rows: DatasetRow[];
  sources: CaseFileLoadSource[];
}

export interface LoadRowsOptions {
  /** When set, only rows whose `label` / `labels` match this regex are included. */
  labelRegex?: RegExp;
}

/** Case label string used for `--label-regex` filtering (joins `labels` with ` > `). */
export function rowLabelText(row: CaseRow): string {
  const suffix = suffixFromRow(row);
  return suffix.join(" > ");
}

export function rowMatchesLabelRegex(row: CaseRow, labelRegex: RegExp): boolean {
  return labelRegex.test(rowLabelText(row));
}

export function compileLabelRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Invalid label regex /${pattern}/: ${msg}`);
  }
}

export async function loadRowsFromCaseFiles(
  files: string[],
  datasetDir: string,
  options?: LoadRowsOptions,
): Promise<DatasetRow[]> {
  const loaded = await loadRowsFromCaseFilesDetailed(files, datasetDir, options);
  return loaded.rows;
}

export interface CaseFileLoadSource {
  file: string;
  rowCount: number;
  rowIds: string[];
  tagsPreview: string[];
}

export async function loadRowsFromCaseFilesDetailed(
  files: string[],
  datasetDir: string,
  options?: LoadRowsOptions,
): Promise<LoadedCaseRows> {
  const absDatasetDir = path.resolve(datasetDir);
  const labelRegex = options?.labelRegex;
  const rows: DatasetRow[] = [];
  const sources: CaseFileLoadSource[] = [];
  for (const file of files) {
    const prefix = pathToTagsPrefix(file, absDatasetDir);
    const fileRows = await readCaseRowsFile(file);
    const rowIds: string[] = [];
    const tagsPreview: string[] = [];
    let rowCount = 0;
    for (const row of fileRows) {
      if (labelRegex && !rowMatchesLabelRegex(row, labelRegex)) {
        continue;
      }
      const btRow = rowForBraintrust(prefix, row);
      rows.push(btRow);
      rowCount += 1;
      if (btRow.id) {
        rowIds.push(btRow.id);
      }
      if (btRow.tags?.length) {
        tagsPreview.push(btRow.tags.join(" > "));
      }
    }
    if (rowCount > 0) {
      sources.push({
        file,
        rowCount,
        rowIds,
        tagsPreview,
      });
    }
  }
  return { rows, sources };
}

/**
 * When all matched files share one L1, use that bucket's `_meta.yaml` project_id.
 * If multiple L1 buckets disagree on project_id, throw.
 */
export async function inferProjectIdFromMeta(
  files: string[],
  datasetDir: string,
): Promise<string | undefined> {
  const absDatasetDir = path.resolve(datasetDir);
  const l1Names = new Set<string>();
  for (const f of files) {
    const rel = path.relative(absDatasetDir, f);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    const l1 = rel.split(path.sep)[0];
    if (l1) {
      l1Names.add(l1);
    }
  }

  const projectIds = new Set<string>();
  for (const l1 of l1Names) {
    const meta = await readDatasetMeta(path.join(absDatasetDir, l1));
    const pid = meta?.project_id;
    if (typeof pid === "string" && pid.trim()) {
      projectIds.add(pid.trim());
    }
  }

  if (projectIds.size === 0) {
    return undefined;
  }
  if (projectIds.size > 1) {
    throw new Error(
      `Multiple project_id values in _meta.yaml across L1 buckets: ${[...projectIds].join(", ")}`,
    );
  }
  return [...projectIds][0];
}

export function buildExperimentUrl(opts: {
  appPublicUrl: string;
  orgName: string;
  projectName: string;
  experimentName: string;
}): string {
  return `${opts.appPublicUrl}/app/${encodeURIComponent(opts.orgName)}/p/${encodeURIComponent(opts.projectName)}/experiments/${encodeURIComponent(opts.experimentName)}`;
}

/**
 * POST without undici body timeout — Node fetch aborts idle SSE streams while the
 * dev server runs judge/scoring with no events.
 */
export function postEvalHttp(
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<{
  ok: boolean;
  status: number;
  contentType: string | null;
  body: ReadableStream<Uint8Array>;
}> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        headers: {
          ...headers,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const status = res.statusCode ?? 500;
        const ok = status >= 200 && status < 300;
        const rawType = res.headers["content-type"];
        const contentType = Array.isArray(rawType) ? rawType[0] : rawType ?? null;
        resolve({
          ok,
          status,
          contentType,
          body: Readable.toWeb(res) as ReadableStream<Uint8Array>,
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

export interface RemoteEvalRequestBody {
  name: string;
  data: { data: unknown[] };
  parameters?: Record<string, unknown>;
  experiment_name?: string;
  project_id?: string;
  stream?: boolean;
}

export function buildRemoteEvalRequest(opts: {
  evalName: string;
  rows: DatasetRow[];
  parameters: Record<string, unknown>;
  experimentName: string;
  projectId?: string;
  stream?: boolean;
}): RemoteEvalRequestBody {
  const body: RemoteEvalRequestBody = {
    name: opts.evalName,
    data: { data: opts.rows as unknown[] },
    parameters: opts.parameters,
    experiment_name: opts.experimentName,
    stream: opts.stream ?? true,
  };
  if (opts.projectId) {
    body.project_id = opts.projectId;
  }
  return body;
}

export interface RemoteEvalStartMetadata {
  experimentUrl?: string;
  experimentName?: string;
  projectName?: string;
  projectUrl?: string;
  experimentId?: string;
  projectId?: string;
}

export interface RemoteEvalSummary {
  scores?: Record<string, { score?: number | null }>;
  experimentUrl?: string;
  experimentName?: string;
  metrics?: Record<string, unknown>;
}

export interface RemoteEvalStreamResult {
  start?: RemoteEvalStartMetadata;
  summary?: RemoteEvalSummary;
  error?: unknown;
  progressCount: number;
}

export type RemoteEvalStreamHandlers = {
  onStart?: (meta: RemoteEvalStartMetadata) => void;
  onProgress?: (progressIndex: number) => void;
};

/** Parse SSE blocks from Braintrust remote eval (`event:` / `data:` lines). */
export function parseSseEvents(
  buffer: string,
): { events: Array<{ event?: string; data: string }>; rest: string } {
  const events: Array<{ event?: string; data: string }> = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    if (!part.trim()) {
      continue;
    }
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    events.push({ event, data: dataLines.join("\n") });
  }
  return { events, rest };
}

function parseJsonData<T>(data: string): T | undefined {
  if (!data.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

export async function consumeRemoteEvalSse(
  stream: ReadableStream<Uint8Array>,
  handlers?: RemoteEvalStreamHandlers,
): Promise<RemoteEvalStreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const result: RemoteEvalStreamResult = { progressCount: 0 };
  let stop = false;

  const handleEvent = (event: string | undefined, data: string): void => {
    if (event === "start") {
      const meta = parseJsonData<RemoteEvalStartMetadata>(data);
      if (meta) {
        result.start = meta;
        handlers?.onStart?.(meta);
      }
      return;
    }
    if (event === "progress") {
      result.progressCount += 1;
      handlers?.onProgress?.(result.progressCount);
      return;
    }
    if (event === "summary") {
      result.summary = parseJsonData<RemoteEvalSummary>(data);
      stop = true;
      return;
    }
    if (event === "error") {
      result.error = parseJsonData<unknown>(data) ?? data;
      stop = true;
      return;
    }
    if (event === "done") {
      stop = true;
    }
  };

  const drainEvents = (chunk: string): void => {
    buffer += chunk;
    const parsed = parseSseEvents(buffer);
    buffer = parsed.rest;
    for (const { event, data } of parsed.events) {
      handleEvent(event, data);
      if (stop) {
        break;
      }
    }
  };

  try {
    while (!stop) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      drainEvents(decoder.decode(value, { stream: true }));
    }
    if (!stop && buffer.trim()) {
      drainEvents(`${buffer}\n\n`);
      buffer = "";
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream may already be closed.
    }
    reader.releaseLock();
  }

  return result;
}

export function formatScoreLine(
  scores: Record<string, { score?: number | null }> | undefined,
): string | undefined {
  if (!scores || typeof scores !== "object") {
    return undefined;
  }
  const parts = Object.entries(scores).map(
    ([name, s]) => `${name}=${((s?.score ?? 0) * 100).toFixed(2)}%`,
  );
  return parts.length ? parts.join(" ") : undefined;
}

export function parameterKeysForLog(
  parameters: Record<string, unknown>,
): string[] {
  return Object.keys(parameters).sort();
}

export function mergeEvalParameters(
  envJson: string | undefined,
  cliJson: string | undefined,
): Record<string, unknown> {
  let fromEnv: Record<string, unknown> = {};
  if (envJson?.trim()) {
    try {
      fromEnv = JSON.parse(envJson) as Record<string, unknown>;
    } catch {
      throw new Error("BT_EVAL_PARAMS_JSON is not valid JSON");
    }
  }
  let fromCli: Record<string, unknown> = {};
  if (cliJson?.trim()) {
    try {
      fromCli = JSON.parse(cliJson) as Record<string, unknown>;
    } catch {
      throw new Error("--params value is not valid JSON");
    }
  }
  return { ...fromEnv, ...fromCli };
}

export function defaultExperimentName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `remote-eval_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export function sanitizePathSegment(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "unnamed";
  }
  return trimmed
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 120);
}

export type ExperimentRecord = Record<string, unknown>;

export function isRootSpan(record: ExperimentRecord): boolean {
  const rootSpanId = record.root_span_id;
  const spanId = record.span_id;
  return (
    typeof rootSpanId === "string" &&
    typeof spanId === "string" &&
    rootSpanId === spanId
  );
}

/** Group all experiment BTQL rows by trace (`root_span_id`). */
export function groupRecordsByTrace(
  records: ExperimentRecord[],
): Map<string, ExperimentRecord[]> {
  const groups = new Map<string, ExperimentRecord[]>();
  for (const record of records) {
    const rootId = record.root_span_id;
    if (typeof rootId !== "string" || !rootId) {
      continue;
    }
    const list = groups.get(rootId) ?? [];
    list.push(record);
    groups.set(rootId, list);
  }
  return groups;
}

export interface ExperimentTraceDump {
  rowId?: string;
  tags?: string[];
  rootSpanId: string;
  root: ExperimentRecord;
  spans: ExperimentRecord[];
}

export function buildTraceDump(
  rootSpanId: string,
  spans: ExperimentRecord[],
): ExperimentTraceDump | undefined {
  const root = spans.find(isRootSpan);
  if (!root) {
    return undefined;
  }
  const rowId = typeof root.id === "string" ? root.id : undefined;
  const tags = Array.isArray(root.tags)
    ? root.tags.filter((t): t is string => typeof t === "string")
    : undefined;
  const sortedSpans = [...spans].sort((a, b) => {
    const aKey = String(a._pagination_key ?? a.span_id ?? "");
    const bKey = String(b._pagination_key ?? b.span_id ?? "");
    return aKey.localeCompare(bKey);
  });
  return {
    rowId,
    tags,
    rootSpanId,
    root,
    spans: sortedSpans,
  };
}

export function traceOutputFilename(
  dump: ExperimentTraceDump,
  index: number,
): string {
  if (dump.rowId) {
    return `${sanitizePathSegment(dump.rowId)}.json`;
  }
  const tagSlug =
    dump.tags?.length ? sanitizePathSegment(dump.tags.join("__")) : undefined;
  if (tagSlug) {
    return `${String(index).padStart(3, "0")}_${tagSlug}.json`;
  }
  return `row-${String(index).padStart(3, "0")}.json`;
}

export interface FetchExperimentTracesOpts {
  state: BraintrustState;
  experimentName: string;
  projectId?: string;
  projectName?: string;
  expectedRowCount?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
}

export async function fetchExperimentRecords(
  opts: FetchExperimentTracesOpts,
): Promise<ExperimentRecord[]> {
  if (!opts.projectId && !opts.projectName) {
    throw new Error(
      "fetchExperimentRecords requires projectId or projectName",
    );
  }
  const experiment = initExperiment({
    ...(opts.projectId
      ? { projectId: opts.projectId }
      : { project: opts.projectName }),
    experiment: opts.experimentName,
    open: true,
    state: opts.state,
    setCurrent: false,
  });
  const records: ExperimentRecord[] = [];
  for await (const record of experiment.fetch()) {
    records.push(record as ExperimentRecord);
  }
  return records;
}

export async function fetchExperimentTraces(
  opts: FetchExperimentTracesOpts,
): Promise<ExperimentTraceDump[]> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const retryDelayMs = opts.retryDelayMs ?? 2_000;
  let records: ExperimentRecord[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    records = await fetchExperimentRecords(opts);
    const rootCount = records.filter(isRootSpan).length;
    const expected = opts.expectedRowCount ?? 0;
    if (expected === 0 || rootCount >= expected || attempt === maxAttempts) {
      break;
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }

  const groups = groupRecordsByTrace(records);
  const dumps: ExperimentTraceDump[] = [];
  for (const [rootSpanId, spans] of groups) {
    const dump = buildTraceDump(rootSpanId, spans);
    if (dump) {
      dumps.push(dump);
    }
  }
  dumps.sort((a, b) => {
    const aId = a.rowId ?? a.rootSpanId;
    const bId = b.rowId ?? b.rootSpanId;
    return aId.localeCompare(bId);
  });
  return dumps;
}

export interface DumpExperimentTracesOpts extends FetchExperimentTracesOpts {
  outputDir: string;
  experimentId?: string;
}

export interface DumpExperimentTracesResult {
  outputDir: string;
  manifestPath: string;
  traceFiles: string[];
  traceCount: number;
}

export async function dumpExperimentTraces(
  opts: DumpExperimentTracesOpts,
): Promise<DumpExperimentTracesResult> {
  const traces = await fetchExperimentTraces(opts);
  const experimentDir = path.join(
    opts.outputDir,
    sanitizePathSegment(opts.experimentName),
  );
  await mkdir(experimentDir, { recursive: true });

  const traceFiles: string[] = [];
  const manifestRows: Array<{
    file: string;
    rowId?: string;
    tags?: string[];
    rootSpanId: string;
  }> = [];

  for (let i = 0; i < traces.length; i++) {
    const dump = traces[i]!;
    const filename = traceOutputFilename(dump, i);
    const filePath = path.join(experimentDir, filename);
    await writeFile(filePath, `${JSON.stringify(dump, null, 2)}\n`, "utf8");
    traceFiles.push(filePath);
    manifestRows.push({
      file: filename,
      rowId: dump.rowId,
      tags: dump.tags,
      rootSpanId: dump.rootSpanId,
    });
  }

  const manifestPath = path.join(experimentDir, "_manifest.json");
  const manifest = {
    experimentName: opts.experimentName,
    experimentId: opts.experimentId,
    projectId: opts.projectId,
    projectName: opts.projectName,
    traceCount: traces.length,
    dumpedAt: new Date().toISOString(),
    traces: manifestRows,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    outputDir: experimentDir,
    manifestPath,
    traceFiles,
    traceCount: traces.length,
  };
}
