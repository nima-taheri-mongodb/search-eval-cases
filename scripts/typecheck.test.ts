import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  globToRegExp,
  schemaRuleForRelativePath,
  toRepoRelativePosix,
  typecheckDatasetYaml,
  validateParsedYaml,
} from "./typecheck.ts";

describe("globToRegExp", () => {
  it("matches path segments with wildcards", () => {
    const re = globToRegExp("dataset/*/*/*.yaml");
    assert.match(
      "dataset/Search/Text Search Index Management/Index Creation.yaml",
      re,
    );
    assert.doesNotMatch("dataset/Search/L3.yaml", re);
    assert.doesNotMatch("dataset/Search/_meta.yaml", re);
  });
});

describe("schemaRuleForRelativePath", () => {
  it("maps L3 case files to case-file schema", () => {
    const rule = schemaRuleForRelativePath(
      "dataset/Search/Text Search Index Management/Index Creation.yaml",
    );
    assert.equal(rule?.schemaFile, "case-file.schema.json");
  });

  it("maps _meta.yaml to dataset-meta schema", () => {
    const rule = schemaRuleForRelativePath("dataset/Search/_meta.yaml");
    assert.equal(rule?.schemaFile, "dataset-meta.schema.json");
  });

  it("returns undefined for taxonomy", () => {
    assert.equal(schemaRuleForRelativePath("dataset/taxonomy.yaml"), undefined);
  });
});

describe("toRepoRelativePosix", () => {
  it("normalizes separators", () => {
    assert.equal(
      toRepoRelativePosix("/repo/dataset/Search/_meta.yaml", "/repo"),
      "dataset/Search/_meta.yaml",
    );
  });
});

describe("validateParsedYaml", () => {
  it("returns issues when validation fails", () => {
    const validate = Object.assign(
      (data: unknown) => data === null,
      {
        errors: [{ instancePath: "/input", message: "must be object" }],
      },
    );
    const issues = validateParsedYaml({ input: {} }, validate, "x.yaml");
    assert.equal(issues.length, 1);
    assert.match(issues[0]!.message, /must be object/);
  });
});

describe("typecheckDatasetYaml", () => {
  it("validates all mapped dataset yaml files", async () => {
    const summary = await typecheckDatasetYaml();
    assert.ok(summary.checked >= 4);
    assert.equal(summary.failed, 0);
    assert.ok(summary.skipped >= 1);
    assert.equal(summary.passed, summary.checked);
  });
});
