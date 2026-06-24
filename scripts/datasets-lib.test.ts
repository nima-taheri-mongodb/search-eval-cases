import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeDatasetPlan,
  computePlan,
  computeSchemaAction,
  formatPlan,
  hashRow,
  parseRemoteDatasetList,
  planExitCode,
  rowTaxonomyLabel,
  SCHEMAS_METADATA_KEY,
  type DatasetFile,
  type DatasetSchemas,
  type RemoteDataset,
} from "./datasets-lib.ts";

const remoteDataset = (name: string, id = "ds-1"): RemoteDataset => ({
  id,
  name,
});

function row(id: string, input: string, xact = "x1"): DatasetFile["rows"] {
  return [{ id, input, _xact_id: xact }];
}

describe("parseRemoteDatasetList", () => {
  it("accepts a plain array", () => {
    const ds = remoteDataset("Search");
    assert.deepEqual(parseRemoteDatasetList([ds]), [ds]);
  });

  it("accepts Braintrust { objects } wrapper", () => {
    const ds = remoteDataset("Search");
    assert.deepEqual(parseRemoteDatasetList({ objects: [ds] }), [ds]);
  });

  it("returns empty for unknown shapes", () => {
    assert.deepEqual(parseRemoteDatasetList({}), []);
    assert.deepEqual(parseRemoteDatasetList(null), []);
  });
});

describe("hashRow", () => {
  it("is stable for key order", () => {
    const a = hashRow({ id: "1", input: "a", expected: { z: 1, a: 2 } });
    const b = hashRow({ expected: { a: 2, z: 1 }, input: "a", id: "1" });
    assert.equal(a, b);
  });
});

describe("rowTaxonomyLabel", () => {
  it("joins present taxonomy segments and name", () => {
    assert.equal(
      rowTaxonomyLabel({
        metadata: {
          category: "Hybrid Search",
          subcategory: "Rank Fusion",
          name: "Weighted blend",
          description: "x",
        },
      }),
      "Hybrid Search / Rank Fusion / Weighted blend",
    );
  });

  it("skips missing/blank segments", () => {
    assert.equal(
      rowTaxonomyLabel({
        metadata: { category: "Vector", group: "  ", name: "Pre-filter" },
      }),
      "Vector / Pre-filter",
    );
  });

  it("returns undefined without usable metadata", () => {
    assert.equal(rowTaxonomyLabel(undefined), undefined);
    assert.equal(rowTaxonomyLabel({ input: "q" }), undefined);
    assert.equal(rowTaxonomyLabel({ metadata: null }), undefined);
    assert.equal(rowTaxonomyLabel({ metadata: {} }), undefined);
  });
});

