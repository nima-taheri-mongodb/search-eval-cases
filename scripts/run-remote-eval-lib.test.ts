import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  buildRemoteEvalRequest,
  buildExperimentUrl,
  buildTraceDump,
  compileLabelRegex,
  consumeRemoteEvalSse,
  formatScoreLine,
  groupRecordsByTrace,
  inferProjectIdFromMeta,
  isL3CaseFile,
  isRootSpan,
  loadRowsFromCaseFiles,
  loadRowsFromCaseFilesDetailed,
  mergeEvalParameters,
  parseSseEvents,
  resolveCaseFilesFromGlobs,
  rowMatchesLabelRegex,
  sanitizePathSegment,
  traceOutputFilename,
} from "./run-remote-eval-lib.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("isL3CaseFile", () => {
  it("accepts L3 yaml under dataset root", () => {
    const ds = path.join(REPO_ROOT, "dataset");
    const f = path.join(ds, "Search", "L2", "L3.yaml");
    assert.equal(isL3CaseFile(f, ds), true);
  });

  it("rejects _meta and taxonomy", () => {
    const ds = path.join(REPO_ROOT, "dataset");
    assert.equal(isL3CaseFile(path.join(ds, "Search", "_meta.yaml"), ds), false);
    assert.equal(isL3CaseFile(path.join(ds, "taxonomy.yaml"), ds), false);
  });

  it("rejects wrong depth", () => {
    const ds = path.join(REPO_ROOT, "dataset");
    assert.equal(isL3CaseFile(path.join(ds, "Search.yaml"), ds), false);
  });
});

describe("resolveCaseFilesFromGlobs", () => {
  it("resolves patterns and dedupes", async () => {
    const a = await resolveCaseFilesFromGlobs(
      [
        "dataset/Team - Search/Category - Text Search Index Management/*.yaml",
        "dataset/Team - Search/Category - Text Search Index Management/Index Creation.yaml",
      ],
      "dataset",
      REPO_ROOT,
    );
    assert.ok(a.length >= 2);
    const set = new Set(a);
    assert.equal(set.size, a.length);
  });

  it("throws when nothing matches", async () => {
    await assert.rejects(
      () =>
        resolveCaseFilesFromGlobs(
          ["dataset/__no_such_bucket__/**/*.yaml"],
          "dataset",
          REPO_ROOT,
        ),
      /No L3 case files matched/,
    );
  });

  it("throws when patterns list is empty", async () => {
    await assert.rejects(
      () => resolveCaseFilesFromGlobs([], "dataset", REPO_ROOT),
      /At least one glob pattern/,
    );
  });
});

describe("rowMatchesLabelRegex", () => {
  it("matches row label and joined labels", () => {
    assert.equal(
      rowMatchesLabelRegex({ label: "Number Facets" }, /Facets/),
      true,
    );
    assert.equal(
      rowMatchesLabelRegex({ labels: ["A", "B"] }, /^A > B$/),
      true,
    );
    assert.equal(
      rowMatchesLabelRegex({ label: "String Facets" }, /^Number/),
      false,
    );
  });

  it("compileLabelRegex throws on invalid pattern", () => {
    assert.throws(() => compileLabelRegex("("), /Invalid label regex/);
  });
});

describe("loadRowsFromCaseFiles", () => {
  it("merges rows from multiple files with tags", async () => {
    const ds = path.join(REPO_ROOT, "dataset");
    const files = [
      path.join(
        ds,
        "Team - Search",
        "Category - Text Search Index Management",
        "Index Creation.yaml",
      ),
      path.join(
        ds,
        "Team - Search",
        "Category - Text Search Index Management",
        "Index Lifecycle.yaml",
      ),
    ];
    const rows = await loadRowsFromCaseFiles(files, ds);
    assert.ok(rows.length >= 2);
    assert.ok(Array.isArray(rows[0]?.tags));
    assert.ok((rows[0]?.tags ?? []).some((t) => t.includes("Team - Search")));
  });

  it("filters rows by label regex", async () => {
    const ds = path.join(REPO_ROOT, "dataset");
    const file = path.join(
      ds,
      "Team - Search",
      "Category - Text Search Query Construction",
      "Faceted Search.yaml",
    );
    const { rows, sources } = await loadRowsFromCaseFilesDetailed([file], ds, {
      labelRegex: /^Number Facets$/,
    });
    assert.equal(rows.length, 1);
    assert.equal(sources.length, 1);
    assert.equal(sources[0]?.rowCount, 1);
    assert.ok(
      (rows[0]?.tags ?? []).some((t) => t.endsWith("Number Facets")),
    );
  });
});

