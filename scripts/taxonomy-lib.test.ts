import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  mergeTaxonomy,
  parseTaxonomyYaml,
  pathToTagsPrefix,
  rowForBraintrust,
  rowTags,
  serializeTaxonomy,
  tagsToLocation,
  taxonomyFromTagPaths,
  type CaseRow,
} from "./taxonomy-lib.ts";
import {
  loadAggregatedDataset,
  groupCaseFilesByL1,
} from "./datasets-layout.ts";
import path from "node:path";

const DATASET_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "dataset",
);

describe("pathToTagsPrefix", () => {
  it("extracts L1/L2/L3 from case file path", () => {
    const file = path.join(
      DATASET_DIR,
      "Team - Search",
      "Category - Text Search Index Management",
      "Index Lifecycle.yaml",
    );
    assert.deepEqual(pathToTagsPrefix(file, DATASET_DIR), [
      "Team - Search",
      "Category - Text Search Index Management",
      "Index Lifecycle",
    ]);
  });

  it("rejects paths that are not L1/L2/L3.yaml", () => {
    assert.throws(() =>
      pathToTagsPrefix(path.join(DATASET_DIR, "Search.yaml"), DATASET_DIR),
    );
  });
});

describe("rowTags", () => {
  it("builds full tag chain from path and label", () => {
    const prefix = [
      "Search",
      "Text Search Index Management",
      "Index Creation",
    ] as [string, string, string];
    const row: CaseRow = { label: "Dynamic Mapping" };
    assert.deepEqual(rowTags(prefix, row), [
      "Search",
      "Text Search Index Management",
      "Index Creation",
      "Dynamic Mapping",
    ]);
  });

  it("uses labels array for deeper levels", () => {
    const prefix = ["A", "B", "C"] as [string, string, string];
    const row: CaseRow = { labels: ["D", "E"] };
    assert.deepEqual(rowTags(prefix, row), ["A", "B", "C", "D", "E"]);
  });
});

describe("tagsToLocation", () => {
  it("maps 4 tags to L3 file plus label suffix", () => {
    const loc = tagsToLocation(
      [
        "Search",
        "Text Search Index Management",
        "Index Creation",
        "Dynamic Mapping",
      ],
      DATASET_DIR,
    );
    assert.equal(loc.l3, "Index Creation");
    assert.deepEqual(loc.labelSuffix, ["Dynamic Mapping"]);
    assert.ok(loc.filePath.endsWith("Index Creation.yaml"));
  });
});

describe("rowForBraintrust", () => {
  it("injects tags and omits local label fields", () => {
    const prefix = [
      "Search",
      "Text Search Index Management",
      "Index Creation",
    ] as [string, string, string];
    const row: CaseRow = {
      label: "Dynamic Mapping",
      input: { prompt: "x" },
    };
    const bt = rowForBraintrust(prefix, row);
    assert.deepEqual(bt.tags, [
      "Search",
      "Text Search Index Management",
      "Index Creation",
      "Dynamic Mapping",
    ]);
    assert.equal((bt as CaseRow).label, undefined);
  });
});

describe("taxonomy yaml", () => {
  it("round-trips parse and serialize", () => {
    const yaml = `
taxonomy:
  - Search:
      - Text Search Index Management:
          - Index Deletion: |
              index deletion for search index
`;
    const roots = parseTaxonomyYaml(yaml);
    assert.equal(roots[0]?.name, "Search");
    const out = serializeTaxonomy(roots);
    const again = parseTaxonomyYaml(out);
    assert.equal(again[0]?.name, "Search");
  });
});

describe("taxonomyFromTagPaths", () => {
  it("builds nested taxonomy for L4 tag paths", () => {
    const roots = taxonomyFromTagPaths([
      {
        tags: [
          "Search",
          "Text Search Index Management",
          "Index Creation",
          "Dynamic Mapping",
        ],
        summary: "index creation for search index with dynamic mapping",
      },
    ]);
    assert.equal(roots[0]?.name, "Search");
    const serialized = serializeTaxonomy(roots);
    assert.match(serialized, /Dynamic Mapping/);
  });

  it("merge preserves existing summaries", () => {
    const existing = taxonomyFromTagPaths([
      { tags: ["Search", "A", "B"], summary: "original" },
    ]);
    const discovered = taxonomyFromTagPaths([
      { tags: ["Search", "A", "C"], summary: "new leaf" },
    ]);
    const merged = mergeTaxonomy(existing, discovered);
    const yaml = serializeTaxonomy(merged);
    assert.match(yaml, /original/);
    assert.match(yaml, /new leaf/);
  });
});

describe("loadAggregatedDataset", () => {
  it("aggregates L3 files under Team - Search into one dataset", async () => {
    const caseFiles = [
      path.join(
        DATASET_DIR,
        "Team - Search",
        "Category - Text Search Index Management",
        "Index Lifecycle.yaml",
      ),
      path.join(
        DATASET_DIR,
        "Team - Search",
        "Category - Text Search Index Management",
        "Index Creation.yaml",
      ),
    ];
    const agg = await loadAggregatedDataset(
      "Team - Search",
      caseFiles,
      DATASET_DIR,
    );
    assert.equal(agg.name, "Team - Search");
    assert.ok(agg.rows.length >= 2);
    const creation = agg.rows.find((r) =>
      r.tags?.includes("Dynamic Mapping Mode"),
    );
    assert.ok(creation);
    assert.deepEqual(creation?.tags, [
      "Team - Search",
      "Category - Text Search Index Management",
      "Index Creation",
      "Dynamic Mapping Mode",
    ]);
  });
});

describe("groupCaseFilesByL1", () => {
  it("buckets files by first path segment", () => {
    const files = [
      path.join(DATASET_DIR, "Search", "A", "B.yaml"),
      path.join(DATASET_DIR, "Vector", "A", "B.yaml"),
    ];
    const groups = groupCaseFilesByL1(files, DATASET_DIR);
    assert.equal(groups.get("Search")?.length, 1);
    assert.equal(groups.get("Vector")?.length, 1);
  });
});
