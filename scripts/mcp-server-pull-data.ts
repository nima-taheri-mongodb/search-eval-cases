#!/usr/bin/env tsx
/**
 * Sync vendored data from mongodb-mcp-server into this repo:
 *
 * 1. Copy every file under `tests/eval/dbSeed/` → `dbseed/` (same basenames).
 * 2. Run `pnpm eval:generate-schemas` in the MCP server repo, then copy
 *    `tests/eval/dist/input.schema.json` and `expected.schema.json` into `schemas/`,
 *    and apply eval-cases patches (`$id`, optional `example` on expected).
 *
 * Set `MONGODB_MCP_SERVER_ROOT` to the absolute path of mongodb-mcp-server if it is
 * not at `~/mongodb-mcp-server`.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SCHEMAS_DIR = path.join(REPO_ROOT, "schemas");
const DBSEED_DIR = path.join(REPO_ROOT, "dbseed");

const MCP_ROOT =
  process.env.MONGODB_MCP_SERVER_ROOT?.replace(/\/$/, "") ??
  path.join(homedir(), "mongodb-mcp-server");

const MCP_DBSEED = path.join(MCP_ROOT, "tests", "eval", "dbSeed");
const MCP_SCHEMA_DIST = path.join(MCP_ROOT, "tests", "eval", "dist");

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function assertMcpRepo(): void {
  const pkg = path.join(MCP_ROOT, "package.json");
  if (!existsSync(pkg)) {
    die(
      `mongodb-mcp-server not found at ${MCP_ROOT}.\n` +
        `Set MONGODB_MCP_SERVER_ROOT to its absolute path.`,
    );
  }
}

function runGenerateSchemas(): void {
  console.log(`Running pnpm eval:generate-schemas in ${MCP_ROOT}...`);
  try {
    execFileSync("pnpm", ["eval:generate-schemas"], {
      cwd: MCP_ROOT,
      stdio: "inherit",
    });
  } catch {
    die("`pnpm eval:generate-schemas` failed (see output above).");
  }
}

function patchInputSchema(raw: string): string {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  obj.$id = "https://mongodb-eval-cases/schemas/input.schema.json";
  return JSON.stringify(obj, null, 4) + "\n";
}

function patchExpectedSchema(raw: string): string {
  const obj = JSON.parse(raw) as Record<string, unknown>;
  obj.$id = "https://mongodb-eval-cases/schemas/expected.schema.json";
  const props = { ...((obj.properties as Record<string, unknown>) ?? {}) };
  if (!props.example) {
    props.example = {
      type: "string",
      description:
        "Optional illustrative command or answer that would satisfy the judge.",
    };
  }
  obj.properties = props;
  return JSON.stringify(obj, null, 4) + "\n";
}

function copyGeneratedSchemas(): void {
  const inputSrc = path.join(MCP_SCHEMA_DIST, "input.schema.json");
  const expectedSrc = path.join(MCP_SCHEMA_DIST, "expected.schema.json");
  if (!existsSync(inputSrc) || !existsSync(expectedSrc)) {
    die(
      `Missing generated schemas under ${MCP_SCHEMA_DIST}.\n` +
        `Expected input.schema.json and expected.schema.json after generate-schemas.`,
    );
  }
  mkdirSync(SCHEMAS_DIR, { recursive: true });
  const inputOut = path.join(SCHEMAS_DIR, "input.schema.json");
  const expectedOut = path.join(SCHEMAS_DIR, "expected.schema.json");
  writeFileSync(inputOut, patchInputSchema(readFileSync(inputSrc, "utf8")), "utf8");
  writeFileSync(
    expectedOut,
    patchExpectedSchema(readFileSync(expectedSrc, "utf8")),
    "utf8",
  );
  console.log(`Wrote ${path.relative(REPO_ROOT, inputOut)}`);
  console.log(`Wrote ${path.relative(REPO_ROOT, expectedOut)}`);
}

function copyDbSeed(): void {
  if (!existsSync(MCP_DBSEED)) {
    die(`Upstream dbSeed directory missing: ${MCP_DBSEED}`);
  }
  mkdirSync(DBSEED_DIR, { recursive: true });
  const names = readdirSync(MCP_DBSEED);
  let n = 0;
  for (const name of names) {
    const src = path.join(MCP_DBSEED, name);
    const dst = path.join(DBSEED_DIR, name);
    const st = statSync(src);
    if (st.isDirectory()) {
      cpSync(src, dst, { recursive: true });
      console.log(`  ${name}/ (dir)`);
      n++;
    } else if (st.isFile()) {
      cpSync(src, dst);
      console.log(`  ${name}`);
      n++;
    }
  }
  console.log(`Copied ${n} dbSeed path(s) → ${path.relative(REPO_ROOT, DBSEED_DIR)}/`);
}

function main(): void {
  console.log(`MONGODB_MCP_SERVER_ROOT=${MCP_ROOT}\n`);
  assertMcpRepo();

  copyDbSeed();
  runGenerateSchemas();
  copyGeneratedSchemas();
  console.log("Done.");
}

main();
