import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";
import {
  buildRemoteRowKeys,
  parseCaseRowsDocument,
  pruneLocalToRemote,
  readCaseRowsFile,
  rowExistsRemotely,
  writeCaseRowsFile,
  writeGroupedRows,
} from "./datasets-layout.ts";
import type { DatasetRow } from "./datasets-lib.ts";
import type { CaseRow } from "./taxonomy-lib.ts";

function remoteRow(id: string | undefined, name?: string): DatasetRow {
  const row: Record<string, unknown> = {};
  if (id !== undefined) {
    row.id = id;
  }
  if (name !== undefined) {
    row.metadata = { name, description: "" };
  }
  return row as DatasetRow;
}

function localCase(id: string, name: string): CaseRow {
  return {
    id,
    input: { prompt: name },
    expected: {},
    metadata: { name, description: "" },
  } as CaseRow;
}

describe("parseCaseRowsDocument", () => {
  it("accepts root array", () => {
    const doc = parse(`
- id: a
  input:
    prompt: "x"
`);
    const rows = parseCaseRowsDocument(doc);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "a");
  });

  it("accepts legacy { rows: [...] }", () => {
    const doc = parse(`
rows:
  - id: b
    input:
      prompt: "y"
`);
    const rows = parseCaseRowsDocument(doc);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, "b");
  });

  it("rejects non-array non-object", () => {
    assert.throws(() => parseCaseRowsDocument("string"));
  });
});

describe("buildRemoteRowKeys", () => {
  it("collects ids and names, skipping rows missing each", () => {
    const keys = buildRemoteRowKeys([
      remoteRow("id1", "alpha"),
      remoteRow(undefined, "beta"),
      remoteRow("id3", undefined),
    ]);
    assert.deepEqual([...keys.ids].sort(), ["id1", "id3"]);
    assert.deepEqual([...keys.names].sort(), ["alpha", "beta"]);
  });
});

describe("rowExistsRemotely", () => {
  const keys = buildRemoteRowKeys([remoteRow("id1", "alpha")]);

  it("matches by id", () => {
    assert.equal(rowExistsRemotely(localCase("id1", "renamed"), keys), true);
  });

  it("matches by metadata name when id differs", () => {
    assert.equal(rowExistsRemotely(localCase("other", "alpha"), keys), true);
  });

  it("returns false when neither id nor name match", () => {
    assert.equal(rowExistsRemotely(localCase("nope", "nope"), keys), false);
  });

  it("returns false for a row without metadata or matching id", () => {
    assert.equal(rowExistsRemotely({ id: "nope" } as CaseRow, keys), false);
  });
});

describe("pruneLocalToRemote", () => {
  it("mirrors remote: prunes rows, deletes emptied files and absent datasets", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prune-"));
    try {
      const aMain = path.join(dir, "DatasetA", "cases.yaml");
      const aSub = path.join(dir, "DatasetA", "Sub", "cases.yaml");
      const aKeep = path.join(dir, "DatasetA", "Keep", "cases.yaml");
      const bMain = path.join(dir, "DatasetB", "cases.yaml");

      await writeCaseRowsFile(aMain, [
        localCase("id1", "alpha"),
        localCase("id2", "beta"),
      ]);
      await writeCaseRowsFile(aSub, [localCase("id3", "delta")]);
      await writeCaseRowsFile(aKeep, [localCase("idZ", "gamma")]);
      await writeCaseRowsFile(bMain, [
        localCase("id4", "epsilon"),
        localCase("id5", "zeta"),
      ]);

      const remoteRows = new Map<string, DatasetRow[]>([
        ["DatasetA", [remoteRow("id1", "alpha"), remoteRow("id-x", "gamma")]],
      ]);

      const result = await pruneLocalToRemote(
        dir,
        new Set(["DatasetA"]),
        remoteRows,
      );

      assert.equal(result.removedRows, 4);
      assert.deepEqual(result.deletedFiles, [aSub]);
      assert.deepEqual(result.deletedDatasets, ["DatasetB"]);

      const keptMain = await readCaseRowsFile(aMain);
      assert.deepEqual(
        keptMain.map((r) => r.id),
        ["id1"],
      );

      assert.equal(existsSync(aSub), false);
      assert.equal(existsSync(path.dirname(aSub)), false);
      assert.equal(existsSync(path.join(dir, "DatasetB")), false);

      const keptKeep = await readCaseRowsFile(aKeep);
      assert.deepEqual(
        keptKeep.map((r) => r.id),
        ["idZ"],
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when local already matches remote", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "prune-noop-"));
    try {
      const file = path.join(dir, "DatasetA", "cases.yaml");
      await writeCaseRowsFile(file, [localCase("id1", "alpha")]);

      const result = await pruneLocalToRemote(
        dir,
        new Set(["DatasetA"]),
        new Map([["DatasetA", [remoteRow("id1", "alpha")]]]),
      );

      assert.equal(result.removedRows, 0);
      assert.deepEqual(result.deletedFiles, []);
      assert.deepEqual(result.deletedDatasets, []);
      assert.equal(existsSync(file), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("writeGroupedRows", () => {
  it("keeps distinct-id rows that share a metadata.name in the same file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "group-dup-"));
    try {
      const written = await writeGroupedRows(
        [
          remoteRow("id1", "Index Deletion"),
          remoteRow("id2", "Index Deletion"),
        ],
        dir,
        "DatasetA",
      );

      assert.equal(written.length, 1);
      const rows = await readCaseRowsFile(written[0]!);
      assert.deepEqual(rows.map((r) => r.id).sort(), ["id1", "id2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("updates an existing row in place when ids match", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "group-update-"));
    try {
      const file = path.join(dir, "DatasetA", "cases.yaml");
      await writeCaseRowsFile(file, [localCase("id1", "alpha")]);

      await writeGroupedRows(
        [remoteRow("id1", "alpha-renamed")],
        dir,
        "DatasetA",
      );

      const rows = await readCaseRowsFile(file);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, "id1");
      assert.equal(
        (rows[0]?.metadata as { name?: string } | undefined)?.name,
        "alpha-renamed",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not collide an id-bearing remote row with a different-id local row of the same name", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "group-nocollide-"));
    try {
      const file = path.join(dir, "DatasetA", "cases.yaml");
      await writeCaseRowsFile(file, [localCase("id1", "Index Deletion")]);

      await writeGroupedRows(
        [remoteRow("id2", "Index Deletion")],
        dir,
        "DatasetA",
      );

      const rows = await readCaseRowsFile(file);
      assert.deepEqual(rows.map((r) => r.id).sort(), ["id1", "id2"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("falls back to name matching when the incoming row has no id", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "group-noid-"));
    try {
      const file = path.join(dir, "DatasetA", "cases.yaml");
      await writeCaseRowsFile(file, [localCase("id1", "alpha")]);

      await writeGroupedRows([remoteRow(undefined, "alpha")], dir, "DatasetA");

      const rows = await readCaseRowsFile(file);
      assert.equal(rows.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("merges an id-bearing remote row into a matching id-less local stub", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "group-stub-"));
    try {
      const file = path.join(dir, "DatasetA", "cases.yaml");
      await writeCaseRowsFile(file, [
        {
          input: { prompt: "x" },
          metadata: { name: "alpha", description: "" },
        } as CaseRow,
      ]);

      await writeGroupedRows([remoteRow("id1", "alpha")], dir, "DatasetA");

      const rows = await readCaseRowsFile(file);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.id, "id1");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
