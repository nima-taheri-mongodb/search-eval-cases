import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CASES_FILENAME,
  casesFilePathForRecord,
  enrichRowMetadata,
  flattenTaxonomy,
  formatTaxonomyBranchKey,
  mergeTaxonomy,
  metadataFromTaxonomyPath,
  orderCaseRowKeys,
  parseTaxonomyKey,
  parseTaxonomyYaml,
  rowMatchKey,
  rowForBraintrust,
  serializeTaxonomy,
  taxonomyFromMetadataPaths,
  taxonomyPathFromCasesFile,
  type CaseRow,
  type TaxonomyRoot,
} from "./taxonomy-lib.ts";
import {
  findCaseFiles,
  groupCaseFilesByDataset,
  loadAggregatedDataset,
} from "./datasets-layout.ts";
import path from "node:path";

const DATASET_DIR = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "dataset",
);

describe("parseTaxonomyKey", () => {
  it("parses typed branch keys", () => {
    assert.deepEqual(parseTaxonomyKey("category=Faceted Search"), {
      kind: "category",
      value: "Faceted Search",
    });
    assert.deepEqual(parseTaxonomyKey("Number Facets"), {
      kind: "leaf",
      name: "Number Facets",
    });
  });
});

describe("parseTaxonomyYaml", () => {
  it("round-trips typed taxonomy", () => {
    const yaml = `
taxonomy:
  - dataset=Search:
      - category=Text Search:
          - subcategory=Facets:
              - Number Facets: number facets for text search query
`;
    const roots = parseTaxonomyYaml(yaml);
    assert.equal(roots[0]?.dataset, "Search");
    const out = serializeTaxonomy(roots);
    const again = parseTaxonomyYaml(out);
    assert.equal(again[0]?.dataset, "Search");
    assert.deepEqual(flattenTaxonomy(again), flattenTaxonomy(roots));
  });
});

describe("taxonomyPathFromCasesFile", () => {
  it("maps cases.yaml path to dataset and taxonomy path", () => {
    const file = path.join(
      DATASET_DIR,
      "Team - Search",
      "Text Search Query Construction",
      "Faceted Search",
      CASES_FILENAME,
    );
    assert.deepEqual(taxonomyPathFromCasesFile(file, DATASET_DIR), {
      dataset: "Team - Search",
      path: {
        category: "Text Search Query Construction",
        subcategory: "Faceted Search",
      },
    });
  });
});

describe("rowMatchKey", () => {
  it("builds stable keys from dataset and metadata", () => {
    const metadata = metadataFromTaxonomyPath(
      { category: "A", subcategory: "B" },
      "Case",
      "desc",
    );
    assert.equal(
      rowMatchKey("Team - Search", metadata),
      ["Team - Search", "A", "B", "", "", "Case"].join("\0"),
    );
  });
});

describe("enrichRowMetadata", () => {
  it("orders metadata keys name, description, then taxonomy path", () => {
    const row: CaseRow = {
      input: { prompt: "q" },
      metadata: {
        subcategory: "Index Creation",
        category: "Text Search Index Management",
        description: "dynamic mapping mode",
        name: "Dynamic Mapping Mode",
      },
    };
    const enriched = enrichRowMetadata(row, {});
    assert.deepEqual(Object.keys(enriched.metadata as object), [
      "name",
      "description",
      "category",
      "subcategory",
    ]);
  });

  it("preserves extra metadata keys after the canonical ones", () => {
    const row: CaseRow = {
      input: { prompt: "q" },
      metadata: {
        custom: "x",
        category: "Vector",
        name: "Pre-filter",
        description: "d",
      },
    };
    const enriched = enrichRowMetadata(row, { group: "Pre-Filtering" });
    assert.deepEqual(Object.keys(enriched.metadata as object), [
      "name",
      "description",
      "category",
      "group",
      "custom",
    ]);
  });
});

describe("rowForBraintrust", () => {
  it("passes metadata through without tags", () => {
    const row: CaseRow = {
      input: { prompt: "x" },
      metadata: {
        category: "A",
        name: "Case",
        description: "desc",
      },
    };
    const bt = rowForBraintrust(row);
    assert.equal((bt as { tags?: string[] }).tags, undefined);
    assert.equal(
      (bt.metadata as { name?: string }).name,
      "Case",
    );
  });
});

