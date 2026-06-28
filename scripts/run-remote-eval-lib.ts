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
  isCasesFile,
} from "./datasets-layout.js";
import {
  enrichRowMetadata,
  getCaseMetadata,
  rowForBraintrust,
  taxonomyPathFromCasesFile,
  type CaseRow,
} from "./taxonomy-lib.js";

/** Same rules as `findCaseFiles` in datasets-layout: cases.yaml under a dataset folder. */
export function isCasesFileForGlob(
  filePath: string,
  datasetDir: string,
): boolean {
  return isCasesFile(filePath, datasetDir);
}

/** @deprecated Use `isCasesFileForGlob`. */
export const isL3CaseFile = isCasesFileForGlob;

/**
 * Expand glob patterns (relative to `cwd`), keep only cases.yaml files under `datasetDir`.
 *
 * Patterns prefixed with `!` are negations: any file matched by a `!pattern`
 * (with the `!` stripped) is excluded from the result, regardless of how many
 * positive patterns matched it. At least one non-negated pattern is required.
 */
export async function resolveCaseFilesFromGlobs(
  patterns: string[],
  datasetDir: string,
  cwd: string,
): Promise<string[]> {
  if (patterns.length === 0) {
    throw new Error("At least one glob pattern is required");
  }

  const positives: string[] = [];
  const negatives: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const stripped = pattern.slice(1);
      if (stripped.length > 0) {
        negatives.push(stripped);
      }
    } else {
      positives.push(pattern);
    }
  }

  if (positives.length === 0) {
    throw new Error(
      "At least one non-negated glob pattern is required (patterns starting with '!' only exclude)",
    );
  }

  const absDatasetDir = path.resolve(cwd, datasetDir);

  const excluded = new Set<string>();
  for (const pattern of negatives) {
    for await (const entry of glob(pattern, { cwd })) {
      excluded.add(path.normalize(path.resolve(cwd, entry)));
    }
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const pattern of positives) {
    const iter = glob(pattern, { cwd });
    for await (const entry of iter) {
      const abs = path.resolve(cwd, entry);
      if (!isCasesFile(abs, absDatasetDir)) {
        continue;
      }
      const key = path.normalize(abs);
      if (excluded.has(key) || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(abs);
    }
  }

  if (out.length === 0) {
    throw new Error(
      `No cases.yaml files matched patterns under ${absDatasetDir}: ${patterns.join(", ")}`,
    );
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

export interface LoadedCaseRows {
  rows: DatasetRow[];
  sources: CaseFileLoadSource[];
}

export interface MetadataRegexFilter {
  key: string;
  regex: RegExp;
}

export interface LoadRowsOptions {
  /** When set, only rows whose `metadata[key]` matches this regex are included. */
  metadataRegex?: MetadataRegexFilter;
  /** When set and non-empty, only rows whose `id` is in this set are included. */
  rowIds?: ReadonlySet<string>;
}

export function rowMatchesIdFilter(
  row: CaseRow,
  rowIds: ReadonlySet<string>,
): boolean {
  return typeof row.id === "string" && rowIds.has(row.id);
}

export function rowMetadataText(row: CaseRow, key: string): string {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object") {
    return "";
  }
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function rowMatchesMetadataRegex(
  row: CaseRow,
  filter: MetadataRegexFilter,
): boolean {
  return filter.regex.test(rowMetadataText(row, filter.key));
}

/** Parse a `key=<regex>` spec into a metadata key and compiled RegExp. */
export function compileMetadataRegex(spec: string): MetadataRegexFilter {
  const sep = spec.indexOf("=");
  const key = sep >= 0 ? spec.slice(0, sep).trim() : "";
  if (sep < 0 || !key) {
    throw new Error(
      `--metadata-regex must be in the form key=<regex>, got: ${spec}`,
    );
  }
  const pattern = spec.slice(sep + 1);
  try {
    return { key, regex: new RegExp(pattern) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Invalid metadata regex /${pattern}/ for key '${key}': ${msg}`,
    );
  }
}

/**
 * Parse a `--concurrency` value into a positive integer.
 * Throws on non-numeric, non-integer, or values < 1.
 */
export function parseConcurrency(value: string): number {
  const trimmed = value.trim();
  const n = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    throw new Error(
      `--concurrency must be a positive integer, got: ${value}`,
    );
  }
  return n;
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
  namesPreview: string[];
}

export async function loadRowsFromCaseFilesDetailed(
  files: string[],
  datasetDir: string,
  options?: LoadRowsOptions,
): Promise<LoadedCaseRows> {
  const absDatasetDir = path.resolve(datasetDir);
  const metadataRegex = options?.metadataRegex;
  const rowIdFilter =
    options?.rowIds && options.rowIds.size > 0 ? options.rowIds : undefined;
  const rows: DatasetRow[] = [];
  const sources: CaseFileLoadSource[] = [];
  for (const file of files) {
    const { path: taxonomyPath } = taxonomyPathFromCasesFile(
      file,
      absDatasetDir,
    );
    const fileRows = await readCaseRowsFile(file);
    const rowIds: string[] = [];
    const namesPreview: string[] = [];
    let rowCount = 0;
    for (const row of fileRows) {
      const enriched = enrichRowMetadata(row, taxonomyPath);
      if (metadataRegex && !rowMatchesMetadataRegex(enriched, metadataRegex)) {
        continue;
      }
      if (rowIdFilter && !rowMatchesIdFilter(enriched, rowIdFilter)) {
        continue;
      }
      const btRow = rowForBraintrust(enriched);
      rows.push(btRow);
      rowCount += 1;
      if (btRow.id) {
        rowIds.push(btRow.id);
      }
      const meta = getCaseMetadata(enriched);
      if (meta?.name) {
        namesPreview.push(meta.name);
      }
    }
    if (rowCount > 0) {
      sources.push({
        file,
        rowCount,
        rowIds,
        namesPreview,
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
  const datasetNames = new Set<string>();
  for (const f of files) {
    const rel = path.relative(absDatasetDir, f);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      continue;
    }
    const dataset = rel.split(path.sep)[0];
    if (dataset) {
      datasetNames.add(dataset);
    }
  }

  const projectIds = new Set<string>();
  for (const datasetName of datasetNames) {
    const meta = await readDatasetMeta(path.join(absDatasetDir, datasetName));
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
  max_concurrency?: number;
}

export function buildRemoteEvalRequest(opts: {
  evalName: string;
  rows: DatasetRow[];
  parameters: Record<string, unknown>;
  experimentName: string;
  projectId?: string;
  stream?: boolean;
  maxConcurrency?: number;
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
  if (opts.maxConcurrency !== undefined) {
    body.max_concurrency = opts.maxConcurrency;
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
