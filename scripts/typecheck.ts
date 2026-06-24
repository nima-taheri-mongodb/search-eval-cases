#!/usr/bin/env tsx
/**
 * Validate local dataset YAML files against JSON Schema (same mapping as .vscode/settings.json).
 */

import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { parse } from "yaml";

const registerFormats = formatsModule as unknown as (ajv: Ajv2020) => void;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const SCHEMAS_DIR = path.join(REPO_ROOT, "schemas");

/** Mirrors `.vscode/settings.json` `yaml.schemas` globs (repo-relative, forward slashes). */
export const YAML_SCHEMA_RULES = [
  {
    glob: "dataset/**/cases.yaml",
    schemaFile: "case-file.schema.json",
    schemaId: "https://mongodb-eval-cases/schemas/case-file.schema.json",
  },
  {
    glob: "dataset/*/_meta.yaml",
    schemaFile: "dataset-meta.schema.json",
    schemaId: "https://mongodb-eval-cases/schemas/dataset-meta.schema.json",
  },
] as const;

const SCHEMA_LOAD_ORDER = [
  "input.schema.json",
  "expected.schema.json",
  "dataset-meta.schema.json",
  "case-file.schema.json",
] as const;

export interface YamlSchemaRule {
  glob: string;
  schemaFile: string;
  schemaId: string;
}

export interface YamlValidationIssue {
  file: string;
  message: string;
  instancePath?: string;
}

export interface YamlValidationResult {
  file: string;
  schemaId?: string;
  ok: boolean;
  skipped: boolean;
  skipReason?: string;
  issues: YamlValidationIssue[];
}

/** Convert a simple glob (segment-wise `*` and `**`) to a regex. */
export function globToRegExp(globPattern: string): RegExp {
  const segmentToRegExp = (segment: string): string => {
    if (segment === "**") {
      return ".*";
    }
    let out = "";
    for (const ch of segment) {
      if (ch === "*") {
        out += "[^/]*";
      } else {
        out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      }
    }
    return out;
  };
  const parts = globPattern.split("/").map(segmentToRegExp);
  return new RegExp(`^${parts.join("/")}$`);
}

const RULE_REGEXES = YAML_SCHEMA_RULES.map((rule) => ({
  ...rule,
  regex: globToRegExp(rule.glob),
}));

export function toRepoRelativePosix(filePath: string, repoRoot = REPO_ROOT): string {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

export function schemaRuleForRelativePath(
  relativePosixPath: string,
): (YamlSchemaRule & { regex: RegExp }) | undefined {
  return RULE_REGEXES.find((rule) => rule.regex.test(relativePosixPath));
}

export async function createYamlSchemaValidator(
  schemasDir = SCHEMAS_DIR,
): Promise<Ajv2020> {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateSchema: false,
  });
  registerFormats(ajv);

  for (const schemaFile of SCHEMA_LOAD_ORDER) {
    const text = await readFile(path.join(schemasDir, schemaFile), "utf8");
    ajv.addSchema(JSON.parse(text) as object);
  }

  return ajv;
}

export function formatAjvError(error: {
  instancePath: string;
  message?: string;
  params?: Record<string, unknown>;
}): string {
  const where = error.instancePath || "/";
  const detail = error.message ?? "invalid";
  if (error.params && Object.keys(error.params).length > 0) {
    return `${where}: ${detail} (${JSON.stringify(error.params)})`;
  }
  return `${where}: ${detail}`;
}

export function validateParsedYaml(
  data: unknown,
  validate: { (data: unknown): boolean; errors?: Array<{
    instancePath: string;
    message?: string;
    params?: Record<string, unknown>;
  }> | null },
  fileLabel: string,
): YamlValidationIssue[] {
  if (!validate(data)) {
    return (validate.errors ?? []).map((error) => ({
      file: fileLabel,
      instancePath: error.instancePath,
      message: formatAjvError(error),
    }));
  }
  return [];
}

export async function validateYamlFile(
  filePath: string,
  ajv: Ajv2020,
  repoRoot = REPO_ROOT,
): Promise<YamlValidationResult> {
  const rel = toRepoRelativePosix(filePath, repoRoot);
  const rule = schemaRuleForRelativePath(rel);

  if (!rule) {
    return {
      file: rel,
      ok: true,
      skipped: true,
      skipReason: "no schema mapping",
      issues: [],
    };
  }

  const validate = ajv.getSchema(rule.schemaId);
  if (!validate) {
    return {
      file: rel,
      schemaId: rule.schemaId,
      ok: false,
      skipped: false,
      issues: [
        {
          file: rel,
          message: `schema not registered: ${rule.schemaId}`,
        },
      ],
    };
  }

  let data: unknown;
  try {
    const text = await readFile(filePath, "utf8");
    data = parse(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      file: rel,
      schemaId: rule.schemaId,
      ok: false,
      skipped: false,
      issues: [{ file: rel, message: `YAML parse error: ${msg}` }],
    };
  }

  const issues = validateParsedYaml(data, validate, rel);
  return {
    file: rel,
    schemaId: rule.schemaId,
    ok: issues.length === 0,
    skipped: false,
    issues,
  };
}

export async function discoverDatasetYamlFiles(
  datasetDir = path.join(REPO_ROOT, "dataset"),
): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob("**/*.yaml", { cwd: datasetDir })) {
    files.push(path.join(datasetDir, entry));
  }
  files.sort((a, b) => a.localeCompare(b));
  return files;
}

export interface TypecheckSummary {
  checked: number;
  passed: number;
  failed: number;
  skipped: number;
  results: YamlValidationResult[];
}

export async function typecheckDatasetYaml(opts?: {
  repoRoot?: string;
  datasetDir?: string;
  schemasDir?: string;
}): Promise<TypecheckSummary> {
  const repoRoot = opts?.repoRoot ?? REPO_ROOT;
  const datasetDir = opts?.datasetDir ?? path.join(repoRoot, "dataset");
  const schemasDir = opts?.schemasDir ?? path.join(repoRoot, "schemas");
  const ajv = await createYamlSchemaValidator(schemasDir);
  const files = await discoverDatasetYamlFiles(datasetDir);

  const results: YamlValidationResult[] = [];
  for (const file of files) {
    results.push(await validateYamlFile(file, ajv, repoRoot));
  }

  const checked = results.filter((r) => !r.skipped).length;
  const passed = results.filter((r) => !r.skipped && r.ok).length;
  const failed = results.filter((r) => !r.skipped && !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;

  return { checked, passed, failed, skipped, results };
}

function printSummary(summary: TypecheckSummary): void {
  for (const result of summary.results) {
    if (result.skipped) {
      console.log(`skip  ${result.file} (${result.skipReason})`);
      continue;
    }
    if (result.ok) {
      console.log(`ok    ${result.file}`);
      continue;
    }
    console.log(`FAIL  ${result.file}`);
    for (const issue of result.issues) {
      console.log(`      ${issue.message}`);
    }
  }

  console.log(
    `\n${summary.passed}/${summary.checked} passed` +
      (summary.skipped ? `, ${summary.skipped} skipped` : "") +
      (summary.failed ? `, ${summary.failed} failed` : ""),
  );
}

async function main(): Promise<void> {
  const summary = await typecheckDatasetYaml();
  printSummary(summary);
  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch((e) => {
    console.error("[typecheck] fatal:", e);
    process.exit(1);
  });
}
