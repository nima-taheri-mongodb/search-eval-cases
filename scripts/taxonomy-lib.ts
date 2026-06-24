import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { DatasetRow } from "./datasets-lib.js";

export const TAXONOMY_FILENAME = "taxonomy.yaml";
export const CASES_FILENAME = "cases.yaml";

export const TAXONOMY_BRANCH_KINDS = [
  "dataset",
  "category",
  "subcategory",
  "group",
  "subgroup",
] as const;

export type TaxonomyBranchKind = (typeof TAXONOMY_BRANCH_KINDS)[number];

export interface TaxonomyPath {
  category?: string;
  subcategory?: string;
  group?: string;
  subgroup?: string;
}

export interface CaseMetadata {
  category?: string;
  subcategory?: string;
  group?: string;
  subgroup?: string;
  name: string;
  description: string;
}

export interface CaseRow extends DatasetRow {
  metadata?: CaseMetadata | Record<string, unknown> | null;
}

/** Parsed root of a cases YAML file: a sequence of rows (legacy `{ rows: [...] }` still accepted when reading). */
export type CaseRowsDocument = CaseRow[];

export interface TaxonomyLeaf {
  name: string;
  description: string;
}

export interface TaxonomyBranchNode {
  kind: TaxonomyBranchKind;
  value: string;
  children: TaxonomyTreeNode[];
}

export type TaxonomyTreeNode = TaxonomyBranchNode | TaxonomyLeaf;

export function isTaxonomyLeaf(node: TaxonomyTreeNode): node is TaxonomyLeaf {
  return "description" in node;
}

export interface TaxonomyRoot {
  dataset: string;
  children: TaxonomyTreeNode[];
}

export interface TaxonomyLeafRecord {
  dataset: string;
  path: TaxonomyPath;
  name: string;
  description: string;
}

type RawTaxonomyYaml = {
  taxonomy?: RawTaxonomyEntry[];
};

type RawTaxonomyEntry = Record<string, RawTaxonomyValue>;
type RawTaxonomyValue = string | RawTaxonomyEntry[];

const FOLDER_LEVEL_KEYS: (keyof TaxonomyPath)[] = [
  "category",
  "subcategory",
  "group",
  "subgroup",
];

const BRANCH_KEY_RE =
  /^(dataset|category|subcategory|group|subgroup)=(.+)$/;

export function parseTaxonomyKey(
  key: string,
): { kind: TaxonomyBranchKind; value: string } | { kind: "leaf"; name: string } {
  const match = BRANCH_KEY_RE.exec(key);
  if (match) {
    return {
      kind: match[1] as TaxonomyBranchKind,
      value: match[2]!.trim(),
    };
  }
  return { kind: "leaf", name: key };
}

export function formatTaxonomyBranchKey(
  kind: TaxonomyBranchKind,
  value: string,
): string {
  return `${kind}=${value}`;
}

export function folderSegments(taxonomyPath: TaxonomyPath): string[] {
  return FOLDER_LEVEL_KEYS.map((key) => taxonomyPath[key]).filter(
    (segment): segment is string => Boolean(segment),
  );
}

export function folderPathForTaxonomyPath(
  datasetDir: string,
  dataset: string,
  taxonomyPath: TaxonomyPath,
): string {
  return path.join(datasetDir, dataset, ...folderSegments(taxonomyPath));
}

export function casesFilePathForRecord(
  datasetDir: string,
  record: Pick<TaxonomyLeafRecord, "dataset" | "path">,
): string {
  return path.join(
    folderPathForTaxonomyPath(datasetDir, record.dataset, record.path),
    CASES_FILENAME,
  );
}

export function casesFilePathFromMetadata(
  datasetDir: string,
  dataset: string,
  metadata: CaseMetadata,
): string {
  const taxonomyPath: TaxonomyPath = {
    category: metadata.category,
    subcategory: metadata.subcategory,
    group: metadata.group,
    subgroup: metadata.subgroup,
  };
  return path.join(
    folderPathForTaxonomyPath(datasetDir, dataset, taxonomyPath),
    CASES_FILENAME,
  );
}

export function taxonomyPathFromCasesFile(
  filePath: string,
  datasetDir: string,
): { dataset: string; path: TaxonomyPath } {
  const rel = path.relative(datasetDir, filePath);
  const parts = rel.split(path.sep);
  if (parts[parts.length - 1] !== CASES_FILENAME) {
    throw new Error(
      `Case file must be dataset/{dataset}/.../${CASES_FILENAME}, got: ${rel}`,
    );
  }
  if (parts.length < 2) {
    throw new Error(`Case file path too short: ${rel}`);
  }
  const dataset = parts[0]!;
  const folderParts = parts.slice(1, -1);
  const taxonomyPath: TaxonomyPath = {};
  for (let i = 0; i < folderParts.length && i < FOLDER_LEVEL_KEYS.length; i++) {
    taxonomyPath[FOLDER_LEVEL_KEYS[i]!] = folderParts[i];
  }
  return { dataset, path: taxonomyPath };
}