describe("computeDatasetPlan", () => {
  const baseline = {
    dataset_id: "ds-1",
    synced_at: "2026-01-01T00:00:00.000Z",
    rows: {
      r1: { xact_id: "x1", content_hash: hashRow({ id: "r1", input: "old" }) },
      r2: { xact_id: "x1", content_hash: hashRow({ id: "r2", input: "stay" }) },
    },
  };

  it("updates when only local changed", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: { rows: row("r1", "new") },
      remote: remoteDataset("Search"),
      remoteRows: [{ id: "r1", input: "old", _xact_id: "x1" }],
      baseline,
      prune: false,
    });
    assert.ok(actions.some((a) => a.type === "update_row" && a.row_id === "r1"));
    assert.ok(!actions.some((a) => a.type === "conflict"));
  });

  it("drifts when only remote changed", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: { rows: [{ id: "r1", input: "old" }] },
      remote: remoteDataset("Search"),
      remoteRows: [{ id: "r1", input: "remote-new", _xact_id: "x2" }],
      baseline,
      prune: false,
    });
    assert.ok(actions.some((a) => a.type === "drift" && a.row_id === "r1"));
    assert.ok(!actions.some((a) => a.type === "update_row"));
  });

  it("conflicts when both changed", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: { rows: [{ id: "r1", input: "local-new" }] },
      remote: remoteDataset("Search"),
      remoteRows: [{ id: "r1", input: "remote-new", _xact_id: "x2" }],
      baseline,
      prune: false,
    });
    assert.ok(actions.some((a) => a.type === "conflict"));
  });

  it("skips remote-only rows without prune", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: { rows: [{ id: "r1", input: "old" }] },
      remote: remoteDataset("Search"),
      remoteRows: [
        { id: "r1", input: "old", _xact_id: "x1" },
        { id: "r3", input: "extra", _xact_id: "x1" },
      ],
      baseline,
      prune: false,
    });
    assert.ok(actions.some((a) => a.type === "remote_only" && a.row_id === "r3"));
    assert.ok(!actions.some((a) => a.type === "delete_row"));
  });

  it("deletes remote-only rows with prune", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: { rows: [{ id: "r1", input: "old" }] },
      remote: remoteDataset("Search"),
      remoteRows: [
        { id: "r1", input: "old", _xact_id: "x1" },
        { id: "r3", input: "extra", _xact_id: "x1" },
      ],
      baseline,
      prune: true,
    });
    assert.ok(actions.some((a) => a.type === "delete_row" && a.row_id === "r3"));
  });

  it("creates dataset when local only", () => {
    const actions = computeDatasetPlan({
      name: "New",
      local: { rows: [{ input: "q1" }] },
      remoteRows: [],
      prune: false,
    });
    assert.deepEqual(actions.map((a) => a.type), ["create_dataset"]);
  });

  it("labels id-less create rows with taxonomy", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: {
        rows: [
          {
            input: "q",
            metadata: {
              category: "Hybrid Search",
              group: "Rank Fusion",
              name: "Weighted blend",
            },
          },
        ],
      },
      remote: remoteDataset("Search"),
      remoteRows: [],
      baseline: { dataset_id: "ds-1", synced_at: "t", rows: {} },
      prune: false,
    });
    const create = actions.find((a) => a.type === "create_row");
    assert.equal(create?.label, "Hybrid Search / Rank Fusion / Weighted blend");
  });

  it("labels conflict rows with taxonomy", () => {
    const actions = computeDatasetPlan({
      name: "Search",
      local: {
        rows: [
          {
            id: "r1",
            input: "local-new",
            metadata: { category: "Vector", name: "Pre-filter" },
          },
        ],
      },
      remote: remoteDataset("Search"),
      remoteRows: [{ id: "r1", input: "remote-new", _xact_id: "x2" }],
      baseline,
      prune: false,
    });
    const conflict = actions.find((a) => a.type === "conflict");
    assert.equal(conflict?.label, "Vector / Pre-filter");
  });
});

describe("computeSchemaAction", () => {
  const schemas: DatasetSchemas = {
    input: { type: "object", required: ["prompt"] },
    expected: { type: "object", properties: { answer: { type: "string" } } },
  };
  const remoteWith = (sch: Record<string, unknown>): RemoteDataset => ({
    id: "ds-1",
    name: "Search",
    metadata: { [SCHEMAS_METADATA_KEY]: sch },
  });

  it("returns null when no schemas provided", () => {
    assert.equal(
      computeSchemaAction({
        name: "Search",
        localExists: true,
        remote: remoteDataset("Search"),
        schemas: null,
      }),
      null,
    );
  });

  it("returns null when dataset is not present locally", () => {
    assert.equal(
      computeSchemaAction({
        name: "Search",
        localExists: false,
        remote: remoteDataset("Search"),
        schemas,
      }),
      null,
    );
  });

  it("returns null when remote schemas already match (ignoring key order and updated_at)", () => {
    const action = computeSchemaAction({
      name: "Search",
      localExists: true,
      remote: remoteWith({
        expected: { properties: { answer: { type: "string" } }, type: "object" },
        input: { required: ["prompt"], type: "object" },
        updated_at: "2020-01-01T00:00:00.000Z",
      }),
      schemas,
    });
    assert.equal(action, null);
  });

  it("emits update_schemas when remote input/expected differ", () => {
    const action = computeSchemaAction({
      name: "Search",
      localExists: true,
      remote: remoteWith({ input: { type: "object" }, expected: {} }),
      schemas,
    });
    assert.ok(action);
    assert.equal(action?.type, "update_schemas");
    assert.equal(action?.dataset_id, "ds-1");
    assert.equal(action?.reason, "schemas changed");
    const meta = action?.metadata?.[SCHEMAS_METADATA_KEY] as Record<
      string,
      unknown
    >;
    assert.deepEqual(meta.input, schemas.input);
    assert.deepEqual(meta.expected, schemas.expected);
    assert.ok(typeof meta.updated_at === "string");
  });

  it("emits update_schemas when remote has no __schemas", () => {
    const action = computeSchemaAction({
      name: "Search",
      localExists: true,
      remote: { id: "ds-1", name: "Search" },
      schemas,
    });
    assert.equal(action?.type, "update_schemas");
  });

  it("emits update_schemas for a brand-new dataset with no remote", () => {
    const action = computeSchemaAction({
      name: "Search",
      localExists: true,
      remote: undefined,
      schemas,
    });
    assert.equal(action?.type, "update_schemas");
    assert.equal(action?.dataset_id, undefined);
    assert.equal(action?.reason, "set schemas on new dataset");
  });

  it("preserves other remote metadata keys and extra __schemas keys", () => {
    const action = computeSchemaAction({
      name: "Search",
      localExists: true,
      remote: {
        id: "ds-1",
        name: "Search",
        metadata: {
          owner: "search-team",
          [SCHEMAS_METADATA_KEY]: { version: 3, input: { old: true }, expected: {} },
        },
      },
      schemas,
    });
    assert.equal(action?.metadata?.owner, "search-team");
    const meta = action?.metadata?.[SCHEMAS_METADATA_KEY] as Record<
      string,
      unknown
    >;
    assert.equal(meta.version, 3);
    assert.deepEqual(meta.input, schemas.input);
  });
});