describe("buildRemoteEvalRequest", () => {
  it("builds POST body with inline data and streaming enabled by default", () => {
    const body = buildRemoteEvalRequest({
      evalName: "mongodb-mcp-server-evals",
      rows: [{ id: "x", input: { prompt: "p" } }],
      parameters: { model: "gpt-4o" },
      experimentName: "exp1",
      projectId: "proj-uuid",
    });
    assert.equal(body.name, "mongodb-mcp-server-evals");
    assert.equal(body.stream, true);
    assert.deepEqual(body.data, { data: [{ id: "x", input: { prompt: "p" } }] });
    assert.equal(body.experiment_name, "exp1");
    assert.equal(body.project_id, "proj-uuid");
    assert.deepEqual(body.parameters, { model: "gpt-4o" });
  });

  it("omits project_id when absent", () => {
    const body = buildRemoteEvalRequest({
      evalName: "e",
      rows: [],
      parameters: {},
      experimentName: "exp",
      stream: false,
    });
    assert.equal(body.project_id, undefined);
    assert.equal(body.stream, false);
  });
});

describe("parseSseEvents", () => {
  it("parses start and summary blocks", () => {
    const buffer =
      'event: start\ndata: {"experimentUrl":"https://x/y"}\n\n' +
      'event: progress\ndata: {"n":1}\n\n' +
      'event: summary\ndata: {"scores":{"s":{"score":1}}}\n\n';
    const { events, rest } = parseSseEvents(buffer);
    assert.equal(events.length, 3);
    assert.equal(events[0]?.event, "start");
    assert.match(events[0]?.data ?? "", /experimentUrl/);
    assert.equal(rest, "");
  });

  it("keeps incomplete trailing block in rest", () => {
    const { events, rest } = parseSseEvents('event: start\ndata: {"a":1}');
    assert.equal(events.length, 0);
    assert.match(rest, /start/);
  });
});

describe("consumeRemoteEvalSse", () => {
  it("invokes onStart before summary", async () => {
    const sse =
      'event: start\ndata: {"experimentUrl":"https://app/e"}\n\n' +
      'event: summary\ndata: {"scores":{"llm":{"score":0.5}}}\n\n';
    const order: string[] = [];
    const result = await consumeRemoteEvalSse(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse));
          controller.close();
        },
      }),
      {
        onStart: () => order.push("start"),
        onProgress: () => order.push("progress"),
      },
    );
    assert.deepEqual(order, ["start"]);
    assert.equal(result.start?.experimentUrl, "https://app/e");
    assert.equal(result.summary?.scores?.llm?.score, 0.5);
  });

  it("stops on summary without done event", async () => {
    const sse = 'event: summary\ndata: {"scores":{"x":{"score":1}}}\n\n';
    let reads = 0;
    const stream = new ReadableStream({
      async pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode(sse));
          return;
        }
        await new Promise(() => {});
      },
    });
    const result = await consumeRemoteEvalSse(stream);
    assert.equal(result.summary?.scores?.x?.score, 1);
    assert.ok(reads <= 2);
  });

  it("stops reading after done without waiting for stream close", async () => {
    let reads = 0;
    const sse =
      'event: summary\ndata: {"scores":{}}\n\n' +
      'event: done\ndata: \n\n';
    const stream = new ReadableStream({
      async pull(controller) {
        reads += 1;
        if (reads === 1) {
          controller.enqueue(new TextEncoder().encode(sse));
          return;
        }
        await new Promise(() => {
          // Never resolve — would hang without done handling.
        });
      },
    });
    const result = await consumeRemoteEvalSse(stream);
    assert.deepEqual(result.summary?.scores, {});
    assert.ok(reads <= 2, `expected at most 2 reads, got ${reads}`);
  });
});

