#!/usr/bin/env tsx
/**
 * Run Braintrust remote eval against `bt eval --dev` (default http://localhost:8300).
 * Resolves cases.yaml via globs, merges rows, POSTs /eval with inline data.
 */

import { login, type BraintrustState } from "braintrust";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  buildExperimentUrl,
  buildRemoteEvalRequest,
  consumeRemoteEvalSse,
  defaultExperimentName,
  dumpExperimentTraces,
  formatScoreLine,
  inferProjectIdFromMeta,
  loadRowsFromCaseFilesDetailed,
  mergeEvalParameters,
  parameterKeysForLog,
  postEvalHttp,
  compileMetadataRegex,
  resolveCaseFilesFromGlobs,
  type MetadataRegexFilter,
  type RemoteEvalStartMetadata,
  type RemoteEvalSummary,
} from "./run-remote-eval-lib.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const DEFAULT_REMOTE = "http://localhost:8300";
const DEFAULT_EVAL_NAME = "mongodb-mcp-server-evals";
const DEFAULT_DATASET_DIR = "dataset";

const log = (msg: string) => console.log(`[eval:remote] ${msg}`);

interface ParsedCli {
  remote: string;
  evalName: string;
  datasetDir: string;
  experimentName: string;
  projectId?: string;
  outputDir: string;
  skipTraces: boolean;
  dryRun: boolean;
  paramsJson?: string;
  metadataRegex?: string;
  globs: string[];
}

function die(msg: string): never {
  console.error(`[eval:remote] error: ${msg}`);
  process.exit(1);
}

function parseCli(argv: string[]): ParsedCli {
  const out: ParsedCli = {
    remote: process.env.EVAL_REMOTE_URL?.trim() || DEFAULT_REMOTE,
    evalName: DEFAULT_EVAL_NAME,
    datasetDir: DEFAULT_DATASET_DIR,
    experimentName: defaultExperimentName(),
    outputDir: "output",
    skipTraces: false,
    dryRun: false,
    globs: [],
  };

  let i = 0;
  let afterSep = false;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      afterSep = true;
      i++;
      continue;
    }
    if (!afterSep && a === "--dry-run") {
      out.dryRun = true;
      i++;
      continue;
    }
    if (!afterSep && a === "--remote") {
      out.remote = argv[++i] ?? die("--remote requires a URL");
      i++;
      continue;
    }
    if (!afterSep && a === "--eval") {
      out.evalName = argv[++i] ?? die("--eval requires a name");
      i++;
      continue;
    }
    if (!afterSep && a === "--dataset-dir") {
      out.datasetDir = argv[++i] ?? die("--dataset-dir requires a path");
      i++;
      continue;
    }
    if (!afterSep && a === "--experiment") {
      out.experimentName = argv[++i] ?? die("--experiment requires a name");
      i++;
      continue;
    }
    if (!afterSep && a === "--project-id") {
      out.projectId = argv[++i] ?? die("--project-id requires an id");
      i++;
      continue;
    }
    if (!afterSep && a === "--output-dir") {
      out.outputDir = argv[++i] ?? die("--output-dir requires a path");
      i++;
      continue;
    }
    if (!afterSep && a === "--skip-traces") {
      out.skipTraces = true;
      i++;
      continue;
    }
    if (!afterSep && a === "--params") {
      out.paramsJson = argv[++i] ?? die("--params requires a JSON string");
      i++;
      continue;
    }
    if (!afterSep && a === "--metadata-regex") {
      out.metadataRegex =
        argv[++i] ?? die("--metadata-regex requires key=<regex>");
      i++;
      continue;
    }
    if (!afterSep && a.startsWith("--")) {
      die(`Unknown flag: ${a}`);
    }
    out.globs.push(a);
    i++;
  }

  return out;
}

function requireApiKey(): void {
  if (!process.env.BRAINTRUST_API_KEY?.trim()) {
    die("BRAINTRUST_API_KEY is required (except with --dry-run)");
  }
}

function shutdownBraintrust(state: BraintrustState | undefined): void {
  try {
    state?.disable();
  } catch {
    // Best-effort; CLI should still exit.
  }
}

