import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { parseCaseRowsDocument } from "./datasets-layout.ts";

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
