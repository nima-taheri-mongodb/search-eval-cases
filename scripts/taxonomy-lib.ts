import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { DatasetRow } from "./datasets-lib.js";

export const TAXONOMY_FILENAME = "taxonomy.yaml";

export interface CaseRow extends DatasetRow {
  label?: string;
  labels?: string[];
}

/** Parsed root of an L3 case YAML file: a sequence of rows (legacy `{ rows: [...] }` still accepted when reading). */
export type CaseRowsDocument = CaseRow[];

export interface TagLocation {
  filePath: string;
  l1: string;
  l2: string;
  l3: string;
  labelSuffix: string[];
}

export type TaxonomyNode = TaxonomyBranch | TaxonomyLeafNode;

export interface TaxonomyLeafNode {
  name: string;
  summary: string;
}

export interface TaxonomyBranch {
  name: string;
  children: TaxonomyNode[];
}

export interface TaxonomyRoot {
  name: string;
  children: TaxonomyNode[];
}

type RawTaxonomyYaml = {
  taxonomy?: RawTaxonomyEntry[];
};

type RawTaxonomyEntry = Record<string, RawTaxonomyValue>;
type RawTaxonomyValue = string | RawTaxonomyEntry[] | Record<string, string | RawTaxonomyEntry[]>;

export function normalizeTag(tag: string): string {
  return tag
    .replace(/^Team - /, "")
    .replace(/^Category - /, "")
    .trim();
}

export function normalizeTags(tags: string[] | undefined | null): string[] {
  if (!tags) {
    return [];
  }
  return tags.map(normalizeTag);
}

export function suffixFromRow(row: CaseRow): string[] {
  if (row.labels?.length) {
    return [...row.labels];
  }
  if (row.label) {
    return [row.label];
  }
  return [];
}

export function pathToTagsPrefix(
  filePath: string,
  datasetDir: string,
): [string, string, string] {
  const rel = path.relative(datasetDir, filePath).replace(/\.yaml$/i, "");
  const parts = rel.split(path.sep);
  if (parts.length !== 3) {
    throw new Error(
      `Case file must be dataset/{L1}/{L2}/{L3}.yaml, got: ${rel}`,
    );
  }
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function rowTags(
  prefix: [string, string, string],
  row: CaseRow,
): string[] {
  return [...prefix, ...suffixFromRow(row)];
}

export function tagsToLocation(tags: string[], datasetDir: string): TagLocation {
  const normalized = normalizeTags(tags);
  if (normalized.length < 3) {
    throw new Error(
      `Row tags need at least 3 levels (L1/L2/L3), got: ${normalized.join(" > ")}`,
    );
  }
  const [l1, l2, l3, ...labelSuffix] = normalized;
  return {
    filePath: path.join(datasetDir, l1!, l2!, `${l3!}.yaml`),
    l1: l1!,
    l2: l2!,
    l3: l3!,
    labelSuffix,
  };
}

export function applyLabelSuffix(row: CaseRow, labelSuffix: string[]): CaseRow {
  const copy: CaseRow = { ...row };
  delete copy.label;
  delete copy.labels;
  if (labelSuffix.length === 1) {
    copy.label = labelSuffix[0];
  } else if (labelSuffix.length > 1) {
    copy.labels = labelSuffix;
  }
  return copy;
}

export function rowForBraintrust(
  prefix: [string, string, string],
  row: CaseRow,
): DatasetRow {
  const { label: _l, labels: _ls, ...rest } = row;
  return {
    ...rest,
    tags: rowTags(prefix, row),
  };
}

function isLeafValue(value: RawTaxonomyValue): value is string {
  return typeof value === "string";
}

function parseRawNodes(entries: RawTaxonomyEntry[]): TaxonomyNode[] {
  const nodes: TaxonomyNode[] = [];
  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry)) {
      nodes.push(parseRawNode(name, value));
    }
  }
  return nodes;
}

function parseRawNode(name: string, value: RawTaxonomyValue): TaxonomyNode {
  if (isLeafValue(value)) {
    return { name, summary: value.trim() };
  }
  if (Array.isArray(value)) {
    return { name, children: parseRawNodes(value) };
  }
  return {
    name,
    children: parseRawNodes(
      Object.entries(value).map(([childName, childValue]) => ({
        [childName]: childValue,
      })),
    ),
  };
}

export interface TaxonomyNamedNode {
  name: string;
  summary?: string;
  children?: TaxonomyNamedNode[];
}