export function metadataFromTaxonomyPath(
  taxonomyPath: TaxonomyPath,
  name: string,
  description: string,
): CaseMetadata {
  const metadata: CaseMetadata = { name, description };
  if (taxonomyPath.category) {
    metadata.category = taxonomyPath.category;
  }
  if (taxonomyPath.subcategory) {
    metadata.subcategory = taxonomyPath.subcategory;
  }
  if (taxonomyPath.group) {
    metadata.group = taxonomyPath.group;
  }
  if (taxonomyPath.subgroup) {
    metadata.subgroup = taxonomyPath.subgroup;
  }
  return metadata;
}

export function getCaseMetadata(row: CaseRow): CaseMetadata | null {
  if (!row.metadata || typeof row.metadata !== "object") {
    return null;
  }
  const raw = row.metadata as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) {
    return null;
  }
  const description =
    typeof raw.description === "string"
      ? raw.description
      : typeof raw.summary === "string"
        ? raw.summary
        : "";
  return {
    category: typeof raw.category === "string" ? raw.category : undefined,
    subcategory:
      typeof raw.subcategory === "string" ? raw.subcategory : undefined,
    group: typeof raw.group === "string" ? raw.group : undefined,
    subgroup: typeof raw.subgroup === "string" ? raw.subgroup : undefined,
    name: raw.name,
    description,
  };
}

export function enrichRowMetadata(
  row: CaseRow,
  taxonomyPath: TaxonomyPath,
): CaseRow {
  const existing =
    row.metadata && typeof row.metadata === "object"
      ? { ...(row.metadata as Record<string, unknown>) }
      : {};
  const metadata = metadataFromTaxonomyPath(
    {
      category:
        (typeof existing.category === "string" ? existing.category : undefined) ??
        taxonomyPath.category,
      subcategory:
        (typeof existing.subcategory === "string"
          ? existing.subcategory
          : undefined) ?? taxonomyPath.subcategory,
      group:
        (typeof existing.group === "string" ? existing.group : undefined) ??
        taxonomyPath.group,
      subgroup:
        (typeof existing.subgroup === "string" ? existing.subgroup : undefined) ??
        taxonomyPath.subgroup,
    },
    typeof existing.name === "string" ? existing.name : "",
    typeof existing.description === "string"
      ? existing.description
      : typeof existing.summary === "string"
        ? existing.summary
        : "",
  );
  delete (existing as { summary?: string }).summary;
  // Emit canonical key order (name, description, category, subcategory, group,
  // subgroup) first, then preserve any extra metadata keys.
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    if (!(key in metadata)) {
      extras[key] = value;
    }
  }
  return {
    ...row,
    metadata: {
      ...metadata,
      ...extras,
    },
  };
}

export function rowMatchKey(dataset: string, metadata: CaseMetadata): string {
  return [
    dataset,
    metadata.category ?? "",
    metadata.subcategory ?? "",
    metadata.group ?? "",
    metadata.subgroup ?? "",
    metadata.name,
  ].join("\0");
}

export function rowForBraintrust(row: CaseRow): DatasetRow {
  const { tags: _tags, ...rest } = row as CaseRow & { tags?: string[] };
  return rest;
}

function parseRawNodes(
  entries: RawTaxonomyEntry[],
  parentKind?: TaxonomyBranchKind,
): TaxonomyTreeNode[] {
  const nodes: TaxonomyTreeNode[] = [];
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      nodes.push(parseRawNode(key, value, parentKind));
    }
  }
  return nodes;
}

function parseRawNode(
  key: string,
  value: RawTaxonomyValue,
  parentKind?: TaxonomyBranchKind,
): TaxonomyTreeNode {
  const parsed = parseTaxonomyKey(key);
  if (parsed.kind === "leaf") {
    if (typeof value !== "string") {
      throw new Error(`Leaf "${key}" must have a string description`);
    }
    return { name: parsed.name, description: value.trim() };
  }

  if (typeof value === "string") {
    throw new Error(
      `Branch key "${key}" must have child entries, not a string value`,
    );
  }
  if (!Array.isArray(value)) {
    throw new Error(`Branch key "${key}" must have a YAML sequence of children`);
  }

  if (parentKind === undefined && parsed.kind !== "dataset") {
    throw new Error(
      `Top-level taxonomy entry must be dataset=..., got: ${key}`,
    );
  }

  return {
    kind: parsed.kind,
    value: parsed.value,
    children: parseRawNodes(value, parsed.kind),
  };
}