describe("computePlan", () => {
  it("blocks apply on conflicts", () => {
    const baseline = {
      dataset_id: "ds-1",
      synced_at: "2026-01-01T00:00:00.000Z",
      rows: {
        r1: { xact_id: "x1", content_hash: hashRow({ id: "r1", input: "old" }) },
      },
    };
    const plan = computePlan({
      project: "p",
      dir: "dataset",
      prune: false,
      localDatasets: [
        {
          name: "Search",
          file: "dataset/Search.yaml",
          data: { rows: [{ id: "r1", input: "local" }] },
        },
      ],
      remoteDatasets: [remoteDataset("Search")],
      remoteRowsByDataset: new Map([
        ["Search", [{ id: "r1", input: "remote", _xact_id: "x2" }]],
      ]),
      syncState: {
        version: 1,
        project: "p",
        datasets: { Search: baseline },
      },
    });
    assert.equal(plan.blocked, true);
    assert.equal(planExitCode(plan), 2);
    assert.match(formatPlan(plan), /conflict/i);
  });

  it("adds an update_schemas action when schemas drift from remote", () => {
    const plan = computePlan({
      project: "p",
      dir: "dataset",
      prune: false,
      localDatasets: [
        {
          name: "Search",
          file: "dataset/Search.yaml",
          data: { rows: [{ id: "r1", input: "same" }] },
        },
      ],
      remoteDatasets: [
        {
          id: "ds-1",
          name: "Search",
          metadata: { [SCHEMAS_METADATA_KEY]: { input: { old: true }, expected: {} } },
        },
      ],
      remoteRowsByDataset: new Map([
        ["Search", [{ id: "r1", input: "same", _xact_id: "x1" }]],
      ]),
      syncState: {
        version: 1,
        project: "p",
        datasets: {
          Search: {
            dataset_id: "ds-1",
            synced_at: "t",
            rows: {
              r1: { xact_id: "x1", content_hash: hashRow({ id: "r1", input: "same" }) },
            },
          },
        },
      },
      schemas: { input: { type: "object" }, expected: { type: "object" } },
    });
    assert.equal(plan.summary.update, 1);
    assert.ok(plan.actions.some((a) => a.type === "update_schemas"));
    assert.match(formatPlan(plan), /update schemas/);
    assert.equal(planExitCode(plan), 1);
  });

  it("renders taxonomy labels in plan output", () => {
    const plan = computePlan({
      project: "p",
      dir: "dataset",
      prune: false,
      localDatasets: [
        {
          name: "Search",
          file: "dataset/Search.yaml",
          data: {
            rows: [
              {
                input: "q",
                metadata: {
                  category: "Hybrid Search",
                  group: "Rank Fusion",
                  name: "Weighted blend",
                },
              },
            ],
          },
        },
      ],
      remoteDatasets: [remoteDataset("Search")],
      remoteRowsByDataset: new Map([["Search", []]]),
      syncState: {
        version: 1,
        project: "p",
        datasets: {
          Search: { dataset_id: "ds-1", synced_at: "t", rows: {} },
        },
      },
    });
    assert.match(
      formatPlan(plan),
      /Hybrid Search \/ Rank Fusion \/ Weighted blend/,
    );
  });
});