function toNamed(node: TaxonomyNode): TaxonomyNamedNode {
  if ("summary" in node) {
    return { name: node.name, summary: node.summary };
  }
  return {
    name: node.name,
    children: node.children.map(toNamed),
  };
}

function fromNamed(node: TaxonomyNamedNode): TaxonomyNode {
  if (node.children?.length) {
    return {
      name: node.name,
      children: node.children.map(fromNamed),
    };
  }
  return { name: node.name, summary: node.summary ?? "" };
}

export function parseTaxonomyYaml(text: string): TaxonomyRoot[] {
  const raw = parse(text) as RawTaxonomyYaml;
  const entries = raw.taxonomy ?? [];
  return parseRawNodes(entries).map((node) => {
    if (!("children" in node)) {
      throw new Error(`Top-level taxonomy node must be a branch: ${node.name}`);
    }
    return { name: node.name, children: node.children };
  });
}

export function serializeTaxonomy(roots: TaxonomyRoot[]): string {
  const taxonomy = roots.map((root) => ({
    [root.name]: serializeNodes(root.children),
  }));
  const yaml = stringify({ taxonomy }, { lineWidth: 0 });
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

function serializeNodes(nodes: TaxonomyNode[]): Record<string, unknown>[] {
  return nodes.map((node) => {
    if ("summary" in node) {
      return { [node.name]: node.summary };
    }
    return { [node.name]: serializeNodes(node.children) };
  });
}

function namedToRaw(nodes: TaxonomyNamedNode[]): TaxonomyNode[] {
  return nodes.map(fromNamed);
}

export function taxonomyPathKey(tags: string[]): string {
  return normalizeTags(tags).join("\0");
}

function setLeafSummary(
  nodes: TaxonomyNamedNode[],
  tagPath: string[],
  summary: string,
): TaxonomyNamedNode[] {
  if (tagPath.length === 0) {
    return nodes;
  }
  const [head, ...rest] = tagPath;
  const existing = nodes.find((n) => n.name === head);
  if (!existing) {
    if (rest.length === 0) {
      return [...nodes, { name: head!, summary }];
    }
    return [
      ...nodes,
      {
        name: head!,
        children: setLeafSummary([], rest, summary),
      },
    ];
  }
  if (rest.length === 0) {
    return nodes.map((n) =>
      n.name === head ? { ...n, summary: summary || n.summary } : n,
    );
  }
  return nodes.map((n) =>
    n.name === head
      ? {
          ...n,
          children: setLeafSummary(n.children ?? [], rest, summary),
        }
      : n,
  );
}

export function flattenTaxonomy(roots: TaxonomyRoot[]): {
  tags: string[];
  summary: string;
}[] {
  const paths: { tags: string[]; summary: string }[] = [];

  function walk(nodes: TaxonomyNode[], prefix: string[]): void {
    for (const node of nodes) {
      const tagPath = [...prefix, node.name];
      if ("summary" in node) {
        paths.push({ tags: tagPath, summary: node.summary });
      } else {
        walk(node.children, tagPath);
      }
    }
  }

  for (const root of roots) {
    walk(root.children, [root.name]);
  }
  return paths;
}

export function mergeTaxonomy(
  existing: TaxonomyRoot[],
  discovered: TaxonomyRoot[],
): TaxonomyRoot[] {
  const summaryByPath = new Map<string, string>();
  for (const { tags, summary } of [
    ...flattenTaxonomy(existing),
    ...flattenTaxonomy(discovered),
  ]) {
    const key = taxonomyPathKey(tags);
    const prev = summaryByPath.get(key);
    summaryByPath.set(key, summary || prev || "");
  }
  for (const { tags, summary } of flattenTaxonomy(existing)) {
    const key = taxonomyPathKey(tags);
    if (summary) {
      summaryByPath.set(key, summary);
    }
  }
  return taxonomyFromTagPaths(
    [...summaryByPath.entries()].map(([key, summary]) => ({
      tags: key.split("\0"),
      summary,
    })),
  );
}

export function taxonomyFromTagPaths(
  paths: { tags: string[]; summary?: string }[],
): TaxonomyRoot[] {
  const roots = new Map<string, TaxonomyNamedNode>();

  for (const { tags, summary } of paths) {
    const normalized = normalizeTags(tags);
    if (normalized.length < 3) {
      continue;
    }
    const [l1, ...rest] = normalized;
    const root = roots.get(l1!) ?? { name: l1!, children: [] };
    root.children = setLeafSummary(
      root.children ?? [],
      rest,
      summary ?? "",
    );
    roots.set(l1!, root);
  }

  return [...roots.values()].map((root) => ({
    name: root.name,
    children: namedToRaw(root.children ?? []),
  }));
}

function stubRow(summary: string, label?: string, labels?: string[]): CaseRow {
  const row: CaseRow = {
    input: { prompt: "" },
    metadata: { summary },
  };
  if (labels?.length) {
    row.labels = labels;
  } else if (label) {
    row.label = label;
  }
  return row;
}

function rowIsPopulated(row: CaseRow): boolean {
  const prompt = (row.input as { prompt?: string } | undefined)?.prompt;
  return Boolean(prompt && prompt.trim().length > 0);
}

function mergeRowStubs(existing: CaseRow[], stubs: CaseRow[]): CaseRow[] {
  const result = [...existing];
  for (const stub of stubs) {
    const stubSuffix = suffixFromRow(stub);
    const found = result.find(
      (row) => suffixFromRow(row).join("\0") === stubSuffix.join("\0"),
    );
    if (!found) {
      result.push(stub);
    } else if (!found.metadata && stub.metadata) {
      found.metadata = stub.metadata;
    } else if (
      found.metadata &&
      stub.metadata &&
      typeof found.metadata === "object" &&
      typeof stub.metadata === "object" &&
      !(found.metadata as { summary?: string }).summary &&
      (stub.metadata as { summary?: string }).summary
    ) {
      (found.metadata as { summary?: string }).summary = (
        stub.metadata as { summary?: string }
      ).summary;
    }
  }
  return result;
}

function scaffoldL3File(
  l1: string,
  l2: string,
  l3: string,
  node: TaxonomyNode,
): CaseRow[] {
  if ("summary" in node) {
    return [stubRow(node.summary)];
  }
  return node.children.map((child) => {
    if ("summary" in child) {
      return stubRow(child.summary, child.name);
    }
    return stubRow("", child.name, collectDeepLabels(child));
  });
}

function collectDeepLabels(node: TaxonomyNode): string[] {
  if ("summary" in node) {
    return [];
  }
  if (node.children.length === 1 && "summary" in node.children[0]!) {
    return [node.name, node.children[0]!.name];
  }
  return [node.name];
}

export interface ScaffoldResult {
  created: string[];
  updated: string[];
}

export async function scaffoldFromTaxonomy(
  roots: TaxonomyRoot[],
  datasetDir: string,
  writeYaml: (file: string, data: unknown) => Promise<void>,
  readYaml: (file: string) => Promise<CaseRow[] | null>,
): Promise<ScaffoldResult> {
  const created: string[] = [];
  const updated: string[] = [];

  for (const root of roots) {
    const l1Dir = path.join(datasetDir, root.name);
    await mkdir(l1Dir, { recursive: true });

    for (const l2Node of root.children) {
      if ("summary" in l2Node) {
        continue;
      }
      const l2Dir = path.join(l1Dir, l2Node.name);
      await mkdir(l2Dir, { recursive: true });

      for (const l3Node of l2Node.children) {
        const filePath = path.join(l2Dir, `${l3Node.name}.yaml`);
        const stubs = scaffoldL3File(root.name, l2Node.name, l3Node.name, l3Node);
        const existing = await readYaml(filePath);
        const merged = mergeRowStubs(existing ?? [], stubs);

        if (!existing) {
          created.push(filePath);
        } else if (merged.length !== existing.length) {
          updated.push(filePath);
        }

        await writeYaml(filePath, merged);
      }
    }
  }

  return { created, updated };
}

export function taxonomyFromFilesystem(
  tagPaths: { tags: string[]; summary?: string }[],
): TaxonomyRoot[] {
  return taxonomyFromTagPaths(tagPaths);
}

export function taxonomyFilePath(datasetDir: string): string {
  return path.join(datasetDir, TAXONOMY_FILENAME);
}

export async function readTaxonomyFile(datasetDir: string): Promise<TaxonomyRoot[]> {
  try {
    const text = await readFile(taxonomyFilePath(datasetDir), "utf8");
    return parseTaxonomyYaml(text);
  } catch {
    return [];
  }
}

export async function writeTaxonomyFile(
  datasetDir: string,
  roots: TaxonomyRoot[],
): Promise<void> {
  await mkdir(datasetDir, { recursive: true });
  await writeFile(taxonomyFilePath(datasetDir), serializeTaxonomy(roots), "utf8");
}