async function main(): Promise<void> {
  let braintrustState: BraintrustState | undefined;
  try {
  const argv = process.argv.slice(2);
  const cli = parseCli(argv);

  if (cli.globs.length === 0) {
    die(
      "Usage: pnpm eval:remote [flags] [glob...]\n" +
        "       pnpm eval:remote [flags] -- <glob> [glob...]\n" +
        "Flags: --remote URL --eval NAME --dataset-dir DIR --experiment NAME --project-id ID --params JSON --metadata-regex key=<regex> --output-dir DIR --skip-traces --dry-run",
    );
  }

  log(`Remote dev server: ${cli.remote}`);
  log(`Evaluator: ${cli.evalName}`);
  log(`Experiment name: ${cli.experimentName}`);
  log(`Glob patterns (${cli.globs.length}): ${cli.globs.join(", ")}`);

  const absDatasetDir = path.resolve(REPO_ROOT, cli.datasetDir);
  const files = await resolveCaseFilesFromGlobs(
    cli.globs,
    cli.datasetDir,
    REPO_ROOT,
  );

  const metadataSpec =
    cli.metadataRegex?.trim() ||
    process.env.METADATA_REGEX?.trim() ||
    undefined;
  let metadataRegex: MetadataRegexFilter | undefined;
  if (metadataSpec) {
    try {
      metadataRegex = compileMetadataRegex(metadataSpec);
    } catch (e) {
      die(e instanceof Error ? e.message : String(e));
    }
    log(`Metadata regex: ${metadataRegex.key}=/${metadataRegex.regex.source}/`);
  }

  const { rows, sources } = await loadRowsFromCaseFilesDetailed(
    files,
    absDatasetDir,
    { metadataRegex },
  );

  if (rows.length === 0) {
    die(
      metadataRegex
        ? "No rows matched the file glob(s) and --metadata-regex filter"
        : "No rows loaded from matched case files",
    );
  }

  let projectId = cli.projectId;
  if (!projectId) {
    projectId = await inferProjectIdFromMeta(files, absDatasetDir);
  }

  const parameters = mergeEvalParameters(
    process.env.BT_EVAL_PARAMS_JSON,
    cli.paramsJson,
  );

  log(`Matched ${files.length} case file(s), ${rows.length} row(s):`);
  for (const src of sources) {
    const rel = path.relative(REPO_ROOT, src.file);
    const idPart =
      src.rowIds.length > 0 ? ` ids=${src.rowIds.join(", ")}` : "";
    const tagPart =
      src.namesPreview.length > 0
        ? ` names="${src.namesPreview.join('" | "')}"`
        : "";
    log(`  ${rel} (${src.rowCount} row${src.rowCount === 1 ? "" : "s"})${idPart}${tagPart}`);
  }
  if (projectId) {
    log(`project_id: ${projectId}`);
  }
  const paramKeys = parameterKeysForLog(parameters);
  if (paramKeys.length > 0) {
    log(`Parameters: ${paramKeys.join(", ")}`);
  } else {
    log("Parameters: (defaults on dev server)");
  }

  if (cli.dryRun) {
    log("dry-run — skipping HTTP");
    return;
  }

  requireApiKey();

  log("Authenticating with Braintrust…");
  braintrustState = await login({
    apiKey: process.env.BRAINTRUST_API_KEY,
    appUrl: process.env.BRAINTRUST_APP_URL,
  });
  const orgName = braintrustState.orgName;
  const token = process.env.BRAINTRUST_API_KEY!.trim();
  if (!orgName) {
    die("Braintrust login did not return orgName");
  }
  log(`Org: ${orgName}`);

  const base = cli.remote.replace(/\/$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "x-bt-auth-token": token,
    "x-bt-org-name": orgName,
  };

  log(`Probing dev server GET ${base}/list …`);
  const listRes = await fetch(`${base}/list`, { headers });
  if (!listRes.ok) {
    const t = await listRes.text();
    die(
      `GET /list failed (${listRes.status}). Is \`pnpm eval:serve\` running in mongodb-mcp-server? ${t}`,
    );
  }
  const listJson = (await listRes.json()) as Record<string, unknown>;
  const evaluators = Object.keys(listJson);
  if (!(cli.evalName in listJson)) {
    die(
      `Evaluator '${cli.evalName}' not found. Available: ${evaluators.join(", ") || "(none)"}`,
    );
  }
  log(`Dev server OK — evaluator '${cli.evalName}' registered`);

  const body = buildRemoteEvalRequest({
    evalName: cli.evalName,
    rows,
    parameters,
    experimentName: cli.experimentName,
    projectId,
    stream: true,
  });

  const totalRows = rows.length;
  if (braintrustState.appPublicUrl && orgName) {
    const expectedUrl = buildExperimentUrl({
      appPublicUrl: braintrustState.appPublicUrl,
      orgName,
      projectName: cli.evalName,
      experimentName: cli.experimentName,
    });
    log(`Expected results: ${expectedUrl}`);
  }

  log(
    `POST ${base}/eval — running ${totalRows} case${totalRows === 1 ? "" : "s"} (streaming)…`,
  );

  const evalRes = await postEvalHttp(
    `${base}/eval`,
    headers,
    JSON.stringify(body),
  );

  if (!evalRes.ok) {
    const errBody = await new Response(evalRes.body).text();
    die(`POST /eval failed (${evalRes.status}): ${errBody.slice(0, 1000)}`);
  }

  const contentType = evalRes.contentType ?? "";
  let summary: RemoteEvalSummary | undefined;
  let startMeta: RemoteEvalStartMetadata | undefined;

  if (contentType.includes("text/event-stream")) {
    let linkPrinted = false;
    let waitingInterval: ReturnType<typeof setInterval> | undefined;
    const streamResult = await consumeRemoteEvalSse(evalRes.body, {
      onStart: (meta) => {
        startMeta = meta;
        log("Experiment created — results will stream live:");
        if (meta.experimentUrl) {
          log(`View results: ${meta.experimentUrl}`);
          linkPrinted = true;
        } else if (meta.projectUrl && meta.experimentName) {
          const url = `${meta.projectUrl}/experiments/${encodeURIComponent(meta.experimentName)}`;
          log(`View results: ${url}`);
          linkPrinted = true;
        }
        if (meta.experimentName) {
          log(`Experiment: ${meta.experimentName}`);
        }
        if (meta.experimentId) {
          log(`experiment_id: ${meta.experimentId}`);
        }
      },
      onProgress: (n) => {
        log(`Progress: ${n}/${totalRows} case${totalRows === 1 ? "" : "s"}`);
        if (n >= totalRows && !waitingInterval) {
          log(
            "Task stream complete — server is judging/scoring (no SSE until summary)…",
          );
          waitingInterval = setInterval(() => {
            log("Still waiting for experiment summary from dev server…");
          }, 30_000);
        }
      },
    });
    if (waitingInterval) {
      clearInterval(waitingInterval);
    }

    if (streamResult.error) {
      die(`Eval failed: ${JSON.stringify(streamResult.error)}`);
    }

    summary = streamResult.summary;
    if (!linkPrinted && summary?.experimentUrl) {
      log(`View results: ${summary.experimentUrl}`);
    }

    log(`Finished — ${streamResult.progressCount} progress event(s)`);
  } else {
    const text = await new Response(evalRes.body).text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      die(`POST /eval: non-JSON response: ${text.slice(0, 500)}`);
    }
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      die(`Eval error: ${JSON.stringify((parsed as { error: unknown }).error)}`);
    }
    summary = parsed as typeof summary;
    if (summary?.experimentUrl) {
      log(`View results: ${summary.experimentUrl}`);
    }
    log("Finished (non-streaming response)");
  }

  if (summary) {
    console.log(JSON.stringify(summary, null, 2));
    const scoreLine = formatScoreLine(summary.scores);
    if (scoreLine) {
      log(`Scores: ${scoreLine}`);
    }
  }

  if (!cli.skipTraces) {
    const experimentName =
      startMeta?.experimentName ??
      summary?.experimentName ??
      cli.experimentName;
    const experimentProjectId = startMeta?.projectId ?? projectId;
    const experimentProjectName =
      startMeta?.projectName ?? cli.evalName;
    const absOutputDir = path.resolve(REPO_ROOT, cli.outputDir);

    log(
      `Fetching full traces for experiment "${experimentName}" (${totalRows} row${totalRows === 1 ? "" : "s"})…`,
    );
    try {
      const dumpResult = await dumpExperimentTraces({
        state: braintrustState!,
        experimentName,
        projectId: experimentProjectId,
        projectName: experimentProjectName,
        experimentId: startMeta?.experimentId,
        expectedRowCount: totalRows,
        outputDir: absOutputDir,
      });
      log(
        `Wrote ${dumpResult.traceCount} trace file(s) to ${path.relative(REPO_ROOT, dumpResult.outputDir)}/`,
      );
      log(`Manifest: ${path.relative(REPO_ROOT, dumpResult.manifestPath)}`);
      if (dumpResult.traceCount < totalRows) {
        log(
          `Warning: expected ${totalRows} trace(s) but fetched ${dumpResult.traceCount}`,
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`Failed to dump traces: ${msg}`);
    }
  }
  } finally {
    shutdownBraintrust(braintrustState);
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error("[eval:remote] fatal:", e);
    process.exit(1);
  });