export function parseTaxonomyYaml(text: string): TaxonomyRoot[] {
  const raw = parse(text) as RawTaxonomyYaml;
  const entries = raw.taxonomy ?? [];
  const roots: TaxonomyRoot[] = [];

  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry)) {
      const parsed = parseTaxonomyKey(key);
      if (parsed.kind !== "dataset") {
        throw new Error(`Top-level taxonomy entry must be dataset=..., got: ${key}`);
      }
      if (!Array.isArray(value)) {
        throw new Error(`dataset=${parsed.value} must have a YAML sequence of children`);
      }
      roots.push({
        dataset: parsed.value,
        children: parseRawNodes(value, "dataset"),
      });
    }
  }

  return roots;
}

function serializeNodes(nodes: TaxonomyTreeNode[]): Record<string, unknown>[] {
  return nodes.map((node) => {
    if (isTaxonomyLeaf(node)) {
      return { [node.name]: node.description };
    }
    return {
      [formatTaxonomyBranchKey(node.kind, node.value)]: serializeNodes(
        node.children,
      ),
    };
  });
}

export function serializeTaxonomy(roots: TaxonomyRoot[]): string {
  const taxonomy = roots.map((root) => ({
    [formatTaxonomyBranchKey("dataset", root.dataset)]: serializeNodes(
      root.children,
    ),
  }));
  const yaml = stringify({ taxonomy }, { lineWidth: 0 });
  return yaml.endsWith("\n") ? yaml : `${yaml}\n`;
}

export function flattenTaxonomy(roots: TaxonomyRoot[]): TaxonomyLeafRecord[] {
  const records: TaxonomyLeafRecord[] = [];

  function walk(
    dataset: string,
    taxonomyPath: TaxonomyPath,
    nodes: TaxonomyTreeNode[],
  ): void {
    for (const node of nodes) {
      if (isTaxonomyLeaf(node)) {
        records.push({
          dataset,
          path: { ...taxonomyPath },
          name: node.name,
          description: node.description,
        });
        continue;
      }

      const nextPath: TaxonomyPath = { ...taxonomyPath };
      if (node.kind === "category") {
        nextPath.category = node.value;
      } else if (node.kind === "subcategory") {
        nextPath.subcategory = node.value;
      } else if (node.kind === "group") {
        nextPath.group = node.value;
      } else if (node.kind === "subgroup") {
        nextPath.subgroup = node.value;
      } else {
        throw new Error(`Unexpected branch kind under dataset: ${node.kind}`);
      }
      walk(dataset, nextPath, node.children);
    }
  }

  for (const root of roots) {
    walk(root.dataset, {}, root.children);
  }
  return records;
}

export function taxonomyPathKey(record: TaxonomyLeafRecord): string {
  return rowMatchKey(
    record.dataset,
    metadataFromTaxonomyPath(record.path, record.name, record.description),
  );
}

function insertLeafRecord(
  roots: Map<string, TaxonomyTreeNode[]>,
  record: TaxonomyLeafRecord,
): void {
  const children = roots.get(record.dataset) ?? [];
  roots.set(record.dataset, insertLeafAtPath(children, record.path, record));
}

function insertLeafAtPath(
  nodes: TaxonomyTreeNode[],
  taxonomyPath: TaxonomyPath,
  record: TaxonomyLeafRecord,
): TaxonomyTreeNode[] {
  const segments: { kind: TaxonomyBranchKind; value: string }[] = [];
  if (taxonomyPath.category) {
    segments.push({ kind: "category", value: taxonomyPath.category });
  }
  if (taxonomyPath.subcategory) {
    segments.push({ kind: "subcategory", value: taxonomyPath.subcategory });
  }
  if (taxonomyPath.group) {
    segments.push({ kind: "group", value: taxonomyPath.group });
  }
  if (taxonomyPath.subgroup) {
    segments.push({ kind: "subgroup", value: taxonomyPath.subgroup });
  }

  if (segments.length === 0) {
    return insertLeafNode(nodes, record);
  }

  const [head, ...rest] = segments;
  const existing = nodes.find(
    (node): node is TaxonomyBranchNode =>
      !isTaxonomyLeaf(node) &&
      node.kind === head!.kind &&
      node.value === head!.value,
  );
  if (!existing) {
    const childNodes =
      rest.length === 0
        ? insertLeafNode([], record)
        : insertLeafAtPath([], branchPathFromSegments(rest), record);
    return [
      ...nodes,
      {
        kind: head!.kind,
        value: head!.value,
        children: childNodes,
      },
    ];
  }

  const nextPath = branchPathFromSegments(rest);
  return nodes.map((node) => {
    if (
      !isTaxonomyLeaf(node) &&
      node.kind === head!.kind &&
      node.value === head!.value
    ) {
      return {
        ...node,
        children: insertLeafAtPath(node.children, nextPath, record),
      };
    }
    return node;
  });
}

