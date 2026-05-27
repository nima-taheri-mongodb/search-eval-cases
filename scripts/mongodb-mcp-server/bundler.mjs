/**
 * Pre-bundle mongodb-mcp-server for Braintrust Lambda sandbox push.
 *
 * Why this exists:
 * - `braintrust push` esbuilds eval code into a single Lambda artifact. Importing
 *   `mongodb-mcp-server` directly fails because optional native deps (electron,
 *   cpu-features, @mongodb-js/atlas-local, ssh2) break the bundler.
 * - `--external-packages mongodb-mcp-server` avoids bundling errors but excludes
 *   the package from the artifact, causing ERR_MODULE_NOT_FOUND at runtime.
 *
 * This script runs a controlled esbuild pass first (with stubs for unused native
 * modules), producing task/lib/vendor/mongodb-mcp-server/bundle.cjs. The eval imports
 * that file via a relative path so Braintrust can bundle it into /var/task/index.js.
 *
 * Run via `pnpm bundle:mcp-server` before `push:sandbox`.
 */
import * as esbuild from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = join(scriptDir, "../..");
const stub = join(scriptDir, "stub.mjs");
// os-dns-native loads a native .node addon via `bindings`, which esbuild cannot
// bundle. Replace it with a built-in `dns`-backed stub so mongodb+srv:// SRV
// resolution works in the sandbox.
const osDnsStub = join(scriptDir, "os-dns-native-stub.cjs");
const outDir = join(root, "task/lib/vendor/mongodb-mcp-server");

mkdirSync(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [join(scriptDir, "entry.mjs")],
  outfile: join(outDir, "bundle.cjs"),
  bundle: true,
  platform: "node",
  // CJS so Braintrust's second bundling pass (also CJS) does not break import.meta.
  format: "cjs",
  target: "node20",
  // Optional deps we never use in sandbox (connection-string-only, no Atlas Local / SSH).
  // Stub them so esbuild can bundle without resolving native binaries.
  alias: {
    electron: stub,
    "cpu-features": stub,
    "@mongodb-js/atlas-local": stub,
    "@mongodb-js/atlas-local-darwin-arm64": stub,
    "@mongodb-js/atlas-local-darwin-x64": stub,
    "@mongodb-js/atlas-local-linux-arm64-gnu": stub,
    "@mongodb-js/atlas-local-linux-x64-gnu": stub,
    "@mongodb-js/atlas-local-win32-x64-msvc": stub,
    ssh2: stub,
    "os-dns-native": osDnsStub,
  },
  // macOS-only watcher; never needed on Lambda.
  external: ["fsevents"],
});

console.log("Wrote task/lib/vendor/mongodb-mcp-server/bundle.cjs");