describe("taxonomyFromMetadataPaths", () => {
  it("builds nested taxonomy from metadata records", () => {
    const roots = taxonomyFromMetadataPaths([
      {
        dataset: "Team - Search",
        path: {
          category: "Text Search Index Management",
          subcategory: "Index Creation",
        },
        name: "Dynamic Mapping Mode",
        description: "dynamic mapping mode for text search index creation",
      },
    ]);
    assert.equal(roots[0]?.dataset, "Team - Search");
    const serialized = serializeTaxonomy(roots);
    assert.match(serialized, /category=Text Search Index Management/);
    assert.match(serialized, /Dynamic Mapping Mode/);
  });

  it("merge preserves existing descriptions", () => {
    const existing = taxonomyFromMetadataPaths([
      {
        dataset: "Search",
        path: { category: "A", subcategory: "B" },
        name: "Leaf",
        description: "original",
      },
    ]);
    const discovered = taxonomyFromMetadataPaths([
      {
        dataset: "Search",
        path: { category: "A", subcategory: "C" },
        name: "Other",
        description: "new leaf",
      },
    ]);
    const merged = mergeTaxonomy(existing, discovered);
    const yaml = serializeTaxonomy(merged);
    assert.match(yaml, /original/);
    assert.match(yaml, /new leaf/);
  });

  it("prune keeps only discovered leaves but preserves existing descriptions", () => {
    const existing = taxonomyFromMetadataPaths([
      {
        dataset: "Search",
        path: { category: "A" },
        name: "Kept",
        description: "curated",
      },
      {
        dataset: "Search",
        path: { category: "A" },
        name: "Orphan",
        description: "stale",
      },
    ]);
    const discovered = taxonomyFromMetadataPaths([
      {
        dataset: "Search",
        path: { category: "A" },
        name: "Kept",
        description: "from case",
      },
      {
        dataset: "Search",
        path: { category: "A" },
        name: "New",
        description: "fresh",
      },
    ]);

    const names = (roots: TaxonomyRoot[]) =>
      flattenTaxonomy(roots)
        .map((r) => r.name)
        .sort();

    assert.deepEqual(names(mergeTaxonomy(existing, discovered)), [
      "Kept",
      "New",
      "Orphan",
    ]);

    const pruned = mergeTaxonomy(existing, discovered, true);
    assert.deepEqual(names(pruned), ["Kept", "New"]);
    const kept = flattenTaxonomy(pruned).find((r) => r.name === "Kept");
    assert.equal(kept?.description, "curated");
  });
});

describe("formatTaxonomyBranchKey", () => {
  it("formats branch keys", () => {
    assert.equal(
      formatTaxonomyBranchKey("category", "Faceted Search"),
      "category=Faceted Search",
    );
  });
});

describe("orderCaseRowKeys", () => {
  it("orders root keys id, metadata, input, expected, then the rest", () => {
    const row = {
      origin: null,
      expected: { llm_judge: "j" },
      input: { prompt: "p" },
      metadata: { name: "n", description: "d" },
      id: "abc",
    } as unknown as CaseRow;
    assert.deepEqual(Object.keys(orderCaseRowKeys(row)), [
      "id",
      "metadata",
      "input",
      "expected",
      "origin",
    ]);
  });

  it("orders expected keys reference_answer, llm_judge, then the rest", () => {
    const row = {
      id: "x",
      expected: { example: "e", llm_judge: "j", reference_answer: "r" },
    } as unknown as CaseRow;
    const ordered = orderCaseRowKeys(row);
    assert.deepEqual(Object.keys(ordered.expected as object), [
      "reference_answer",
      "llm_judge",
      "example",
    ]);
  });

  it("preserves metadata field order and values", () => {
    const row = {
      id: "x",
      metadata: { name: "n", description: "d", category: "c" },
    } as unknown as CaseRow;
    const ordered = orderCaseRowKeys(row);
    assert.deepEqual(Object.keys(ordered.metadata as object), [
      "name",
      "description",
      "category",
    ]);
  });

  it("handles missing id/expected and non-object expected without throwing", () => {
    const stub = { metadata: { name: "n" }, input: { prompt: "" } } as CaseRow;
    assert.deepEqual(Object.keys(orderCaseRowKeys(stub)), ["metadata", "input"]);
    const weird = { id: "x", expected: null } as unknown as CaseRow;
    assert.deepEqual(orderCaseRowKeys(weird).expected, null);
  });
});

describe("findCaseFiles", () => {
  it("discovers cases.yaml under dataset folders", async () => {
    const files = await findCaseFiles(DATASET_DIR);
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => f.endsWith(CASES_FILENAME)));
  });
});

describe("loadAggregatedDataset", () => {
  it("aggregates cases.yaml under a dataset", async () => {
    const caseFiles = await findCaseFiles(DATASET_DIR);
    const groups = groupCaseFilesByDataset(caseFiles, DATASET_DIR);
    const search = groups.get("Search") ?? [];
    assert.ok(search.length > 0);
    const agg = await loadAggregatedDataset("Search", search, DATASET_DIR);
    assert.equal(agg.name, "Search");
    assert.ok(agg.rows.length > 0);
    const facets = agg.rows.find(
      (r) =>
        (r.metadata as { name?: string } | undefined)?.name === "Number Facets",
    );
    assert.ok(facets);
    assert.equal(
      (facets?.metadata as { category?: string }).category,
      "Text Search Query Construction",
    );
  });
});

describe("groupCaseFilesByDataset", () => {
  it("buckets files by dataset folder", async () => {
    const files = await findCaseFiles(DATASET_DIR);
    const groups = groupCaseFilesByDataset(files, DATASET_DIR);
    assert.ok(groups.get("Search")?.length);
  });
});
