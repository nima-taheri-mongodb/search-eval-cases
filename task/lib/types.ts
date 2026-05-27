import type { EvalScorerArgs } from "braintrust";

export type SeedSearchIndex = {
  type: "search" | "vectorSearch";
  name: string;
  definition: Record<string, unknown>;
};

export type SeedClassicIndex = {
  type: "classic";
  name?: string;
  key: Record<string, 1 | -1>;
} & Record<string, unknown>;

export type SeedIndexSpec = SeedSearchIndex | SeedClassicIndex;

export type SeedSetup = { indexes?: SeedIndexSpec[] };

// A db_seed entry is either a bare collection name, or a single-key object
// mapping a collection name to its setup (e.g. indexes to create).
export type DbSeedEntry = string | { [collection: string]: SeedSetup };

export type DataMatch = {
  aggregate: Record<string, unknown>[];
};

export interface RunEvalInput {
  prompt: string;
  db_seed?: DbSeedEntry[];
}

export interface RunEvalExpected {
  llm_judge?: string | string[];
  data_match?: DataMatch;
}

// A single computed score: the numeric value plus any judge metadata. Computed
// in the task (while the temp DB is alive) and read back out by the scorers.
export interface ScoreEntry {
  score: number;
  metadata?: Record<string, unknown>;
}

export type CaseScores = {
  llm_judge?: ScoreEntry;
  data_match?: ScoreEntry;
};

export interface RunEvalOutput {
  text: string;
  // Scores computed in the task; the scorer functions just extract these.
  scores: CaseScores;
}

export interface Verdict {
  score: number;
  explanation: string;
}

export type RunEvalScorerArgs = EvalScorerArgs<
  RunEvalInput,
  RunEvalOutput,
  RunEvalExpected
>;