function branchPathFromSegments(
  segments: { kind: TaxonomyBranchKind; value: string }[],
): TaxonomyPath {
  const taxonomyPath: TaxonomyPath = {};
  for (const segment of segments) {
    if (segment.kind === "category") {
      taxonomyPath.category = segment.value;
    } else if (segment.kind === "subcategory") {
      taxonomyPath.subcategory = segment.value;
    } else if (segment.kind === "group") {
      taxonomyPath.group = segment.value;
    } else if (segment.kind === "subgroup") {
      taxonomyPath.subgroup = segment.value;
    }
  }
  return taxonomyPath;
}

function insertLeafNode(
  nodes: TaxonomyTreeNode[],
  record: TaxonomyLeafRecord,
): TaxonomyTreeNode[] {
  const existing = nodes.find(
    (node): node is TaxonomyLeaf =>
      isTaxonomyLeaf(node) && node.name === record.name,
  );
  if (existing) {
    return nodes.map((node) =>
      isTaxonomyLeaf(node) && node.name === record.name
        ? { ...node, description: record.description || node.description }
        : node,
    );
  }
  return [
    ...nodes,
    { name: record.name, description: record.description },
  ];
}

export function taxonomyFromMetadataPaths(
  paths: TaxonomyLeafRecord[],
): TaxonomyRoot[] {
  const roots = new Map<string, TaxonomyTreeNode[]>();
  for (const record of paths) {
    insertLeafRecord(roots, record);
  }
  return [...roots.entries()].map(([dataset, children]) => ({
    dataset,
    children,
  }));
}

export function mergeTaxonomy(
  existing: TaxonomyRoot[],
  discovered: TaxonomyRoot[],
): TaxonomyRoot[] {
  const descriptionByPath = new Map<string, string>();
  for (const record of [
    ...flattenTaxonomy(existing),
    ...flattenTaxonomy(discovered),
  ]) {
    const key = taxonomyPathKey(record);
    const prev = descriptionByPath.get(key);
    descriptionByPath.set(key, record.description || prev || "");
  }
  for (const record of flattenTaxonomy(existing)) {
    const key = taxonomyPathKey(record);
    if (record.description) {
      descriptionByPath.set(key, record.description);
    }
  }
  return taxonomyFromMetadataPaths(
    [...descriptionByPath.entries()].map(([key, description]) => {
      const [dataset, category, subcategory, group, subgroup, name] =
        key.split("\0");
      return {
        dataset: dataset!,
        path: {
          category: category || undefined,
          subcategory: subcategory || undefined,
          group: group || undefined,
          subgroup: subgroup || undefined,
        },
        name: name!,
        description,
      };
    }),
  );
}

function stubRow(metadata: CaseMetadata): CaseRow {
  return {
    input: { prompt: "" },
    metadata,
  };
}

function mergeRowStubs(existing: CaseRow[], stubs: CaseRow[]): CaseRow[] {
  const result = [...existing];
  for (const stub of stubs) {
    const stubMeta = getCaseMetadata(stub);
    if (!stubMeta) {
      continue;
    }
    const found = result.find((row) => {
      const meta = getCaseMetadata(row);
      return meta && meta.name === stubMeta.name;
    });
    if (!found) {
      result.push(stub);
      continue;
    }
    if (!found.metadata && stub.metadata) {
      found.metadata = stub.metadata;
    } else if (found.metadata && stub.metadata) {
      const current = found.metadata as Record<string, unknown>;
      const incoming = stub.metadata as Record<string, unknown>;
      if (!current.description && incoming.description) {
        current.description = incoming.description;
      }
    }
  }
  return result;
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
  const byFile = new Map<string, CaseRow[]>();

  for (const record of flattenTaxonomy(roots)) {
    const filePath = casesFilePathForRecord(datasetDir, record);
    const metadata = metadataFromTaxonomyPath(
      record.path,
      record.name,
      record.description,
    );
    const stubs = byFile.get(filePath) ?? [];
    stubs.push(stubRow(metadata));
    byFile.set(filePath, stubs);
  }

  for (const [filePath, stubs] of byFile) {
    await mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readYaml(filePath);
    const merged = mergeRowStubs(existing ?? [], stubs);

    if (!existing) {
      created.push(filePath);
    } else if (merged.length !== existing.length) {
      updated.push(filePath);
    }

    await writeYaml(filePath, merged);
  }

  return { created, updated };
}

export function taxonomyFromFilesystem(
  records: TaxonomyLeafRecord[],
): TaxonomyRoot[] {
  return taxonomyFromMetadataPaths(records);
}

export function taxonomyFilePath(datasetDir: string): string {
  return path.join(datasetDir, TAXONOMY_FILENAME);
}

export async function readTaxonomyFile(
  datasetDir: string,
): Promise<TaxonomyRoot[]> {
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