describe("formatScoreLine", () => {
  it("formats scores as percentages", () => {
    assert.equal(
      formatScoreLine({ llm: { score: 0.875 } }),
      "llm=87.50%",
    );
  });
});

describe("buildExperimentUrl", () => {
  it("builds braintrust experiment path", () => {
    const url = buildExperimentUrl({
      appPublicUrl: "https://www.braintrust.dev",
      orgName: "my-org",
      projectName: "my-project",
      experimentName: "exp-1",
    });
    assert.equal(
      url,
      "https://www.braintrust.dev/app/my-org/p/my-project/experiments/exp-1",
    );
  });
});

describe("mergeEvalParameters", () => {
  it("merges CLI over env", () => {
    const merged = mergeEvalParameters(
      JSON.stringify({ a: 1, b: 2 }),
      JSON.stringify({ b: 3 }),
    );
    assert.deepEqual(merged, { a: 1, b: 3 });
  });

  it("throws on invalid env JSON", () => {
    assert.throws(
      () => mergeEvalParameters("{not json", undefined),
      /BT_EVAL_PARAMS_JSON/,
    );
  });

  it("throws on invalid CLI JSON", () => {
    assert.throws(
      () => mergeEvalParameters(undefined, "not json"),
      /--params/,
    );
  });
});

describe("inferProjectIdFromMeta", () => {
  it("throws when L1 buckets disagree on project_id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "eval-meta-"));
    try {
      const ds = path.join(root, "dataset");
      const uuidA = "11111111-1111-4111-8111-111111111111";
      const uuidB = "22222222-2222-4222-8222-222222222222";
      for (const [l1, pid] of [
        ["A", uuidA],
        ["B", uuidB],
      ] as const) {
        await mkdir(path.join(ds, l1, "L2"), { recursive: true });
        await writeFile(
          path.join(ds, l1, "_meta.yaml"),
          `dataset:\n  id: ${pid}\n  name: ${l1}\n  project_id: ${pid}\n`,
          "utf8",
        );
        await writeFile(
          path.join(ds, l1, "L2", "Case.yaml"),
          `- input:\n    prompt: "x"\n`,
          "utf8",
        );
      }
      const files = [
        path.join(ds, "A", "L2", "Case.yaml"),
        path.join(ds, "B", "L2", "Case.yaml"),
      ];
      await assert.rejects(
        () => inferProjectIdFromMeta(files, ds),
        /Multiple project_id/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("trace dump helpers", () => {
  it("isRootSpan matches root rows only", () => {
    assert.equal(
      isRootSpan({ root_span_id: "a", span_id: "a" }),
      true,
    );
    assert.equal(
      isRootSpan({ root_span_id: "a", span_id: "b" }),
      false,
    );
  });

  it("groupRecordsByTrace groups child spans under root", () => {
    const groups = groupRecordsByTrace([
      { root_span_id: "r1", span_id: "r1", id: "row-1" },
      { root_span_id: "r1", span_id: "c1" },
      { root_span_id: "r2", span_id: "r2", id: "row-2" },
    ]);
    assert.equal(groups.size, 2);
    assert.equal(groups.get("r1")?.length, 2);
    assert.equal(groups.get("r2")?.length, 1);
  });

  it("buildTraceDump extracts root and sorts spans", () => {
    const dump = buildTraceDump("r1", [
      { root_span_id: "r1", span_id: "c1", _pagination_key: "2" },
      {
        root_span_id: "r1",
        span_id: "r1",
        id: "abc",
        tags: ["Search > L2 > L3"],
        _pagination_key: "1",
      },
    ]);
    assert.ok(dump);
    assert.equal(dump.rowId, "abc");
    assert.equal(dump.spans[0]?.span_id, "r1");
    assert.equal(dump.spans[1]?.span_id, "c1");
  });

  it("traceOutputFilename prefers row id", () => {
    const dump = buildTraceDump("r1", [
      { root_span_id: "r1", span_id: "r1", id: "uuid-here" },
    ]);
    assert.ok(dump);
    assert.equal(traceOutputFilename(dump, 0), "uuid-here.json");
  });

  it("sanitizePathSegment makes safe directory names", () => {
    assert.equal(
      sanitizePathSegment("remote-eval_2025-01-02_12:30:45"),
      "remote-eval_2025-01-02_12_30_45",
    );
  });
});
