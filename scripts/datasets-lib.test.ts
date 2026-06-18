import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeDatasetPlan,
  computePlan,
  formatPlan,
  hashRow,
  parseRemoteDatasetList,
  planExitCode,
  type DatasetFile,
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
});
